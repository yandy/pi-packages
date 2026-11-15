import { describe, expect, it } from "vitest";
import {
	getLifetimeTotal,
	getSessionContextPercent,
	getSessionTokens,
	snapshotIsZero,
	sumSessionUsage,
	toUsageEntryUsage,
	usageDelta,
	type SessionUsageSnapshot,
} from "../../src/lifecycle/usage";

// Session usage snapshots — cost settle basis (2026-11-15 subagent cost design)
describe("session usage snapshots", () => {
	const CURRENT: SessionUsageSnapshot = {
		input: 1000,
		output: 200,
		cacheRead: 500,
		cacheWrite: 50,
		totalTokens: 1750,
		cost: 0.05,
	};
	const BASELINE: SessionUsageSnapshot = {
		input: 600,
		output: 100,
		cacheRead: 200,
		cacheWrite: 0,
		totalTokens: 900,
		cost: 0.02,
	};

	describe("usageDelta", () => {
		it("returns a copy of current when last is undefined", () => {
			expect(usageDelta(CURRENT, undefined)).toEqual(CURRENT);
		});

		it("subtracts each field of last from current", () => {
			const delta = usageDelta(CURRENT, BASELINE);
			expect(delta.input).toBe(400);
			expect(delta.output).toBe(100);
			expect(delta.cacheRead).toBe(300);
			expect(delta.cacheWrite).toBe(50);
			expect(delta.totalTokens).toBe(850);
			// Float-safe: 0.05 - 0.02 is not exactly 0.03 in binary.
			expect(delta.cost).toBeCloseTo(0.03, 10);
		});
	});

	describe("snapshotIsZero", () => {
		it("is true for an all-zero snapshot", () => {
			expect(
				snapshotIsZero({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 }),
			).toBe(true);
		});

		it("is false when only cost is nonzero", () => {
			expect(
				snapshotIsZero({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0.01 }),
			).toBe(false);
		});

		it("is false when only totalTokens is nonzero", () => {
			expect(
				snapshotIsZero({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: 0 }),
			).toBe(false);
		});
	});

	describe("toUsageEntryUsage", () => {
		it("copies token fields and puts the scalar cost on cost.total with zeroed split", () => {
			expect(
				toUsageEntryUsage({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100, cost: 0.042 }),
			).toEqual({
				input: 10,
				output: 20,
				cacheRead: 30,
				cacheWrite: 40,
				totalTokens: 100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.042 },
			});
		});
	});
});

// Regression for issue #38 — token semantics + context indicator
describe("usage", () => {
	describe("getSessionTokens", () => {
		it("uses billed-token semantics (input + output + cacheWrite), not inflated total", () => {
			const session = {
				getSessionStats: () => ({
					tokens: { input: 100, output: 200, cacheRead: 500_000, cacheWrite: 50, total: 500_350 },
					contextUsage: { tokens: 50_300, contextWindow: 200_000, percent: 25 },
				}),
			};
			expect(getSessionTokens(session)).toBe(350);
		});

		it("returns 0 when session is undefined or stats throw", () => {
			expect(getSessionTokens(undefined)).toBe(0);
			const broken = {
				getSessionStats: (): never => {
					throw new Error("nope");
				},
			};
			expect(getSessionTokens(broken)).toBe(0);
		});
	});

	describe("getSessionContextPercent", () => {
		it("returns null when contextUsage is unavailable", () => {
			const session = {
				getSessionStats: () => ({ tokens: { input: 10, output: 20, cacheWrite: 5 } }),
			};
			expect(getSessionContextPercent(session)).toBeNull();
		});

		it("returns null when percent is null (post-compaction)", () => {
			const session = {
				getSessionStats: () => ({
					tokens: { input: 10, output: 20, cacheWrite: 5 },
					contextUsage: { tokens: null, contextWindow: 200_000, percent: null },
				}),
			};
			expect(getSessionContextPercent(session)).toBeNull();
		});

		it("returns the upstream percent when available", () => {
			const session = {
				getSessionStats: () => ({
					tokens: { input: 10, output: 20, cacheWrite: 5 },
					contextUsage: { tokens: 50_000, contextWindow: 200_000, percent: 25 },
				}),
			};
			expect(getSessionContextPercent(session)).toBe(25);
		});
	});

	describe("getLifetimeTotal", () => {
		it("sums components and handles undefined", () => {
			expect(getLifetimeTotal(undefined)).toBe(0);
			expect(getLifetimeTotal({ input: 100, output: 200, cacheWrite: 50 })).toBe(350);
		});
	});
});

describe("sumSessionUsage", () => {
	/** One assistant message with token usage and cost. */
	const assistant = (cost: number) => ({
		type: "message",
		message: {
			role: "assistant",
			usage: {
				input: 100, output: 20, cacheRead: 30, cacheWrite: 5, totalTokens: 155,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
			},
		},
	});

	it("sums tokens and cost across assistant, toolResult, usage, compaction, and branch_summary entries", () => {
		const entries = [
			{ type: "session", id: "s1" },
			{ type: "message", message: { role: "user", content: "hi" } },
			assistant(0.02),
			{ type: "message", message: { role: "toolResult", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0.005 } } } },
			{ type: "usage", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0.01 } } },
			{ type: "compaction", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0.003 } } },
			{ type: "branch_summary", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0.002 } } },
		];
		const snapshot = sumSessionUsage(entries);
		expect(snapshot.input).toBe(100);
		expect(snapshot.output).toBe(20);
		expect(snapshot.cacheRead).toBe(30);
		expect(snapshot.cacheWrite).toBe(5);
		expect(snapshot.totalTokens).toBe(155);
		expect(snapshot.cost).toBeCloseTo(0.04, 10);
	});

	it("tolerates entries with missing usage and unknown shapes", () => {
		const snapshot = sumSessionUsage([undefined, null, { type: "message" }, { type: "usage" }, { type: "compaction", usage: {} }]);
		expect(snapshot).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 });
	});
});
