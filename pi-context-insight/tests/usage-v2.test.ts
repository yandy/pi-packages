import { describe, expect, it } from "vitest";
import { allocateCost, collectUsageLedger, summarizeUsage } from "../src/session/usage";
import { assistantEntry, usage } from "./helpers/entries";

describe("usage v2", () => {
	it("classifies costBasis from totalFromProvider flags", () => {
		const mixed = summarizeUsage(
			collectUsageLedger([
				assistantEntry({ content: [], usage: usage(1, 1, 0, 0, 0.1, true), timestamp: 1 }),
				assistantEntry({ content: [], usage: usage(1, 1, 0, 0, 0.1, false), timestamp: 2 }),
			]),
		);
		expect(mixed.total.costBasis).toBe("mixed");
		const provider = summarizeUsage(
			collectUsageLedger([assistantEntry({ content: [], usage: usage(1, 1, 0, 0, 0.1, true), timestamp: 1 })]),
		);
		expect(provider.total.costBasis).toBe("provider");
		const estimate = summarizeUsage(
			collectUsageLedger([assistantEntry({ content: [], usage: usage(1, 1, 0, 0, 0.1, false), timestamp: 1 })]),
		);
		expect(estimate.total.costBasis).toBe("estimate");
	});
	it("allocates the whole step cost across categories", () => {
		const [step] = allocateCost([
			{
				index: 0,
				turn: 1,
				stepInTurn: 1,
				timestamp: 0,
				durationEstimated: false,
				activeMs: 0,
				idleMs: 0,
				sums: { user: 100, toolResults: 300 } as never,
				estimatedTotal: 400,
				actual: { prompt: 400, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.4, costFromProvider: true },
				delta: {},
				deltaTotal: 0,
				itemRanges: [],
				eventIds: [],
				hasDetails: true,
				brief: { inputs: [], replies: [] },
				system: null,
			},
		]);
		const sum = Object.values(step?.costByCategory ?? {}).reduce((a, b) => a + b, 0);
		expect(Math.abs(sum - 0.4)).toBeLessThan(1e-9);
		expect(step?.costByCategory?.unattributed).toBeUndefined();
	});
	it("skips allocation without actual usage", () => {
		const [step] = allocateCost([{ sums: {} as never, estimatedTotal: 0, actual: undefined } as never]);
		expect(step?.costByCategory).toBeUndefined();
	});
});
