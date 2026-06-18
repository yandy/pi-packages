import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// We import after mocking so the module uses our mock
let exaSearch: typeof import("../src/web_search/exa.js").exaSearch;

beforeEach(async () => {
	vi.resetModules();
	mockFetch.mockReset();
	const mod = await import("../src/web_search/exa.js");
	exaSearch = mod.exaSearch;
});

describe("exaSearch", () => {
	it("falls back to MCP when EXA_API_KEY not set", async () => {
		delete process.env.EXA_API_KEY;
		// MCP: first initialize call
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({}),
		});
		// MCP: second tools/call
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					result: { content: [{ text: "Title: Test\nURL: https://example.com\nText: Sample" }] },
				}),
		});

		const result = await exaSearch("test query", 5);

		expect(result.sourceLabel).toBe("exa");
		expect(mockFetch).toHaveBeenCalledTimes(2);
		expect(mockFetch).toHaveBeenNthCalledWith(
			1,
			"https://api.exa.ai/api/mcp",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("calls REST API when EXA_API_KEY is set", async () => {
		process.env.EXA_API_KEY = "test-key";
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					results: [
						{ title: "Test Page", url: "https://example.com", text: "Sample content" },
						{ title: "Another", url: "https://example.org", text: "More" },
					],
				}),
		});

		const result = await exaSearch("test query", 5);

		expect(mockFetch).toHaveBeenCalledWith(
			"https://api.exa.ai/search",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({ "x-api-key": "test-key" }),
			}),
		);
		expect(result.sourceLabel).toBe("exa");
		expect(result.sources).toHaveLength(2);
		expect(result.sources[0].title).toBe("Test Page");
	});
});
