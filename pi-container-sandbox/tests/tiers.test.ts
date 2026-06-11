import { describe, it, expect } from "vitest";
import { parseSizeTier, TIER_SPECS } from "../src/tiers";

describe("parseSizeTier", () => {
  it("returns the tier for valid tier names", () => {
    expect(parseSizeTier("small")).toBe("small");
    expect(parseSizeTier("medium")).toBe("medium");
    expect(parseSizeTier("large")).toBe("large");
  });

  it("returns null for unknown tier names", () => {
    expect(parseSizeTier("xlarge")).toBeNull();
    expect(parseSizeTier("")).toBeNull();
    expect(parseSizeTier("SMALL")).toBeNull();
  });
});

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
