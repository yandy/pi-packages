import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CheckpointStore } from "../src/checkpoint-store.js";
import { createGitRunner, type RunGit } from "../src/git.js";
import { checkpointRef } from "../src/refs.js";
import {
	buildPrunePlan,
	createRetentionSweeper,
	isCheckpointRefName,
	pruneCheckpointRefs,
} from "../src/retention.js";
import {
	commitAll,
	createCheckpointCommit,
	createTestRepo,
	git,
	type TestRepo,
	seedBaselineRef,
	seedCompletedRef,
} from "./helpers/git-repo.js";

const day = 86_400;
const nowIso = "2026-11-21T00:00:00Z";
const nowSeconds = Math.floor(Date.parse(nowIso) / 1000);
const now = () => new Date(nowIso);

function record(name: string, daysAgo: number) {
	return {
		name: `refs/pi/checkpoint/${name}`,
		committedAtSeconds: nowSeconds - daysAgo * day,
		objectOid: "0".repeat(40),
	};
}

/** Serializes one `for-each-ref` line in the exact format the enumerator requests. */
function listingLine(commit: { oid: string; seconds: number; parent: string; subject: string; ref: string }): string {
	return ["commit", commit.oid, String(commit.seconds), commit.parent, commit.subject, commit.ref, ""].join("\x1f") + "\n";
}

async function commitDetails(dir: string, oid: string, ref: string) {
	return {
		oid,
		seconds: Number(await git(dir, "log", "-1", "--format=%ct", oid)),
		parent: await git(dir, "rev-list", "--parents", "-n", "1", oid).then((line) => line.split(" ").slice(1).join(" ")),
		subject: await git(dir, "log", "-1", "--format=%s", oid),
		ref,
	};
}

describe("checkpoint ref retention", () => {
	const repos: TestRepo[] = [];
	const tempDirs: string[] = [];

	// Fixtures are registered and torn down here rather than at the end of each test body: an
	// assertion that throws halfway through must not leave temporary repositories behind.
	async function makeRepo(): Promise<TestRepo> {
		const repo = await createTestRepo();
		repos.push(repo);
		return repo;
	}

	async function makeTempDir(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), "pi-checkpoint-plain-"));
		tempDirs.push(dir);
		return dir;
	}

	afterEach(async () => {
		await Promise.all(repos.splice(0).map((repo) => repo.cleanup()));
		await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
	});

	describe("prune plan", () => {
		const policy = { nowSeconds, retentionDays: 30, maxRefs: 200 };

		it("keeps refs inside both limits", () => {
			const plan = buildPrunePlan([record("s1/run-a", 1), record("s1/run-b", 5)], policy);
			expect(plan.selected).toEqual([]);
			expect(plan.expired).toHaveLength(0);
			expect(plan.overflow).toHaveLength(0);
		});

		it("deletes refs older than the retention window", () => {
			const plan = buildPrunePlan([record("s1/fresh", 3), record("s1/stale", 31)], policy);
			expect(plan.selected.map((entry) => entry.name)).toEqual(["refs/pi/checkpoint/s1/stale"]);
			expect(plan.expired.map((entry) => entry.name)).toEqual(["refs/pi/checkpoint/s1/stale"]);
			expect(plan.overflow).toHaveLength(0);
		});

		it("keeps only the newest refs when the count limit binds", () => {
			const plan = buildPrunePlan(
				[record("s1/oldest", 4), record("s2/middle", 3), record("s3/newest", 1)],
				{ ...policy, maxRefs: 2 },
			);
			expect(plan.selected.map((entry) => entry.name)).toEqual(["refs/pi/checkpoint/s1/oldest"]);
			expect(plan.expired).toHaveLength(0);
			expect(plan.overflow.map((entry) => entry.name)).toEqual(["refs/pi/checkpoint/s1/oldest"]);
		});

		it("selects globally by age instead of per session", () => {
			const plan = buildPrunePlan(
				[...Array.from({ length: 3 }, (_, index) => record(`busy/run-${index}`, index)), record("quiet/only-run", 20)],
				{ ...policy, maxRefs: 2 },
			);
			expect(plan.selected.map((entry) => entry.name)).toEqual([
				"refs/pi/checkpoint/quiet/only-run",
				"refs/pi/checkpoint/busy/run-2",
			]);
			expect(plan.overflow).toHaveLength(2);
		});

		it("keeps a ref exactly at each boundary", () => {
			const atWindow = buildPrunePlan([record("s/at-window", 30), record("s/over-window", 31)], policy);
			expect(atWindow.selected.map((entry) => entry.name)).toEqual(["refs/pi/checkpoint/s/over-window"]);

			const atQuota = buildPrunePlan([record("s/newest", 1), record("s/older", 2)], { ...policy, maxRefs: 2 });
			expect(atQuota.selected).toEqual([]);
		});

		it("does not let expired refs consume the count quota", () => {
			// TTL runs first: the expired ref is dropped, so both fresh refs fit in the quota.
			const plan = buildPrunePlan(
				[record("s/expired", 31), record("s/fresh-a", 2), record("s/fresh-b", 1)],
				{ ...policy, maxRefs: 2 },
			);
			expect(plan.selected.map((entry) => entry.name)).toEqual(["refs/pi/checkpoint/s/expired"]);
			expect(plan.expired).toHaveLength(1);
			expect(plan.overflow).toHaveLength(0);
		});

		it("orders the selection oldest first and breaks ties by name", () => {
			const plan = buildPrunePlan(
				[record("s/b", 31), record("s/a", 31), record("s/c", 40)],
				{ ...policy, maxRefs: 0 },
			);
			expect(plan.selected.map((entry) => entry.name)).toEqual([
				"refs/pi/checkpoint/s/c",
				"refs/pi/checkpoint/s/a",
				"refs/pi/checkpoint/s/b",
			]);
		});
	});

	describe("classification", () => {
		it("recognizes only two-segment checkpoint ref names", () => {
			expect(isCheckpointRefName("refs/pi/checkpoint/c2Vz/run-1")).toBe(true);
			expect(isCheckpointRefName("refs/pi/checkpoint/c2Vz")).toBe(false);
			expect(isCheckpointRefName("refs/pi/checkpoint/a/b/c")).toBe(false);
			expect(isCheckpointRefName("refs/pi/checkpoint/a/")).toBe(false);
			expect(isCheckpointRefName("refs/heads/main")).toBe(false);
		});

		it("prunes stale completed refs and reports the reasons", async () => {
			const repo = await makeRepo();
			await commitAll(repo.dir);
			await seedCompletedRef(repo.dir, "busy/run-new", "2026-11-20T00:00:00Z");
			await seedCompletedRef(repo.dir, "busy/run-old", "2026-09-01T00:00:00Z");
			const result = await pruneCheckpointRefs(repo.dir, { now });
			expect(result).toMatchObject({
				dryRun: false,
				completed: 2,
				baselineOnly: 0,
				unknown: 0,
				expired: 1,
				overflow: 0,
				selected: 1,
				deleted: 1,
				kept: 1,
			});
			const refs = await git(repo.dir, "for-each-ref", "refs/pi/checkpoint");
			expect(refs).toContain("busy/run-new");
			expect(refs).not.toContain("busy/run-old");
		});

		it("never deletes a baseline-only ref, even when it is far past the retention window", async () => {
			const repo = await makeRepo();
			await commitAll(repo.dir);
			const { ref, baseline } = await seedBaselineRef(repo.dir, "busy/in-flight", "2026-09-01T00:00:00Z");
			const result = await pruneCheckpointRefs(repo.dir, { now });
			expect(result).toMatchObject({ completed: 0, baselineOnly: 1, selected: 0, deleted: 0 });
			expect(await git(repo.dir, "rev-parse", ref)).toBe(baseline);
		});

		it("does not let baseline-only refs consume the count quota", async () => {
			const repo = await makeRepo();
			await commitAll(repo.dir);
			await seedCompletedRef(repo.dir, "busy/older", "2026-11-19T00:00:00Z");
			await seedCompletedRef(repo.dir, "busy/newer", "2026-11-20T00:00:00Z");
			const { ref } = await seedBaselineRef(repo.dir, "busy/in-flight", "2026-11-20T12:00:00Z");
			const result = await pruneCheckpointRefs(repo.dir, { now, maxRefs: 1 });
			expect(result).toMatchObject({ completed: 2, baselineOnly: 1, expired: 0, overflow: 1, deleted: 1 });
			const refs = await git(repo.dir, "for-each-ref", "refs/pi/checkpoint");
			expect(refs).toContain("busy/newer");
			expect(refs).toContain("busy/in-flight");
			expect(refs).not.toContain("busy/older");
			expect(await git(repo.dir, "rev-parse", ref)).not.toBe("");
		});

		it("leaves foreign and malformed refs untouched", async () => {
			const repo = await makeRepo();
			const head = await commitAll(repo.dir);
			await seedCompletedRef(repo.dir, "busy/run-old", "2026-09-01T00:00:00Z");
			await git(repo.dir, "update-ref", "refs/pi/checkpoint/lonely", head);
			await git(repo.dir, "update-ref", "refs/pi/checkpoint/a/b/c", head);
			await git(repo.dir, "update-ref", "refs/tags/keep", head);
			const result = await pruneCheckpointRefs(repo.dir, { now });
			expect(result).toMatchObject({ completed: 1, unknown: 2, deleted: 1 });
			expect(await git(repo.dir, "rev-parse", "refs/pi/checkpoint/lonely")).toBe(head);
			expect(await git(repo.dir, "rev-parse", "refs/pi/checkpoint/a/b/c")).toBe(head);
			expect(await git(repo.dir, "rev-parse", "refs/tags/keep")).toBe(head);
			await expect(git(repo.dir, "rev-parse", "refs/pi/checkpoint/busy/run-old")).rejects.toThrow();
		});

		it("rejects a result subject that is not backed by the run's baseline commit", async () => {
			const repo = await makeRepo();
			await commitAll(repo.dir);
			const ref = "refs/pi/checkpoint/busy/forged";
			// A hand-written commit can carry the package's result subject; without a baseline parent
			// for the same ref it is not proof of a completed run.
			const unrelated = await createCheckpointCommit(repo.dir, {
				ref: "refs/pi/checkpoint/busy/other",
				kind: "baseline",
				date: "2026-09-01T00:00:00Z",
			});
			const forged = await createCheckpointCommit(repo.dir, {
				ref,
				kind: "result",
				date: "2026-09-01T00:00:00Z",
				parent: unrelated,
				subject: `pi-checkpoint result ref=${ref}`,
			});
			await git(repo.dir, "update-ref", ref, forged);
			const result = await pruneCheckpointRefs(repo.dir, { now });
			expect(result).toMatchObject({ completed: 0, unknown: 1, deleted: 0 });
			expect(await git(repo.dir, "rev-parse", ref)).toBe(forged);
		});

		it("refuses a result commit with more than one parent", async () => {
			const repo = await makeRepo();
			const head = await commitAll(repo.dir);
			const ref = "refs/pi/checkpoint/busy/merge";
			const baseline = await createCheckpointCommit(repo.dir, { ref, kind: "baseline", date: "2026-09-01T00:00:00Z" });
			const tree = await git(repo.dir, "rev-parse", `${head}^{tree}`);
			const merge = await git(
				repo.dir,
				"commit-tree",
				tree,
				"-p",
				baseline,
				"-p",
				head,
				"-m",
				`pi-checkpoint result ref=${ref}`,
			);
			await git(repo.dir, "update-ref", ref, merge);
			const result = await pruneCheckpointRefs(repo.dir, { now });
			expect(result).toMatchObject({ completed: 0, unknown: 1, deleted: 0 });
			expect(await git(repo.dir, "rev-parse", ref)).toBe(merge);
		});

		it("cross-checks a recorded session entry before deleting", async () => {
			const repo = await makeRepo();
			await commitAll(repo.dir);
			const { ref, result } = await seedCompletedRef(repo.dir, "busy/run-old", "2026-09-01T00:00:00Z");

			// The current session says this ref belongs to a run whose result was a different
			// commit, so the listing is not enough to claim ownership of the ref.
			const mismatched = new Map([
				[ref, { ref, baselineCommit: "0".repeat(40), resultCommit: "1".repeat(40) }],
			]);
			const guarded = await pruneCheckpointRefs(repo.dir, { now, recorded: mismatched });
			expect(guarded).toMatchObject({ completed: 0, deleted: 0 });
			expect(await git(repo.dir, "rev-parse", ref)).toBe(result);

			const matching = new Map([[
				ref,
				{ ref, baselineCommit: await git(repo.dir, "rev-parse", `${result}^`), resultCommit: result },
			]]);
			const pruned = await pruneCheckpointRefs(repo.dir, { now, recorded: matching });
			expect(pruned).toMatchObject({ completed: 1, deleted: 1 });
			await expect(git(repo.dir, "rev-parse", ref)).rejects.toThrow();
		});

		it("lets an in-flight run capture its result after a concurrent sweep", async () => {
			const repo = await makeRepo();
			await commitAll(repo.dir);
			const store = new CheckpointStore(createGitRunner());
			const ref = checkpointRef("session-in-flight", "run-1");
			const baseline = await store.captureBaseline(repo.dir, ref);
			expect(baseline).not.toBeNull();

			// A sweep far past the retention window would delete this ref if baseline-only refs
			// were candidates.
			const committedSeconds = Number(await git(repo.dir, "log", "-1", "--format=%ct", baseline!.commit));
			const swept = await pruneCheckpointRefs(repo.dir, {
				now: () => new Date((committedSeconds + 400 * day) * 1000),
			});
			expect(swept).toMatchObject({ completed: 0, baselineOnly: 1, deleted: 0 });

			const result = await store.captureResult(baseline!);
			expect(result.commit).not.toBe(baseline!.commit);
			expect(await git(repo.dir, "rev-parse", ref)).toBe(result.commit);
		});
	});

	describe("dry run", () => {
		it("reports the same plan without touching refs or their objects", async () => {
			const repo = await makeRepo();
			await commitAll(repo.dir);
			await seedCompletedRef(repo.dir, "busy/run-fresh", "2026-11-20T00:00:00Z");
			await seedCompletedRef(repo.dir, "busy/run-stale-a", "2026-09-01T00:00:00Z");
			await seedCompletedRef(repo.dir, "busy/run-stale-b", "2026-09-02T00:00:00Z");
			const before = await git(repo.dir, "for-each-ref", "--format=%(objectname) %(refname)", "refs/pi/checkpoint");

			const dryRun = await pruneCheckpointRefs(repo.dir, { now, dryRun: true });
			expect(dryRun).toMatchObject({
				dryRun: true,
				completed: 3,
				expired: 2,
				overflow: 0,
				selected: 2,
				deleted: 0,
				kept: 1,
			});
			const after = await git(repo.dir, "for-each-ref", "--format=%(objectname) %(refname)", "refs/pi/checkpoint");
			expect(after).toBe(before);

			// The identical plan, executed, deletes exactly what the dry run projected.
			const applied = await pruneCheckpointRefs(repo.dir, { now });
			expect(applied).toMatchObject({ selected: 2, deleted: 2, kept: 1 });
			expect(await git(repo.dir, "for-each-ref", "refs/pi/checkpoint")).toContain("busy/run-fresh");
		});

		it("reports a dry run without invoking update-ref", async () => {
			const repo = await makeRepo();
			await commitAll(repo.dir);
			await seedCompletedRef(repo.dir, "busy/run-old", "2026-09-01T00:00:00Z");
			const calls: string[][] = [];
			const runGit: RunGit = async (args, options) => {
				calls.push(args);
				return createGitRunner()(args, options);
			};
			await pruneCheckpointRefs(repo.dir, { now, dryRun: true, runGit });
			expect(calls.some((args) => args.includes("update-ref"))).toBe(false);
		});
	});

	describe("git protocol", () => {
		it("succeeds when the delete set contains already missing refs", async () => {
			const repo = await makeRepo();
			await commitAll(repo.dir);
			await seedCompletedRef(repo.dir, "busy/run-a", "2026-09-01T00:00:00Z");
			await seedCompletedRef(repo.dir, "busy/run-b", "2026-09-02T00:00:00Z");
			const realRunner = createGitRunner();
			const runGit: RunGit = async (args, options) => {
				if (args.includes("update-ref")) await git(repo.dir, "update-ref", "-d", "refs/pi/checkpoint/busy/run-a");
				return realRunner(args, options);
			};
			const result = await pruneCheckpointRefs(repo.dir, { now, runGit });
			// The ref that vanished behind our back is not ours to count; the retry deletes the other one.
			expect(result).toMatchObject({ deleted: 1, kept: 0 });
			await expect(git(repo.dir, "rev-parse", "refs/pi/checkpoint/busy/run-b")).rejects.toThrow();
		});

		it("prunes the shared repository from a linked worktree", async () => {
			const repo = await makeRepo();
			await commitAll(repo.dir);
			const linked = join(repo.dir, "linked");
			await git(repo.dir, "worktree", "add", "-q", linked, "HEAD");
			await seedCompletedRef(repo.dir, "busy/run-old", "2026-09-01T00:00:00Z");
			await pruneCheckpointRefs(linked, { now });
			await expect(git(repo.dir, "rev-parse", "refs/pi/checkpoint/busy/run-old")).rejects.toThrow();
		});

		it("returns null outside a git worktree", async () => {
			const plain = await makeTempDir();
			expect(await pruneCheckpointRefs(plain)).toBeNull();
		});

		it("deletes in exactly one conditional batched call", async () => {
			const repo = await makeRepo();
			await commitAll(repo.dir);
			const first = await seedCompletedRef(repo.dir, "busy/run-first", "2026-09-01T00:00:00Z");
			const second = await seedCompletedRef(repo.dir, "busy/run-second", "2026-09-02T00:00:00Z");
			const calls: { args: string[]; stdin?: string }[] = [];
			const runGit: RunGit = async (args, options) => {
				calls.push({ args, stdin: options.stdin });
				return createGitRunner()(args, options);
			};
			await pruneCheckpointRefs(repo.dir, { now, runGit });
			const deletions = calls.filter((call) => call.args.includes("update-ref"));
			expect(deletions).toHaveLength(1);
			expect(deletions[0]?.args).toContain("--stdin");
			expect(deletions[0]?.stdin?.trim().split("\n")).toEqual([
				`delete ${first.ref} ${first.result}`,
				`delete ${second.ref} ${second.result}`,
			]);
		});

		it("refuses to delete when the ref listing was truncated", async () => {
			const repo = await makeRepo();
			await commitAll(repo.dir);
			const stale = await seedCompletedRef(repo.dir, "busy/run-old", "2026-09-01T00:00:00Z");
			const line = listingLine(await commitDetails(repo.dir, stale.result, stale.ref));
			const calls: string[][] = [];
			const runGit: RunGit = async (args, options) => {
				calls.push(args);
				if (args[0] === "for-each-ref") {
					// Complete enough to select the ref, but not a trustworthy listing of the repository.
					return { stdout: line, stderr: "", code: 0, killed: false, truncated: true };
				}
				return createGitRunner()(args, options);
			};
			await expect(pruneCheckpointRefs(repo.dir, { now, runGit })).rejects.toThrow(
				"Checkpoint ref listing did not complete",
			);
			expect(calls.some((args) => args.includes("update-ref"))).toBe(false);
			expect(await git(repo.dir, "rev-parse", stale.ref)).toBe(stale.result);
			expect((await createRetentionSweeper({ now, runGit }).sweep(repo.dir)).status).toBe("failed");
			expect(await git(repo.dir, "rev-parse", stale.ref)).toBe(stale.result);
		});

		it("refuses to delete when the baseline lookup did not complete", async () => {
			const repo = await makeRepo();
			await commitAll(repo.dir);
			const stale = await seedCompletedRef(repo.dir, "busy/run-old", "2026-09-01T00:00:00Z");
			const calls: string[][] = [];
			const runGit: RunGit = async (args, options) => {
				calls.push(args);
				if (args[0] === "log") {
					return { stdout: "", stderr: "", code: 0, killed: false, truncated: true };
				}
				return createGitRunner()(args, options);
			};
			await expect(pruneCheckpointRefs(repo.dir, { now, runGit })).rejects.toThrow(
				"Checkpoint baseline lookup did not complete",
			);
			expect(calls.some((args) => args.includes("update-ref"))).toBe(false);
			expect(await git(repo.dir, "rev-parse", stale.ref)).toBe(stale.result);
		});

		it("refuses a baseline lookup whose record framing is ambiguous", async () => {
			const repo = await makeRepo();
			await commitAll(repo.dir);
			const stale = await seedCompletedRef(repo.dir, "busy/run-old", "2026-09-01T00:00:00Z");
			const runGit: RunGit = async (args, options) => {
				if (args[0] === "log") {
					// A subject can contain the field separator; the prefix would otherwise look like a
					// matching baseline subject.
					return {
						stdout: `${stale.baseline}\x1fpi-checkpoint baseline ref=${stale.ref}\x1fjunk\n`,
						stderr: "",
						code: 0,
						killed: false,
						truncated: false,
					};
				}
				return createGitRunner()(args, options);
			};
			await expect(pruneCheckpointRefs(repo.dir, { now, runGit })).rejects.toThrow(
				"Checkpoint baseline lookup did not complete",
			);
			expect(await git(repo.dir, "rev-parse", stale.ref)).toBe(stale.result);
		});

		it("keeps a ref whose commit changed between the listing and the delete", async () => {
			const repo = await makeRepo();
			await commitAll(repo.dir);
			await seedCompletedRef(repo.dir, "busy/run-new", "2026-11-20T00:00:00Z");
			const stale = await seedCompletedRef(repo.dir, "busy/run-old", "2026-09-01T00:00:00Z");
			const realRunner = createGitRunner();
			let intercepted = false;
			const runGit: RunGit = async (args, options) => {
				if (!args.includes("update-ref") || intercepted) return realRunner(args, options);
				intercepted = true;
				// The old ref gets a fresh result right before our transaction lands.
				const freshBaseline = await createCheckpointCommit(repo.dir, {
					ref: stale.ref,
					kind: "baseline",
					date: "2026-11-20T00:00:00Z",
				});
				const freshResult = await createCheckpointCommit(repo.dir, {
					ref: stale.ref,
					kind: "result",
					date: "2026-11-20T00:00:00Z",
					parent: freshBaseline,
				});
				await git(repo.dir, "update-ref", stale.ref, freshResult);
				return realRunner(args, options);
			};
			const outcome = await createRetentionSweeper({ now, runGit }).sweep(repo.dir);
			expect(outcome).toEqual({ status: "pruned", deleted: 0, kept: 2 });
			expect(await git(repo.dir, "rev-parse", stale.ref)).not.toBe(stale.result);
		});

		it("does not run the repository's reference-transaction hook", async () => {
			const repo = await makeRepo();
			await commitAll(repo.dir);
			await seedCompletedRef(repo.dir, "busy/run-old", "2026-09-01T00:00:00Z");
			const marker = join(repo.dir, "hook-fired.txt");
			const hookPath = join(repo.dir, ".git", "hooks", "reference-transaction");
			await mkdir(dirname(hookPath), { recursive: true });
			await writeFile(hookPath, `#!/bin/sh\necho "$1" >> "${marker.replaceAll("\\", "/")}"\n`);
			await chmod(hookPath, 0o755);
			// Positive control: the hook is wired up and does run for an ordinary update-ref.
			const head = await git(repo.dir, "rev-parse", "HEAD");
			await git(repo.dir, "update-ref", "refs/pi/checkpoint/busy/control", head);
			expect(await readFile(marker, "utf8")).toContain("committed");
			await rm(marker);
			await pruneCheckpointRefs(repo.dir, { now });
			await expect(readFile(marker, "utf8")).rejects.toThrow();
		});

		it("never deletes what a symbolic checkpoint ref points at", async () => {
			const repo = await makeRepo();
			await commitAll(repo.dir);
			const stale = await seedCompletedRef(repo.dir, "busy/run-old", "2026-09-01T00:00:00Z");
			await git(repo.dir, "update-ref", "refs/heads/victim", stale.result);
			await git(repo.dir, "symbolic-ref", "refs/pi/checkpoint/busy/run-symref", "refs/heads/victim");
			const calls: string[][] = [];
			const runGit: RunGit = async (args, options) => {
				calls.push(args);
				return createGitRunner()(args, options);
			};
			// for-each-ref reports the target's object and date for a symbolic ref, so without the shape
			// guard this ref would be selected and its target branch deleted.
			const result = await pruneCheckpointRefs(repo.dir, { now, runGit });
			expect(result).toMatchObject({ deleted: 1, kept: 0 });
			expect(await git(repo.dir, "rev-parse", "refs/heads/victim")).toBe(stale.result);
			expect(await git(repo.dir, "symbolic-ref", "refs/pi/checkpoint/busy/run-symref")).toBe("refs/heads/victim");
			expect(calls.find((args) => args.includes("update-ref"))).toContain("--no-deref");
		});

		it("reports failure when the retried delete also fails", async () => {
			const repo = await makeRepo();
			await commitAll(repo.dir);
			const stale = await seedCompletedRef(repo.dir, "busy/run-old", "2026-09-01T00:00:00Z");
			let deletions = 0;
			const runGit: RunGit = async (args, options) => {
				if (!args.includes("update-ref")) return createGitRunner()(args, options);
				deletions += 1;
				return { stdout: "", stderr: "cannot lock ref", code: 1, killed: false, truncated: false };
			};
			const outcome = await createRetentionSweeper({ now, runGit }).sweep(repo.dir);
			expect(outcome.status).toBe("failed");
			expect(deletions).toBe(2);
			expect(await git(repo.dir, "rev-parse", stale.ref)).toBe(stale.result);
		});
	});

	describe("sweeper", () => {
		it("sweeps a repository once per process unless forced", async () => {
			const repo = await makeRepo();
			await commitAll(repo.dir);
			await seedCompletedRef(repo.dir, "busy/run-old", "2026-09-01T00:00:00Z");
			const sweeper = createRetentionSweeper({ now });
			expect(await sweeper.sweep(repo.dir)).toEqual({ status: "pruned", deleted: 1, kept: 0 });
			expect(await sweeper.sweep(repo.dir)).toEqual({ status: "skipped", reason: "already-swept" });
			expect((await sweeper.sweep(repo.dir, { force: true })).status).toBe("pruned");
		});

		it("reports not-a-worktree outside a repository", async () => {
			const plain = await makeTempDir();
			expect(await createRetentionSweeper().sweep(plain)).toEqual({ status: "skipped", reason: "not-a-worktree" });
		});

		it("reports git failures instead of throwing", async () => {
			const repo = await makeRepo();
			const failing = createRetentionSweeper({
				runGit: async (args, options) => {
					if (args[0] === "for-each-ref") throw new Error("boom\nsecond line");
					return createGitRunner()(args, options);
				},
			});
			expect(await failing.sweep(repo.dir)).toEqual({ status: "failed", error: "boom second line" });
		});

		it("reports an aborted run as failed without throwing", async () => {
			const repo = await makeRepo();
			const aborted = createRetentionSweeper({
				timeoutMs: 1,
				runGit: async (args, options) => {
					if (args[0] !== "for-each-ref") return createGitRunner()(args, options);
					await new Promise((resolve) => setTimeout(resolve, 20));
					return { stdout: "", stderr: "", code: null, killed: true, truncated: false };
				},
			});
			const outcome = await aborted.sweep(repo.dir);
			expect(outcome.status).toBe("failed");
		});

		it("bounds the repository-context resolve by the sweep timeout", async () => {
			const repo = await makeRepo();
			const sweeper = createRetentionSweeper({
				timeoutMs: 10,
				runGit: async (args, options) => {
					// Hangs on the very first resolve call (checkpoint-store.ts) and ignores the signal.
					if (args[0] === "rev-parse") return new Promise(() => {});
					return createGitRunner()(args, options);
				},
			});
			expect(await sweeper.sweep(repo.dir)).toEqual({ status: "failed", error: "Retention sweep timed out after 10ms" });
		});

		it("does not run update-ref when nothing is stale", async () => {
			const repo = await makeRepo();
			await commitAll(repo.dir);
			await seedCompletedRef(repo.dir, "busy/run-new", "2026-11-20T00:00:00Z");
			const calls: string[][] = [];
			const runGit: RunGit = async (args, options) => {
				calls.push(args);
				return createGitRunner()(args, options);
			};
			expect(await pruneCheckpointRefs(repo.dir, { now, runGit })).toMatchObject({ deleted: 0, kept: 1 });
			expect(calls.some((args) => args.includes("update-ref"))).toBe(false);
		});

		it("bounds the delete transaction by the sweep timeout", async () => {
			const repo = await makeRepo();
			await commitAll(repo.dir);
			const stale = await seedCompletedRef(repo.dir, "busy/run-old", "2026-09-01T00:00:00Z");
			const line = listingLine(await commitDetails(repo.dir, stale.result, stale.ref));
			let listings = 0;
			const sweeper = createRetentionSweeper({
				timeoutMs: 20,
				// Only the repository resolve runs for real: a listing or a delete that outlives the
				// timeout would leave a git child holding the fixture during teardown on Windows.
				runGit: async (args, options) => {
					if (args[0] === "for-each-ref") {
						const first = listings++ === 0;
						return { stdout: first ? line : "", stderr: "", code: first ? 0 : null, killed: !first, truncated: false };
					}
					if (args[0] === "log") {
						return {
							stdout: `${stale.baseline}\x1fpi-checkpoint baseline ref=${stale.ref}\n`,
							stderr: "",
							code: 0,
							killed: false,
							truncated: false,
						};
					}
					if (args.includes("update-ref")) {
						await new Promise((resolve) => setTimeout(resolve, 60));
						return { stdout: "", stderr: "", code: null, killed: true, truncated: false };
					}
					return createGitRunner()(args, options);
				},
			});
			expect((await sweeper.sweep(repo.dir)).status).toBe("failed");
		});
	});
});
