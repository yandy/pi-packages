# aliyun web_search fallback 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 web_search 工具新增阿里云百炼 WebSearch MCP 作为 Exa 的回退源，同时将 MCP 调用统一升级为 `@modelcontextprotocol/sdk`。

**Architecture:** 新增 `mcp.ts` 共享 MCP Client 工厂，exa.ts MCP 路径和 aliyun.ts 共用。orchestrator 的 SOURCES 从常量改为工厂函数 `buildSources(apiKeys)`，通过闭包注入 API key，SearchFn 签名不变。

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, vitest, typebox.

## 全局约束

- 命名：文件名/函数/source enum/sourceLabel 用 `aliyun`；MCP tool 名保持 `bailian_web_search`
- 环境变量：`ALIYUN_API_KEY`
- API key 优先级：`ALIYUN_API_KEY` env → `buildSources` 闭包传入的 `apiKeys.aliyun`
- fallback 顺序：`exa → aliyun`
- SearchFn 类型不变：`(query, numResults, signal?) => Promise<SearchResponse>`
- 与现有代码风格一致：tab 缩进、双引号、分号、120 列

---

### Task 1: 安装 MCP SDK 依赖

**Files:**
- Modify: `package.json`

**Interfaces:**
- Produces: `@modelcontextprotocol/sdk` 可用

- [ ] **Step 1: 安装依赖**

```bash
npm install @modelcontextprotocol/sdk
```

- [ ] **Step 2: 验证安装**

```bash
node -e "import('@modelcontextprotocol/sdk/client/index.js').then(m => console.log('Client imported OK'))"
node -e "import('@modelcontextprotocol/sdk/client/streamableHttp.js').then(m => console.log('Transport imported OK'))"
```

Expected: 两次都输出 "OK"

- [ ] **Step 3: 运行现有测试确保依赖不破坏任何东西**

```bash
npm test
```

Expected: 所有 12 个测试通过

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json node_modules/
git commit -m "chore: add @modelcontextprotocol/sdk dependency"
```

---

### Task 2: 创建共享 MCP Client 工厂 `src/web_search/mcp.ts`

**Files:**
- Create: `src/web_search/mcp.ts`

**Interfaces:**
- Produces: `createMcpClient(url: string, headers: Record<string, string>): Promise<Client>`

> **注意：** 具体的 `StreamableHTTPClientTransport` 构造参数需根据安装的 SDK 版本确认。以下代码基于 SDK 典型 API，若编译报错需对照 `node_modules/@modelcontextprotocol/sdk/client/streamableHttp.d.ts` 调整。

- [ ] **Step 1: 创建文件**

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export async function createMcpClient(
	url: string,
	headers: Record<string, string>,
): Promise<Client> {
	const transport = new StreamableHTTPClientTransport(new URL(url), {
		requestInit: { headers },
	});

	const client = new Client(
		{ name: "pi-web-tools", version: "0.3.0" },
		{ capabilities: {} },
	);

	await client.connect(transport);
	return client;
}
```

- [ ] **Step 2: 验证类型检查**

```bash
npx tsc --noEmit
```

Expected: 无类型错误。若 `StreamableHTTPClientTransport` API 不匹配，对照 `node_modules/@modelcontextprotocol/sdk/client/streamableHttp.d.ts` 调整构造参数。

- [ ] **Step 3: Commit**

```bash
git add src/web_search/mcp.ts
git commit -m "feat: add shared MCP client factory"
```

---

### Task 3: 用 SDK 重写 exa.ts 的 MCP 路径

**Files:**
- Modify: `src/web_search/exa.ts:57-135`

**Interfaces:**
- Consumes: `createMcpClient` from `./mcp`
- Produces: `exaSearch` 签名不变，MCP 路径改用 SDK
- 保留: `exaRestSearch`（REST 路径）不变，`parseMcpResults`、`formatAnswer` 不变

- [ ] **Step 1: 修改 exa.ts，将 MCP 部分替换为 SDK 调用**

删除 `mcpCall` 函数（第 93-135 行）和 `exaMcpSearch` 函数（第 58-91 行），替换为：

```typescript
import { createMcpClient } from "./mcp";
import type { SearchResponse } from "./types";

const EXA_REST_URL = "https://api.exa.ai/search";
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const MCP_TOOL_NAME = "web_search_exa";
const TIMEOUT_MS = 60_000;

export async function exaSearch(query: string, numResults: number, signal?: AbortSignal): Promise<SearchResponse> {
	const apiKey = process.env.EXA_API_KEY;

	const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);
	const s = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

	if (!apiKey) {
		return exaMcpSearch(query, numResults, s);
	}
	return exaRestSearch(query, numResults, apiKey, s);
}

async function exaRestSearch(
	query: string,
	numResults: number,
	apiKey: string,
	signal: AbortSignal,
): Promise<SearchResponse> {
	const resp = await fetch(EXA_REST_URL, {
		method: "POST",
		headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
		body: JSON.stringify({
			query,
			numResults,
			type: "auto",
			contents: { text: { maxCharacters: 3000 } },
		}),
		signal,
	});

	if (!resp.ok) {
		const detail = await resp.text().catch(() => resp.statusText);
		throw new Error(`Exa API ${resp.status}: ${detail}`);
	}

	const data = (await resp.json()) as {
		results?: Array<{ title?: string; url?: string; text?: string }>;
	};
	const results = data.results || [];

	const sources = results.map((r) => ({
		title: r.title || "Untitled",
		url: r.url || "",
		snippet: (r.text || "").slice(0, 500),
	}));

	const answer = formatAnswer(sources, query);
	return { answer, sources, sourceLabel: "exa" };
}

async function exaMcpSearch(query: string, numResults: number, signal: AbortSignal): Promise<SearchResponse> {
	const client = await createMcpClient(EXA_MCP_URL, {});

	try {
		const result = await client.callTool({
			name: MCP_TOOL_NAME,
			arguments: {
				query,
				numResults,
				type: "auto",
				contents: { text: { maxCharacters: 3000 } },
			},
		});

		const text = result?.content
			?.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n\n") || "";

		const sources = parseMcpResults(text);
		const answer = formatAnswer(sources, query);

		return { answer, sources, sourceLabel: "exa" };
	} finally {
		await client.close().catch(() => {});
	}
}

// parseMcpResults 和 formatAnswer 保持不变
```

- [ ] **Step 2: 验证类型检查**

```bash
npx tsc --noEmit
```

Expected: 无类型错误

- [ ] **Step 3: Commit**

```bash
git add src/web_search/exa.ts
git commit -m "refactor: use MCP SDK for exa MCP path"
```

---

### Task 4: 创建 `src/web_search/aliyun.ts`

**Files:**
- Create: `src/web_search/aliyun.ts`

**Interfaces:**
- Consumes: `createMcpClient` from `./mcp`, `SearchResponse`/`SearchSource` from `./types`
- Produces: `aliyunSearch(query: string, numResults: number, signal?: AbortSignal, apiKey?: string): Promise<SearchResponse>`

- [ ] **Step 1: 创建 aliyun.ts**

```typescript
import { createMcpClient } from "./mcp";
import type { SearchResponse, SearchSource } from "./types";

const ALIYUN_MCP_URL = "https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp";
const MCP_TOOL_NAME = "bailian_web_search";
const TIMEOUT_MS = 60_000;

export async function aliyunSearch(
	query: string,
	numResults: number,
	signal?: AbortSignal,
	apiKey?: string,
): Promise<SearchResponse> {
	const key = apiKey || process.env.ALIYUN_API_KEY;
	if (!key) {
		throw new Error("ALIYUN_API_KEY not set. Get one at https://bailian.console.aliyun.com");
	}

	const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);
	const s = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

	const headers: Record<string, string> = {
		Authorization: `Bearer ${key}`,
	};

	const client = await createMcpClient(ALIYUN_MCP_URL, headers);

	try {
		const result = await client.callTool({
			name: MCP_TOOL_NAME,
			arguments: { query, count: numResults },
		});

		const text = result?.content
			?.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n\n") || "";

		const sources = parseBailianResults(text);
		const answer = formatAnswer(sources, query);

		return { answer, sources, sourceLabel: "aliyun" };
	} finally {
		await client.close().catch(() => {});
	}
}

function parseBailianResults(text: string): SearchSource[] {
	try {
		const data = JSON.parse(text) as {
			pages?: Array<{
				title?: string;
				link?: string;
				url?: string;
				snippet?: string;
				content?: string;
			}>;
		};
		return (data.pages || []).map((p) => ({
			title: p.title || "Untitled",
			url: p.link || p.url || "",
			snippet: (p.snippet || p.content || "").slice(0, 500),
		}));
	} catch {
		return parseTextResults(text);
	}
}

function parseTextResults(text: string): SearchSource[] {
	const results: SearchSource[] = [];
	const blocks = text.split(/\n\n---\n\n/);

	for (const block of blocks) {
		const titleMatch = block.match(/^Title:\s*(.+)$/m);
		const urlMatch = block.match(/^(?:URL|Link):\s*(.+)$/m);
		const snippetMatch = block.match(/^(?:Highlights|Snippet|Content):\s*\n([\s\S]*?)$/m);

		if (urlMatch) {
			results.push({
				title: titleMatch?.[1]?.trim() || "Untitled",
				url: urlMatch[1].trim(),
				snippet: snippetMatch?.[1]?.trim().slice(0, 500) || "",
			});
		}
	}

	return results;
}

function formatAnswer(sources: SearchSource[], query: string): string {
	const lines = sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})\n   ${s.snippet}`);
	return lines.join("\n\n") || `No results found for: ${query}`;
}
```

- [ ] **Step 2: 验证类型检查**

```bash
npx tsc --noEmit
```

Expected: 无类型错误

- [ ] **Step 3: Commit**

```bash
git add src/web_search/aliyun.ts
git commit -m "feat: add aliyun web_search source via Bailian MCP"
```

---

### Task 5: 更新 orchestrator `src/web_search/index.ts`

**Files:**
- Modify: `src/web_search/index.ts`

**Interfaces:**
- Consumes: `exaSearch` from `./exa`, `aliyunSearch` from `./aliyun`
- Produces: `buildSources(apiKeys)`, `search(..., sources?)` — SearchFn 不变

- [ ] **Step 1: 修改 orchestrator**

将文件内容替换为：

```typescript
import { aliyunSearch } from "./aliyun";
import { exaSearch } from "./exa";
import type { SearchResponse } from "./types";

type SearchFn = (query: string, numResults: number, signal?: AbortSignal) => Promise<SearchResponse>;

interface SourceEntry {
	name: string;
	fn: SearchFn;
}

export function buildSources(
	apiKeys: Record<string, string | undefined>,
): SourceEntry[] {
	return [
		{ name: "exa", fn: exaSearch },
		{
			name: "aliyun",
			fn: (query, numResults, signal) =>
				aliyunSearch(query, numResults, signal, apiKeys.aliyun),
		},
	];
}

const DEFAULT_SOURCES = buildSources({});

export async function search(
	query: string,
	numResults: number,
	signal?: AbortSignal,
	onProgress?: (msg: string) => void,
	specifiedSource?: string,
	sources?: SourceEntry[],
): Promise<SearchResponse> {
	const errors: string[] = [];

	const src = sources ?? DEFAULT_SOURCES;

	const filtered = specifiedSource
		? src.filter((s) => s.name === specifiedSource)
		: src;

	if (specifiedSource && filtered.length === 0) {
		throw new Error(
			`Unknown source: ${specifiedSource}. Available: ${src.map((s) => s.name).join(", ")}`,
		);
	}

	for (const source of filtered) {
		try {
			onProgress?.(`Trying ${source.name}...`);
			const resp = await source.fn(query, numResults, signal);
			return resp;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			errors.push(`${source.name}: ${msg}`);
		}
	}

	throw new Error(
		`All search sources failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
	);
}
```

- [ ] **Step 2: 验证类型检查**

```bash
npx tsc --noEmit
```

Expected: 无类型错误

- [ ] **Step 3: 运行现有测试确保向后兼容**

```bash
npm test
```

Expected: 测试通过（orchestrator 测试使用默认 sources，行为应不变）

- [ ] **Step 4: Commit**

```bash
git add src/web_search/index.ts
git commit -m "refactor: change SOURCES to buildSources factory with aliyun fallback"
```

---

### Task 6: 更新工具注册入口 `index.ts`

**Files:**
- Modify: `index.ts:5,14-28,49-77`

**Interfaces:**
- Consumes: `search`, `buildSources` from `./src/web_search/index`
- Uses: `ctx.modelRegistry.getApiKeyForProvider("aliyun")` for API key resolution

- [ ] **Step 1: 更新描述和参数 schema**

对 `index.ts` 做以下修改：

```typescript
// 第 5 行：import 新增 buildSources
import { search, buildSources } from "./src/web_search/index";
```

```typescript
// 第 14-18 行：更新 description 和 promptSnippet
description:
	`Search the web via Exa or Aliyun. Exa (default): with EXA_API_KEY uses full REST API, without uses MCP free tier (150 calls/day). ` +
	`Aliyun fallback: requires ALIYUN_API_KEY or a registered aliyun provider. ` +
	`The current year is ${new Date().getFullYear()}.`,
promptSnippet:
	"web_search: search the web via Exa with Aliyun fallback. Returns raw results with titles, URLs, snippets. LLM synthesizes the answer.",
```

```typescript
// 第 28 行：更新 source enum
source: Type.Optional(Type.String({ enum: ["exa", "aliyun"], description: "Search source. Default: exa." })),
```

```typescript
// 第 49 行：execute 参数中使用 ctx
async execute(_toolCallId, params, signal, onUpdate, ctx) {
```

```typescript
// 第 66-68 行：在 search() 调用前新增 API key 解析和 source 构建
try {
	const aliyunApiKey = await ctx.modelRegistry
		.getApiKeyForProvider("aliyun")
		.catch(() => undefined);

	const sources = buildSources({ aliyun: aliyunApiKey });

	const result = await search(query, p.numResults ?? 10, signal, onProgress, p.source, sources);
```

- [ ] **Step 2: 验证类型检查**

```bash
npx tsc --noEmit
```

Expected: 无类型错误

- [ ] **Step 3: 检查 linter**

```bash
npm run lint
```

Expected: 无 lint 错误

- [ ] **Step 4: Commit**

```bash
git add index.ts
git commit -m "feat: wire aliyun source into web_search tool with provider key resolution"
```

---

### Task 7: 更新测试

**Files:**
- Modify: `tests/web_search.test.ts`（全部重写以适配 SDK mock）

**Interfaces:**
- Consumes: `search`, `buildSources` from `../src/web_search/index.js`
- Mock pattern: `vi.mock("../src/web_search/mcp.js")`，假 `createMcpClient` 返回可控 `callTool`

- [ ] **Step 1: 重写测试文件**

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

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
	mockCallTool.mockReset();
	mockClose.mockReset();
	vi.unstubAllEnvs();

	// 重设 createMcpClient 的 mock 实现
	const { createMcpClient } = await import("../src/web_search/mcp.js");
	vi.mocked(createMcpClient).mockResolvedValue({
		callTool: mockCallTool,
		close: mockClose,
	});

	const wsMod = await import("../src/web_search/index.js");
	search = wsMod.search;
	buildSources = wsMod.buildSources;
});

// ---------------------------------------------------------------------------
// aliyunSearch
// ---------------------------------------------------------------------------

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
		);
	});
});

// ---------------------------------------------------------------------------
// exaSearch (adapted for SDK mock)
// ---------------------------------------------------------------------------

describe("exaSearch", () => {
	it("falls back to MCP when EXA_API_KEY not set", async () => {
		vi.stubEnv("EXA_API_KEY", "");
		const { createMcpClient } = await import("../src/web_search/mcp.js");
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

		expect(result.sourceLabel).toBe("exa");
		expect(createMcpClient).toHaveBeenCalledWith(
			"https://mcp.exa.ai/mcp",
			{},
		);
		expect(mockCallTool).toHaveBeenCalledWith(
			expect.objectContaining({ name: "web_search_exa" }),
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

	it("throws when MCP call fails", async () => {
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
		mockCallTool.mockResolvedValueOnce({
			content: [
				{ type: "text", text: "Title: X\nURL: https://x.com\nHighlights:\nyes" },
			],
		});

		const sources = buildSources({});
		const result = await search("test", 5, undefined, undefined, undefined, sources);
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
```

- [ ] **Step 2: 运行测试**

```bash
npm test
```

Expected: 全部 24 个测试通过（aliyunSearch 5 + exaSearch 5 + orchestrator 7 = 17 web_search 测试 + 7 web_fetch 测试）

- [ ] **Step 3: 运行 typecheck 和 lint**

```bash
npm run typecheck && npm run lint
```

Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add tests/web_search.test.ts
git commit -m "test: update web_search tests for SDK-based MCP and aliyun fallback"
```
