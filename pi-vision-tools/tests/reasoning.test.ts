import { describe, expect, it } from "vitest";
import { reasoningToOptions, type VisionReasoning } from "../src/reasoning.js";

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
