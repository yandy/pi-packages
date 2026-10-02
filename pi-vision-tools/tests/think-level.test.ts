import { describe, expect, it } from "vitest";
import { effectiveThinkLevel, thinkLevelToOptions, type VisionThinkLevel } from "../src/think-level.js";

describe("thinkLevelToOptions", () => {
	it("returns empty object for undefined", () => {
		expect(thinkLevelToOptions(undefined)).toEqual({});
	});

	it("returns empty object for 'off'", () => {
		expect(thinkLevelToOptions("off")).toEqual({});
	});

	const levels: VisionThinkLevel[] = ["minimal", "low", "medium", "high", "xhigh"];
	for (const lvl of levels) {
		it(`maps '${lvl}' to { reasoningEffort: '${lvl}' }`, () => {
			expect(thinkLevelToOptions(lvl)).toEqual({ reasoningEffort: lvl });
		});
	}
});

describe("effectiveThinkLevel", () => {
	it("returns 'off' when both are undefined", () => {
		expect(effectiveThinkLevel(undefined, undefined)).toBe("off");
	});

	it("param wins over undefined config default", () => {
		expect(effectiveThinkLevel("high", undefined)).toBe("high");
	});

	it("config default used when param is undefined", () => {
		expect(effectiveThinkLevel(undefined, "medium")).toBe("medium");
	});

	it("param beats config default when both provided", () => {
		expect(effectiveThinkLevel("low", "high")).toBe("low");
	});
});
