import { describe, expect, it } from "vitest";
import { buildReport } from "../src/report";
import { fakeContext } from "./helpers/ctx";
import {
	assistantEntry,
	resetEntryIds,
	systemEntry,
	tool,
	toolCall,
	toolResultEntry,
	usage,
	userEntry,
} from "./helpers/entries";

function session() {
	resetEntryIds();
	return [
		systemEntry({ sections: { preamble: "base" }, toolsAdded: [tool("read")], timestamp: 1 }),
		userEntry("hi", 2),
		assistantEntry({ content: [{ type: "text", text: "answer" }], usage: usage(100, 10, 0, 0, 0.1), timestamp: 3 }),
	];
}

describe("buildReport", () => {
	it("assembles a schema-2 report with steps and items", () => {
		const report = buildReport(fakeContext({ entries: session() }), { mode: "full", lang: "en" });
		expect(report.schema).toBe(2);
		expect(report.steps.length).toBeGreaterThan(0);
		expect(report.items.length).toBeGreaterThan(0);
		expect(report.warnings.every((warning) => typeof warning.key === "string")).toBe(true);
		expect(report.metadata.id).toBe("s1");
		expect(report.family.children).toEqual([]);
	});
	it("drops every body in short mode", () => {
		const report = buildReport(fakeContext({ entries: session() }), { mode: "short", lang: "en" });
		expect(report.bodies).toHaveLength(0);
		expect(report.items.every((item) => item.textIndex === null)).toBe(true);
	});
	it("records a truncation entry when a body exceeds its cap", () => {
		resetEntryIds();
		const entries = [
			userEntry("hi", 1),
			assistantEntry({ content: [toolCall("c1", "read", { path: "a" })], timestamp: 2 }),
			toolResultEntry({ toolCallId: "c1", toolName: "read", content: "x".repeat(9000), timestamp: 3 }),
		];
		const report = buildReport(fakeContext({ entries }), { mode: "full", lang: "en" });
		expect(report.truncation.some((entry) => entry.kind === "body")).toBe(true);
	});
	it("stays inside the payload budget for a 300-step fixture", () => {
		resetEntryIds();
		const entries = [systemEntry({ sections: { preamble: "base" }, timestamp: 0 })];
		let t = 1;
		for (let i = 0; i < 300; i++) {
			entries.push(userEntry(`q${i}`, t++));
			entries.push(assistantEntry({ content: [{ type: "text", text: `a${i}` }], timestamp: t++ }));
			entries.push(toolResultEntry({ toolCallId: `c${i}`, toolName: "read", content: "body", timestamp: t++ }));
		}
		const report = buildReport(fakeContext({ entries }), { mode: "full", lang: "en" });
		const bytes = Buffer.byteLength(JSON.stringify({ items: report.items, bodies: report.bodies }), "utf8");
		expect(bytes).toBeLessThan(6 * 1024 * 1024);
		expect(report.truncation.some((entry) => entry.kind === "stepDetails")).toBe(false);
	});
	it("warns when the session never recorded a system prompt", () => {
		resetEntryIds();
		const entries = [userEntry("hi", 1), assistantEntry({ content: [{ type: "text", text: "x" }], timestamp: 2 })];
		const report = buildReport(fakeContext({ entries }), { mode: "full", lang: "en" });
		expect(report.warnings.map((warning) => warning.key)).toContain("warning.noSystem");
		expect(report.kpis.modelCalls).toBe(1);
	});
});
