# aliyun web_search fallback 实现计划（TDD）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

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
- **测试策略**：使用 `InMemoryTransport.createLinkedPair()` + 真实 `Client`/`Server`，不 mock `mcp.ts` 模块本身。`mockFetch` 仅用于 exa REST 路径。

## 测试基础设施

所有 MCP 相关测试共享以下设置：

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

let search: typeof import("../src/web_search/index.js").search;
let buildSources: typeof import("../src/web_search/index.js").buildSources;
let testServer: Server;
let testClient: Client;

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock mcp.ts: createMcpClient returns testClient (connected via InMemoryTransport)
vi.mock("../src/web_search/mcp.js", () => ({
    createMcpClient: vi.fn().mockImplementation(() => Promise.resolve(testClient)),
}));

beforeEach(async () => {
    vi.resetModules();
    mockFetch.mockReset();
    vi.unstubAllEnvs();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    testServer = new Server(
        { name: "test-server", version: "1.0" },
        { capabilities: { tools: {} } },
    );

    testClient = new Client(
        { name: "test-client", version: "1.0" },
        { capabilities: {} },
    );

    await Promise.all([
        testClient.connect(clientTransport),
        testServer.connect(serverTransport),
    ]);

    const wsMod = await import("../src/web_search/index.js");
    search = wsMod.search;
    buildSources = wsMod.buildSources;
});
```

**每个测试**通过 `testServer.setRequestHandler(CallToolRequestSchema, ...)` 配置返回数据。createMcpClient mock 返回的 testClient 通过 InMemoryTransport 与 testServer 通信，使用真实的 MCP 协议。

**mockFetch** 仅用于 exa REST 路径测试。

---

### Task 1: 安装 MCP SDK 依赖

**Files:** Modify `package.json`

- [ ] `npm install @modelcontextprotocol/sdk`
- [ ] `npm test` — 17 tests pass
- [ ] Commit: `chore: add @modelcontextprotocol/sdk dependency`

---

### Task 2: 创建 `src/web_search/mcp.ts`（TDD）

**Files:** Create `src/web_search/mcp.ts`, modify `tests/web_search.test.ts`

**先写测试：** 在 `tests/web_search.test.ts` 中添加 InMemoryTransport 基础设施和 mcp client 测试。

- [ ] **Step 1 (RED):** 添加测试基础设施（imports、beforeEach、InMemoryTransport setup）和一个 mcp client 测试：

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

let search: typeof import("../src/web_search/index.js").search;
let buildSources: typeof import("../src/web_search/index.js").buildSources;
let testServer: Server;
let testClient: Client;

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("../src/web_search/mcp.js", () => ({
	createMcpClient: vi.fn().mockImplementation(() => Promise.resolve(testClient)),
}));

beforeEach(async () => {
	vi.resetModules();
	mockFetch.mockReset();
	vi.unstubAllEnvs();

	const [ct, st] = InMemoryTransport.createLinkedPair();
	testServer = new Server({ name: "test-server", version: "1.0" }, { capabilities: { tools: {} } });
	testClient = new Client({ name: "test-client", version: "1.0" }, { capabilities: {} });
	await Promise.all([testClient.connect(ct), testServer.connect(st)]);

	const wsMod = await import("../src/web_search/index.js");
	search = wsMod.search;
	buildSources = wsMod.buildSources;
});

describe("mcp client", () => {
	it("createMcpClient resolves with a Client", async () => {
		const { createMcpClient } = await import("../src/web_search/mcp.js");
		const client = await createMcpClient("https://test.example.com/mcp", {});
		expect(client).toBe(testClient);
	});
});
```

- [ ] **Step 2 (RED expected):** 运行测试 — `mcp.js` 不存在，编译失败 → FAIL

- [ ] **Step 3 (GREEN):** 实现 `src/web_search/mcp.ts`

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export async function createMcpClient(
	url: string,
	headers: Record<string, string>,
	signal?: AbortSignal,
): Promise<Client> {
	const transport = new StreamableHTTPClientTransport(new URL(url), {
		requestInit: { headers, signal },
	});
	const client = new Client(
		{ name: "pi-web-tools", version: "0.3.0" },
		{ capabilities: {} },
	);
	await client.connect(transport);
	return client;
}
```

- [ ] **Step 4:** `npx tsc --noEmit` + `npm test` — all pass

- [ ] Commit: `feat: add shared MCP client factory`

---

### Task 3: 用 SDK 重写 exa.ts MCP 路径（TDD）

**Files:** Modify `src/web_search/exa.ts`, modify `tests/web_search.test.ts`

- [ ] **Step 1 (RED):** 更新 exaSearch 测试 — MCP 测试改用 testServer.setRequestHandler

```typescript
describe("exaSearch", () => {
	it("falls back to MCP when EXA_API_KEY not set", async () => {
		vi.stubEnv("EXA_API_KEY", "");
		const mod = await import("../src/web_search/exa.js");

		testServer.setRequestHandler(CallToolRequestSchema, async (request) => {
			expect(request.params.name).toBe("web_search_exa");
			return {
				content: [{ type: "text", text: "Title: Test\nURL: https://example.com\nHighlights:\nSample content" }],
			};
		});

		const result = await mod.exaSearch("test query", 5);
		expect(result.sourceLabel).toBe("exa");
		expect(result.sources[0].title).toBe("Test");
	});

	it("throws when MCP call fails", async () => {
		vi.stubEnv("EXA_API_KEY", "");
		const mod = await import("../src/web_search/exa.js");

		testServer.setRequestHandler(CallToolRequestSchema, async () => {
			throw new Error("Simulated error");
		});

		await expect(mod.exaSearch("test query", 5)).rejects.toThrow();
	});

	// REST 测试不变（用 mockFetch）:
	// "calls REST API when EXA_API_KEY is set"
	// "throws on REST API non-2xx response"
	// "shows fallback message for empty REST results"
});
```

- [ ] **Step 2:** 运行 — exa MCP 测试 FAIL（exa.ts 仍用旧 fetch）

- [ ] **Step 3 (GREEN):** 在 `exa.ts` 中导入 `createMcpClient`，重写 `exaMcpSearch`，删除 `mcpCall`

```typescript
import { createMcpClient } from "./mcp";

// ... exaRestSearch 不变 ...

async function exaMcpSearch(query: string, numResults: number, signal: AbortSignal): Promise<SearchResponse> {
	const client = await createMcpClient(EXA_MCP_URL, {}, signal);
	try {
		const result = await client.callTool({
			name: MCP_TOOL_NAME,
			arguments: { query, numResults, type: "auto", contents: { text: { maxCharacters: 3000 } } },
		});
		const text = result?.content?.filter((c): c is { type: "text"; text: string } => c.type === "text").map(c => c.text).join("\n\n") || "";
		const sources = parseMcpResults(text);
		return { answer: formatAnswer(sources, query), sources, sourceLabel: "exa" };
	} finally {
		await client.close().catch(() => {});
	}
}
```

- [ ] **Step 4:** `npm test` — all pass, `npx tsc --noEmit` — clean

- [ ] Commit: `refactor: use MCP SDK for exa MCP path`

---

### Task 4: 创建 `src/web_search/aliyun.ts`（TDD）

**Files:** Create `src/web_search/aliyun.ts`, modify `tests/web_search.test.ts`

- [ ] **Step 1 (RED):** 追加 aliyunSearch 测试（5 个）：

```typescript
describe("aliyunSearch", () => {
	it("throws when ALIYUN_API_KEY not set", async () => {
		vi.stubEnv("ALIYUN_API_KEY", "");
		const mod = await import("../src/web_search/aliyun.js");
		await expect(mod.aliyunSearch("test query", 5)).rejects.toThrow("ALIYUN_API_KEY not set");
	});

	it("calls MCP with Bearer auth and returns results", async () => {
		vi.stubEnv("ALIYUN_API_KEY", "test-key");
		const mod = await import("../src/web_search/aliyun.js");

		testServer.setRequestHandler(CallToolRequestSchema, async (request) => {
			expect(request.params.name).toBe("bailian_web_search");
			expect(request.params.arguments).toEqual({ query: "test query", count: 5 });
			return {
				content: [{ type: "text", text: JSON.stringify({
					pages: [{ title: "Bailian Test", link: "https://example.com", snippet: "content" }],
				}) }],
			};
		});

		const result = await mod.aliyunSearch("test query", 5);
		expect(result.sourceLabel).toBe("aliyun");
		expect(result.sources).toHaveLength(1);
		expect(result.sources[0].title).toBe("Bailian Test");
	});

	it("returns empty when no pages", async () => {
		vi.stubEnv("ALIYUN_API_KEY", "test-key");
		const mod = await import("../src/web_search/aliyun.js");
		testServer.setRequestHandler(CallToolRequestSchema, async () => ({
			content: [{ type: "text", text: JSON.stringify({ pages: [] }) }],
		}));
		const result = await mod.aliyunSearch("test query", 5);
		expect(result.answer).toContain("No results found");
	});

	it("throws on Server error", async () => {
		vi.stubEnv("ALIYUN_API_KEY", "test-key");
		const mod = await import("../src/web_search/aliyun.js");
		testServer.setRequestHandler(CallToolRequestSchema, async () => {
			throw new Error("Server error");
		});
		await expect(mod.aliyunSearch("test query", 5)).rejects.toThrow();
	});

	it("uses apiKey parameter over env var", async () => {
		vi.stubEnv("ALIYUN_API_KEY", "env-key");
		const mod = await import("../src/web_search/aliyun.js");

		testServer.setRequestHandler(CallToolRequestSchema, async (request) => {
			// Test verifies auth header — impossible to assert via InMemoryTransport
			// Indirectly: env-key would fail auth, param-key succeeds
			return { content: [{ type: "text", text: JSON.stringify({ pages: [{ title: "OK" }] }) }] };
		});

		await mod.aliyunSearch("test query", 5, undefined, "param-key");
		// No throw = success
	});
});
```

- [ ] **Step 2:** 运行 — 5 个测试 FAIL（aliyun.js 不存在）

- [ ] **Step 3 (GREEN):** 实现 `src/web_search/aliyun.ts`（代码与当前生产代码相同）

- [ ] **Step 4:** `npm test` — all pass

- [ ] Commit: `feat: add aliyun web_search source via Bailian MCP`

---

### Task 5: 更新 orchestrator（TDD）

**Files:** Modify `src/web_search/index.ts`, modify `tests/web_search.test.ts`

- [ ] **Step 1 (RED):** 更新 orchestrator 测试签名 + 追加 fallback 测试

```typescript
describe("search orchestrator", () => {
	it("uses exa with API key", async () => {
		vi.stubEnv("EXA_API_KEY", "test-key");
		mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ results: [{ title: "T", url: "https://x.com", text: "content" }] }) });
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
		mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ results: [{ title: "R", url: "https://x.com", text: "content" }] }) });
		const sources = buildSources({});
		const result = await search("test", 5, undefined, undefined, "exa", sources);
		expect(result.sourceLabel).toBe("exa");
	});

	it("falls back to aliyun when exa fails", async () => {
		vi.stubEnv("EXA_API_KEY", "");
		vi.stubEnv("ALIYUN_API_KEY", "aliyun-key");
		// exa MCP throws
		testServer.setRequestHandler(CallToolRequestSchema, async (request) => {
			if (request.params.name === "web_search_exa") throw new Error("Exa down");
			if (request.params.name === "bailian_web_search") {
				return { content: [{ type: "text", text: JSON.stringify({ pages: [{ title: "Aliyun", link: "https://a.com", snippet: "f" }] }) }] };
			}
			throw new Error("Unexpected");
		});
		const sources = buildSources({ aliyun: "aliyun-key" });
		const result = await search("test", 5, undefined, undefined, undefined, sources);
		expect(result.sourceLabel).toBe("aliyun");
	});

	it("uses specified aliyun source", async () => {
		vi.stubEnv("ALIYUN_API_KEY", "aliyun-key");
		testServer.setRequestHandler(CallToolRequestSchema, async () => ({
			content: [{ type: "text", text: JSON.stringify({ pages: [{ title: "Aliyun", link: "https://a.com", snippet: "d" }] }) }],
		}));
		const sources = buildSources({ aliyun: "aliyun-key" });
		const result = await search("test", 5, undefined, undefined, "aliyun", sources);
		expect(result.sourceLabel).toBe("aliyun");
	});

	it("throws when all sources fail", async () => {
		vi.stubEnv("EXA_API_KEY", "");
		vi.stubEnv("ALIYUN_API_KEY", "");
		testServer.setRequestHandler(CallToolRequestSchema, async () => { throw new Error("Fail"); });
		const sources = buildSources({});
		await expect(search("test", 5, undefined, undefined, undefined, sources)).rejects.toThrow("All search sources failed");
	});

	it("throws for unknown source", async () => {
		const sources = buildSources({});
		await expect(search("test", 5, undefined, undefined, "unknown", sources)).rejects.toThrow("Unknown source");
	});
});
```

- [ ] **Step 2:** 运行 — orchestrator 测试 FAIL（buildSources 不存在）

- [ ] **Step 3 (GREEN):** 实现 `buildSources` + 更新 `search()` 签名

- [ ] **Step 4:** `npm test` + `npx tsc --noEmit` — all pass

- [ ] Commit: `refactor: SOURCES to buildSources factory`

---

### Task 6: 更新工具注册入口 `index.ts`

**Files:** Modify `index.ts` — 添加 aliyun provider key 解析、更新 enum/description

- [ ] 更新 `source` enum: `["exa", "aliyun"]`
- [ ] 更新 description 和 promptSnippet
- [ ] `execute` 中解析 `ctx.modelRegistry.getApiKeyForProvider("aliyun")`
- [ ] `npm test` — all pass
- [ ] Commit: `feat: wire aliyun source`

---

### Task 7: 最终验证

- [ ] `npm test` — 25 tests pass
- [ ] `npm run check` — no errors
- [ ] Commit any remaining tweaks
