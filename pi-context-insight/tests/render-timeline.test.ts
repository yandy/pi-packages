import { describe, expect, it } from "vitest";
import { renderStepDetail } from "../src/render/detail";
import { renderTimeline, timelineGeometry } from "../src/render/timeline";
import { buildReport } from "../src/report";
import { fakeContext } from "./helpers/ctx";
import {
	assistantEntry,
	compactionEntry,
	resetEntryIds,
	systemEntry,
	toolCall,
	toolResultEntry,
	usage,
	userEntry,
} from "./helpers/entries";

function report(steps = 3) {
	resetEntryIds();
	const entries = [systemEntry({ sections: { preamble: "base" }, timestamp: 0 })];
	let t = 1;
	for (let i = 0; i < steps; i++) {
		entries.push(userEntry(`question ${i}`, t++));
		entries.push(assistantEntry({ content: [toolCall(`c${i}`, "read", { path: `f${i}` })], usage: usage(100 + i * 10, 10, 0, 0, 0.1), durationMs: 100, timestamp: t++ }));
		entries.push(toolResultEntry({ toolCallId: `c${i}`, toolName: "read", content: `body ${i}`, timestamp: t++ }));
	}
	return buildReport(fakeContext({ entries }), { mode: "full", lang: "en" });
}

describe("renderTimeline", () => {
	it("draws one column per step", () => {
		const html = renderTimeline(report(4));
		expect(html.match(/data-step="\d+"/g)).toHaveLength(4);
	});
	it("sizes the stack by the largest step", () => {
		const r = report(3);
		const html = renderTimeline(r);
		const max = Math.max(...r.steps.map((step) => step.estimatedTotal));
		const heights = [...html.matchAll(/data-step="0"[^>]*>([\s\S]*?)<\/g>/g)]
			.flatMap((match) => [...(match[1] ?? "").matchAll(/height="([\d.]+)"/g)])
			.map((height) => Number(height[1]));
		const total = heights.reduce((sum, value) => sum + value, 0);
		const expected = Math.round((r.steps[0]!.estimatedTotal / max) * timelineGeometry(3).chartH);
		expect(Math.abs(total - expected)).toBeLessThanOrEqual(1);
	});
	it("offers only the wired switches", () => {
		const html = renderTimeline(report(2));
		for (const value of ["total", "delta", "step", "turn", "duration", "overview"]) {
			expect(html).toContain(`data-value="${value}"`);
		}
		expect(html).not.toContain('data-value="adaptive"');
		expect(html).not.toContain('data-toggle="dna"');
	});
	it("widens bars for short sessions and narrows them for long ones", () => {
		expect(timelineGeometry(10).barW).toBe(24);
		expect(timelineGeometry(400).barW).toBe(6);
		expect(timelineGeometry(150).barW).toBe(7);
		expect(timelineGeometry(0).barW).toBe(24);
	});
	it("draws three y ticks and a flag lane", () => {
		const html = renderTimeline(report(4));
		expect((html.match(/class="tick"/g) ?? []).length).toBe(3);
		expect(html).toContain("data-flag-lane");
	});
	it("renders a single-column timeline for a one-step session", () => {
		const html = renderTimeline(report(1));
		expect((html.match(/data-step="\d+"/g) ?? []).length).toBe(1);
		expect(html).not.toContain('height="-');
		expect(html).not.toContain("NaN");
	});
	it("publishes the geometry the client redraws with", () => {
		const html = renderTimeline(report(3));
		expect(html).toContain("data-timeline-svg");
		expect(html).toContain('data-geometry="');
	});
	it("marks compaction as a flag on its step", () => {
		resetEntryIds();
		const entries = [
			systemEntry({ sections: { preamble: "base" }, timestamp: 0 }),
			userEntry("hi", 1),
			assistantEntry({ content: [{ type: "text", text: "a" }], timestamp: 2 }),
			compactionEntry({ summary: "S", tokensBefore: 400, firstKeptEntryId: "e2", timestamp: 3 }),
			assistantEntry({ content: [{ type: "text", text: "b" }], timestamp: 4 }),
		];
		const html = renderTimeline(buildReport(fakeContext({ entries }), { mode: "full", lang: "en" }));
		expect(html).toContain('data-flag="compaction"');
	});
	it("renders a turn band with one block per turn", () => {
		const html = renderTimeline(report(3));
		expect(html.match(/data-turn-block="\d+"/g)).toHaveLength(3);
	});
});

describe("renderStepDetail", () => {
	it("pre-renders one panel per step and shows the last", () => {
		const html = renderStepDetail(report(3));
		expect(html.match(/data-step-panel="\d+"/g)).toHaveLength(3);
		expect(html).toContain('data-step-panel="2"');
		expect(html).not.toContain('data-step-panel="2" hidden');
		expect(html).toContain('data-step-panel="0" hidden');
	});
	it("locates chips only for steps with details", () => {
		const html = renderStepDetail(report(3));
		expect(html).toContain("data-locate-item=");
	});
});
