import { describe, expect, it } from "vitest";
import { computeTiming } from "../src/session/timing";
import type { Step } from "../src/session/steps";
import { assistantEntry, resetEntryIds, tool, toolCall, toolResultEntry, usage, userEntry } from "./helpers/entries";

function step(index: number, timestamp: number, output = 0): Step {
	return {
		index,
		turn: 1,
		stepInTurn: index + 1,
		timestamp,
		durationEstimated: false,
		activeMs: 0,
		idleMs: 0,
		sums: {} as never,
		estimatedTotal: 0,
		delta: {},
		deltaTotal: 0,
		itemRanges: [],
		eventIds: [],
		hasDetails: true,
		brief: { inputs: [], replies: [] },
		system: null,
		...(output > 0 ? { actual: { prompt: 0, output, cacheRead: 0, cacheWrite: 0, cost: 0, costFromProvider: true } } : {}),
	};
}

describe("computeTiming", () => {
	it("prefers durationMs and flags the estimate when it is missing", () => {
		resetEntryIds();
		const precise = computeTiming({
			entries: [userEntry("hi", 0), assistantEntry({ content: [], durationMs: 900, timestamp: 1000 })],
			steps: [step(0, 1000)],
			executions: [],
		});
		expect(precise.estimated.model).toBe(false);
		expect(precise.modelMs).toBe(900);
		const rough = computeTiming({
			entries: [userEntry("hi", 0), assistantEntry({ content: [], timestamp: 1000 })],
			steps: [step(0, 1000)],
			executions: [],
		});
		expect(rough.estimated.model).toBe(true);
		expect(rough.modelMs).toBe(1000);
	});
	it("excludes idle gaps of 120s or more", () => {
		resetEntryIds();
		const entries = [
			userEntry("a", 0),
			assistantEntry({ content: [{ type: "text", text: "x" }], durationMs: 1000, timestamp: 1000 }),
			userEntry("b", 602_000),
			assistantEntry({ content: [{ type: "text", text: "y" }], durationMs: 1000, timestamp: 603_000 }),
		];
		const steps = [step(0, 1000), step(1, 603_000)];
		const timing = computeTiming({ entries, steps, executions: [] });
		expect(timing.idleMs).toBeGreaterThanOrEqual(600_000);
		expect(timing.activeMs).toBeLessThan(timing.wallMs);
		expect(steps[0]?.idleMs).toBeGreaterThanOrEqual(600_000);
	});
	it("counts ask_user tool time as idle", () => {
		resetEntryIds();
		const entries = [
			userEntry("a", 0),
			assistantEntry({ content: [toolCall("c1", "ask_user")], durationMs: 1000, timestamp: 1000 }),
			toolResultEntry({ toolCallId: "c1", toolName: "ask_user", content: "answer", durationMs: 30_000, timestamp: 31_000 }),
			assistantEntry({ content: [{ type: "text", text: "done" }], durationMs: 500, timestamp: 32_000 }),
		];
		const steps = [step(0, 1000), step(1, 32_000)];
		const timing = computeTiming({
			entries,
			steps,
			executions: [{ name: "ask_user", nested: false, durationMs: 30_000, durationEstimated: false }],
		});
		expect(timing.idleMs).toBeGreaterThanOrEqual(30_000);
	});
	it("does not double count nested tool calls", () => {
		const timing = computeTiming({
			entries: [userEntry("a", 0), assistantEntry({ content: [], timestamp: 1 })],
			steps: [step(0, 1)],
			executions: [
				{ name: "code", nested: false, durationMs: 5000, durationEstimated: false },
				{ name: "bash", nested: true, durationMs: 2000, durationEstimated: false },
			],
		});
		expect(timing.toolMs).toBe(5000);
		expect(timing.toolCalls).toBe(2);
	});
	it("computes tps from model time", () => {
		const timing = computeTiming({
			entries: [userEntry("a", 0), assistantEntry({ content: [], durationMs: 2000, timestamp: 1000 })],
			steps: [step(0, 1000, 1000)],
			executions: [],
		});
		expect(timing.tps).toBeCloseTo(500, 5);
	});
});
