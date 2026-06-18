import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

let deepSearch: typeof import("../src/deep_search/index.js").deepSearch;

beforeEach(async () => {
	vi.resetModules();
	mockFetch.mockReset();
	vi.stubEnv("ALIYUN_API_KEY", "test-key");
	const mod = await import("../src/deep_search/index.js");
	deepSearch = mod.deepSearch;
});

describe("deepSearch", () => {
	it("calls aliyun responses API", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					output: [
						{
							type: "web_search_call",
							action: { query: "test query" },
							sources: [{ type: "web", url: "https://example.com" }],
						},
						{
							type: "message",
							role: "assistant",
							content: [{ type: "output_text", text: "Answer text" }],
						},
					],
				}),
		});

		const result = await deepSearch("test query");
		expect(mockFetch).toHaveBeenCalledWith(
			expect.stringContaining("/responses"),
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining("web_search"),
			}),
		);
		expect(result.answer).toBe("Answer text");
		expect(result.sources).toHaveLength(1);
	});

	it("throws when ALIYUN_API_KEY not configured", async () => {
		vi.stubEnv("ALIYUN_API_KEY", "");
		await expect(deepSearch("test")).rejects.toThrow("ALIYUN_API_KEY");
	});
});
