import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { extractContextEvents } from "../src/events";

describe("context events", () => {
	it("extracts chronological metadata without summary or result bodies", () => {
		const entries: SessionEntry[] = [
			{ type: "compaction", id: "compact", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", summary: "SENSITIVE SUMMARY", firstKeptEntryId: "compact", tokensBefore: 5_000 },
			{ type: "branch_summary", id: "branch", parentId: null, timestamp: "2026-01-01T00:01:00.000Z", fromId: "old-leaf", summary: "SECRET BRANCH" },
			{ type: "context_edit", id: "edit", parentId: null, timestamp: "2026-01-01T00:02:00.000Z", targetId: "target-entry", replacement: null },
			{ type: "model_change", id: "model", parentId: null, timestamp: "2026-01-01T00:03:00.000Z", provider: "provider-a", modelId: "model-a" },
			{ type: "thinking_level_change", id: "thinking", parentId: null, timestamp: "2026-01-01T00:04:00.000Z", thinkingLevel: "high" },
			{
				type: "custom",
				id: "subagent",
				parentId: null,
				timestamp: "2026-01-01T00:05:00.000Z",
				customType: "subagents:record",
				data: { id: "agent-1", type: "Explore", description: "Inspect context", status: "completed", result: "SENSITIVE RESULT" },
			},
		];

		const events = extractContextEvents(entries);
		expect(events).toEqual([
			{ id: "compact", timestamp: "2026-01-01T00:00:00.000Z", type: "compaction", label: "Compaction", tokensBefore: 5_000 },
			{ id: "branch", timestamp: "2026-01-01T00:01:00.000Z", type: "branch_summary", label: "Branch summary", targetId: "old-leaf" },
			{ id: "edit", timestamp: "2026-01-01T00:02:00.000Z", type: "context_edit", label: "Context edit", targetId: "target-entry" },
			{ id: "model", timestamp: "2026-01-01T00:03:00.000Z", type: "model_change", label: "Model: provider-a/model-a" },
			{ id: "thinking", timestamp: "2026-01-01T00:04:00.000Z", type: "thinking_level_change", label: "Thinking: high" },
			{ id: "subagent", timestamp: "2026-01-01T00:05:00.000Z", type: "subagent", label: "Subagent completed: agent-1 · Inspect context", targetId: "agent-1" },
		]);
		expect(JSON.stringify(events)).not.toContain("SENSITIVE");
		expect(JSON.stringify(events)).not.toContain("SECRET");
	});

	it("ignores unrelated and malformed custom entries", () => {
		const entries: SessionEntry[] = [
			{ type: "custom", id: "other", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", customType: "other", data: { value: 1 } },
			{ type: "custom", id: "bad", parentId: null, timestamp: "2026-01-01T00:01:00.000Z", customType: "subagents:record", data: null },
		];
		expect(extractContextEvents(entries)).toEqual([]);
	});
});
