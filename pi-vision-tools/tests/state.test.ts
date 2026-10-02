import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { footerLabel } from "../src/state.js";

const fakeModel = (id: string, provider: string) =>
	({
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://x",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 1000,
	}) as Model<any>;

describe("footerLabel", () => {
	it("hides the indicator when the tool is disabled", () => {
		expect(footerLabel(false, { ok: true, model: fakeModel("gpt-4o", "openai") })).toBeUndefined();
	});

	it("hides the indicator when the model cannot be resolved", () => {
		expect(footerLabel(true, { ok: false, error: "Model not found: nope" })).toBeUndefined();
	});

	it("shows the resolved provider/id, not the configured fuzzy name", () => {
		expect(footerLabel(true, { ok: true, model: fakeModel("claude-haiku-4-5", "anthropic") })).toBe(
			"👁 anthropic/claude-haiku-4-5",
		);
	});
});
