import type { CustomEntry, EntryRenderOptions, EntryRenderer } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createCheckpointRenderer, formatCheckpointEntry } from "../src/renderer.js";
import { CHECKPOINT_ENTRY_TYPE, type CheckpointOkData } from "../src/session.js";

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
		ref: "refs/pi/checkpoint/c2Vzc2lvbg/run-7",
		baselineCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		resultCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		headBefore: "head-before",
		headAfter: "head-after",
		shortstat: "1 file changed, 1 insertion(+), 1 deletion(-)",
		patchPreview: "diff --git a/file b/file\n+before",
		previewTruncated: false,
		previewError: null,
		...overrides,
	};
}

describe("formatCheckpointEntry", () => {
	it("formats a compact change summary", () => {
		expect(formatCheckpointEntry(okData(), false)).toEqual([
			"[checkpoint #7] 1 file changed, 1 insertion(+), 1 deletion(-)",
		]);
	});

	it("marks aborted and no-change runs", () => {
		expect(formatCheckpointEntry(okData({ aborted: true }), false)[0]).toContain("aborted");
		expect(formatCheckpointEntry(okData({ shortstat: "", patchPreview: "" }), false)[0]).toContain(
			"No workspace changes",
		);
	});

	it("expands refs, commits, and the patch preview", () => {
		const lines = formatCheckpointEntry(okData(), true).join("\n");
		expect(lines).toContain("refs/pi/checkpoint/c2Vzc2lvbg/run-7");
		expect(lines).toContain("baseline: aaaaaaa");
		expect(lines).toContain("result: bbbbbbb");
		expect(lines).toContain("diff --git a/file b/file");
	});

	it("marks truncation and preview failures distinctly", () => {
		expect(formatCheckpointEntry(okData({ previewTruncated: true }), true).join("\n")).toContain(
			"/checkpoint 7",
		);
		const failed = formatCheckpointEntry(
			okData({ shortstat: null, patchPreview: null, previewError: "patch failed" }),
			true,
		).join("\n");
		expect(failed).toContain("Diff preview unavailable");
		expect(failed).toContain("patch failed");
	});

	it("renders capture errors and malformed data without throwing", () => {
		const error = {
			...okData(),
			status: "error" as const,
			settledAt: null,
			stage: "baseline" as const,
			baselineCommit: null,
			error: "capture failed",
		};
		expect(formatCheckpointEntry(error, false).join("\n")).toContain("capture failed");
		expect(formatCheckpointEntry({ version: 99 }, true)).toEqual([
			"[checkpoint] Invalid or unsupported checkpoint data",
		]);
	});
});

describe("createCheckpointRenderer", () => {
	it("renders formatted lines as a real TUI component", () => {
		const renderer = createCheckpointRenderer();
		const entry: CustomEntry = {
			type: "custom",
			customType: CHECKPOINT_ENTRY_TYPE,
			data: okData(),
			id: "checkpoint-entry",
			parentId: "assistant",
			timestamp: "2026-11-21T00:00:01.000Z",
		};
		const options: EntryRenderOptions = {
			expanded: true,
			keyText: () => "",
			keyHint: (_keybinding, description) => description,
		};
		const theme = {
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
		} as unknown as Parameters<EntryRenderer>[2];
		const component = renderer(entry, options, theme);

		expect(component).toBeDefined();
		expect(component?.render(120).join("\n")).toContain("checkpoint #7");
	});
});
