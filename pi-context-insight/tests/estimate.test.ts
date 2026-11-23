import { describe, expect, it } from "vitest";
import { estimateTextAndImageContentTokens, estimateTextTokens } from "../src/estimate";

describe("estimateTextTokens", () => {
	it("rounds character count up at 3.5 characters per token", () => {
		expect(estimateTextTokens("")).toBe(0);
		expect(estimateTextTokens("abcdefg")).toBe(2);
		expect(estimateTextTokens("a".repeat(350))).toBe(100);
		expect(estimateTextTokens("a".repeat(351))).toBe(101);
	});
});

describe("estimateTextAndImageContentTokens", () => {
	it("counts a plain string like text", () => {
		expect(estimateTextAndImageContentTokens("a".repeat(351))).toBe(101);
	});

	it("sums text blocks and bills every image as 4800 characters", () => {
		const tokens = estimateTextAndImageContentTokens([
			{ type: "text", text: "a".repeat(350) },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
			{ type: "text", text: "a".repeat(350) },
		]);

		// (350 + 4800 + 350) / 3.5 = 1571.43 -> 1572
		expect(tokens).toBe(1572);
	});

	it("counts an empty block list as zero", () => {
		expect(estimateTextAndImageContentTokens([])).toBe(0);
	});
});
