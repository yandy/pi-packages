import { describe, expect, it } from "vitest";
import { renderActivity } from "../src/render/activity";
import { renderEvents } from "../src/render/events";
import { renderFamily } from "../src/render/family";
import { buildReport } from "../src/report";
import { fakeContext } from "./helpers/ctx";
import {
	assistantEntry,
	compactionEntry,
	resetEntryIds,
	systemEntry,
	tool,
	toolCall,
	toolResultEntry,
	usage,
	userEntry,
} from "./helpers/entries";

function report() {
	resetEntryIds();
	const entries = [
		systemEntry({ sections: { preamble: "base" }, toolsAdded: [tool("read")], timestamp: 0 }),
		userEntry("hi", 1),
		assistantEntry({ content: [toolCall("c1", "read", { path: "src/a.ts" })], usage: usage(100, 10, 0, 0, 0.1), timestamp: 2 }),
		toolResultEntry({ toolCallId: "c1", toolName: "read", content: "body", durationMs: 40, timestamp: 3 }),
		assistantEntry({ content: [toolCall("c2", "bash", { command: "npm test" })], usage: usage(120, 10, 0, 0, 0.1), timestamp: 4 }),
		toolResultEntry({ toolCallId: "c2", toolName: "bash", content: "Command exited with code 1", isError: true, durationMs: 12_000, timestamp: 16_000 }),
		compactionEntry({ summary: "S", tokensBefore: 500, firstKeptEntryId: "e2", timestamp: 17_000 }),
		assistantEntry({ content: [{ type: "text", text: "done" }], usage: usage(140, 10, 0, 0, 0.1), timestamp: 18_000 }),
	];
	const toolInfos = [
		{ name: "read", description: "", parameters: {}, exposure: "default", sourceInfo: { path: "builtin:read", source: "builtin", scope: "user", origin: "package" } },
		{ name: "bash", description: "", parameters: {}, exposure: "default", sourceInfo: { path: "builtin:bash", source: "builtin", scope: "user", origin: "package" } },
	];
	return buildReport(fakeContext({ entries }, { getAllTools: () => toolInfos }), { mode: "full", lang: "en" });
}

describe("renderEvents", () => {
	it("renders filter tabs and event rows with kind and position", () => {
		const html = renderEvents(report());
		expect(html).toContain('data-filter-group="events"');
		const rows = [...html.matchAll(/data-event="(\d+)" data-kind="([^"]+)"/g)];
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.some((row) => row[2] === "compaction")).toBe(true);
	});
	it("shows an empty state when there are no events", () => {
		resetEntryIds();
		const entries = [userEntry("hi", 1), assistantEntry({ content: [{ type: "text", text: "x" }], timestamp: 2 })];
		const html = renderEvents(buildReport(fakeContext({ entries }), { mode: "full", lang: "en" }));
		expect(html).toContain('data-empty="events"');
	});
});

describe("renderActivity", () => {
	it("renders tool rows with source labels and per-step distribution", () => {
		const html = renderActivity(report());
		expect(html).toContain('data-tool-row="read"');
		expect(html).toContain('data-tool-source="builtin"');
	});
	it("renders file rows with filter attributes", () => {
		const html = renderActivity(report());
		expect(html).toContain('data-filter-group="files"');
		expect(html).toContain('data-path="src/a.ts"');
	});
	it("renders command rows with status and program", () => {
		const html = renderActivity(report());
		expect(html).toContain('data-program="npm"');
		expect(html).toContain('data-status="error"');
		expect(html).toContain('data-command-filter="failed"');
	});
	it("shows empty states for an idle session", () => {
		resetEntryIds();
		const html = renderActivity(buildReport(fakeContext({ entries: [userEntry("hi", 1)] }), { mode: "full", lang: "en" }));
		expect(html).toContain('data-empty="files"');
		expect(html).toContain('data-empty="commands"');
	});
});

describe("renderFamily", () => {
	it("renders member cards and the delegation table", () => {
		const base = report();
		const withFamily = {
			...base,
			family: {
				members: [
					{
						id: "a1",
						parentId: "s1",
						depth: 1,
						status: "completed" as const,
						record: { id: "a1", type: "general-purpose", description: "audit", status: "completed", startedAt: 1, completedAt: 2, result: "done" },
						steps: 4,
						brief: "audit the parser",
					},
					{
						id: "a2",
						parentId: "s1",
						depth: 1,
						status: "untracked" as const,
						steps: 1,
					},
				],
				children: [],
			},
		};
		const html = renderFamily(withFamily);
		expect(html).toContain('data-member="a1"');
		expect(html).toContain('data-status="untracked"');
		expect(html).toContain("audit the parser");
	});
	it("renders nothing when the session has no subagents", () => {
		expect(renderFamily(report())).toBe("");
	});
});
