import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

let search: typeof import("../src/web_search/index.js").search;
let buildSources: typeof import("../src/web_search/index.js").buildSources;
let testServer: Server;

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("../src/web_search/mcp.js", () => ({
	createMcpClient: vi.fn().mockImplementation(async () => {
		const [ct, st] = InMemoryTransport.createLinkedPair();
		const client = new Client(
			{ name: "test-client", version: "1.0" },
			{ capabilities: {} },
		);
		await Promise.all([client.connect(ct), testServer.connect(st)]);
		return client;
	}),
}));

beforeEach(async () => {
	vi.resetModules();
	mockFetch.mockReset();
	vi.unstubAllEnvs();

	testServer = new Server(
		{ name: "test-server", version: "1.0" },
		{ capabilities: { tools: {} } },
	);

	const wsMod = await import("../src/web_search/index.js");
	search = wsMod.search;
	buildSources = wsMod.buildSources;
});

// ---------------------------------------------------------------------------
// mcp client
// ---------------------------------------------------------------------------

describe("mcp client", () => {
	it("createMcpClient is a function exported from the real module", async () => {
		const actualModule = await vi.importActual<typeof import("../src/web_search/mcp.js")>("../src/web_search/mcp.js");
		expect(actualModule.createMcpClient).toBeDefined();
		expect(typeof actualModule.createMcpClient).toBe("function");
	});
});

// ---------------------------------------------------------------------------
// exaSearch
// ---------------------------------------------------------------------------

describe("exaSearch", () => {
	it("falls back to MCP when EXA_API_KEY not set", async () => {
		vi.stubEnv("EXA_API_KEY", "");
		const mod = await import("../src/web_search/exa.js");

		testServer.setRequestHandler(CallToolRequestSchema, async (request) => {
			expect(request.params.name).toBe("web_search_exa");
			return {
				content: [
					{
						type: "text",
						text: "Title: Test\nURL: https://example.com\nHighlights:\nSample content",
					},
				],
			};
		});

		const result = await mod.exaSearch("test query", 5);

		expect(result.sourceLabel).toBe("exa");
		expect(result.sources).toHaveLength(1);
		expect(result.sources[0].title).toBe("Test");
	});

	it("calls REST API when EXA_API_KEY is set", async () => {
		vi.stubEnv("EXA_API_KEY", "test-key");
		const mod = await import("../src/web_search/exa.js");

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

		const result = await mod.exaSearch("test query", 5);

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

		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 500,
			text: () => Promise.resolve("Internal Server Error"),
		});

		await expect(mod.exaSearch("test query", 5)).rejects.toThrow("Exa API 500");
	});

	it("throws when MCP call fails", async () => {
		vi.stubEnv("EXA_API_KEY", "");
		const mod = await import("../src/web_search/exa.js");

		testServer.setRequestHandler(CallToolRequestSchema, async () => {
			throw new Error("Simulated MCP error");
		});

		await expect(mod.exaSearch("test query", 5)).rejects.toThrow("Simulated MCP error");
	});

	it("shows fallback message for empty REST results", async () => {
		vi.stubEnv("EXA_API_KEY", "test-key");
		const mod = await import("../src/web_search/exa.js");

		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ results: [] }),
		});

		const result = await mod.exaSearch("test query", 5);

		expect(result.sources).toHaveLength(0);
		expect(result.answer).toContain("No results found");
	});
});

// ---------------------------------------------------------------------------
// aliyunSearch
// ---------------------------------------------------------------------------

describe("aliyunSearch", () => {
	it("throws when ALIYUN_API_KEY not set", async () => {
		vi.stubEnv("ALIYUN_API_KEY", "");
		const mod = await import("../src/web_search/aliyun.js");

		await expect(mod.aliyunSearch("test query", 5)).rejects.toThrow("ALIYUN_API_KEY not set");
	});

	it("calls MCP with correct tool name and returns parsed results", async () => {
		vi.stubEnv("ALIYUN_API_KEY", "test-key");
		const mod = await import("../src/web_search/aliyun.js");

		testServer.setRequestHandler(CallToolRequestSchema, async (request) => {
			expect(request.params.name).toBe("bailian_web_search");
			expect(request.params.arguments).toEqual({ query: "test query", count: 5 });
			return {
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
			};
		});

		const result = await mod.aliyunSearch("test query", 5);

		expect(result.sourceLabel).toBe("aliyun");
		expect(result.sources).toHaveLength(1);
		expect(result.sources[0].title).toBe("Bailian Test");
		expect(result.sources[0].url).toBe("https://example.com");
	});

	it("returns empty results when no pages found", async () => {
		vi.stubEnv("ALIYUN_API_KEY", "test-key");
		const mod = await import("../src/web_search/aliyun.js");

		testServer.setRequestHandler(CallToolRequestSchema, async () => ({
			content: [{ type: "text", text: JSON.stringify({ pages: [] }) }],
		}));

		const result = await mod.aliyunSearch("test query", 5);

		expect(result.sources).toHaveLength(0);
		expect(result.answer).toContain("No results found");
	});

	it("throws on Server error", async () => {
		vi.stubEnv("ALIYUN_API_KEY", "test-key");
		const mod = await import("../src/web_search/aliyun.js");

		testServer.setRequestHandler(CallToolRequestSchema, async () => {
			throw new Error("MCP server error");
		});

		await expect(mod.aliyunSearch("test query", 5)).rejects.toThrow("MCP server error");
	});

	it("uses apiKey parameter over env var", async () => {
		vi.stubEnv("ALIYUN_API_KEY", "env-key");
		const mod = await import("../src/web_search/aliyun.js");
		const { createMcpClient } = await import("../src/web_search/mcp.js");

		testServer.setRequestHandler(CallToolRequestSchema, async () => ({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						pages: [{ title: "Param Key", link: "https://param.example.com", snippet: "content" }],
					}),
				},
			],
		}));

		const result = await mod.aliyunSearch("test query", 5, undefined, "param-key");

		expect(result.sourceLabel).toBe("aliyun");
		expect(result.sources[0].title).toBe("Param Key");
		expect(vi.mocked(createMcpClient)).toHaveBeenCalledWith(
			expect.any(String),
			{ Authorization: "Bearer param-key" },
			expect.any(AbortSignal),
		);
	});
});

// ---------------------------------------------------------------------------
// search orchestrator
// ---------------------------------------------------------------------------

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

		const sources = buildSources({});
		const result = await search("test", 5, undefined, undefined, undefined, sources);
		expect(result.sourceLabel).toBe("exa");
	});

	it("uses exa MCP when no API key", async () => {
		vi.stubEnv("EXA_API_KEY", "");
		testServer.setRequestHandler(CallToolRequestSchema, async () => ({
			content: [{ type: "text", text: "Title: X\nURL: https://x.com\nHighlights:\nyes" }],
		}));

		const sources = buildSources({});
		const result = await search("test", 5, undefined, undefined, undefined, sources);
		expect(result.sourceLabel).toBe("exa");
	});

	it("uses specified exa source", async () => {
		vi.stubEnv("EXA_API_KEY", "test-key");
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					results: [{ title: "R", url: "https://x.com", text: "content" }],
				}),
		});

		const sources = buildSources({});
		const result = await search("test", 5, undefined, undefined, "exa", sources);
		expect(result.sourceLabel).toBe("exa");
	});

	it("falls back to aliyun when exa fails", async () => {
		vi.stubEnv("EXA_API_KEY", "");
		vi.stubEnv("ALIYUN_API_KEY", "aliyun-key");

		testServer.setRequestHandler(CallToolRequestSchema, async (request) => {
			if (request.params.name === "web_search_exa") {
				throw new Error("Exa down");
			}
			if (request.params.name === "bailian_web_search") {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								pages: [{ title: "Aliyun Fallback", link: "https://a.com", snippet: "fallback" }],
							}),
						},
					],
				};
			}
			throw new Error(`Unexpected tool: ${request.params.name}`);
		});

		const sources = buildSources({ aliyun: "aliyun-key" });
		const result = await search("test", 5, undefined, undefined, undefined, sources);
		expect(result.sourceLabel).toBe("aliyun");
		expect(result.sources[0].title).toBe("Aliyun Fallback");
	});

	it("uses specified aliyun source", async () => {
		vi.stubEnv("ALIYUN_API_KEY", "aliyun-key");
		testServer.setRequestHandler(CallToolRequestSchema, async () => ({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						pages: [{ title: "Aliyun Direct", link: "https://example.com", snippet: "direct" }],
					}),
				},
			],
		}));

		const sources = buildSources({ aliyun: "aliyun-key" });
		const result = await search("test", 5, undefined, undefined, "aliyun", sources);
		expect(result.sourceLabel).toBe("aliyun");
	});

	it("throws when all sources fail", async () => {
		vi.stubEnv("EXA_API_KEY", "");
		vi.stubEnv("ALIYUN_API_KEY", "");

		testServer.setRequestHandler(CallToolRequestSchema, async () => {
			throw new Error("Fail");
		});

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
