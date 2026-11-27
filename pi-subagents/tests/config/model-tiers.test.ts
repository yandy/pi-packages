import { describe, expect, it } from "vitest";
import { normalizeModelTier, resolveModelTier } from "../../src/config/model-tiers";

describe("normalizeModelTier", () => {
	it.each(["fast", "standard", "advanced"] as const)("recognizes %s", (tier) => {
		expect(normalizeModelTier(tier)).toBe(tier);
	});

	it("normalizes case and surrounding whitespace", () => {
		expect(normalizeModelTier(" FAST ")).toBe("fast");
	});

	it.each(["", "   ", "turbo", "custom/fast", "haiku", undefined, null, 42, {}, []])(
		"rejects non-tier input %j",
		(input) => {
			expect(normalizeModelTier(input)).toBeUndefined();
		},
	);
});

describe("resolveModelTier", () => {
	it("returns the trimmed model reference configured for the tier", () => {
		expect(resolveModelTier("fast", { fast: "  haiku  " })).toEqual({ model: "haiku" });
	});

	it("reports an unknown tier instead of treating it as a model reference", () => {
		const result = resolveModelTier("turbo", { fast: "haiku" });
		expect(result.error).toContain('Unknown model tier: "turbo"');
		expect(result.error).toContain("fast, standard, advanced");
	});

	it("reports an unconfigured tier with actionable settings paths", () => {
		const result = resolveModelTier("advanced", { fast: "haiku" });
		expect(result.model).toBeUndefined();
		expect(result.error).toContain('Model tier "advanced" is not configured');
		expect(result.error).toContain(".pi/subagents.json");
		expect(result.error).toContain("~/.pi/agent/subagents.json");
	});

	it("treats a blank configured reference as unconfigured", () => {
		const result = resolveModelTier("fast", { fast: "   " });
		expect(result.error).toContain('Model tier "fast" is not configured');
	});
});
