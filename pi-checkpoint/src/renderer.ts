import type { EntryRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { parseCheckpointEntryData } from "./session.js";

export function formatCheckpointEntry(value: unknown, expanded: boolean): string[] {
	const data = parseCheckpointEntryData(value);
	if (!data) return ["[checkpoint] Invalid checkpoint data"];
	if (data.status === "error") {
		const lines = [`[checkpoint #${data.runNumber}] ${data.stage} capture failed: ${data.error}`];
		if (expanded) {
			lines.push(`ref: ${data.ref}`);
			if (data.baselineCommit) lines.push(`baseline: ${data.baselineCommit.slice(0, 7)}`);
		}
		return lines;
	}

	const summary = data.shortstat ?? (data.patchPreview === null ? "Diff preview unavailable" : "Workspace changes");
	const lines = [`[checkpoint #${data.runNumber}] ${summary || "No workspace changes"}${data.aborted ? " (aborted)" : ""}`];
	if (!expanded) return lines;

	lines.push(`ref: ${data.ref}`, `baseline: ${data.baselineCommit.slice(0, 7)}`, `result: ${data.resultCommit.slice(0, 7)}`);
	if (data.previewError) lines.push(`preview error: ${data.previewError}`);
	if (data.patchPreview) lines.push("", ...data.patchPreview.split("\n"));
	if (data.previewTruncated) {
		lines.push("", `Preview truncated; run /checkpoint ${data.runNumber} for the full diff command`);
	}
	return lines;
}

export function createCheckpointRenderer(): EntryRenderer {
	return (entry, { expanded }, theme) => {
		const lines = formatCheckpointEntry(entry.data, expanded);
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		for (const [index, line] of lines.entries()) {
			box.addChild(new Text(index === 0 ? theme.fg("accent", line) : line, 0, 0));
		}
		return box;
	};
}
