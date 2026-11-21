import type { CustomEntry, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCheckpointCommandHandler } from "../src/command.js";
import { createGitRunner, type GitResult, type GitRunOptions, type RunGit } from "../src/git.js";
import {
	CHECKPOINT_ENTRY_TYPE,
	type CheckpointEntryData,
	type CheckpointErrorData,
	type CheckpointOkData,
} from "../src/session.js";
import { commitAll, createTestRepo, git, type TestRepo, writeRepoFile } from "./helpers/git-repo.js";

const REF = "refs/pi/checkpoint/c2Vzc2lvbg/run-7";
const BASELINE = "a".repeat(40);
const RESULT = "b".repeat(40);
const OTHER = "c".repeat(40);
const SHORTSTAT = "1 file changed, 2 insertions(+)";
const PREVIEW = "diff --git a/file.txt b/file.txt\n+hello";
const USAGE = "/checkpoint <runNumber> | /checkpoint prune [--dry-run]";

function okData(overrides: Partial<CheckpointOkData> = {}): CheckpointOkData {
	return {
		version: 1,
		status: "ok",
		runId: "run-7",
		runNumber: 7,
		previousLeafId: "before",
		sourceEntryId: "source",
		messageType: "user",
		startedAt: "2026-11-21T00:00:00.000Z",
		settledAt: "2026-11-21T00:00:01.000Z",
		aborted: false,
		ref: REF,
		baselineCommit: BASELINE,
		resultCommit: RESULT,
		headBefore: "head-before",
		headAfter: "head-after",
		shortstat: SHORTSTAT,
		patchPreview: PREVIEW,
		previewTruncated: false,
		previewError: null,
		...overrides,
	};
}

function errorData(): CheckpointErrorData {
	return {
		version: 1,
		status: "error",
		runId: "run-8",
		runNumber: 8,
		previousLeafId: "before",
		sourceEntryId: "source",
		messageType: "user",
		startedAt: "2026-11-21T00:00:00.000Z",
		settledAt: null,
		aborted: false,
		stage: "result",
		ref: "refs/pi/checkpoint/c2Vzc2lvbg/run-8",
		baselineCommit: BASELINE,
		error: "capture exploded",
	};
}

function entryRecord(data: CheckpointEntryData): CustomEntry {
	return {
		type: "custom",
		customType: CHECKPOINT_ENTRY_TYPE,
		data,
		id: "checkpoint-entry",
		parentId: "assistant",
		timestamp: "2026-11-21T00:00:01.000Z",
	};
}

function gitResult(overrides: Partial<GitResult> = {}): GitResult {
	return { stdout: "", stderr: "", code: 0, killed: false, truncated: false, ...overrides };
}

interface GitCall {
	args: string[];
	options: GitRunOptions;
}

interface HarnessOptions {
	entry?: CheckpointEntryData | null;
	git?: (args: string[], options: GitRunOptions) => Promise<GitResult>;
}

function makeHarness(options: HarnessOptions = {}) {
	const calls: GitCall[] = [];
	const runGit: RunGit = async (args, runOptions) => {
		calls.push({ args, options: runOptions });
		if (options.git) return options.git(args, runOptions);
		return gitResult({ stdout: `${RESULT}\n` });
	};
	const prune = vi.fn(async () => {});
	const notify = vi.fn();
	const branch = options.entry === null ? [] : [entryRecord(options.entry ?? okData())];
	const ctx = {
		cwd: "/work",
		sessionManager: { getBranch: () => branch },
		ui: { notify },
	} as unknown as ExtensionCommandContext;
	const handler = createCheckpointCommandHandler({ runGit, prune });
	return { handler, notify, prune, calls, ctx };
}

function lastNotification(notify: ReturnType<typeof vi.fn>): { message: string; level: string } {
	const call = notify.mock.calls.at(-1);
	if (!call) throw new Error("no notification was emitted");
	return { message: String(call[0]), level: String(call[1]) };
}

function parseRepositoryDiffCommand(command: string): string[] {
	const match = /^git --git-dir='((?:[^']|'\\'')*)' diff ([0-9a-f]{40}) ([0-9a-f]{40})$/.exec(command);
	if (!match) throw new Error(`not a repository-qualified diff command: ${command}`);
	const commonDir = match[1].replaceAll("'\\''", "'");
	return ["git", `--git-dir=${commonDir}`, "diff", match[2], match[3]];
}

describe("/checkpoint <runNumber>", () => {
	it("prints the diff command only when the ref resolves to the recorded result commit", async () => {
		const { handler, notify, calls, ctx } = makeHarness({ entry: okData({ commonDir: "/repo/.git" }) });

		await handler("7", ctx);

		expect(calls).toEqual([
			{
				args: ["rev-parse", "--verify", "--quiet", `${REF}^{commit}`],
				options: { cwd: "/repo/.git", allowNonZeroExit: true },
			},
		]);
		const { message, level } = lastNotification(notify);
		expect(level).toBe("info");
		expect(message).toContain(`git --git-dir='/repo/.git' diff ${BASELINE} ${RESULT}`);
		expect(message).toContain(`ref: ${REF}`);
	});

	it("shell-quotes repository paths in the emitted diff command", async () => {
		const { handler, notify, ctx } = makeHarness({
			entry: okData({ commonDir: "/tmp/repository with 'quote'/.git" }),
		});

		await handler("7", ctx);

		expect(lastNotification(notify).message).toContain(
			`git --git-dir='/tmp/repository with '\\''quote'\\''/.git' diff ${BASELINE} ${RESULT}`,
		);
	});

	it("keeps the aborted marker on live snapshots", async () => {
		const { handler, notify, ctx } = makeHarness({ entry: okData({ aborted: true, commonDir: "/repo/.git" }) });

		await handler("7", ctx);

		expect(lastNotification(notify).message.split("\n")[0]).toBe("Checkpoint #7 (aborted)");
	});

	it("verifies legacy entries against the session cwd", async () => {
		const { handler, notify, calls, ctx } = makeHarness();

		await handler("7", ctx);

		expect(calls[0]?.options.cwd).toBe("/work");
		expect(lastNotification(notify).message.split("\n").at(-1)).toBe(`git diff ${BASELINE} ${RESULT}`);
	});

	it("shows the stored summary without a diff command when the ref is missing", async () => {
		const { handler, notify, ctx } = makeHarness({
			entry: okData({ commonDir: "/repo/.git" }),
			git: async () => gitResult({ code: 1 }),
		});

		await handler("7", ctx);

		const { message, level } = lastNotification(notify);
		expect(level).toBe("warning");
		expect(message).toContain("snapshot unavailable");
		expect(message).toContain("no longer exists");
		expect(message).toContain(`ref: ${REF}`);
		expect(message).toContain(SHORTSTAT);
		expect(message).toContain(PREVIEW);
		expect(message).not.toContain("git diff");
	});

	it("does not trust a ref that points to a different commit", async () => {
		const { handler, notify, ctx } = makeHarness({
			entry: okData({ commonDir: "/repo/.git" }),
			git: async () => gitResult({ stdout: `${OTHER}\n` }),
		});

		await handler("7", ctx);

		const { message, level } = lastNotification(notify);
		expect(level).toBe("warning");
		expect(message).toContain("snapshot unavailable");
		expect(message).toContain(OTHER.slice(0, 7));
		expect(message).not.toContain(`git diff ${BASELINE}`);
		expect(message).toContain(SHORTSTAT);
		expect(message).toContain(PREVIEW);
	});

	it("uses non-assertive wording for legacy entries missing from the current repository", async () => {
		const { handler, notify, ctx } = makeHarness({ git: async () => gitResult({ code: 1 }) });

		await handler("7", ctx);

		const { message, level } = lastNotification(notify);
		expect(level).toBe("warning");
		expect(message).toContain("may have been pruned");
		expect(message).toContain("different repository");
		expect(message).toContain(SHORTSTAT);
		expect(message).toContain(PREVIEW);
		expect(message).not.toContain("git diff");
	});

	it("uses non-assertive wording for legacy entries whose ref moved in the current repository", async () => {
		const { handler, notify, ctx } = makeHarness({ git: async () => gitResult({ stdout: `${OTHER}\n` }) });

		await handler("7", ctx);

		const { message } = lastNotification(notify);
		expect(message).toContain("may have been pruned");
		expect(message).toContain("different repository");
		expect(message).not.toContain("git diff");
	});

	it("reports Git failures as unconfirmed rather than pruned", async () => {
		const thrown = makeHarness({
			entry: okData({ commonDir: "/repo/.git" }),
			git: async () => {
				throw new Error("Git executable was not found");
			},
		});

		await thrown.handler("7", thrown.ctx);

		const thrownMessage = lastNotification(thrown.notify);
		expect(thrownMessage.level).toBe("warning");
		expect(thrownMessage.message).toContain("cannot verify");
		expect(thrownMessage.message).not.toContain("pruned");
		expect(thrownMessage.message).not.toContain("git diff");

		const fatal = makeHarness({
			git: async () => gitResult({ code: 128, stderr: "fatal: not a git repository" }),
		});

		await fatal.handler("7", fatal.ctx);

		const fatalMessage = lastNotification(fatal.notify);
		expect(fatalMessage.level).toBe("warning");
		expect(fatalMessage.message).toContain("cannot verify");
		expect(fatalMessage.message).not.toContain("pruned");
		expect(fatalMessage.message).not.toContain("git diff");
	});

	it("caps legacy previews instead of printing unbounded patch content", async () => {
		const oversized = "x".repeat(200_000);
		const { handler, notify, ctx } = makeHarness({
			entry: okData({ patchPreview: oversized, previewTruncated: false }),
			git: async () => gitResult({ code: 1 }),
		});

		await handler("7", ctx);

		const { message } = lastNotification(notify);
		expect(message).toContain("preview truncated");
		expect(Buffer.byteLength(message, "utf8")).toBeLessThan(17 * 1024);
	});

	it("leaves error entries unchanged and does not run Git", async () => {
		const { handler, notify, calls, ctx } = makeHarness({ entry: errorData() });

		await handler("8", ctx);

		expect(notify).toHaveBeenCalledWith(
			`Checkpoint #8: result capture failed\nref: ${errorData().ref}\nbaseline: ${BASELINE}\ncapture exploded`,
			"warning",
		);
		expect(calls).toEqual([]);
	});

	it("shows usage for missing or invalid run numbers", async () => {
		const { handler, notify, calls, ctx } = makeHarness();

		for (const args of ["", "not-a-number", "1.5", "0", "-1", "7 8"]) {
			await handler(args, ctx);
			expect(notify).toHaveBeenLastCalledWith(expect.stringContaining(USAGE), "warning");
		}
		expect(calls).toEqual([]);
	});

	it("reports a missing checkpoint", async () => {
		const { handler, notify, ctx } = makeHarness({ entry: null });

		await handler("404", ctx);

		expect(lastNotification(notify)).toEqual({
			message: "Checkpoint #404 not found in the current conversation branch",
			level: "warning",
		});
	});
});

describe("/checkpoint prune", () => {
	it("routes the manual sweep through maintenance", async () => {
		const { handler, notify, prune, calls, ctx } = makeHarness();

		await handler("prune", ctx);

		expect(prune).toHaveBeenCalledTimes(1);
		expect(prune).toHaveBeenCalledWith(ctx, false);
		expect(calls).toEqual([]);
		expect(notify).not.toHaveBeenCalled();
	});

	it("passes dry-run through with surrounding whitespace", async () => {
		const { handler, prune, ctx } = makeHarness();

		await handler("  prune   --dry-run  ", ctx);

		expect(prune).toHaveBeenCalledTimes(1);
		expect(prune).toHaveBeenCalledWith(ctx, true);
	});

	it("rejects invalid prune arguments without sweeping", async () => {
		const { handler, notify, prune, calls, ctx } = makeHarness();

		for (const args of ["prune extra", "prune --dry-run now", "prune --force", "prune -n", "prune --dry-run=1"]) {
			await handler(args, ctx);
			expect(notify).toHaveBeenLastCalledWith(expect.stringContaining(USAGE), "warning");
		}
		expect(prune).not.toHaveBeenCalled();
		expect(calls).toEqual([]);
	});

	it("reports a rejecting prune without failing the command", async () => {
		const { handler, notify, prune, ctx } = makeHarness();
		prune.mockRejectedValueOnce(new Error("update-ref failed"));

		await expect(handler("prune", ctx)).resolves.toBeUndefined();

		const { message, level } = lastNotification(notify);
		expect(level).toBe("warning");
		expect(message).toContain("prune failed");
		expect(message).toContain("update-ref failed");
	});
});

describe("/checkpoint <runNumber> with a real repository", () => {
	let repo: TestRepo;
	let other: TestRepo;

	afterEach(async () => {
		await repo?.cleanup();
		await other?.cleanup();
	});

	async function seed(): Promise<{ baseline: string; result: string; commonDir: string }> {
		await writeRepoFile(repo.dir, "file.txt", "before\n");
		const baseline = await commitAll(repo.dir, "baseline");
		await writeRepoFile(repo.dir, "file.txt", "after\n");
		const result = await commitAll(repo.dir, "result");
		const commonDir = await git(repo.dir, "rev-parse", "--path-format=absolute", "--git-common-dir");
		return { baseline, result, commonDir };
	}

	function realHarness(data: CheckpointEntryData, cwd: string) {
		const notify = vi.fn();
		const handler = createCheckpointCommandHandler({ runGit: createGitRunner(), prune: async () => {} });
		const ctx = {
			cwd,
			sessionManager: { getBranch: () => [entryRecord(data)] },
			ui: { notify },
		} as unknown as ExtensionCommandContext;
		return { handler, notify, ctx };
	}

	it("verifies live, deleted, and foreign-repository snapshots", async () => {
		repo = await createTestRepo();
		other = await createTestRepo();
		const { baseline, result, commonDir } = await seed();
		const ref = "refs/pi/checkpoint/cmVhbA/run-1";
		await git(repo.dir, "update-ref", ref, result);

		const live = realHarness(
			okData({ runNumber: 1, ref, baselineCommit: baseline, resultCommit: result, commonDir }),
			other.dir,
		);
		await live.handler("1", live.ctx);
		expect(lastNotification(live.notify).message).toContain(
			`git --git-dir='${commonDir}' diff ${baseline} ${result}`,
		);

		await git(repo.dir, "update-ref", "-d", ref);
		const deleted = realHarness(
			okData({ runNumber: 1, ref, baselineCommit: baseline, resultCommit: result, commonDir }),
			other.dir,
		);
		await deleted.handler("1", deleted.ctx);
		const deletedMessage = lastNotification(deleted.notify);
		expect(deletedMessage.level).toBe("warning");
		expect(deletedMessage.message).toContain("no longer exists");
		expect(deletedMessage.message).not.toContain("git diff");

		const foreign = realHarness(okData({ runNumber: 1, ref, baselineCommit: baseline, resultCommit: result }), other.dir);
		await foreign.handler("1", foreign.ctx);
		const foreignMessage = lastNotification(foreign.notify);
		expect(foreignMessage.message).toContain("may have been pruned");
		expect(foreignMessage.message).toContain("different repository");
		expect(foreignMessage.message).not.toContain("git diff");
	});

	it("executes the emitted diff from a foreign cwd when the repository path contains spaces", async () => {
		repo = await createTestRepo("pi-checkpoint repository with spaces-");
		other = await createTestRepo();
		const { baseline, result, commonDir } = await seed();
		const ref = "refs/pi/checkpoint/c3BhY2Vz/run-3";
		await git(repo.dir, "update-ref", ref, result);
		const live = realHarness(
			okData({ runNumber: 3, ref, baselineCommit: baseline, resultCommit: result, commonDir }),
			other.dir,
		);

		await live.handler("3", live.ctx);

		const { message, level } = lastNotification(live.notify);
		expect(level).toBe("info");
		const argv = parseRepositoryDiffCommand(message.split("\n").at(-1) ?? "");
		expect(argv[1]).toBe(`--git-dir=${commonDir}`);
		const emittedOutput = await git(other.dir, ...argv.slice(1));
		const expectedOutput = await git(repo.dir, "diff", baseline, result);
		expect(emittedOutput).toBe(expectedOutput);
		expect(emittedOutput).toContain("-before");
		expect(emittedOutput).toContain("+after");
	});

	it("falls back to the session cwd for entries without a recorded common dir", async () => {
		repo = await createTestRepo();
		const { baseline, result } = await seed();
		const ref = "refs/pi/checkpoint/cmVhbA/run-2";
		await git(repo.dir, "update-ref", ref, result);

		const legacy = realHarness(
			okData({ runNumber: 2, ref, baselineCommit: baseline, resultCommit: result }),
			repo.dir,
		);
		await legacy.handler("2", legacy.ctx);

		expect(lastNotification(legacy.notify).message.split("\n").at(-1)).toBe(`git diff ${baseline} ${result}`);
	});
});
