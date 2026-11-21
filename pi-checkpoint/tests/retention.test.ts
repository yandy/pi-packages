import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitRunner, type RunGit } from "../src/git.js";
import { isCheckpointRefName, pruneCheckpointRefs, selectRefsToDelete } from "../src/retention.js";
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
		expect(result).toEqual({ deleted: 2, kept: 0 });
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
