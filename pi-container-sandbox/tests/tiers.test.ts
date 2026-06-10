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

  it("small tier has expected values", () => {
    expect(TIER_SPECS.small).toEqual({ memory: "1g", swap: "512m", cpus: "1" });
  });

  it("medium tier has expected values", () => {
    expect(TIER_SPECS.medium).toEqual({ memory: "4g", swap: "2g", cpus: "2" });
  });

  it("large tier has expected values", () => {
    expect(TIER_SPECS.large).toEqual({ memory: "8g", swap: "4g", cpus: "4" });
  });
});
