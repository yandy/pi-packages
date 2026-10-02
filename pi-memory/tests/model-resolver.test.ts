import { describe, it, expect } from "vitest";
import { resolveModel } from "../src/model-resolver";

/** `available` 缺省 = 全部可用；显式传它就能造出「getAll 认得、getAvailable 里没有」的无凭据情形。 */
function makeRegistry(
	models: Array<{ provider: string; id: string; name: string }>,
	available: Array<{ provider: string; id: string; name: string }> = models,
) {
	return {
		find: (provider: string, modelId: string) =>
			models.find((m) => m.provider === provider && m.id === modelId) as any,
		getAvailable: () => available as any[],
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

	// getAll 里有、getAvailable 里没有 = 模型存在但**没有凭据**：解析必须失败（不回退、不降级）。
	// 第二个断言把这条路径与「一个可用模型都没有」的早退区分开。
	it("returns undefined for a model present in getAll but missing from getAvailable", () => {
		const registry = makeRegistry(
			models,
			models.filter((m) => m.provider === "anthropic"),
		);
		expect(resolveModel("deepseek/deepseek-v4-flash", registry)).toBeUndefined();
		expect(resolveModel("anthropic/claude-haiku-4-5", registry)?.id).toBe("claude-haiku-4-5");
	});
});
