import { describe, expect, it } from "vitest";
import { buildPayload } from "../src/render/payload";
import { buildReport } from "../src/report";
import { fakeContext } from "./helpers/ctx";
import { assistantEntry, resetEntryIds, systemEntry, toolCall, toolResultEntry, usage, userEntry } from "./helpers/entries";

interface Payload {
	steps: Array<{ i: number; ranges: Array<[number, number]>; details: boolean; total: number }>;
	items: Array<{ id: number; cat: string }>;
}

describe("interactive payload", () => {
	it("carries per-step item ranges so a step can be rebuilt without others' items", () => {
		resetEntryIds();
		const entries = [systemEntry({ sections: { preamble: "base" }, timestamp: 0 })];
		let t = 1;
		for (let i = 0; i < 3; i++) {
			entries.push(userEntry(`question ${i}`, t++));
			entries.push(assistantEntry({ content: [toolCall(`c${i}`, "read", { path: `f${i}` })], usage: usage(100, 10, 0, 0, 0.1), timestamp: t++ }));
			entries.push(toolResultEntry({ toolCallId: `c${i}`, toolName: "read", content: `body ${i}`, timestamp: t++ }));
		}
		const report = buildReport(fakeContext({ entries }), { mode: "full", lang: "en" });
		const payload = JSON.parse(buildPayload(report)) as Payload;
		expect(payload.steps.every((step) => Array.isArray(step.ranges))).toBe(true);
		const first = payload.steps[0];
		const last = payload.steps[payload.steps.length - 1];
		const inFirst = new Set<number>();
		for (const [start, end] of first?.ranges ?? []) for (let id = start; id <= end; id++) inFirst.add(id);
		const inLast = new Set<number>();
		for (const [start, end] of last?.ranges ?? []) for (let id = start; id <= end; id++) inLast.add(id);
		for (const id of inFirst) expect(inLast.has(id)).toBe(true);
		expect(inLast.size).toBeGreaterThan(inFirst.size);
	});
});
