import { spawn, type SpawnOptions } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitRunner, GitCommandError, GitUnavailableError } from "../src/git.js";
import { createTestRepo, type TestRepo } from "./helpers/git-repo.js";

describe("Git process boundary", () => {
	let repo: TestRepo;

	beforeEach(async () => {
		repo = await createTestRepo();
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await repo.cleanup();
	});

	it("runs real Git and preserves output", async () => {
		const run = createGitRunner();
		const result = await run(["--version"], { cwd: repo.dir });
		expect(result.stdout.trim()).toMatch(/^git version /);
		expect(result.code).toBe(0);
		expect(result.killed).toBe(false);
		expect(result.truncated).toBe(false);
	});

	it("removes inherited repository selectors while allowing an explicit temporary index", async () => {
		for (const name of [
			"GIT_DIR",
			"GIT_WORK_TREE",
			"GIT_COMMON_DIR",
			"GIT_INDEX_FILE",
			"GIT_OBJECT_DIRECTORY",
			"GIT_ALTERNATE_OBJECT_DIRECTORIES",
			"GIT_QUARANTINE_PATH",
		]) {
			vi.stubEnv(name, join(repo.dir, `wrong-${name}`));
		}

		let observedEnv: NodeJS.ProcessEnv | undefined;
		const captureSpawn = ((command: string, args: string[], options: SpawnOptions) => {
			observedEnv = options.env;
			return spawn(command, args, options);
		}) as typeof spawn;
		const run = createGitRunner(captureSpawn);

		await run(["--version"], { cwd: repo.dir, env: { CHECKPOINT_TEST_VALUE: "preserved" } });
		expect(observedEnv?.GIT_DIR).toBeUndefined();
		expect(observedEnv?.GIT_INDEX_FILE).toBeUndefined();
		expect(observedEnv?.GIT_OBJECT_DIRECTORY).toBeUndefined();
		expect(observedEnv?.CHECKPOINT_TEST_VALUE).toBe("preserved");

		const temporaryIndex = join(repo.dir, "temporary-index");
		await run(["--version"], { cwd: repo.dir, env: { GIT_INDEX_FILE: temporaryIndex } });
		expect(observedEnv?.GIT_INDEX_FILE).toBe(temporaryIndex);
	});

	it("throws a command error for nonzero exits unless they are allowed", async () => {
		const run = createGitRunner();
		await expect(run(["rev-parse", "--verify", "missing"], { cwd: repo.dir })).rejects.toBeInstanceOf(
			GitCommandError,
		);
		const result = await run(["rev-parse", "--verify", "missing"], {
			cwd: repo.dir,
			allowNonZeroExit: true,
		});
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("fatal:");
	});

	it("distinguishes a missing Git executable", async () => {
		const run = createGitRunner();
		await expect(run(["--version"], { cwd: repo.dir, env: { PATH: "" } })).rejects.toBeInstanceOf(
			GitUnavailableError,
		);
	});

	it("terminates output that exceeds the byte limit", async () => {
		const run = createGitRunner();
		const largeOutput = await run(["--version"], {
			cwd: repo.dir,
			allowNonZeroExit: true,
			maxOutputBytes: 1,
		});
		expect(largeOutput.truncated).toBe(true);
		expect(largeOutput.killed).toBe(true);

		const largeError = await run(["--definitely-invalid-option"], {
			cwd: repo.dir,
			allowNonZeroExit: true,
			maxOutputBytes: 4,
		});
		expect(largeError.truncated).toBe(true);
		expect(largeError.killed).toBe(true);
	});

	it("terminates a child when the caller aborts", async () => {
		const run = createGitRunner();
		const controller = new AbortController();
		controller.abort();
		const result = await run(["--version"], {
			cwd: repo.dir,
			allowNonZeroExit: true,
			signal: controller.signal,
		});
		expect(result.killed).toBe(true);
	});
});
