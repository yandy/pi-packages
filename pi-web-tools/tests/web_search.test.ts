import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

let search: typeof import("../src/web_search/index.js").search;

beforeEach(async () => {
	vi.resetModules();
	mockFetch.mockReset();
	vi.unstubAllEnvs();

	const wsMod = await import("../src/web_search/index.js");
	search = wsMod.search;
});

describe("exaSearch", () => {
	it("falls back to MCP when EXA_API_KEY not set", async () => {
		vi.stubEnv("EXA_API_KEY", "");
		const mod = await import("../src/web_search/exa.js");
		const exaSearch = mod.exaSearch;

		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ result: {} }),
		});
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					result: {
						content: [
							{
								type: "text",
								text: "Title: Test\nURL: https://example.com\nPublished: N/A\nAuthor: N/A\nHighlights:\nSample content",
							},
						],
					},
				}),
		});

		const result = await exaSearch("test query", 5);

		expect(result.sourceLabel).toBe("exa");
		expect(mockFetch).toHaveBeenCalledTimes(2);
		expect(mockFetch).toHaveBeenNthCalledWith(
			1,
			"https://mcp.exa.ai/mcp",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("calls REST API when EXA_API_KEY is set", async () => {
		vi.stubEnv("EXA_API_KEY", "test-key");
		const mod = await import("../src/web_search/exa.js");
		const exaSearch = mod.exaSearch;

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

	it("throws on REST API non-2xx response", async () => {
		vi.stubEnv("EXA_API_KEY", "test-key");
		const mod = await import("../src/web_search/exa.js");
		const exaSearch = mod.exaSearch;

		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 500,
			text: () => Promise.resolve("Internal Server Error"),
		});

		await expect(exaSearch("test query", 5)).rejects.toThrow("Exa API 500");
	});

	it("throws on MCP initialize non-2xx response", async () => {
		vi.stubEnv("EXA_API_KEY", "");
		const mod = await import("../src/web_search/exa.js");
		const exaSearch = mod.exaSearch;

		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 403,
			text: () => Promise.resolve("Forbidden"),
		});

		await expect(exaSearch("test query", 5)).rejects.toThrow("Exa MCP initialize failed: 403");
	});

	it("shows fallback message for empty REST results", async () => {
		vi.stubEnv("EXA_API_KEY", "test-key");
		const mod = await import("../src/web_search/exa.js");
		const exaSearch = mod.exaSearch;

		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ results: [] }),
		});

		const result = await exaSearch("test query", 5);

		expect(result.sources).toHaveLength(0);
		expect(result.answer).toContain("No results found");
	});
});

describe("search orchestrator", () => {
	it("uses exa with API key", async () => {
		vi.stubEnv("EXA_API_KEY", "test-key");
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					results: [{ title: "T", url: "https://x.com", text: "content" }],
				}),
		});

		const result = await search("test", 5);
		expect(result.sourceLabel).toBe("exa");
	});

	it("uses exa MCP when no API key", async () => {
		vi.stubEnv("EXA_API_KEY", "");
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ result: {} }),
		});
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					result: {
						content: [{ type: "text", text: "Title: X\nURL: https://x.com\nHighlights:\nyes" }],
					},
				}),
		});

		const result = await search("test", 5);
		expect(result.sourceLabel).toBe("exa");
	});

	it("uses specified source", async () => {
		vi.stubEnv("EXA_API_KEY", "test-key");
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					results: [{ title: "R", url: "https://x.com", text: "content" }],
				}),
		});

		const result = await search("test", 5, undefined, undefined, "exa");
		expect(result.sourceLabel).toBe("exa");
	});

	it("throws when all sources fail", async () => {
		vi.stubEnv("EXA_API_KEY", "");
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 500,
			text: () => Promise.resolve("Error"),
		});

		await expect(search("test", 5)).rejects.toThrow("All search sources failed");
	});

	it("throws for unknown source", async () => {
		await expect(search("test", 5, undefined, undefined, "unknown")).rejects.toThrow("Unknown source");
	});
});
