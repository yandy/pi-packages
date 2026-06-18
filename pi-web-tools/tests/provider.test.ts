import { beforeEach, describe, expect, it, vi } from "vitest";

let resolveAliyunProvider: typeof import("../src/provider.js").resolveAliyunProvider;

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

beforeEach(async () => {
	vi.resetModules();
	vi.unstubAllEnvs();
	const mod = await import("../src/provider.js");
	resolveAliyunProvider = mod.resolveAliyunProvider;
});

describe("resolveAliyunProvider", () => {
	it("uses env ALIYUN_API_KEY when set", async () => {
		vi.stubEnv("ALIYUN_API_KEY", "env-key");
		vi.stubEnv("ALIYUN_BASE_URL", "");
		const result = await resolveAliyunProvider({ config: {} });
		expect(result.apiKey).toBe("env-key");
	});

	it("throws when no apiKey configured", async () => {
		vi.stubEnv("ALIYUN_API_KEY", "");
		await expect(resolveAliyunProvider({ config: {} })).rejects.toThrow("ALIYUN_API_KEY not configured");
	});

	it("uses provider apiKey when aliyunProviderKey set and provider exists", async () => {
		vi.stubEnv("ALIYUN_API_KEY", "");
		const mockCtx = {
			modelRegistry: {
				getApiKeyForProvider: vi.fn().mockResolvedValue("provider-key"),
				getAll: () => [{ provider: "aliyun", baseUrl: "https://provider.example.com/v1" }],
			},
		} as any;
		const result = await resolveAliyunProvider({
			ctx: mockCtx,
			config: { aliyunProviderKey: "aliyun" },
		});
		expect(result.apiKey).toBe("provider-key");
	});

	it("throws when aliyunProviderKey set but provider has no apiKey and env not set", async () => {
		vi.stubEnv("ALIYUN_API_KEY", "");
		const mockCtx = {
			modelRegistry: {
				getApiKeyForProvider: vi.fn().mockResolvedValue(undefined),
				getAll: () => [{ provider: "aliyun", baseUrl: "https://provider.example.com/v1" }],
			},
		} as any;
		await expect(resolveAliyunProvider({ ctx: mockCtx, config: { aliyunProviderKey: "aliyun" } })).rejects.toThrow(
			"ALIYUN_API_KEY not configured",
		);
	});

	it("baseUrl: env > provider > config > default", async () => {
		// env wins
		vi.stubEnv("ALIYUN_API_KEY", "env-key");
		vi.stubEnv("ALIYUN_BASE_URL", "https://env.example.com/v1");
		let result = await resolveAliyunProvider({ config: {} });
		expect(result.baseUrl).toBe("https://env.example.com/v1");

		// provider second
		vi.stubEnv("ALIYUN_BASE_URL", "");
		const mockCtx = {
			modelRegistry: {
				getApiKeyForProvider: vi.fn().mockResolvedValue("provider-key"),
				getAll: () => [{ provider: "aliyun", baseUrl: "https://provider.example.com/v1" }],
			},
		} as any;
		result = await resolveAliyunProvider({ ctx: mockCtx, config: { aliyunProviderKey: "aliyun" } });
		expect(result.baseUrl).toBe("https://provider.example.com/v1");

		// config third
		vi.stubEnv("ALIYUN_API_KEY", "env-key");
		result = await resolveAliyunProvider({ config: { baseUrl: "https://config.example.com/v1" } });
		expect(result.baseUrl).toBe("https://config.example.com/v1");

		// default
		result = await resolveAliyunProvider({ config: {} });
		expect(result.baseUrl).toBe(DEFAULT_BASE_URL);
	});

	it("falls back to config baseUrl when providerKey set but no matching provider", async () => {
		vi.stubEnv("ALIYUN_API_KEY", "env-key");
		vi.stubEnv("ALIYUN_BASE_URL", "");
		const mockCtx = {
			modelRegistry: {
				getApiKeyForProvider: vi.fn().mockResolvedValue(undefined),
				getAll: () => [{ provider: "other", baseUrl: "https://other.example.com/v1" }],
			},
		} as any;
		const result = await resolveAliyunProvider({
			ctx: mockCtx,
			config: { aliyunProviderKey: "aliyun", baseUrl: "https://config.example.com/v1" },
		});
		expect(result.baseUrl).toBe("https://config.example.com/v1");
	});
});
