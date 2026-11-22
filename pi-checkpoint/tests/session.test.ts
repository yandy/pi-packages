import type { CustomEntry, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	CHECKPOINT_ENTRY_TYPE,
	type CheckpointErrorData,
	type CheckpointOkData,
	findCheckpoint,
	nextRunNumber,
	parseCheckpointEntryData,
	recordedSnapshots,
	resolveSourceEntryId,
} from "../src/session.js";

function okData(overrides: Partial<CheckpointOkData> = {}): CheckpointOkData {
	return {
		version: 1,
		status: "ok",
		runId: "run-7",
		runNumber: 7,
		previousLeafId: "before",
		sourceEntryId: "first-user-after-before",
		messageType: "user",
		startedAt: "2026-11-21T00:00:00.000Z",
		settledAt: "2026-11-21T00:00:01.000Z",
		aborted: false,
		ref: "refs/pi/checkpoint/c2Vzc2lvbg/run-7",
		baselineCommit: "baseline-oid",
		resultCommit: "result-oid",
		headBefore: "head-before",
		headAfter: "head-after",
		shortstat: "1 file changed, 1 insertion(+), 1 deletion(-)",
		patchPreview: "diff --git a/file b/file",
		previewTruncated: false,
		previewError: null,
		...overrides,
	};
}

function errorData(overrides: Partial<CheckpointErrorData> = {}): CheckpointErrorData {
	return {
		version: 1,
		status: "error",
		runId: "run-error",
		runNumber: 5,
		previousLeafId: "before",
		sourceEntryId: null,
		messageType: "user",
		startedAt: "2026-11-21T00:00:00.000Z",
		settledAt: null,
		aborted: false,
		stage: "baseline",
		ref: "refs/pi/checkpoint/c2Vzc2lvbg/run-error",
		baselineCommit: null,
		error: "capture failed",
		...overrides,
	};
}

function custom(id: string, data: unknown, customType = CHECKPOINT_ENTRY_TYPE): CustomEntry {
	return { type: "custom", id, parentId: null, timestamp: "2026-11-21T00:00:00.000Z", customType, data };
}

function userMessage(id: string, parentId: string | null): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-11-21T00:00:00.000Z",
		message: { role: "user", content: [{ type: "text", text: id }], timestamp: 1 },
	};
}

describe("checkpoint session data", () => {
	it("round-trips complete ok and error records", () => {
		expect(parseCheckpointEntryData(okData())).toEqual(okData());
		expect(parseCheckpointEntryData(errorData())).toEqual(errorData());
	});

	it("records the snapshot's common dir and keeps legacy entries readable", () => {
		const withCommonDir = okData({ commonDir: "/repo/.git" });
		expect(parseCheckpointEntryData(withCommonDir)).toEqual(withCommonDir);

		// Legacy entries predate the field: they still parse, and no value is invented for them.
		const legacy = parseCheckpointEntryData(okData());
		expect(legacy).toEqual(okData());
		expect(legacy && "commonDir" in legacy).toBe(false);

		expect(parseCheckpointEntryData({ ...withCommonDir, commonDir: 42 })).toBeNull();
	});

	it("collects the snapshot commits this session recorded for pruning", () => {
		const entries: SessionEntry[] = [
			custom("ok-2", okData({ runNumber: 2, ref: "refs/pi/checkpoint/c2Vzc2lvbg/run-2" })),
			custom("error-3", errorData({ ref: "refs/pi/checkpoint/c2Vzc2lvbg/run-3" })),
			custom("other", { ...okData(), runNumber: 4 }, "other-extension"),
		];
		expect(recordedSnapshots(entries)).toEqual(
			new Map([
				[
					"refs/pi/checkpoint/c2Vzc2lvbg/run-2",
					{
						ref: "refs/pi/checkpoint/c2Vzc2lvbg/run-2",
						baselineCommit: "baseline-oid",
						resultCommit: "result-oid",
					},
				],
			]),
		);
	});

	it("rejects malformed, old-version, and incomplete records", () => {
		expect(parseCheckpointEntryData({ version: 1, status: "ok" })).toBeNull();
		expect(parseCheckpointEntryData({ ...okData(), version: 2 })).toBeNull();
		expect(parseCheckpointEntryData({ ...okData(), runNumber: 0 })).toBeNull();
		expect(parseCheckpointEntryData({ ...okData(), previewTruncated: "false" })).toBeNull();
		expect(parseCheckpointEntryData({ ...errorData(), stage: "preview" })).toBeNull();
		expect(parseCheckpointEntryData(null)).toBeNull();
		expect(parseCheckpointEntryData([])).toBeNull();
	});

	it("allocates the next run number across all branches and includes error records", () => {
		const entries: SessionEntry[] = [
			custom("ok-2", okData({ runNumber: 2 })),
			custom("error-5", errorData({ runNumber: 5 })),
			custom("other", { runNumber: 99 }, "other-extension"),
			custom("malformed", { ...okData(), runNumber: 100, status: "unknown" }),
		];
		expect(nextRunNumber(entries)).toBe(6);
		expect(nextRunNumber([custom("other", { runNumber: 99 }, "other-extension")])).toBe(1);
	});

	it("finds only valid checkpoints in the supplied conversation branch", () => {
		const branch: SessionEntry[] = [custom("checkpoint-7", okData()), custom("bad-8", { version: 1 })];
		expect(findCheckpoint(branch, 7)?.runId).toBe("run-7");
		expect(findCheckpoint(branch, 8)).toBeNull();
		expect(findCheckpoint([custom("checkpoint-9", okData({ runNumber: 9 }))], 7)).toBeNull();
		expect(findCheckpoint(branch, 1.5)).toBeNull();
	});
});

describe("resolveSourceEntryId", () => {
	const branch: SessionEntry[] = [
		userMessage("older-user", null),
		custom("before", undefined, "other-extension"),
		custom("pending-extension", undefined, "other-extension"),
		userMessage("first-user-after-before", "before"),
		userMessage("queued-user", "first-user-after-before"),
	];

	it("resolves the first user message after the pre-run anchor", () => {
		expect(resolveSourceEntryId(branch, "before", "user")).toBe("first-user-after-before");
	});

	it("does not infer a source for custom runs, missing anchors, or absent anchors", () => {
		expect(resolveSourceEntryId(branch, "before", "custom")).toBeNull();
		expect(resolveSourceEntryId(branch, null, "user")).toBeNull();
		expect(resolveSourceEntryId(branch, "not-in-branch", "user")).toBeNull();
	});
});
