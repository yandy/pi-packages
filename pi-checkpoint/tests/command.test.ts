import type { CustomEntry, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type CheckpointCommandDeps, createCheckpointCommandHandler } from "../src/command.js";
import { CHECKPOINT_ENTRY_TYPE, type CheckpointOkData } from "../src/session.js";

function checkpointEntry(): CustomEntry {
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
		ref: "refs/pi/checkpoint/c2Vzc2lvbg/run-7",
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

const stubDeps: CheckpointCommandDeps = {
	sweep: async () => ({ status: "skipped", reason: "not-a-worktree" }),
	refExists: async () => true,
};

describe("/checkpoint", () => {
	let notify: ReturnType<typeof vi.fn>;
	let ctx: ExtensionCommandContext;
	const handler = createCheckpointCommandHandler(stubDeps);

	beforeEach(() => {
		notify = vi.fn();
		ctx = {
			cwd: "/repo",
			sessionManager: { getBranch: () => [checkpointEntry()] },
			ui: { notify },
		} as unknown as ExtensionCommandContext;
	});

	it("shows the ref and a complete Git diff command", async () => {
		await handler("7", ctx);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("refs/pi/checkpoint/"), "info");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("git diff baseline-oid result-oid"), "info");
	});

	it("shows usage for missing or invalid run numbers", async () => {
		await handler("", ctx);
		expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("/checkpoint <runNumber>"), "warning");
		await handler("not-a-number", ctx);
		expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("/checkpoint <runNumber>"), "warning");
		await handler("1.5", ctx);
		expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("/checkpoint <runNumber>"), "warning");
	});

	it("reports a missing checkpoint", async () => {
		await handler("404", ctx);
		expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("not found"), "warning");
	});

	it("prunes when asked and reports counts", async () => {
		const handler = createCheckpointCommandHandler({
			sweep: async () => ({ status: "pruned", deleted: 3, kept: 197 }),
			refExists: async () => true,
		});
		await handler("prune", ctx);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Pruned 3"), "info");
	});

	it("reports prune failures", async () => {
		const handler = createCheckpointCommandHandler({
			sweep: async () => ({ status: "failed", error: "git update-ref failed" }),
			refExists: async () => true,
		});
		await handler("prune", ctx);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Checkpoint prune failed"), "warning");
	});

	it("notes pruned objects when the ref is gone", async () => {
		const handler = createCheckpointCommandHandler({
			sweep: async () => ({ status: "skipped", reason: "not-a-worktree" }),
			refExists: async () => false,
		});
		await handler("7", ctx);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("only the stored preview remains"), "warning");
	});

	it("still prints the diff command when the ref is gone", async () => {
		const handler = createCheckpointCommandHandler({
			sweep: async () => ({ status: "skipped", reason: "not-a-worktree" }),
			refExists: async () => false,
		});
		await handler("7", ctx);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("git diff baseline-oid result-oid"), "info");
	});

	it("omits the pruned note when the ref still exists", async () => {
		const handler = createCheckpointCommandHandler({
			sweep: async () => ({ status: "skipped", reason: "not-a-worktree" }),
			refExists: async () => true,
		});
		await handler("7", ctx);
		expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("only the stored preview remains"), expect.anything());
	});

	it("keeps the query output when the ref check throws", async () => {
		const handler = createCheckpointCommandHandler({
			sweep: async () => ({ status: "skipped", reason: "not-a-worktree" }),
			refExists: async () => {
				throw new Error("git rev-parse failed");
			},
		});
		await handler("7", ctx);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("git diff baseline-oid result-oid"), "info");
		expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("only the stored preview remains"), expect.anything());
	});
});
