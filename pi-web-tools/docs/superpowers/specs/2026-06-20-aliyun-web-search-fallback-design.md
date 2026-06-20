# aliyun web_search fallback 设计文档

## 概述

为 `web_search` 工具新增阿里云百炼 WebSearch MCP 作为 Exa 的回退搜索源。当 Exa 搜索失败时，自动尝试百炼搜索。

## 当前状态

`web_search` 只有一个源 `exa`，fallback 链路为空（唯一源失败即报错）。DuckDuckGo 此前已被移除（commit `9990c3d`）。

## 目标架构

```
src/web_search/
├── types.ts          # 不变
├── exa.ts            # 改：MCP 路径用 SDK 改写
├── aliyun.ts         # 新增：百炼 WebSearch MCP 源
├── mcp.ts            # 新增：共享 MCP Client 工厂
└── index.ts          # 改：SOURCES → buildSources(apiKeys)

index.ts              # 改：execute() 解析 aliyun provider key
```

## 命名约定

| 概念 | 命名 |
|------|------|
| 文件名 | `aliyun.ts` |
| 导出函数 | `aliyunSearch` |
| source enum / sourceLabel | `"aliyun"` |
| MCP tool 名（百炼服务端定义） | `"bailian_web_search"`（不动） |
| 环境变量 | `ALIYUN_API_KEY` |

## 一、MCP SDK 集成

新增依赖 `@modelcontextprotocol/sdk`，替换现有的裸 JSON-RPC 实现。

### 共享工厂 `src/web_search/mcp.ts`

```typescript
// 封装 SDK Client + StreamableHTTPClientTransport
// 提供 createMcpClient(url, headers): Promise<Client>
// 内部处理 connect()，返回已就绪的 Client
```

exa.ts（MCP 路径）和 aliyun.ts 共用此工厂。

### exa.ts 改动范围

- **REST 路径**（有 `EXA_API_KEY` 时）：不变
- **MCP 路径**（无 `EXA_API_KEY` 时）：`exaMcpSearch()` + `mcpCall()` → `createMcpClient()` + `client.callTool()`
- `parseMcpResults()` 保留，格式解析逻辑不变

## 二、aliyun.ts

### MCP 连接

| 参数 | 值 |
|------|-----|
| URL | `https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp` |
| 协议 | Streamable HTTP（MCP） |
| 鉴权 | `Authorization: Bearer <apiKey>` |
| Tool 名 | `bailian_web_search` |
| 参数 | `{ query: string, count: number }` |
| 超时 | 60 秒 |

### API key 解析优先级

```
ALIYUN_API_KEY 环境变量 → buildSources 传入的 apiKeys.aliyun
```

`aliyunSearch` 函数签名保持 `(query, numResults, signal?)`，API key 通过工厂注入。

### 响应解析

返回格式 `{ content: [{ type: "text", text: "<JSON>" }] }`，JSON 内 `pages` 数组：

```typescript
pages: Array<{
  title?: string;
  link?: string;   // 或 url
  url?: string;
  snippet?: string; // 或 content
  content?: string;
}>
```

映射为 `SearchSource[]`，snippet 截断 500 字符。JSON 解析失败时 fallback 到纯文本解析（与 exa MCP 一致）。

### 错误处理

| 场景 | 行为 |
|------|------|
| 无 API key | `throw Error("ALIYUN_API_KEY not set. Get one at https://bailian.console.aliyun.com")` |
| MCP initialize/调用 HTTP 非 2xx | `throw Error("Aliyun MCP {method} failed: {status}")` |
| 空结果 | answer 返回 `"No results found for: {query}"` |

sourceLabel 返回 `"aliyun"`。

## 三、orchestrator 改动

### `src/web_search/index.ts`

`SOURCES` 从常量改为工厂，工厂在 `execute()` 中调用，构建好的列表传入 `search()`：

```typescript
// src/web_search/index.ts

// 之前
const SOURCES: SourceEntry[] = [{ name: "exa", fn: exaSearch }];

// 之后
export function buildSources(
  apiKeys: Record<string, string | undefined>,
): SourceEntry[] {
  return [
    { name: "exa", fn: exaSearch },
    {
      name: "aliyun",
      // 闭包捕获 apiKey，SearchFn 签名不变
      fn: (query, numResults, signal) =>
        aliyunSearch(query, numResults, signal, apiKeys.aliyun),
    },
  ];
}
```

`aliyunSearch` 实现接受可选第 4 参数 `apiKey?: string`，内部优先取该参数，fallback 到 `process.env.ALIYUN_API_KEY`。

`search()` 新增可选 `sources` 参数代替模块常量，签名变为：

```typescript
export async function search(
  query: string,
  numResults: number,
  signal?: AbortSignal,
  onProgress?: (msg: string) => void,
  specifiedSource?: string,
  sources?: SourceEntry[],   // 由 execute() 构建后传入，默认 buildSources({})
): Promise<SearchResponse>
```

`search()` 不感知 apiKeys。fallback 遍历逻辑不变。

**Fallback 顺序：** `exa → aliyun`

### `index.ts`（工具注册入口）

`execute()` 中新增 API key 解析并构建 sources：

```typescript
const aliyunApiKey = await ctx.modelRegistry
  .getApiKeyForProvider("aliyun")
  .catch(() => undefined);

const sources = buildSources({ aliyun: aliyunApiKey });

const result = await search(
  query, numResults, signal, onProgress, p.source, sources,
);
```

参数 schema 更新：`source` enum `["exa", "aliyun"]`。

## 四、测试策略

### SDK 测试工具

使用 `@modelcontextprotocol/sdk` 内置的 `InMemoryTransport.createLinkedPair()`：
- 一端 `Client` + 一端 mock `Server`
- 不依赖全局 `fetch` mock
- mock Server 注册对应 tool handler 返回预设数据

### 测试覆盖

**`describe("aliyunSearch")`**:
- 无 API key 时抛错
- 正常 MCP 调用（Bearer auth 验证）
- SSE 响应处理
- 空结果返回 fallback 消息
- MCP 错误响应抛错

**`describe("exaSearch")`**:
- MCP 路径测试适配 SDK，REST 路径测试不变

**`describe("search orchestrator")`**:
- exa 成功时直接返回 exa 结果
- exa 失败时 fallback 到 aliyun
- `source: "aliyun"` 直接指定 aliyun
- `source: "exa"` 直接指定 exa
- 所有源失败时错误信息包含两者原因
- 未知 source 抛错

## 五、不变的部分

- `types.ts`（`SearchSource`、`SearchResponse`）不变
- `config.ts` 不变（不新增配置项，aliyun provider 由 pi 框架管理）
- `web_fetch.ts` 不变
