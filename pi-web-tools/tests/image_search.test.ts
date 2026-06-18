import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreate = vi.fn();
vi.mock("openai", () => {
	return {
		default: class MockOpenAI {
			responses = {
				create: mockCreate,
			};
		},
	};
});

let imageSearch: typeof import("../src/image_search/index.js").imageSearch;

beforeEach(async () => {
	vi.resetModules();
	mockCreate.mockReset();
	vi.stubEnv("ALIYUN_API_KEY", "test-key");
	vi.stubEnv("ALIYUN_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1");
	const mod = await import("../src/image_search/index.js");
	imageSearch = mod.imageSearch;
});

describe("imageSearch", () => {
	it("uses web_search_image tool when only query provided", async () => {
		mockCreate.mockResolvedValueOnce({
			output: [
				{
					type: "web_search_image_call",
					output: JSON.stringify([{ index: 1, title: "Image 1", url: "https://img.com/1.jpg" }]),
				},
				{
					type: "message",
					content: [{ type: "output_text", text: "Found images" }],
				},
			],
		});

		const result = await imageSearch({ query: "find cats" });
		const body = mockCreate.mock.calls[0][0];
		expect(body.tools).toEqual([{ type: "web_search_image" }]);
		expect(body.input).toBe("find cats");
		expect(body.model).toBe("qwen3.7-plus");
		expect(result.images).toHaveLength(1);
		expect(result.answer).toBe("Found images");
	});

	it("uses image_search tool when imageUrl provided", async () => {
		mockCreate.mockResolvedValueOnce({
			output: [
				{
					type: "image_search_call",
					output: JSON.stringify([{ index: 1, title: "Similar", url: "https://img.com/2.jpg" }]),
				},
				{
					type: "message",
					content: [{ type: "output_text", text: "Similar images found" }],
				},
			],
		});

		await imageSearch({ imageUrl: "https://example.com/photo.jpg" });
		const body = mockCreate.mock.calls[0][0];
		expect(body.tools).toEqual([{ type: "image_search" }]);
		const content = body.input[0].content;
		expect(content.some((c: any) => c.type === "input_image")).toBe(true);
	});

	it("combines query and imageUrl", async () => {
		mockCreate.mockResolvedValueOnce({
			output: [
				{
					type: "image_search_call",
					output: JSON.stringify([{ index: 1, title: "Result", url: "https://img.com/3.jpg" }]),
				},
				{ type: "message", content: [{ type: "output_text", text: "Combined result" }] },
			],
		});

		await imageSearch({ query: "cats", imageUrl: "https://example.com/cat.jpg" });
		const body = mockCreate.mock.calls[0][0];
		const content = body.input[0].content;
		expect(content.some((c: any) => c.type === "input_text")).toBe(true);
		expect(content.some((c: any) => c.type === "input_image")).toBe(true);
	});

	it("throws when neither query nor imageUrl provided", async () => {
		await expect(imageSearch({})).rejects.toThrow("query or imageUrl");
	});

	it("throws when ALIYUN_API_KEY not configured", async () => {
		vi.stubEnv("ALIYUN_API_KEY", "");
		await expect(imageSearch({ query: "cats" })).rejects.toThrow("ALIYUN_API_KEY not configured");
	});

	it("uses config model when provided", async () => {
		mockCreate.mockResolvedValueOnce({
			output: [
				{ type: "web_search_image_call", output: "[]" },
				{ type: "message", content: [{ type: "output_text", text: "Done" }] },
			],
		});

		await imageSearch({ query: "cats" }, undefined, { imageSearchModel: "custom-image-model" });
		const body = mockCreate.mock.calls[0][0];
		expect(body.model).toBe("custom-image-model");
	});
});
