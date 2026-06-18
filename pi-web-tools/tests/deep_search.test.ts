import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreate = vi.fn();
vi.mock("openai", () => {
	return {
		default: class MockOpenAI {
			chat = {
				completions: {
					create: mockCreate,
				},
			};
		},
	};
});

let deepSearch: typeof import("../src/deep_search/index.js").deepSearch;

beforeEach(async () => {
	vi.resetModules();
	mockCreate.mockReset();
	vi.stubEnv("ALIYUN_API_KEY", "test-key");
	vi.stubEnv("ALIYUN_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1");
	const mod = await import("../src/deep_search/index.js");
	deepSearch = mod.deepSearch;
});

describe("deepSearch", () => {
	it("calls chat.completions.create with enable_search and turbo strategy", async () => {
		mockCreate.mockResolvedValueOnce({
			choices: [{ message: { content: "Answer text" } }],
		});

		const result = await deepSearch("test query");
		expect(mockCreate).toHaveBeenCalledTimes(1);
		const body = mockCreate.mock.calls[0][0];
		expect(body.enable_search).toBe(true);
		expect(body.search_options.search_strategy).toBe("turbo");
		expect(body.search_options.forced_search).toBe(true);
		expect(body.model).toBe("deepseek-v4-flash");
		expect(body.messages).toEqual([{ role: "user", content: "test query" }]);
		expect(result.answer).toBe("Answer text");
		expect(result.sources).toEqual([]);
	});

	it("passes extension params when provided", async () => {
		mockCreate.mockResolvedValueOnce({
			choices: [{ message: { content: "Answer" } }],
		});

		await deepSearch("query", undefined, undefined, undefined, {
			enableSearchExtension: true,
			freshness: 7,
			assignedSiteList: ["baidu.com"],
			enableImageOutput: true,
		});
		const body = mockCreate.mock.calls[0][0];
		expect(body.search_options.enable_search_extension).toBe(true);
		expect(body.search_options.freshness).toBe(7);
		expect(body.search_options.assigned_site_list).toEqual(["baidu.com"]);
		expect(body.enable_text_image_mixed).toBe(true);
	});

	it("does not set extension fields when not provided", async () => {
		mockCreate.mockResolvedValueOnce({
			choices: [{ message: { content: "Answer" } }],
		});

		await deepSearch("query");
		const body = mockCreate.mock.calls[0][0];
		expect(body.search_options.enable_search_extension).toBeUndefined();
		expect(body.search_options.freshness).toBeUndefined();
		expect(body.search_options.assigned_site_list).toBeUndefined();
		expect(body.enable_text_image_mixed).toBeUndefined();
	});

	it("throws when ALIYUN_API_KEY not configured", async () => {
		vi.stubEnv("ALIYUN_API_KEY", "");
		await expect(deepSearch("test")).rejects.toThrow("ALIYUN_API_KEY not configured");
	});

	it("uses config model when provided", async () => {
		mockCreate.mockResolvedValueOnce({
			choices: [{ message: { content: "Answer" } }],
		});

		await deepSearch("query", undefined, { deepSearchModel: "custom-model" });
		const body = mockCreate.mock.calls[0][0];
		expect(body.model).toBe("custom-model");
	});
});
