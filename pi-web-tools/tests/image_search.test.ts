import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

let imageSearch: typeof import("../src/image_search/index.js").imageSearch;

beforeEach(async () => {
	vi.resetModules();
	mockFetch.mockReset();
	vi.stubEnv("ALIYUN_API_KEY", "test-key");
	const mod = await import("../src/image_search/index.js");
	imageSearch = mod.imageSearch;
});

describe("imageSearch", () => {
	it("uses web_search_image tool when only query provided", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					output: [
						{
							type: "web_search_image_call",
							output: JSON.stringify([
								{ index: 1, title: "Image 1", url: "https://img.com/1.jpg" },
							]),
						},
						{
							type: "message",
							content: [{ type: "output_text", text: "Found images" }],
						},
					],
				}),
		});

		const result = await imageSearch({ query: "find cats" });
		expect(mockFetch).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				body: expect.stringContaining("web_search_image"),
			}),
		);
		expect(result.images).toHaveLength(1);
	});

	it("uses image_search tool when imageUrl provided", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					output: [
						{
							type: "image_search_call",
							output: JSON.stringify([
								{ index: 1, title: "Similar", url: "https://img.com/2.jpg" },
							]),
						},
						{
							type: "message",
							content: [{ type: "output_text", text: "Similar images found" }],
						},
					],
				}),
		});

		const result = await imageSearch({ imageUrl: "https://example.com/photo.jpg" });
		expect(mockFetch).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				body: expect.stringContaining("image_search"),
			}),
		);
		expect(mockFetch).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				body: expect.stringContaining("input_image"),
			}),
		);
	});

	it("throws when neither query nor imageUrl provided", async () => {
		await expect(imageSearch({})).rejects.toThrow("query or imageUrl");
	});
});
