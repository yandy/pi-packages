import { describe, expect, it } from "vitest";
import { fmtClock, fmtCost, fmtDuration, fmtPercent, fmtShare, fmtTokens } from "../src/format";

describe("format v2", () => {
	it("formats tokens with k/M suffixes and never emits NaN", () => {
		expect(fmtTokens(999)).toBe("999");
		expect(fmtTokens(1200)).toBe("1.2k");
		expect(fmtTokens(1_250_000)).toBe("1.3M");
		expect(fmtTokens(Number.NaN)).toBe("—");
		expect(fmtTokens(-5)).toBe("-5");
	});
	it("formats durations in four bands", () => {
		expect(fmtDuration(0)).toBe("—");
		expect(fmtDuration(850)).toBe("850ms");
		expect(fmtDuration(2300)).toBe("2.3s");
		expect(fmtDuration(200_000)).toBe("3m20s");
		expect(fmtDuration(3_900_000)).toBe("1h5m");
	});
	it("formats the clock as local 24h time", () => {
		expect(fmtClock(Date.UTC(2026, 0, 2, 3, 4, 5))).toMatch(/^\d{2}:\d{2}:\d{2}$/);
		expect(fmtClock(Number.NaN)).toBe("—");
	});
	it("formats percent, share and cost", () => {
		expect(fmtPercent(12.344)).toBe("12.3%");
		expect(fmtPercent(null)).toBe("—");
		expect(fmtShare(0, 0)).toBe("—");
		expect(fmtShare(1, 3)).toBe("33.3%");
		expect(fmtCost(0.00123)).toBe("$0.0012");
		expect(fmtCost(1.234)).toBe("$1.23");
		expect(fmtCost(Number.NaN)).toBe("—");
	});
});
