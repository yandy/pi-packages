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
let buildSources: typeof import("../src/web_search/index.js").buildSources;

beforeEach(async () => {
	vi.resetModules();
	mockFetch.mockReset();
	vi.unstubAllEnvs();

	mockCallTool.mockReset();
	mockClose.mockReset();
	mockClose.mockResolvedValue(undefined);

	// Reset createMcpClient mock so call history is isolated per-test
	const { createMcpClient: mcpReset } = await import("../src/web_search/mcp.js");
	vi.mocked(mcpReset).mockReset();
	vi.mocked(mcpReset).mockResolvedValue({
		callTool: mockCallTool,
		close: mockClose,
	} as any);

	// 重设 createMcpClient 的 mock 实现
	const { createMcpClient } = await import("../src/web_search/mcp.js");
	vi.mocked(createMcpClient).mockResolvedValue({
		callTool: mockCallTool,
		close: mockClose,
	} as any);

	const wsMod = await import("../src/web_search/index.js");
	search = wsMod.search;
	buildSources = wsMod.buildSources;
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
			expect.any(AbortSignal),
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

		const result = await search("test", 5, undefined, undefined, undefined, buildSources({}));
		expect(result.sourceLabel).toBe("exa");
	});

	it("uses exa MCP when no API key", async () => {
		vi.stubEnv("EXA_API_KEY", "");

		const result = await search("test", 5, undefined, undefined, undefined, buildSources({}));
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

		const result = await search("test", 5, undefined, undefined, "exa", buildSources({}));
		expect(result.sourceLabel).toBe("exa");
	});

	it("falls back to aliyun when exa fails", async () => {
		vi.stubEnv("EXA_API_KEY", "");
		vi.stubEnv("ALIYUN_API_KEY", "aliyun-key");
		// exa MCP fails
		mockCallTool.mockRejectedValueOnce(new Error("Exa down"));
		// aliyun succeeds
		mockCallTool.mockResolvedValueOnce({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						pages: [{ title: "Aliyun Fallback", link: "https://aliyun.example.com", snippet: "fallback content" }],
					}),
				},
			],
		});

		const sources = buildSources({ aliyun: "aliyun-key" });
		const result = await search("test", 5, undefined, undefined, undefined, sources);
		expect(result.sourceLabel).toBe("aliyun");
		expect(result.sources[0].title).toBe("Aliyun Fallback");
	});

	it("uses specified aliyun source", async () => {
		vi.stubEnv("ALIYUN_API_KEY", "aliyun-key");
		mockCallTool.mockResolvedValueOnce({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						pages: [{ title: "Aliyun Direct", link: "https://example.com", snippet: "direct" }],
					}),
				},
			],
		});

		const sources = buildSources({ aliyun: "aliyun-key" });
		const result = await search("test", 5, undefined, undefined, "aliyun", sources);
		expect(result.sourceLabel).toBe("aliyun");
	});

	it("throws when all sources fail", async () => {
		vi.stubEnv("EXA_API_KEY", "");
		vi.stubEnv("ALIYUN_API_KEY", "");
		mockCallTool.mockRejectedValueOnce(new Error("Exa error"));
		mockCallTool.mockRejectedValueOnce(new Error("ALIYUN_API_KEY not set"));

		const sources = buildSources({});
		await expect(
			search("test", 5, undefined, undefined, undefined, sources),
		).rejects.toThrow("All search sources failed");
	});

	it("throws for unknown source", async () => {
		const sources = buildSources({});
		await expect(
			search("test", 5, undefined, undefined, "unknown", sources),
		).rejects.toThrow("Unknown source");
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

describe("aliyunSearch", () => {
	it("throws when ALIYUN_API_KEY not set", async () => {
		vi.stubEnv("ALIYUN_API_KEY", "");
		const mod = await import("../src/web_search/aliyun.js");
		const aliyunSearch = mod.aliyunSearch;

		await expect(aliyunSearch("test query", 5)).rejects.toThrow("ALIYUN_API_KEY not set");
	});

	it("calls MCP with Bearer auth", async () => {
		vi.stubEnv("ALIYUN_API_KEY", "test-key");
		const { createMcpClient } = await import("../src/web_search/mcp.js");
		const mod = await import("../src/web_search/aliyun.js");
		const aliyunSearch = mod.aliyunSearch;

		mockCallTool.mockResolvedValueOnce({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						pages: [
							{ title: "Bailian Test", link: "https://example.com", snippet: "Bailian content" },
						],
					}),
				},
			],
		});

		const result = await aliyunSearch("test query", 5);

		expect(result.sourceLabel).toBe("aliyun");
		expect(result.sources).toHaveLength(1);
		expect(result.sources[0].title).toBe("Bailian Test");
		expect(result.sources[0].url).toBe("https://example.com");
		expect(createMcpClient).toHaveBeenCalledWith(
			"https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp",
			{ Authorization: "Bearer test-key" },
			expect.any(AbortSignal),
		);
		expect(mockCallTool).toHaveBeenCalledWith({
			name: "bailian_web_search",
			arguments: { query: "test query", count: 5 },
		});
	});

	it("returns empty results when no pages found", async () => {
		vi.stubEnv("ALIYUN_API_KEY", "test-key");
		const mod = await import("../src/web_search/aliyun.js");
		const aliyunSearch = mod.aliyunSearch;

		mockCallTool.mockResolvedValueOnce({
			content: [{ type: "text", text: JSON.stringify({ pages: [] }) }],
		});

		const result = await aliyunSearch("test query", 5);

		expect(result.sources).toHaveLength(0);
		expect(result.answer).toContain("No results found");
	});

	it("throws on callTool error", async () => {
		vi.stubEnv("ALIYUN_API_KEY", "test-key");
		const mod = await import("../src/web_search/aliyun.js");
		const aliyunSearch = mod.aliyunSearch;

		mockCallTool.mockRejectedValueOnce(new Error("MCP connection failed"));

		await expect(aliyunSearch("test query", 5)).rejects.toThrow("MCP connection failed");
	});

	it("uses apiKey parameter over env var", async () => {
		vi.stubEnv("ALIYUN_API_KEY", "env-key");
		const { createMcpClient } = await import("../src/web_search/mcp.js");
		const mod = await import("../src/web_search/aliyun.js");
		const aliyunSearch = mod.aliyunSearch;

		mockCallTool.mockResolvedValueOnce({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						pages: [{ title: "Param Key", link: "https://param.example.com", snippet: "content" }],
					}),
				},
			],
		});

		await aliyunSearch("test query", 5, undefined, "param-key");

		expect(createMcpClient).toHaveBeenCalledWith(
			expect.any(String),
			{ Authorization: "Bearer param-key" },
			expect.any(AbortSignal),
		);
	});
});
