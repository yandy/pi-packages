import { describe, expect, it } from "vitest";
import { TIER_SPECS } from "../src/tiers";

describe("TIER_SPECS", () => {
	it("has small, medium, large entries", () => {
		expect(Object.keys(TIER_SPECS).sort()).toEqual(["large", "medium", "small"].sort());
	});

	it.each([
		["small", { memory: "1g", swap: "512m", cpus: "1" }],
		["medium", { memory: "4g", swap: "2g", cpus: "2" }],
		["large", { memory: "8g", swap: "4g", cpus: "4" }],
	])("%s tier has expected values", (tier: string, expected: object) => {
		expect(TIER_SPECS[tier as keyof typeof TIER_SPECS]).toEqual(expected);
	});
});
