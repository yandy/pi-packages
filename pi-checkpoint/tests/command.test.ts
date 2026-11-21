import type { CustomEntry, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCheckpointCommandHandler } from "../src/command.js";
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

describe("/checkpoint", () => {
	let notify: ReturnType<typeof vi.fn>;
	let ctx: ExtensionCommandContext;
	const handler = createCheckpointCommandHandler();

	beforeEach(() => {
		notify = vi.fn();
		ctx = {
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
});
