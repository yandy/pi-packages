import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

let duckduckgoSearch: typeof import("../src/web_search/duckduckgo.js").duckduckgoSearch;
let search: typeof import("../src/web_search/index.js").search;

beforeEach(async () => {
	vi.resetModules();
	mockFetch.mockReset();
	vi.unstubAllEnvs();

	const ddgMod = await import("../src/web_search/duckduckgo.js");
	duckduckgoSearch = ddgMod.duckduckgoSearch;
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

describe("duckduckgoSearch", () => {
	it("returns formatted results from DDG API", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					Abstract: "Abstract text",
					AbstractText: "Abstract description",
					AbstractURL: "https://example.com",
					RelatedTopics: [
						{ Text: "Topic 1 - Description", FirstURL: "https://one.com" },
						{ Text: "Topic 2", FirstURL: "https://two.com" },
					],
				}),
		});

		const result = await duckduckgoSearch("test query", 5);

		expect(result.sourceLabel).toBe("duckduckgo");
		expect(result.sources.length).toBeGreaterThan(0);
		expect(result.answer).toContain("example.com");
	});

	it("handles nested RelatedTopics", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					RelatedTopics: [
						{
							Text: "Parent Topic - Description",
							FirstURL: "https://parent.com",
							Topics: [
								{ Text: "Child Topic - Details", FirstURL: "https://child.com" },
								{ Text: "Child 2", FirstURL: "https://child2.com" },
							],
						},
						{ Text: "Flat Topic", FirstURL: "https://flat.com" },
					],
				}),
		});

		const result = await duckduckgoSearch("test query", 10);

		expect(result.sources).toHaveLength(4);
		expect(result.sources[0].title).toBe("Parent Topic");
		expect(result.sources[1].title).toBe("Child Topic");
		expect(result.sources[2].title).toBe("Child 2");
		expect(result.sources[3].title).toBe("Flat Topic");
	});

	it("handles empty response", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({}),
		});

		const result = await duckduckgoSearch("rare query", 5);
		expect(result.answer).toContain("No results");
	});
});

describe("search orchestrator", () => {
	beforeEach(() => {
		vi.stubEnv("EXA_API_KEY", "");
	});

	it("falls back from exa to duckduckgo when exa not configured", async () => {
		// exa MCP initialize fails (no result in response)
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({}),
		});
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					RelatedTopics: [{ Text: "Result", FirstURL: "https://example.com" }],
				}),
		});

		const result = await search("test", 5);
		expect(result.sourceLabel).toBe("duckduckgo");
	});

	it("uses exa when configured", async () => {
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

	it("uses specified source", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					RelatedTopics: [{ Text: "R", FirstURL: "https://x.com" }],
				}),
		});

		const result = await search("test", 5, undefined, undefined, "duckduckgo");
		expect(result.sourceLabel).toBe("duckduckgo");
	});

	it("throws when all sources unavailable", async () => {
		mockFetch.mockRejectedValue(new Error("network error"));

		await expect(search("test", 5)).rejects.toThrow("All search sources failed");
	});
});
