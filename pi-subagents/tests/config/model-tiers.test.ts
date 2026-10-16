import { describe, expect, it } from "vitest";
import { normalizeModelTier, resolveModelTier } from "../../src/config/model-tiers";

describe("normalizeModelTier", () => {
	it("returns the canonical tier for a valid name", () => {
		expect(normalizeModelTier("fast")).toBe("fast");
		expect(normalizeModelTier("standard")).toBe("standard");
		expect(normalizeModelTier("advanced")).toBe("advanced");
	});

	it("is case- and whitespace-insensitive", () => {
		expect(normalizeModelTier(" FAST ")).toBe("fast");
		expect(normalizeModelTier("Standard")).toBe("standard");
	});

	it("returns undefined for unknown names and non-strings", () => {
		expect(normalizeModelTier("turbo")).toBeUndefined();
		expect(normalizeModelTier("")).toBeUndefined();
		expect(normalizeModelTier(undefined)).toBeUndefined();
		expect(normalizeModelTier(3)).toBeUndefined();
	});
});

describe("resolveModelTier", () => {
	it("resolves a configured tier to its real model", () => {
		expect(resolveModelTier("fast", { fast: "deepseek-flash" })).toEqual({ model: "deepseek-flash" });
	});

	it("accepts mixed-case input", () => {
		expect(resolveModelTier("Advanced", { advanced: "qwen3.8-max" })).toEqual({ model: "qwen3.8-max" });
	});

	it("trims whitespace around the configured model", () => {
		expect(resolveModelTier("fast", { fast: "  deepseek-flash  " })).toEqual({ model: "deepseek-flash" });
	});

	it("lists valid tiers when the tier name is unknown", () => {
		const result = resolveModelTier("turbo", { fast: "deepseek-flash" });
		if (!("error" in result)) throw new Error("expected an error");
		expect(result.error).toContain('"turbo"');
		expect(result.error).toContain("fast, standard, advanced");
	});

	it("points at the settings file when the tier has no mapping", () => {
		const result = resolveModelTier("standard", { fast: "deepseek-flash" });
		if (!("error" in result)) throw new Error("expected an error");
		expect(result.error).toContain('"standard" is not configured');
		expect(result.error).toContain("subagents.json");
		expect(result.error).toContain("modelTiers");
	});

	it("treats a missing tier map like an unconfigured tier", () => {
		const result = resolveModelTier("fast", undefined);
		expect("error" in result).toBe(true);
	});

	it("treats a blank configured value as unconfigured", () => {
		const result = resolveModelTier("fast", { fast: "   " });
		expect("error" in result).toBe(true);
	});
});
