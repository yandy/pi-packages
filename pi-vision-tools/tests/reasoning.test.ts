import { describe, expect, it } from "vitest";
import { effectiveReasoning, reasoningToOptions, type VisionReasoning } from "../src/reasoning.js";

describe("reasoningToOptions", () => {
	it("returns empty object for undefined", () => {
		expect(reasoningToOptions(undefined)).toEqual({});
	});

	it("returns empty object for 'off'", () => {
		expect(reasoningToOptions("off")).toEqual({});
	});

	const levels: VisionReasoning[] = ["minimal", "low", "medium", "high", "xhigh"];
	for (const lvl of levels) {
		it(`maps '${lvl}' to { reasoningEffort: '${lvl}' }`, () => {
			expect(reasoningToOptions(lvl)).toEqual({ reasoningEffort: lvl });
		});
	}
});

describe("effectiveReasoning", () => {
	it("returns 'off' when both are undefined", () => {
		expect(effectiveReasoning(undefined, undefined)).toBe("off");
	});

	it("param wins over undefined config default", () => {
		expect(effectiveReasoning("high", undefined)).toBe("high");
	});

	it("config default used when param is undefined", () => {
		expect(effectiveReasoning(undefined, "medium")).toBe("medium");
	});

	it("param beats config default when both provided", () => {
		expect(effectiveReasoning("low", "high")).toBe("low");
	});
});
