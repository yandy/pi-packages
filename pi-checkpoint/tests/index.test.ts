import type { CustomEntry, ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitRunner, type RunGit } from "../src/git.js";
import registerCheckpoint from "../src/index.js";
import { CHECKPOINT_ENTRY_TYPE, type CheckpointOkData } from "../src/session.js";
import { createTestRepo, type TestRepo } from "./helpers/git-repo.js";

type Handler = (...args: never[]) => unknown;

/**
 * The session_start handler is fire-and-forget, so a test that returns before the sweep finishes
 * leaves git children holding the temporary repository open. Windows then refuses to remove it
 * (EBUSY). Waiting for `pending()` to reach zero is what makes the fixture teardown safe.
 */
function trackCalls(runGit: RunGit) {
	let pending = 0;
	const calls: string[][] = [];
	const wrapped: RunGit = async (args, options) => {
		pending += 1;
		calls.push(args);
		try {
			return await runGit(args, options);
		} finally {
			pending -= 1;
		}
	};
	return { runGit: wrapped, calls, pending: () => pending };
}

const repos: TestRepo[] = [];

async function makeRepo(): Promise<TestRepo> {
	const repo = await createTestRepo();
	repos.push(repo);
	return repo;
}

afterEach(async () => {
	await Promise.all(repos.splice(0).map((repo) => repo.cleanup()));
});

function createHost() {
	const events = new Map<string, Handler>();
	const appendEntry = vi.fn();
	const registerCommand = vi.fn();
	const pi = {
		appendEntry,
		on: vi.fn((event: string, handler: Handler) => {
			events.set(event, handler);
			return vi.fn();
		}),
		registerEntryRenderer: vi.fn(),
		registerCommand,
		registerTool: vi.fn(),
	} as unknown as ExtensionAPI;
	return { pi, events, appendEntry, registerCommand };
}

function commandHandler(registerCommand: ReturnType<typeof vi.fn>): (args: string, ctx: ExtensionCommandContext) => Promise<void> {
	return registerCommand.mock.calls[0]?.[1].handler;
}

function checkpointEntry(ref: string): CustomEntry {
	const data: CheckpointOkData = {
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
		ref,
		baselineCommit: "baseline-oid",
		resultCommit: "result-oid",
		headBefore: "head-before",
		headAfter: "head-after",
		shortstat: "1 file changed",
		patchPreview: "diff",
		previewTruncated: false,
		previewError: null,
	};
	return {
		type: "custom",
		customType: CHECKPOINT_ENTRY_TYPE,
		data,
		id: "checkpoint-entry",
		parentId: "assistant",
		timestamp: "2026-11-21T00:00:01.000Z",
	};
}

function commandContext(ref: string, cwd: string) {
	const notify = vi.fn();
	const ctx = {
		cwd,
		sessionManager: { getBranch: () => [checkpointEntry(ref)] },
		ui: { notify },
	} as unknown as ExtensionCommandContext;
	return { ctx, notify };
}

describe("pi-checkpoint extension entry", () => {
	it("registers only run-level capture events and read-only UI", () => {
		const { pi, events, registerCommand } = createHost();

		registerCheckpoint(pi);

		expect(events.has("before_agent_start")).toBe(true);
		expect(events.has("agent_settled")).toBe(true);
		expect(events.has("session_start")).toBe(true);
		expect(events.has("session_shutdown")).toBe(true);
		expect(events.has("turn_end")).toBe(false);
		expect(pi.registerEntryRenderer).toHaveBeenCalledWith(CHECKPOINT_ENTRY_TYPE, expect.any(Function));
		expect(registerCommand).toHaveBeenCalledWith(
			"checkpoint",
			expect.objectContaining({ handler: expect.any(Function) }),
		);
		expect(pi.registerTool).not.toHaveBeenCalled();
	});

	it("sweeps checkpoint refs once per session", async () => {
		const repo = await makeRepo();
		const tracker = trackCalls(async (args, options) => {
			if (args[0] === "for-each-ref") return { stdout: "", stderr: "", code: 0, killed: false, truncated: false };
			return createGitRunner()(args, options);
		});
		const { pi, events } = createHost();
		registerCheckpoint(pi, { runGit: tracker.runGit });

		await events.get("session_start")?.({}, { cwd: repo.dir } as never);
		await events.get("session_start")?.({}, { cwd: repo.dir } as never);

		await vi.waitFor(() => expect(tracker.pending()).toBe(0));
		expect(tracker.calls.filter((args) => args[0] === "for-each-ref")).toHaveLength(1);
	});

	it("keeps a failed sweep invisible to the session", async () => {
		const repo = await makeRepo();
		const tracker = trackCalls(async (args, options) => {
			if (args[0] === "for-each-ref") throw new Error("git for-each-ref failed");
			return createGitRunner()(args, options);
		});
		const { pi, events, appendEntry } = createHost();
		const notify = vi.fn();
		const ctx = { cwd: repo.dir, ui: { notify } } as unknown as ExtensionCommandContext;
		registerCheckpoint(pi, { runGit: tracker.runGit });

		await expect(Promise.resolve(events.get("session_start")?.({}, ctx as never))).resolves.toBeUndefined();
		await vi.waitFor(() => {
			expect(tracker.calls.some((args) => args[0] === "for-each-ref")).toBe(true);
			expect(tracker.pending()).toBe(0);
		});

		// The run-level capture path keeps working after a failed sweep.
		await expect(Promise.resolve(events.get("agent_settled")?.({ aborted: false }, ctx as never))).resolves.toBeUndefined();
		expect(appendEntry).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
	});

	it("treats an unexpected rev-parse failure as unknown, not as pruned objects", async () => {
		const repo = await makeRepo();
		const runGit: RunGit = async (args, options) => {
			// 128 is what git returns outside a worktree or on dubious ownership; 1 means "no such ref".
			if (args[0] === "rev-parse") return { stdout: "", stderr: "fatal: not a git repository", code: 128, killed: false, truncated: false };
			return createGitRunner()(args, options);
		};
		const { pi, registerCommand } = createHost();
		registerCheckpoint(pi, { runGit });
		const { ctx, notify } = commandContext("refs/pi/checkpoint/c2Vz/run-7", repo.dir);

		await commandHandler(registerCommand)("7", ctx);

		expect(notify).toHaveBeenCalledWith(expect.stringContaining("git diff baseline-oid result-oid"), "info");
		expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("pruned"), expect.anything());
	});

	it("notes pruned objects only when the ref is definitely missing", async () => {
		const repo = await makeRepo();
		const runGit: RunGit = async (args, options) => {
			if (args[0] === "rev-parse") return { stdout: "", stderr: "", code: 1, killed: false, truncated: false };
			return createGitRunner()(args, options);
		};
		const { pi, registerCommand } = createHost();
		registerCheckpoint(pi, { runGit });
		const { ctx, notify } = commandContext("refs/pi/checkpoint/c2Vz/run-7", repo.dir);

		await commandHandler(registerCommand)("7", ctx);

		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("the checkpoint ref was pruned"),
			"warning",
		);
	});
});
