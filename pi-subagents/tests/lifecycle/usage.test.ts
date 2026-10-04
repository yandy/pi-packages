import { describe, expect, it } from "vitest";
import { getLifetimeTotal, getSessionContextPercent, getSessionTokens } from "../../src/lifecycle/usage";

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
