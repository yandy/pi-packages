import { describe, expect, it } from "vitest";
import { renderTokens } from "../src/render/tokens";
import { renderCurrentContext } from "../src/render/context";
import { renderTimeline } from "../src/render/timeline";
import { collectToolExecutions } from "../src/activity/tools";
import { collectCommands } from "../src/activity/commands";
import { computeTiming } from "../src/session/timing";
import { buildReport } from "../src/report";
import { fakeContext } from "./helpers/ctx";
import { assistantEntry, resetEntryIds, toolCall, toolResultEntry, usage, userEntry } from "./helpers/entries";

describe("unknown versus zero in renderers", () => {
	it("shows — instead of ≈0 for a session without a system prompt", () => {
		resetEntryIds();
		const entries = [userEntry("hi", 1), assistantEntry({ content: [{ type: "text", text: "x" }], usage: usage(50, 5, 0, 0, 0), timestamp: 2 })];
		const report = buildReport(fakeContext({ entries }), { mode: "full", lang: "en" });
		const html = renderTokens(report);
		expect(html).toContain('data-unknown="system"');
		expect(html).not.toContain('data-cat="systemBase"><td>');
	});
});

describe("abnormal numbers", () => {
	it("never renders NaN for a non-finite occupancy", () => {
		const report = buildReport(fakeContext({ entries: [userEntry("hi", 1)] }), { mode: "full", lang: "en" });
		const html = renderCurrentContext({ ...report, currentContext: { ...report.currentContext, tokens: Number.NaN, percent: Number.NaN, window: Number.NaN } });
		expect(html).not.toContain("NaN");
	});
	it("ignores non-finite durations when timing", () => {
		const timing = computeTiming({
			entries: [userEntry("a", 0), assistantEntry({ content: [], timestamp: 1 })],
			steps: [],
			executions: [{ name: "read", nested: false, durationMs: Number.NaN, durationEstimated: true }],
		});
		expect(timing.toolMs).toBe(0);
		expect(Number.isFinite(timing.modelMs)).toBe(true);
	});
	it("caps the timeline note when there are too many steps", () => {
		const report = buildReport(fakeContext({ entries: [userEntry("hi", 1)] }), { mode: "full", lang: "en" });
		const steps = Array.from({ length: 4005 }, (_, index) => ({
			...report.steps[0],
			index,
			turn: 1,
			stepInTurn: index + 1,
			estimatedTotal: 10,
			sums: {} as never,
			delta: {},
			deltaTotal: 0,
			itemRanges: [] as Array<[number, number]>,
			eventIds: [] as number[],
			hasDetails: true,
			timestamp: index,
		}));
		const html = renderTimeline({ ...report, steps, turns: [] });
		expect(html).toContain('data-timeline-cap="4000"');
	});
});

describe("tool and command status edges", () => {
	it("does not fabricate an execution for an orphan result", () => {
		resetEntryIds();
		const executions = collectToolExecutions({
			entries: [toolResultEntry({ toolCallId: "ghost", toolName: "read", content: "x", timestamp: 5 })],
		});
		expect(executions).toHaveLength(0);
	});
	it("keeps an unknown exit code unknown", () => {
		resetEntryIds();
		const entries = [
			assistantEntry({ content: [toolCall("c1", "bash", { command: "boom" })], timestamp: 1 }),
			toolResultEntry({ toolCallId: "c1", toolName: "bash", content: "something failed", isError: true, timestamp: 2 }),
		];
		const record = collectCommands({ entries }).records[0];
		expect(record?.status).toBe("error");
		expect(record?.exitCode).toBeUndefined();
		expect(record?.exitInferred).toBe(false);
	});
});
