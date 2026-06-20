import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Shared MCP mock
// ---------------------------------------------------------------------------

const mockCallTool = vi.fn();
const mockClose = vi.fn();

vi.mock("../src/web_search/mcp.js", () => ({
	createMcpClient: vi.fn().mockResolvedValue({
		callTool: mockCallTool,
		close: mockClose,
	}),
}));

let search: typeof import("../src/web_search/index.js").search;

beforeEach(async () => {
	vi.resetModules();
	mockFetch.mockReset();
	vi.unstubAllEnvs();

	mockCallTool.mockReset();
	mockClose.mockReset();
	mockClose.mockResolvedValue(undefined);

	// 重设 createMcpClient 的 mock 实现
	const { createMcpClient } = await import("../src/web_search/mcp.js");
	vi.mocked(createMcpClient).mockResolvedValue({
		callTool: mockCallTool,
		close: mockClose,
	} as any);

	const wsMod = await import("../src/web_search/index.js");
	search = wsMod.search;
});

describe("exaSearch", () => {
	it("falls back to MCP when EXA_API_KEY not set", async () => {
		vi.stubEnv("EXA_API_KEY", "");
		const mod = await import("../src/web_search/exa.js");
		const exaSearch = mod.exaSearch;

		mockCallTool.mockResolvedValueOnce({
			content: [
				{
					type: "text",
					text: "Title: Test\nURL: https://example.com\nHighlights:\nSample content",
				},
			],
		});

		const result = await exaSearch("test query", 5);

		const { createMcpClient } = await import("../src/web_search/mcp.js");
		expect(createMcpClient).toHaveBeenCalledWith(
			"https://mcp.exa.ai/mcp",
			{},
		);
		expect(mockCallTool).toHaveBeenCalledWith(
			expect.objectContaining({ name: "web_search_exa" }),
		);
		expect(result.sourceLabel).toBe("exa");
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

		mockCallTool.mockRejectedValueOnce(new Error("Connection refused"));

		await expect(exaSearch("test query", 5)).rejects.toThrow("Connection refused");
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
			headers: new Headers({ "content-type": "application/json" }),
			json: () => Promise.resolve({ result: {} }),
		});
		mockFetch.mockResolvedValueOnce({
			ok: true,
			headers: new Headers({ "content-type": "application/json" }),
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
		mockCallTool.mockRejectedValueOnce(new Error("Connection refused"));

		await expect(search("test", 5)).rejects.toThrow("All search sources failed");
	});

	it("throws for unknown source", async () => {
		await expect(search("test", 5, undefined, undefined, "unknown")).rejects.toThrow("Unknown source");
	});
});

describe("mcp client", () => {
	it("createMcpClient resolves with callTool and close", async () => {
		const { createMcpClient } = await import("../src/web_search/mcp.js");

		const client = await createMcpClient("https://test.example.com/mcp", {
			Authorization: "Bearer test-key",
		});

		expect(client.callTool).toBe(mockCallTool);
		expect(client.close).toBe(mockClose);
	});
});
