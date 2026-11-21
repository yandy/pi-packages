import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitRunner, type RunGit } from "../src/git.js";
import {
	createRetentionSweeper,
	isCheckpointRefName,
	pruneCheckpointRefs,
	selectRefsToDelete,
} from "../src/retention.js";
import { commitAll, createTestRepo, git, gitWithEnv } from "./helpers/git-repo.js";

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
		const repo = await createTestRepo();
		const head = await commitAll(repo.dir);
		await seedRef(repo.dir, head, "busy/run-new", "2026-11-20T00:00:00Z");
		await seedRef(repo.dir, head, "busy/run-old", "2026-09-01T00:00:00Z");
		const result = await pruneCheckpointRefs(repo.dir, { now: () => new Date("2026-11-21T00:00:00Z") });
		expect(result).toEqual({ deleted: 1, kept: 1 });
		expect(await git(repo.dir, "for-each-ref", "refs/pi/checkpoint")).toContain("busy/run-new");
		expect(await git(repo.dir, "for-each-ref", "refs/pi/checkpoint")).not.toContain("busy/run-old");
		await repo.cleanup();
	});

	it("leaves foreign and malformed refs untouched", async () => {
		const repo = await createTestRepo();
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
		await repo.cleanup();
	});

	it("succeeds when the delete set contains already missing refs", async () => {
		const repo = await createTestRepo();
		const head = await commitAll(repo.dir);
		await seedRef(repo.dir, head, "busy/run-a", "2026-09-01T00:00:00Z");
		await seedRef(repo.dir, head, "busy/run-b", "2026-09-02T00:00:00Z");
		const realRunner = createGitRunner();
		const runGit: RunGit = async (args, options) => {
			if (args[0] === "update-ref") await git(repo.dir, "update-ref", "-d", "refs/pi/checkpoint/busy/run-a");
			return realRunner(args, options);
		};
		const result = await pruneCheckpointRefs(repo.dir, { now: () => new Date("2026-11-21T00:00:00Z"), runGit });
		// The ref that vanished behind our back is not ours to count; the retry deletes the other one.
		expect(result).toEqual({ deleted: 1, kept: 0 });
		await expect(git(repo.dir, "rev-parse", "refs/pi/checkpoint/busy/run-b")).rejects.toThrow();
		await repo.cleanup();
	});

	it("prunes the shared repository from a linked worktree", async () => {
		const repo = await createTestRepo();
		const head = await commitAll(repo.dir);
		const linked = join(repo.dir, "linked");
		await git(repo.dir, "worktree", "add", "-q", linked, "HEAD");
		await seedRef(repo.dir, head, "busy/run-old", "2026-09-01T00:00:00Z");
		await pruneCheckpointRefs(linked, { now: () => new Date("2026-11-21T00:00:00Z") });
		await expect(git(repo.dir, "rev-parse", "refs/pi/checkpoint/busy/run-old")).rejects.toThrow();
		await git(repo.dir, "worktree", "remove", "--force", linked);
		await repo.cleanup();
	});

	it("returns null outside a git worktree", async () => {
		const plain = await mkdtemp(join(tmpdir(), "pi-checkpoint-plain-"));
		expect(await pruneCheckpointRefs(plain)).toBeNull();
		await rm(plain, { recursive: true, force: true });
	});

	it("deletes in exactly one conditional batched call", async () => {
		const repo = await createTestRepo();
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
		const deletions = calls.filter((call) => call.args[0] === "update-ref");
		expect(deletions).toHaveLength(1);
		expect(deletions[0]?.args).toContain("--stdin");
		expect(deletions[0]?.stdin?.trim().split("\n")).toEqual([
			`delete refs/pi/checkpoint/busy/run-old ${oldOid}`,
			`delete refs/pi/checkpoint/busy/run-older ${olderOid}`,
		]);
		await repo.cleanup();
	});

	it("refuses to delete when the ref listing was truncated", async () => {
		const repo = await createTestRepo();
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
		expect(calls.some((args) => args[0] === "update-ref")).toBe(false);
		expect(await git(repo.dir, "rev-parse", "refs/pi/checkpoint/busy/run-old")).toBe(staleOid);
		expect((await createRetentionSweeper({ now: nowFn, runGit }).sweep(repo.dir)).status).toBe("failed");
		expect(await git(repo.dir, "rev-parse", "refs/pi/checkpoint/busy/run-old")).toBe(staleOid);
		await repo.cleanup();
	});

	it("keeps a ref whose commit changed between the listing and the delete", async () => {
		const repo = await createTestRepo();
		const head = await commitAll(repo.dir);
		await seedRef(repo.dir, head, "busy/run-old", "2026-09-01T00:00:00Z");
		await seedRef(repo.dir, head, "busy/run-new", "2026-11-20T00:00:00Z");
		const freshOid = await git(repo.dir, "rev-parse", "refs/pi/checkpoint/busy/run-new");
		const realRunner = createGitRunner();
		let intercepted = false;
		const runGit: RunGit = async (args, options) => {
			if (args[0] !== "update-ref" || intercepted) return realRunner(args, options);
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
		await repo.cleanup();
	});

	it("sweeps a repository once per process unless forced", async () => {
		const repo = await createTestRepo();
		const head = await commitAll(repo.dir);
		await seedRef(repo.dir, head, "busy/run-old", "2026-09-01T00:00:00Z");
		const sweeper = createRetentionSweeper({ now: () => new Date("2026-11-21T00:00:00Z") });
		expect(await sweeper.sweep(repo.dir)).toEqual({ status: "pruned", deleted: 1, kept: 0 });
		expect(await sweeper.sweep(repo.dir)).toEqual({ status: "skipped", reason: "already-swept" });
		expect((await sweeper.sweep(repo.dir, { force: true })).status).toBe("pruned");
		await repo.cleanup();
	});

	it("reports not-a-worktree outside a repository", async () => {
		const plain = await mkdtemp(join(tmpdir(), "pi-checkpoint-plain-"));
		expect(await createRetentionSweeper().sweep(plain)).toEqual({ status: "skipped", reason: "not-a-worktree" });
		await rm(plain, { recursive: true, force: true });
	});

	it("reports git failures instead of throwing", async () => {
		const repo = await createTestRepo();
		const failing = createRetentionSweeper({
			runGit: async (args, options) => {
				if (args[0] === "for-each-ref") throw new Error("boom\nsecond line");
				return createGitRunner()(args, options);
			},
		});
		expect(await failing.sweep(repo.dir)).toEqual({ status: "failed", error: "boom second line" });
		await repo.cleanup();
	});

	it("reports an aborted run as failed without throwing", async () => {
		const repo = await createTestRepo();
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
		await repo.cleanup();
	});

	it("bounds the repository-context resolve by the sweep timeout", async () => {
		const repo = await createTestRepo();
		const sweeper = createRetentionSweeper({
			timeoutMs: 10,
			runGit: async (args, options) => {
				// Hangs on the very first resolve call (checkpoint-store.ts:112) and ignores the signal.
				if (args[0] === "rev-parse") return new Promise(() => {});
				return createGitRunner()(args, options);
			},
		});
		expect(await sweeper.sweep(repo.dir)).toEqual({ status: "failed", error: "Retention sweep timed out after 10ms" });
		await repo.cleanup();
	});

	it("does not run update-ref when nothing is stale", async () => {
		const repo = await createTestRepo();
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
		expect(calls.some((args) => args[0] === "update-ref")).toBe(false);
		await repo.cleanup();
	});
});
