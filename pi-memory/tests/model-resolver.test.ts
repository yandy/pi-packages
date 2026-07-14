import { describe, it, expect } from "vitest";
import { resolveModel } from "../src/model-resolver";

function makeRegistry(models: Array<{ provider: string; id: string; name: string }>) {
	return {
		find: (provider: string, modelId: string) =>
			models.find((m) => m.provider === provider && m.id === modelId) as any,
		getAvailable: () => models as any[],
		getAll: () => models as any[],
	} as any;
}

describe("resolveModel", () => {
	const models = [
		{ provider: "deepseek", id: "deepseek-v4-flash", name: "DeepSeek Flash" },
		{ provider: "deepseek", id: "deepseek-v4-pro", name: "DeepSeek Pro" },
		{ provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku" },
	];

	it("exact match provider/modelId", () => {
		const m = resolveModel("deepseek/deepseek-v4-flash", makeRegistry(models));
		expect(m).toBeDefined();
		expect(m!.id).toBe("deepseek-v4-flash");
	});

	it("fuzzy match by id substring (haiku)", () => {
		const m = resolveModel("haiku", makeRegistry(models));
		expect(m).toBeDefined();
		expect(m!.id).toBe("claude-haiku-4-5");
	});

	it("fuzzy match by name substring", () => {
		const m = resolveModel("Pro", makeRegistry(models));
		expect(m).toBeDefined();
		expect(m!.id).toBe("deepseek-v4-pro");
	});

	it("returns undefined when no match", () => {
		const m = resolveModel("nonexistent-model-xyz", makeRegistry(models));
		expect(m).toBeUndefined();
	});

	it("returns undefined for empty input", () => {
		const m = resolveModel("", makeRegistry(models));
		expect(m).toBeUndefined();
	});

	it("exact match is case-insensitive", () => {
		const m = resolveModel("DeepSeek/DeepSeek-V4-Flash", makeRegistry(models));
		expect(m).toBeDefined();
		expect(m!.id).toBe("deepseek-v4-flash");
	});
});
