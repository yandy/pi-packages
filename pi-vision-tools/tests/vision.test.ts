import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { DecodedImage } from "../src/image.js";
import { type CompleteFn, callVision, resolveVisionModel } from "../src/vision.js";

const fakeModel = (input: string[], id = "m", provider = "p") =>
	({
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://x",
		reasoning: false,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 1000,
	}) as Model<any>;

describe("resolveVisionModel", () => {
	const gpt4o = fakeModel(["text", "image"], "gpt-4o", "openai");
	const haiku = fakeModel(["text", "image"], "claude-haiku-4-5", "anthropic");
	const textOnly = fakeModel(["text"], "text-only", "openai");
	const models = [gpt4o, haiku, textOnly];
	const registry = {
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		getAll: () => models,
		getAvailable: () => models,
	};

	it("resolves a configured provider/id", () => {
		const r = resolveVisionModel(registry, { model: "openai/gpt-4o", enabled: "auto" });
		expect(r.ok && r.model).toBe(gpt4o);
	});

	it("resolves a fuzzy model name", () => {
		const r = resolveVisionModel(registry, { model: "haiku", enabled: "auto" });
		expect(r.ok && r.model).toBe(haiku);
	});

	it("errors when no model is configured", () => {
		const r = resolveVisionModel(registry, { enabled: "auto" });
		expect(r.ok).toBe(false);
		expect((r as { error: string }).error).toMatch(/not configured/i);
	});

	it("errors when the model cannot be resolved", () => {
		const r = resolveVisionModel(registry, { model: "nope", enabled: "auto" });
		expect(r.ok).toBe(false);
		expect((r as { error: string }).error).toMatch(/not found/i);
	});

	it("errors when the resolved model cannot accept images", () => {
		const r = resolveVisionModel(registry, { model: "openai/text-only", enabled: "auto" });
		expect(r.ok).toBe(false);
		expect((r as { error: string }).error).toMatch(/image input/i);
	});
});

describe("callVision", () => {
	const model = fakeModel(["text", "image"]);
	const img: DecodedImage = { data: Buffer.from([1, 2, 3]), mimeType: "image/png" };

	it("builds a message with text + image parts and returns extracted text", async () => {
		const completeFn: CompleteFn = async (_m, context, _opts) => {
			const msg = context.messages[0];
			expect(msg.content[0]).toEqual({ type: "text", text: "describe" });
			expect(msg.content[1]).toEqual({ type: "image", data: "AQID", mimeType: "image/png" });
			return {
				role: "assistant",
				content: [{ type: "text", text: "it is red" }],
				api: "openai-completions",
				provider: "p",
				model: "m",
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
				stopReason: "stop",
				timestamp: 0,
			} as AssistantMessage;
		};

		const out = await callVision(
			{ model, auth: { apiKey: "k" }, prompt: "describe", images: [img], reasoning: {} },
			completeFn,
		);
		expect(out.text).toBe("it is red");
		expect(out.usage?.input).toBe(10);
		expect(out.errorMessage).toBeUndefined();
		expect(out.stopReason).toBe("stop");
	});

	it("passes reasoningEffort through when provided", async () => {
		let receivedOpts: Record<string, unknown> | undefined;
		const completeFn: CompleteFn = async (_m, _c, opts) => {
			receivedOpts = opts;
			return {
				role: "assistant",
				content: [{ type: "text", text: "x" }],
				api: "openai-completions",
				provider: "p",
				model: "m",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "stop",
				timestamp: 0,
			} as AssistantMessage;
		};
		await callVision(
			{ model, auth: { apiKey: "k" }, prompt: "p", images: [img], reasoning: { reasoningEffort: "high" } },
			completeFn,
		);
		expect(receivedOpts?.reasoningEffort).toBe("high");
	});

	it("returns errorMessage when completeFn throws", async () => {
		const completeFn: CompleteFn = async () => {
			throw new Error("boom");
		};
		const out = await callVision({ model, auth: { apiKey: "k" }, prompt: "p", images: [img], reasoning: {} }, completeFn);
		expect(out.text).toBe("");
		expect(out.errorMessage).toMatch(/boom/);
	});

	it("propagates errorMessage from a non-thrown response", async () => {
		const completeFn: CompleteFn = async () =>
			({
				role: "assistant",
				content: [],
				api: "openai-completions",
				provider: "p",
				model: "m",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "error",
				errorMessage: "rate limited",
				timestamp: 0,
			}) as unknown as AssistantMessage;
		const out = await callVision({ model, auth: { apiKey: "k" }, prompt: "p", images: [img], reasoning: {} }, completeFn);
		expect(out.text).toBe("");
		expect(out.errorMessage).toBe("rate limited");
	});

	it("concatenates multiple text content parts", async () => {
		const completeFn: CompleteFn = async () =>
			({
				role: "assistant",
				content: [
					{ type: "text", text: "a" },
					{ type: "text", text: "b" },
				],
				api: "openai-completions",
				provider: "p",
				model: "m",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "stop",
				timestamp: 0,
			}) as AssistantMessage;
		const out = await callVision({ model, auth: { apiKey: "k" }, prompt: "p", images: [img], reasoning: {} }, completeFn);
		expect(out.text).toBe("a\nb");
	});
});
