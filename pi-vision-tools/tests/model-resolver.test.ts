import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { resolveModel, type VisionModelRegistry } from "../src/model-resolver.js";

const fakeModel = (provider: string, id: string, name: string, input: string[]) =>
	({
		id,
		name,
		api: "openai-completions",
		provider,
		baseUrl: "https://x",
		reasoning: false,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 1000,
	}) as Model<any>;

const haiku = fakeModel("anthropic", "claude-haiku-4-5", "Claude Haiku 4.5", ["text", "image"]);
const sonnet = fakeModel("anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5", ["text", "image"]);
const qwenVl = fakeModel("alibaba", "qwen-vl-max", "Qwen VL Max", ["text", "image"]);
const gpt4o = fakeModel("openai", "gpt-4o", "GPT-4o", ["text", "image"]);
const deepseekChat = fakeModel("deepseek", "deepseek-chat", "DeepSeek Chat", ["text"]);

function registry(models: Model<any>[], available: Model<any>[] = models): VisionModelRegistry {
	return {
		find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
		getAll: () => models,
		getAvailable: () => available,
	};
}

const all = [haiku, sonnet, qwenVl, gpt4o, deepseekChat];

describe("resolveModel", () => {
	it("resolves an exact provider/id even when other models exist", () => {
		expect(resolveModel("anthropic/claude-sonnet-4-5", registry(all))).toBe(sonnet);
	});

	it("fuzzy matches a partial model id", () => {
		expect(resolveModel("haiku", registry(all))).toBe(haiku);
	});

	it("fuzzy matches the human-readable model name", () => {
		expect(resolveModel("Qwen VL", registry(all))).toBe(qwenVl);
	});

	it("fuzzy matches when every whitespace-separated part is present", () => {
		expect(resolveModel("anthropic haiku", registry(all))).toBe(haiku);
	});

	it("explains that an exact match cannot accept images", () => {
		const result = resolveModel("deepseek/deepseek-chat", registry(all));
		expect(result).toBe(
			'Model "deepseek/deepseek-chat" does not support image input.\n\nAvailable vision models:\n  alibaba/qwen-vl-max\n  anthropic/claude-haiku-4-5\n  anthropic/claude-sonnet-4-5\n  openai/gpt-4o',
		);
	});

	it("explains that a fuzzy match cannot accept images", () => {
		const result = resolveModel("deepseek", registry(all));
		expect(result as string).toMatch(/does not support image input/i);
	});

	it("ignores models that are not available (no auth)", () => {
		const result = resolveModel("gpt-4o", registry(all, [haiku]));
		expect(typeof result).toBe("string");
		expect(result as string).toMatch(/not found/i);
	});

	it("lists available vision models when nothing matches", () => {
		const result = resolveModel("nope", registry(all));
		expect(result).toBe(
			'Model not found: "nope".\n\nAvailable vision models:\n  alibaba/qwen-vl-max\n  anthropic/claude-haiku-4-5\n  anthropic/claude-sonnet-4-5\n  openai/gpt-4o',
		);
	});

	it("reports when no vision model is available at all", () => {
		const result = resolveModel("haiku", registry([deepseekChat]));
		expect(result).toBe("No vision-capable model is available (none has image input or auth configured).");
	});

	it("rejects an empty model string", () => {
		expect(resolveModel("   ", registry(all))).toMatch(/not configured/i);
	});
});
