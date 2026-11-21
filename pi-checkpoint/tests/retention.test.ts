import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitRunner, type RunGit } from "../src/git.js";
import {
	createRetentionSweeper,
	isCheckpointRefName,
	pruneCheckpointRefs,
	selectRefsToDelete,
} from "../src/retention.js";
import { commitAll, createTestRepo, git, gitWithEnv, type TestRepo } from "./helpers/git-repo.js";

const day = 86_400;
const now = 1_800_000_000;

function record(name: string, daysAgo: number) {
	return { name: `refs/pi/checkpoint/${name}`, committedAtSeconds: now - daysAgo * day };
}

async function seedRef(dir: string, head: string, name: string, committerDate: string) {
	const tree = await git(dir, "rev-parse", `${head}^{tree}`);
	const commit = await gitWithEnv(
		dir,
		{ GIT_COMMITTER_DATE: committerDate, GIT_AUTHOR_DATE: committerDate },
		"commit-tree",
		tree,
		"-p",
		head,
		"-m",
		name,
	);
	await git(dir, "update-ref", `refs/pi/checkpoint/${name}`, commit);
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

	it("keeps refs inside both limits", () => {
		const records = [record("s1/run-a", 1), record("s1/run-b", 5)];
		expect(selectRefsToDelete(records, { nowSeconds: now, retentionDays: 30, maxRefs: 200 })).toEqual([]);
	});

	it("deletes refs older than the retention window", () => {
		const records = [record("s1/fresh", 3), record("s1/stale", 31)];
		expect(selectRefsToDelete(records, { nowSeconds: now, retentionDays: 30, maxRefs: 200 })).toEqual([
			"refs/pi/checkpoint/s1/stale",
		]);
	});

	it("keeps only the newest refs when the count limit binds", () => {
		const records = [record("s1/oldest", 4), record("s2/middle", 3), record("s3/newest", 1)];
		expect(selectRefsToDelete(records, { nowSeconds: now, retentionDays: 30, maxRefs: 2 })).toEqual([
			"refs/pi/checkpoint/s1/oldest",
		]);
	});

	it("selects globally by age instead of per session", () => {
		const records = [
			...Array.from({ length: 3 }, (_, index) => record(`busy/run-${index}`, index)),
			record("quiet/only-run", 20),
		];
		expect(selectRefsToDelete(records, { nowSeconds: now, retentionDays: 30, maxRefs: 2 })).toEqual([
			"refs/pi/checkpoint/busy/run-2",
			"refs/pi/checkpoint/quiet/only-run",
		]);
	});

	it("recognizes only two-segment checkpoint ref names", () => {
		expect(isCheckpointRefName("refs/pi/checkpoint/c2Vz/run-1")).toBe(true);
		expect(isCheckpointRefName("refs/pi/checkpoint/c2Vz")).toBe(false);
		expect(isCheckpointRefName("refs/pi/checkpoint/a/b/c")).toBe(false);
		expect(isCheckpointRefName("refs/pi/checkpoint/a/")).toBe(false);
		expect(isCheckpointRefName("refs/heads/main")).toBe(false);
	});

	it("keeps a ref exactly at each boundary", () => {
		const atWindow = [record("s/at-window", 30), record("s/over-window", 31)];
		expect(selectRefsToDelete(atWindow, { nowSeconds: now, retentionDays: 30, maxRefs: 200 })).toEqual([
			"refs/pi/checkpoint/s/over-window",
		]);
		const atQuota = [record("s/newest", 1), record("s/older", 2)];
		expect(selectRefsToDelete(atQuota, { nowSeconds: now, retentionDays: 30, maxRefs: 2 })).toEqual([]);
	});

	it("prunes stale refs and reports counts", async () => {
		const repo = await makeRepo();
		const head = await commitAll(repo.dir);
		await seedRef(repo.dir, head, "busy/run-new", "2026-11-20T00:00:00Z");
		await seedRef(repo.dir, head, "busy/run-old", "2026-09-01T00:00:00Z");
		const result = await pruneCheckpointRefs(repo.dir, { now: () => new Date("2026-11-21T00:00:00Z") });
		expect(result).toEqual({ deleted: 1, kept: 1 });
		expect(await git(repo.dir, "for-each-ref", "refs/pi/checkpoint")).toContain("busy/run-new");
		expect(await git(repo.dir, "for-each-ref", "refs/pi/checkpoint")).not.toContain("busy/run-old");
	});

	it("leaves foreign and malformed refs untouched", async () => {
		const repo = await makeRepo();
		const head = await commitAll(repo.dir);
		await seedRef(repo.dir, head, "busy/run-old", "2026-09-01T00:00:00Z");
		await git(repo.dir, "update-ref", "refs/pi/checkpoint/lonely", head);
		await git(repo.dir, "update-ref", "refs/pi/checkpoint/a/b/c", head);
		await git(repo.dir, "update-ref", "refs/tags/keep", head);
		await pruneCheckpointRefs(repo.dir, { now: () => new Date("2026-11-21T00:00:00Z") });
		expect(await git(repo.dir, "rev-parse", "refs/pi/checkpoint/lonely")).toBe(head);
		expect(await git(repo.dir, "rev-parse", "refs/pi/checkpoint/a/b/c")).toBe(head);
		expect(await git(repo.dir, "rev-parse", "refs/tags/keep")).toBe(head);
		await expect(git(repo.dir, "rev-parse", "refs/pi/checkpoint/busy/run-old")).rejects.toThrow();
	});

	it("succeeds when the delete set contains already missing refs", async () => {
		const repo = await makeRepo();
		const head = await commitAll(repo.dir);
		await seedRef(repo.dir, head, "busy/run-a", "2026-09-01T00:00:00Z");
		await seedRef(repo.dir, head, "busy/run-b", "2026-09-02T00:00:00Z");
		const realRunner = createGitRunner();
		const runGit: RunGit = async (args, options) => {
			if (args.includes("update-ref")) await git(repo.dir, "update-ref", "-d", "refs/pi/checkpoint/busy/run-a");
			return realRunner(args, options);
		};
		const result = await pruneCheckpointRefs(repo.dir, { now: () => new Date("2026-11-21T00:00:00Z"), runGit });
		// The ref that vanished behind our back is not ours to count; the retry deletes the other one.
		expect(result).toEqual({ deleted: 1, kept: 0 });
		await expect(git(repo.dir, "rev-parse", "refs/pi/checkpoint/busy/run-b")).rejects.toThrow();
	});

	it("prunes the shared repository from a linked worktree", async () => {
		const repo = await makeRepo();
		const head = await commitAll(repo.dir);
		const linked = join(repo.dir, "linked");
		await git(repo.dir, "worktree", "add", "-q", linked, "HEAD");
		await seedRef(repo.dir, head, "busy/run-old", "2026-09-01T00:00:00Z");
		await pruneCheckpointRefs(linked, { now: () => new Date("2026-11-21T00:00:00Z") });
		await expect(git(repo.dir, "rev-parse", "refs/pi/checkpoint/busy/run-old")).rejects.toThrow();
	});

	it("returns null outside a git worktree", async () => {
		const plain = await makeTempDir();
		expect(await pruneCheckpointRefs(plain)).toBeNull();
	});

	it("deletes in exactly one conditional batched call", async () => {
		const repo = await makeRepo();
		const head = await commitAll(repo.dir);
		await seedRef(repo.dir, head, "busy/run-old", "2026-09-01T00:00:00Z");
		await seedRef(repo.dir, head, "busy/run-older", "2026-09-02T00:00:00Z");
		const oldOid = await git(repo.dir, "rev-parse", "refs/pi/checkpoint/busy/run-old");
		const olderOid = await git(repo.dir, "rev-parse", "refs/pi/checkpoint/busy/run-older");
		const calls: { args: string[]; stdin?: string }[] = [];
		const runGit: RunGit = async (args, options) => {
			calls.push({ args, stdin: options.stdin });
			return createGitRunner()(args, options);
		};
		await pruneCheckpointRefs(repo.dir, { now: () => new Date("2026-11-21T00:00:00Z"), runGit });
		const deletions = calls.filter((call) => call.args.includes("update-ref"));
		expect(deletions).toHaveLength(1);
		expect(deletions[0]?.args).toContain("--stdin");
		expect(deletions[0]?.stdin?.trim().split("\n")).toEqual([
			`delete refs/pi/checkpoint/busy/run-old ${oldOid}`,
			`delete refs/pi/checkpoint/busy/run-older ${olderOid}`,
		]);
	});

	it("refuses to delete when the ref listing was truncated", async () => {
		const repo = await makeRepo();
		const head = await commitAll(repo.dir);
		await seedRef(repo.dir, head, "busy/run-old", "2026-09-01T00:00:00Z");
		const staleOid = await git(repo.dir, "rev-parse", "refs/pi/checkpoint/busy/run-old");
		const calls: string[][] = [];
		const runGit: RunGit = async (args, options) => {
			calls.push(args);
			if (args[0] === "for-each-ref") {
				// Complete enough to select the ref, but not a trustworthy listing of the repository.
				return {
					stdout: `${Math.floor(Date.parse("2026-09-01T00:00:00Z") / 1000)} ${staleOid} refs/pi/checkpoint/busy/run-old\n`,
					stderr: "",
					code: 0,
					killed: false,
					truncated: true,
				};
			}
			return createGitRunner()(args, options);
		};
		const nowFn = () => new Date("2026-11-21T00:00:00Z");
		await expect(pruneCheckpointRefs(repo.dir, { now: nowFn, runGit })).rejects.toThrow(
			"Checkpoint ref listing did not complete",
		);
		expect(calls.some((args) => args.includes("update-ref"))).toBe(false);
		expect(await git(repo.dir, "rev-parse", "refs/pi/checkpoint/busy/run-old")).toBe(staleOid);
		expect((await createRetentionSweeper({ now: nowFn, runGit }).sweep(repo.dir)).status).toBe("failed");
		expect(await git(repo.dir, "rev-parse", "refs/pi/checkpoint/busy/run-old")).toBe(staleOid);
	});

	it("keeps a ref whose commit changed between the listing and the delete", async () => {
		const repo = await makeRepo();
		const head = await commitAll(repo.dir);
		await seedRef(repo.dir, head, "busy/run-old", "2026-09-01T00:00:00Z");
		await seedRef(repo.dir, head, "busy/run-new", "2026-11-20T00:00:00Z");
		const freshOid = await git(repo.dir, "rev-parse", "refs/pi/checkpoint/busy/run-new");
		const realRunner = createGitRunner();
		let intercepted = false;
		const runGit: RunGit = async (args, options) => {
			if (!args.includes("update-ref") || intercepted) return realRunner(args, options);
			intercepted = true;
			// A run's baseline ref gets its fresh result right before our transaction lands.
			await git(repo.dir, "update-ref", "refs/pi/checkpoint/busy/run-old", freshOid);
			return realRunner(args, options);
		};
		const outcome = await createRetentionSweeper({
			now: () => new Date("2026-11-21T00:00:00Z"),
			runGit,
		}).sweep(repo.dir);
		expect(outcome).toEqual({ status: "pruned", deleted: 0, kept: 2 });
		expect(await git(repo.dir, "rev-parse", "refs/pi/checkpoint/busy/run-old")).toBe(freshOid);
	});

	it("sweeps a repository once per process unless forced", async () => {
		const repo = await makeRepo();
		const head = await commitAll(repo.dir);
		await seedRef(repo.dir, head, "busy/run-old", "2026-09-01T00:00:00Z");
		const sweeper = createRetentionSweeper({ now: () => new Date("2026-11-21T00:00:00Z") });
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
				// Hangs on the very first resolve call (checkpoint-store.ts:112) and ignores the signal.
				if (args[0] === "rev-parse") return new Promise(() => {});
				return createGitRunner()(args, options);
			},
		});
		expect(await sweeper.sweep(repo.dir)).toEqual({ status: "failed", error: "Retention sweep timed out after 10ms" });
	});

	it("does not run update-ref when nothing is stale", async () => {
		const repo = await makeRepo();
		const head = await commitAll(repo.dir);
		await seedRef(repo.dir, head, "busy/run-new", "2026-11-20T00:00:00Z");
		const calls: string[][] = [];
		const runGit: RunGit = async (args, options) => {
			calls.push(args);
			return createGitRunner()(args, options);
		};
		expect(await pruneCheckpointRefs(repo.dir, { now: () => new Date("2026-11-21T00:00:00Z"), runGit })).toEqual({
			deleted: 0,
			kept: 1,
		});
		expect(calls.some((args) => args.includes("update-ref"))).toBe(false);
	});
	it("never deletes what a symbolic checkpoint ref points at", async () => {
		const repo = await makeRepo();
		const head = await commitAll(repo.dir);
		await seedRef(repo.dir, head, "busy/run-old", "2026-09-01T00:00:00Z");
		const stale = await git(repo.dir, "rev-parse", "refs/pi/checkpoint/busy/run-old");
		await git(repo.dir, "update-ref", "refs/heads/victim", stale);
		await git(repo.dir, "symbolic-ref", "refs/pi/checkpoint/busy/run-symref", "refs/heads/victim");
		const calls: string[][] = [];
		const runGit: RunGit = async (args, options) => {
			calls.push(args);
			return createGitRunner()(args, options);
		};
		// for-each-ref reports the target's object and date for a symbolic ref, so without the shape
		// guard this ref would be selected and its target branch deleted.
		const result = await pruneCheckpointRefs(repo.dir, { now: () => new Date("2026-11-21T00:00:00Z"), runGit });
		expect(result).toEqual({ deleted: 1, kept: 0 });
		expect(await git(repo.dir, "rev-parse", "refs/heads/victim")).toBe(stale);
		expect(await git(repo.dir, "symbolic-ref", "refs/pi/checkpoint/busy/run-symref")).toBe("refs/heads/victim");
		expect(calls.find((args) => args.includes("update-ref"))).toContain("--no-deref");
	});

	it("does not run the repository's reference-transaction hook", async () => {
		const repo = await makeRepo();
		const head = await commitAll(repo.dir);
		await seedRef(repo.dir, head, "busy/run-old", "2026-09-01T00:00:00Z");
		const marker = join(repo.dir, "hook-fired.txt");
		const hookPath = join(repo.dir, ".git", "hooks", "reference-transaction");
		await mkdir(dirname(hookPath), { recursive: true });
		await writeFile(hookPath, `#!/bin/sh\necho "$1" >> "${marker.replaceAll("\\", "/")}"\n`);
		await chmod(hookPath, 0o755);
		// Positive control: the hook is wired up and does run for an ordinary update-ref.
		await git(repo.dir, "update-ref", "refs/pi/checkpoint/busy/control", head);
		expect(await readFile(marker, "utf8")).toContain("committed");
		await rm(marker);
		await pruneCheckpointRefs(repo.dir, { now: () => new Date("2026-11-21T00:00:00Z") });
		await expect(readFile(marker, "utf8")).rejects.toThrow();
	});

	it("reports failure when the retried delete also fails", async () => {
		const repo = await makeRepo();
		const head = await commitAll(repo.dir);
		await seedRef(repo.dir, head, "busy/run-old", "2026-09-01T00:00:00Z");
		let deletions = 0;
		const runGit: RunGit = async (args, options) => {
			if (!args.includes("update-ref")) return createGitRunner()(args, options);
			deletions += 1;
			return { stdout: "", stderr: "cannot lock ref", code: 1, killed: false, truncated: false };
		};
		const outcome = await createRetentionSweeper({
			now: () => new Date("2026-11-21T00:00:00Z"),
			runGit,
		}).sweep(repo.dir);
		expect(outcome.status).toBe("failed");
		expect(deletions).toBe(2);
		expect(await git(repo.dir, "rev-parse", "refs/pi/checkpoint/busy/run-old")).not.toBe("");
	});

	it("bounds the delete transaction by the sweep timeout", async () => {
		const repo = await makeRepo();
		const head = await commitAll(repo.dir);
		await seedRef(repo.dir, head, "busy/run-old", "2026-09-01T00:00:00Z");
		const staleOid = await git(repo.dir, "rev-parse", "refs/pi/checkpoint/busy/run-old");
		const staleSeconds = Math.floor(Date.parse("2026-09-01T00:00:00Z") / 1000);
		let listings = 0;
		const sweeper = createRetentionSweeper({
			timeoutMs: 20,
			// Only the repository resolve runs for real: a listing or a delete that outlives the
			// timeout would leave a git child holding the fixture during teardown on Windows.
			runGit: async (args, options) => {
				if (args[0] === "for-each-ref") {
					const first = listings++ === 0;
					return {
						stdout: first ? `${staleSeconds} ${staleOid} refs/pi/checkpoint/busy/run-old\n` : "",
						stderr: "",
						code: first ? 0 : null,
						killed: !first,
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
