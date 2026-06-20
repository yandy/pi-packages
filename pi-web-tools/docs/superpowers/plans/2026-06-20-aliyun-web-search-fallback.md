# aliyun web_search fallback 实现计划（TDD）

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
- **TDD 约束**：每个 task 内先写测试 → 验证失败 → 实现 → 验证通过

---

### Task 1: 安装 MCP SDK 依赖

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 安装依赖**

```bash
npm install @modelcontextprotocol/sdk
```

- [ ] **Step 2: 验证安装**

```bash
node -e "import('@modelcontextprotocol/sdk/client/index.js').then(m => console.log('Client OK'))"
node -e "import('@modelcontextprotocol/sdk/client/streamableHttp.js').then(m => console.log('Transport OK'))"
```

Expected: 两次都输出 "OK"

- [ ] **Step 3: 运行现有测试确保依赖不破坏任何东西**

```bash
npm test
```

Expected: 17 个测试通过

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @modelcontextprotocol/sdk dependency"
```

---

### Task 2: 创建 `mcp.ts`（TDD）

**Files:**
- Create: `src/web_search/mcp.ts`
- Modify: `tests/web_search.test.ts`（在文件末尾追加 mcp.ts 的 mock 和测试）

**Interfaces:**
- Produces: `createMcpClient(url: string, headers: Record<string, string>): Promise<Client>`
- Mock 约定：`vi.mock("../src/web_search/mcp.js", ...)`，假 `createMcpClient` 返回 `{ callTool, close }`

> **注意：** 具体 `StreamableHTTPClientTransport` 构造参数需根据安装的 SDK 版本确认。若编译报错，参考 `node_modules/@modelcontextprotocol/sdk/client/streamableHttp.d.ts` 调整。

- [ ] **Step 1: 在 tests/web_search.test.ts 末尾追加 mcp mock 和第一个测试**

在 `tests/web_search.test.ts` 文件末尾（`}` 之前），追加：

```typescript
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
```

然后在 `beforeEach` 块中追加 mock 重置。找到现有的 `beforeEach`，追加：

```typescript
	mockCallTool.mockReset();
	mockClose.mockReset();

	// 重设 createMcpClient 的 mock 实现
	const { createMcpClient } = await import("../src/web_search/mcp.js");
	vi.mocked(createMcpClient).mockResolvedValue({
		callTool: mockCallTool,
		close: mockClose,
	});
```

追加 `describe("mcp client", ...)` 测试套件：

```typescript
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
```

- [ ] **Step 2: 运行测试，验证失败**

```bash
npm test
```

Expected: 新测试 FAIL —— 因为 `src/web_search/mcp.js` 还不存在或 mock 未生效

- [ ] **Step 3: 实现 `src/web_search/mcp.ts`**

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

- [ ] **Step 4: 运行测试，验证通过**

```bash
npm test
```

Expected: 18 个测试通过（新增 1 个 mcp client 测试）

- [ ] **Step 5: 验证类型检查**

```bash
npx tsc --noEmit
```

Expected: 无类型错误。若 `StreamableHTTPClientTransport` API 不匹配，对照 `node_modules/@modelcontextprotocol/sdk/client/streamableHttp.d.ts` 调整构造参数。

- [ ] **Step 6: Commit**

```bash
git add src/web_search/mcp.ts tests/web_search.test.ts
git commit -m "feat: add shared MCP client factory with test"
```

---

### Task 3: 用 SDK 重写 exa.ts 的 MCP 路径（TDD）

**Files:**
- Modify: `src/web_search/exa.ts:57-135`
- Modify: `tests/web_search.test.ts`（更新 exaSearch 测试套件）

**保留:** `exaRestSearch`（REST 路径）不变，`parseMcpResults`、`formatAnswer` 不变

- [ ] **Step 1: 更新 exaSearch 测试，使 MCP 路径测试使用 SDK mock 而非 fetch mock**

将现有 `describe("exaSearch", ...)` 中依赖 `mockFetch` 的 MCP 测试改为使用 `mockCallTool`：

**修改 "falls back to MCP when EXA_API_KEY not set" 测试：**

将：
```typescript
mockFetch.mockResolvedValueOnce({ ok: true, headers: ..., json: ... });
mockFetch.mockResolvedValueOnce({ ok: true, headers: ..., json: ... });
```
替换为：
```typescript
mockCallTool.mockResolvedValueOnce({
    content: [
        {
            type: "text",
            text: "Title: Test\nURL: https://example.com\nHighlights:\nSample content",
        },
    ],
});
```

并将断言从检查 `mockFetch` 调用改为：
```typescript
const { createMcpClient } = await import("../src/web_search/mcp.js");
expect(createMcpClient).toHaveBeenCalledWith(
    "https://mcp.exa.ai/mcp",
    {},
);
expect(mockCallTool).toHaveBeenCalledWith(
    expect.objectContaining({ name: "web_search_exa" }),
);
```

**修改 "throws on MCP initialize non-2xx response" 测试：**

将 fetch mock 替换为：
```typescript
mockCallTool.mockRejectedValueOnce(new Error("Connection refused"));
```
断言改为 `rejects.toThrow("Connection refused")`。

> REST 路径测试（"calls REST API when EXA_API_KEY is set"、"throws on REST API non-2xx response"、"shows fallback message for empty REST results"）不变，继续用 `mockFetch`。

- [ ] **Step 2: 运行测试，验证 exaSearch MCP 测试失败**

```bash
npx vitest run tests/web_search.test.ts -t "exaSearch"
```

Expected: MCP 相关测试 FAIL —— 因为 exa.ts 还是旧的 fetch 实现

- [ ] **Step 3: 重写 exa.ts 的 MCP 路径**

在 `exa.ts` 顶部新增 import：`import { createMcpClient } from "./mcp";`

删除 `mcpCall` 函数（第 93-135 行），重写 `exaMcpSearch`（第 58-91 行）为：

```typescript
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
```

- [ ] **Step 4: 运行测试，验证通过**

```bash
npm test
```

Expected: 全部 18 个测试通过（exaSearch 5 + orchestrator 5 + mcp client 1 + web_fetch 7）

- [ ] **Step 5: 验证类型检查**

```bash
npx tsc --noEmit
```

Expected: 无类型错误

- [ ] **Step 6: Commit**

```bash
git add src/web_search/exa.ts tests/web_search.test.ts
git commit -m "refactor: use MCP SDK for exa MCP path (TDD)"
```

---

### Task 4: 创建 `aliyun.ts`（TDD）

**Files:**
- Create: `src/web_search/aliyun.ts`
- Modify: `tests/web_search.test.ts`（在末尾追加 aliyunSearch 测试套件）

- [ ] **Step 1: 在测试文件中追加 aliyunSearch 测试**

在 `tests/web_search.test.ts` 末尾追加 `describe("aliyunSearch", ...)`：

```typescript
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
```

- [ ] **Step 2: 运行测试，验证新测试失败**

```bash
npx vitest run tests/web_search.test.ts -t "aliyunSearch"
```

Expected: 全部 FAIL —— aliyun.js 还不存在

- [ ] **Step 3: 实现 `src/web_search/aliyun.ts`**

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

- [ ] **Step 4: 运行测试，验证通过**

```bash
npm test
```

Expected: 23 个测试通过（aliyunSearch 5 + exaSearch 5 + orchestrator 5 + mcp client 1 + web_fetch 7）

- [ ] **Step 5: 验证类型检查**

```bash
npx tsc --noEmit
```

Expected: 无类型错误

- [ ] **Step 6: Commit**

```bash
git add src/web_search/aliyun.ts tests/web_search.test.ts
git commit -m "feat: add aliyun web_search source via Bailian MCP (TDD)"
```

---

### Task 5: 更新 orchestrator + 测试（TDD）

**Files:**
- Modify: `src/web_search/index.ts`
- Modify: `tests/web_search.test.ts`（更新 orchestrator 测试套件，追加 fallback 测试）

- [ ] **Step 1: 更新 orchestrator 测试**

**更新现有测试签名：** 所有 `search(...)` 调用需要在末尾加 `sources` 参数。添加导入 `buildSources`。

在测试文件顶部的 `beforeEach` 中，将：
```typescript
search = wsMod.search;
```
改为：
```typescript
search = wsMod.search;
buildSources = wsMod.buildSources;
```

并在变量声明中添加：
```typescript
let buildSources: typeof import("../src/web_search/index.js").buildSources;
```

**修改现有 orchestrator 测试：**
- 每个 `search("test", 5, ...)` 调用末尾加 `, buildSources(...)` 参数
- 需要 aliyun API key 的测试加 `vi.stubEnv("ALIYUN_API_KEY", "aliyun-key")`

具体改动：

"uses exa with API key"：`search("test", 5, undefined, undefined, undefined, buildSources({}))`

"uses exa MCP when no API key"：同上，但 `mockFetch` → `mockCallTool`

"uses specified source"：改为 `search("test", 5, undefined, undefined, "exa", buildSources({}))`

**追加新的 orchestrator 测试：**

```typescript
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
```

- [ ] **Step 2: 运行测试，验证新/改测试失败**

```bash
npm test
```

Expected: orchestrator 测试 FAIL —— `sources` 参数还不支持，且 `buildSources` 还不存在

- [ ] **Step 3: 实现 orchestrator 改动**

将 `src/web_search/index.ts` 内容替换为：

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

- [ ] **Step 4: 运行测试，验证通过**

```bash
npm test
```

Expected: 全部 25 个测试通过（aliyunSearch 5 + exaSearch 5 + orchestrator 7 + mcp client 1 + web_fetch 7）

- [ ] **Step 5: 验证类型检查和 lint**

```bash
npx tsc --noEmit && npm run lint
```

Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add src/web_search/index.ts tests/web_search.test.ts
git commit -m "refactor: SOURCES to buildSources factory with aliyun fallback (TDD)"
```

---

### Task 6: 更新工具注册入口 `index.ts`

**Files:**
- Modify: `index.ts:5,14-28,49-77`

**此 task 无需独立测试** —— 变更已在 Task 5 的 orchestrator 测试中覆盖。

- [ ] **Step 1: 更新 import、描述、参数 schema 和 execute**

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
// 第 49 行：参数名从 _ctx 改为 ctx
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

- [ ] **Step 2: 运行完整测试**

```bash
npm test
```

Expected: 全部 25 个测试通过

- [ ] **Step 3: 验证 typecheck 和 lint**

```bash
npm run typecheck && npm run lint
```

Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add index.ts
git commit -m "feat: wire aliyun source into web_search tool (TDD)"
```

---

### Task 7: 最终验证

- [ ] **Step 1: 运行全部测试**

```bash
npm test
```

Expected: 25 个测试全部通过

- [ ] **Step 2: 运行完整检查**

```bash
npm run check
```

Expected: 无 biome 错误

- [ ] **Step 3: 查看变更总结**

```bash
git log --oneline -7
git diff --stat main..HEAD
```

- [ ] **Step 4: Commit（如 Task 6 有遗漏变更）**

```bash
git add -A
git diff --cached
git commit -m "chore: final verification tweaks"
```
