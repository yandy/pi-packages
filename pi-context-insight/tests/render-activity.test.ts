import { describe, expect, it } from "vitest";
import { renderActivity, sparkSeries } from "../src/render/activity";
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
		expect(html).toContain('<input type="search" data-filter-group="events"');
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
	it("splits activity into a tools card and a two-up files/commands row", () => {
		const html = renderActivity(report());
		expect(html).toContain('data-card="tools"');
		expect(html).toContain('data-card="files"');
		expect(html).toContain('data-card="commands"');
		expect(html).toContain("span-6");
		expect(html).not.toContain("<hr");
	});
	it("bars each tool row by call count", () => {
		expect(renderActivity(report())).toContain('data-bar="read"');
	});
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
	it("offers an all filter that is pressed by default", () => {
		const html = renderActivity(report());
		expect(html).toMatch(/<button type="button" data-file-filter="all" aria-pressed="true">/);
		expect(html).toContain('data-file-filter="read"');
	});
	it("scrolls the file and command lists instead of growing the card", () => {
		const html = renderActivity(report());
		expect(html).toContain('data-scroll-list="files"');
		expect(html).toContain('data-scroll-list="commands"');
	});
	it("caps the per-step spark and keeps the counts", () => {
		const short = sparkSeries([0, 2, 0, 1]);
		expect(short).toEqual([
			{ from: 0, to: 0, count: 0 },
			{ from: 1, to: 1, count: 2 },
			{ from: 2, to: 2, count: 0 },
			{ from: 3, to: 3, count: 1 },
		]);
		const long = sparkSeries(new Array(1000).fill(1), 40);
		expect(long).toHaveLength(40);
		expect(long.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(1000);
		expect(long.at(-1)?.to).toBe(999);
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
	const family = {
		members: [
			{
				id: "a1",
				parentId: "s1",
				depth: 1,
				status: "completed" as const,
				record: {
					id: "a1",
					type: "general-purpose",
					description: "audit",
					status: "completed",
					startedAt: 1,
					completedAt: 2,
					result: "done",
				},
				steps: 4,
				brief: "audit the parser",
				child: { id: "a1", steps: 4, records: [], context: { tokens: 80_000, window: 200_000, percent: 40 } },
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
	};
	const withFamilyReport = () => ({ ...report(), family });

	it("renders member cards and the delegation table", () => {
		const html = renderFamily(withFamilyReport());
		expect(html).toContain('data-member="a1"');
		expect(html).toContain('data-status="untracked"');
		expect(html).toContain("audit the parser");
	});
	it("gives each member a third-width card with an occupancy bar", () => {
		const html = renderFamily(withFamilyReport());
		expect(html).toContain("span-4");
		expect(html).toContain('class="bar"');
		expect(html).toContain('data-member="a1"');
	});
	it("clamps long brief and result text", () => {
		expect(renderFamily(withFamilyReport())).toContain("clamp-2");
	});
	it("renders nothing when the session has no subagents", () => {
		expect(renderFamily(report())).toBe("");
	});
});
