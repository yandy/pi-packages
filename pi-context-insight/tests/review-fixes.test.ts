import { describe, expect, it } from "vitest";
import { renderDocument } from "../src/render/document";
import { renderTimeline } from "../src/render/timeline";
import { renderActivity } from "../src/render/activity";
import { renderFamily } from "../src/render/family";
import { buildReport } from "../src/report";
import { fakeContext } from "./helpers/ctx";
import { assistantEntry, resetEntryIds, systemEntry, toolCall, toolResultEntry, usage, userEntry } from "./helpers/entries";

describe("escaping boundaries", () => {
	it("escapes the session name and id in the title and body", () => {
		resetEntryIds();
		const entries = [userEntry("hi", 1), assistantEntry({ content: [{ type: "text", text: "x" }], timestamp: 2 })];
		const report = buildReport(
			fakeContext({ entries, name: "</title><script>alert(1)</script>", id: "<img src=x onerror=1>" }, { cwd: "/repo/<b>" }),
			{ mode: "full", lang: "en" },
		);
		const html = renderDocument({ report, body: "", payload: "{}" });
		expect(html).not.toContain("</title><script>");
		expect(html).not.toContain("<img src=x");
		expect(html).toContain("&lt;/title&gt;");
	});
	it("escapes interpolated warnings", () => {
		resetEntryIds();
		const entries = [userEntry("hi", 1), assistantEntry({ content: [], timestamp: 2 })];
		const report = buildReport(fakeContext({ entries }), { mode: "full", lang: "en" });
		const evil = { ...report, warnings: [{ key: "warning.brokenChild", params: { id: "<svg onload=1>" } }] };
		expect(renderDocument({ report: evil, body: "", payload: "{}" })).not.toContain("<svg onload");
	});
});

describe("short mode carries no free text", () => {
	it("hides commands, delegations, briefs and results", () => {
		resetEntryIds();
		const entries = [
			systemEntry({ sections: { preamble: "base" }, timestamp: 0 }),
			userEntry("user-sentinel", 1),
			assistantEntry({ content: [toolCall("c1", "bash", { command: "echo command-sentinel" })], usage: usage(10, 5, 0, 0, 0), timestamp: 2 }),
			toolResultEntry({ toolCallId: "c1", toolName: "bash", content: "output-sentinel", timestamp: 3 }),
		];
		const report = buildReport(fakeContext({ entries }), { mode: "short", lang: "en" });
		const html = renderDocument({
			report,
			body: renderActivity(report),
			payload: "{}",
		});
		expect(html).not.toContain("command-sentinel");
		expect(html).not.toContain("output-sentinel");
		expect(report.commands.records[0]?.command).toBe("");
	});
	it("hides family descriptions, briefs and results", () => {
		const base = buildReport(fakeContext({ entries: [userEntry("hi", 1)] }), { mode: "short", lang: "en" });
		const familyReport = {
			...base,
			family: {
				members: [
					{
						id: "a1",
						parentId: "s1",
						depth: 1,
						status: "completed" as const,
						record: { id: "a1", type: "explore", description: "desc-sentinel", status: "completed", startedAt: 1, completedAt: 2, result: "result-sentinel" },
						steps: 2,
						brief: "brief-sentinel",
					},
				],
				children: [],
			},
		};
		const html = renderFamily(familyReport);
		expect(html).not.toContain("desc-sentinel");
		expect(html).not.toContain("brief-sentinel");
		expect(html).not.toContain("result-sentinel");
	});
});

describe("unknown versus zero", () => {
	it("shows — for system categories when no system prompt was recorded", () => {
		resetEntryIds();
		const entries = [userEntry("hi", 1), assistantEntry({ content: [{ type: "text", text: "x" }], usage: usage(50, 5, 0, 0, 0), timestamp: 2 })];
		const report = buildReport(fakeContext({ entries }), { mode: "full", lang: "en" });
		expect(report.steps[0]?.system).toBeNull();
		expect(report.currentContext.unknownSystem).toBe(true);
	});
});


