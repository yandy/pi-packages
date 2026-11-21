import { chmod, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore, type Snapshot } from "../src/checkpoint-store.js";
import { createGitRunner, GitCommandError } from "../src/git.js";
import { checkpointRef } from "../src/refs.js";
import { commitAll, createTestRepo, git, readRepoFile, type TestRepo, writeRepoFile } from "./helpers/git-repo.js";

function required(snapshot: Snapshot | null): Snapshot {
	if (!snapshot) throw new Error("Expected a Git snapshot");
	return snapshot;
}

async function temporaryEntries(commonDir: string): Promise<string[]> {
	return (await readdir(commonDir)).filter((name) => name.startsWith("pi-checkpoint-"));
}

describe("checkpointRef", () => {
	it("uses a base64url session namespace without padding", () => {
		expect(checkpointRef("abc", "run-1")).toBe("refs/pi/checkpoint/YWJj/run-1");
		expect(checkpointRef("?", "run-2")).toBe("refs/pi/checkpoint/Pw/run-2");
	});
});

describe("CheckpointStore", () => {
	let store: CheckpointStore;
	let repos: TestRepo[];
	let tempDirs: string[];

	beforeEach(() => {
		store = new CheckpointStore();
		repos = [];
		tempDirs = [];
	});

	afterEach(async () => {
		await Promise.all([...repos].reverse().map((repo) => repo.cleanup()));
		await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
	});

	async function makeRepo(): Promise<TestRepo> {
		const repo = await createTestRepo();
		repos.push(repo);
		return repo;
	}

	it("captures dirty and untracked changes without touching HEAD, the real index, or worktree files", async () => {
		const repo = await makeRepo();
		await writeRepoFile(repo.dir, ".gitignore", "ignored.txt\n");
		await writeRepoFile(repo.dir, "tracked.txt", "base\n");
		await writeRepoFile(repo.dir, "staged.txt", "base\n");
		await writeRepoFile(repo.dir, "partial.txt", "one\ntwo\n");
		await writeRepoFile(repo.dir, "delete.txt", "delete\n");
		const headBefore = await commitAll(repo.dir, "initial");

		await writeRepoFile(repo.dir, "tracked.txt", "worktree change\n");
		await writeRepoFile(repo.dir, "staged.txt", "staged change\n");
		await git(repo.dir, "add", "staged.txt");
		await writeRepoFile(repo.dir, "partial.txt", "one\nstaged\n");
		await git(repo.dir, "add", "partial.txt");
		await writeRepoFile(repo.dir, "partial.txt", "one\nstaged\nworking\n");
		await rm(join(repo.dir, "delete.txt"));
		await writeRepoFile(repo.dir, "untracked.txt", "snapshot me\n");
		await writeRepoFile(repo.dir, "ignored.txt", "do not snapshot\n");
		await writeRepoFile(repo.dir, "dir/空 格.txt", "unicode and space\n");

		const branchBefore = await git(repo.dir, "branch", "--show-current");
		const cachedBefore = await git(repo.dir, "diff", "--cached", "--name-only");
		const indexPath = join(repo.dir, ".git", "index");
		const indexLockPath = join(repo.dir, ".git", "index.lock");
		await writeFile(indexLockPath, "user-owned index lock");
		const indexBefore = await readRepoFile(repo.dir, ".git/index");
		const indexLockBefore = await readRepoFile(repo.dir, ".git/index.lock");
		const ref = checkpointRef("session", "dirty-run");

		const baseline = required(await store.captureBaseline(repo.dir, ref));
		await writeRepoFile(repo.dir, "tracked.txt", "new content\n");
		const trackedPath = join(repo.dir, "tracked.txt");
		const untrackedPath = join(repo.dir, "untracked.txt");
		const mtimesBefore = [(await stat(trackedPath)).mtimeMs, (await stat(untrackedPath)).mtimeMs];
		const result = await store.captureResult(baseline);

		expect(baseline.head).toBe(headBefore);
		expect(result.head).toBe(headBefore);
		expect(await git(repo.dir, "rev-parse", "HEAD")).toBe(headBefore);
		expect(await git(repo.dir, "branch", "--show-current")).toBe(branchBefore);
		expect(await readRepoFile(repo.dir, ".git/index")).toEqual(indexBefore);
		expect(await readRepoFile(repo.dir, ".git/index.lock")).toEqual(indexLockBefore);
		expect(result.commit).not.toBe(baseline.commit);
		expect(await git(repo.dir, "rev-parse", `${result.commit}^1`)).toBe(baseline.commit);
		expect(await git(repo.dir, "rev-parse", `${baseline.commit}^1`)).toBe(headBefore);
		expect(await git(repo.dir, "diff", baseline.commit, result.commit)).toContain("new content");
		expect(await git(repo.dir, "show", `${result.commit}:untracked.txt`)).toContain("snapshot me");
		expect(await git(repo.dir, "show", `${result.commit}:dir/空 格.txt`)).toContain("unicode and space");
		expect(await git(repo.dir, "ls-tree", "-r", "--name-only", result.commit)).not.toContain("ignored.txt");
		expect(await git(repo.dir, "ls-tree", "-r", "--name-only", result.commit)).not.toContain("delete.txt");
		expect((await stat(trackedPath)).mtimeMs).toBe(mtimesBefore[0]);
		expect((await stat(untrackedPath)).mtimeMs).toBe(mtimesBefore[1]);
		expect(await readRepoFile(repo.dir, "tracked.txt")).toEqual(Buffer.from("new content\n"));
		expect(await temporaryEntries(baseline.commonDir)).toEqual([]);

		await rm(indexLockPath);
		expect(await git(repo.dir, "diff", "--cached", "--name-only")).toBe(cachedBefore);
	});

	it("creates distinct baseline and result commits for a no-change run", async () => {
		const repo = await makeRepo();
		await writeRepoFile(repo.dir, "file.txt", "same\n");
		await commitAll(repo.dir);
		const baseline = required(await store.captureBaseline(repo.dir, checkpointRef("session", "empty")));
		const result = await store.captureResult(baseline);

		expect(result.commit).not.toBe(baseline.commit);
		expect(result.tree).toBe(baseline.tree);
		expect(await git(repo.dir, "diff", baseline.commit, result.commit)).toBe("");
	});

	it("captures an unborn HEAD repository", async () => {
		const repo = await makeRepo();
		await writeRepoFile(repo.dir, "first.txt", "first\n");
		const baseline = required(await store.captureBaseline(repo.dir, checkpointRef("session", "unborn")));
		const result = await store.captureResult(baseline);

		expect(baseline.head).toBeNull();
		expect(result.head).toBeNull();
		expect(await git(repo.dir, "show", `${result.commit}:first.txt`)).toBe("first");
		expect(await git(repo.dir, "rev-parse", `${result.commit}^1`)).toBe(baseline.commit);
		await expect(git(repo.dir, "rev-parse", "--verify", "HEAD")).rejects.toThrow();
	});

	it("leaves a detached HEAD detached and unchanged", async () => {
		const repo = await makeRepo();
		await writeRepoFile(repo.dir, "file.txt", "one\n");
		await commitAll(repo.dir, "one");
		await writeRepoFile(repo.dir, "file.txt", "two\n");
		const headBefore = await commitAll(repo.dir, "two");
		await git(repo.dir, "checkout", "--detach", "HEAD");
		const baseline = required(await store.captureBaseline(repo.dir, checkpointRef("session", "detached")));
		const result = await store.captureResult(baseline);

		expect(result.head).toBe(headBefore);
		expect(await git(repo.dir, "rev-parse", "HEAD")).toBe(headBefore);
		expect(await git(repo.dir, "branch", "--show-current")).toBe("");
	});

	it("uses the common object directory from a linked worktree", async () => {
		const repo = await makeRepo();
		await writeRepoFile(repo.dir, "file.txt", "base\n");
		const mainHead = await commitAll(repo.dir);
		const parent = await mkdtemp(join(tmpdir(), "pi-checkpoint-linked-"));
		tempDirs.push(parent);
		const linkedDir = join(parent, "worktree");
		await git(repo.dir, "worktree", "add", "-b", "linked", linkedDir);
		let linkedRemoved = false;
		try {
			const baseline = required(await store.captureBaseline(linkedDir, checkpointRef("session", "linked")));
			await writeRepoFile(linkedDir, "file.txt", "linked change\n");
			const result = await store.captureResult(baseline);

			expect(baseline.worktreeRoot).toBe(await realpath(linkedDir));
			expect(baseline.commonDir).toBe(await realpath(join(repo.dir, ".git")));
			expect(result.commonDir).toBe(baseline.commonDir);
			expect(await git(repo.dir, "rev-parse", "HEAD")).toBe(mainHead);
			expect(await git(linkedDir, "branch", "--show-current")).toBe("linked");
			expect(await git(repo.dir, "show", `${result.commit}:file.txt`)).toBe("linked change");
			expect(await temporaryEntries(baseline.commonDir)).toEqual([]);
		} finally {
			await git(repo.dir, "worktree", "remove", "--force", linkedDir);
			linkedRemoved = true;
		}
		expect(linkedRemoved).toBe(true);
	});

	it("captures the whole worktree when invoked from a repository subdirectory", async () => {
		const repo = await makeRepo();
		await writeRepoFile(repo.dir, "root.txt", "base\n");
		await writeRepoFile(repo.dir, "nested/file.txt", "nested\n");
		await commitAll(repo.dir);
		const baseline = required(await store.captureBaseline(join(repo.dir, "nested"), checkpointRef("session", "subdir")));
		await writeRepoFile(repo.dir, "root.txt", "root change\n");
		const result = await store.captureResult(baseline);

		expect(baseline.worktreeRoot).toBe(await realpath(repo.dir));
		expect(await git(repo.dir, "show", `${result.commit}:root.txt`)).toBe("root change");
		expect(await git(repo.dir, "show", `${result.commit}:nested/file.txt`)).toBe("nested");
	});

	it.skipIf(process.platform === "win32")("captures executable mode changes", async () => {
		const repo = await makeRepo();
		await writeRepoFile(repo.dir, "run.sh", "#!/bin/sh\necho ok\n");
		await commitAll(repo.dir);
		const baseline = required(await store.captureBaseline(repo.dir, checkpointRef("session", "mode")));
		await chmod(join(repo.dir, "run.sh"), 0o755);
		const result = await store.captureResult(baseline);

		expect(await git(repo.dir, "ls-tree", result.commit, "--", "run.sh")).toMatch(/^100755 /);
	});

	it("publishes refs atomically and cleans temporary files after failures", async () => {
		const repo = await makeRepo();
		await writeRepoFile(repo.dir, "file.txt", "base\n");
		const head = await commitAll(repo.dir);
		const ref = checkpointRef("session", "atomic");
		const baseline = required(await store.captureBaseline(repo.dir, ref));

		await expect(store.captureBaseline(repo.dir, ref)).rejects.toBeInstanceOf(GitCommandError);
		await git(repo.dir, "update-ref", ref, head);
		await expect(store.captureResult(baseline)).rejects.toBeInstanceOf(GitCommandError);
		expect(await git(repo.dir, "rev-parse", ref)).toBe(head);
		expect(await temporaryEntries(baseline.commonDir)).toEqual([]);
	});

	it("cleans the temporary index when a Git stage fails", async () => {
		const repo = await makeRepo();
		await writeRepoFile(repo.dir, "file.txt", "base\n");
		await commitAll(repo.dir);
		const commonDir = await realpath(join(repo.dir, ".git"));
		const storeRunner = createGitRunner();
		const failingStore = new CheckpointStore(async (args, options) => {
			if (args.includes("write-tree")) throw new Error("injected write-tree failure");
			return storeRunner(args, options);
		});

		await expect(failingStore.captureBaseline(repo.dir, checkpointRef("session", "failure"))).rejects.toThrow(
			"injected write-tree failure",
		);
		expect(await temporaryEntries(commonDir)).toEqual([]);
	});

	it("rejects a result when repository identity changes", async () => {
		const first = await makeRepo();
		const second = await makeRepo();
		await writeRepoFile(first.dir, "file.txt", "first\n");
		await writeRepoFile(second.dir, "file.txt", "second\n");
		await commitAll(first.dir);
		await commitAll(second.dir);
		const baseline = required(await store.captureBaseline(first.dir, checkpointRef("session", "identity")));

		await expect(store.captureResult({ ...baseline, worktreeRoot: second.dir })).rejects.toThrow(
			"repository identity changed",
		);
		await expect(store.captureResult({ ...baseline, commonDir: join(first.dir, "wrong-common") })).rejects.toThrow(
			"repository identity changed",
		);
	});

	it("returns null outside a Git worktree", async () => {
		const plainDir = await mkdtemp(join(tmpdir(), "pi-checkpoint-plain-"));
		tempDirs.push(plainDir);
		expect(await store.captureBaseline(plainDir, checkpointRef("session", "plain"))).toBeNull();
	});

	it("returns null in a bare repository", async () => {
		const bareDir = await mkdtemp(join(tmpdir(), "pi-checkpoint-bare-"));
		tempDirs.push(bareDir);
		await git(bareDir, "init", "--bare");
		expect(await store.captureBaseline(bareDir, checkpointRef("session", "bare"))).toBeNull();
	});
});
