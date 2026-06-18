# pi-web-tools 设计文档

## 概述

`pi-web-tools` 是一个 pi 包，提供四个工具：`web_search`、`deep_search`、`image_search`、`web_fetch`。

| Tool | 本质 | 源 |
|------|------|-----|
| `web_search` | 纯搜索，返回原始结果给 LLM 自行分析 | Exa → DuckDuckGo |
| `deep_search` | LLM server-side 搜索+合成，返回结构化答案 | Aliyun（百炼） |
| `image_search` | LLM server-side 图片搜索+分析 | Aliyun（百炼） |
| `web_fetch` | URL 抓取 | — |

## 目录结构

```
pi-web-tools/
├── index.ts                     # 扩展入口，注册三个 tool
├── src/
│   ├── web_search/
│   │   ├── types.ts             # 共享类型
│   │   ├── exa.ts               # Exa (REST API + MCP free tier)
│   │   ├── duckduckgo.ts        # DuckDuckGo Instant Answer API
│   │   └── index.ts             # Fallback 编排器
│   ├── deep_search/
│   │   ├── types.ts             # 共享类型
│   │   ├── aliyun.ts            # 阿里云百炼 Responses API
│   │   └── index.ts             # 入口
│   ├── image_search/
│   │   ├── types.ts             # 共享类型
│   │   ├── aliyun.ts            # 阿里云百炼 Responses API（文搜图 + 图搜图）
│   │   └── index.ts             # 入口
│   └── web_fetch.ts             # URL 抓取 + HTML→Markdown 转换
├── package.json
├── tsconfig.json
├── biome.json
├── vitest.config.ts
└── README.md
```

## 工具一：web_search

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `query` | string | 是 | — | 搜索查询 |
| `numResults` | number | 否 | 10 | 1-20 |
| `source` | `"exa"` \| `"duckduckgo"` | 否 | — | 指定源，不指定则自动 fallback |

### Fallback 策略

1. 指定 `source` → 只尝试该源
2. 未指定 → Exa → DuckDuckGo
3. 源不可用时跳过，全部不可用返回 `isError: true`
4. 结果标注实际使用的源名

### 搜索源详情

#### Exa (`src/web_search/exa.ts`)

- **有 `EXA_API_KEY`**：REST API `POST https://api.exa.ai/search`，`type: "auto"`，`contents: { text: { maxCharacters: 3000 } }`
- **无 key**：MCP free tier `POST https://api.exa.ai/api/mcp`，150次/天，3 QPS
- 返回结构化 results：title, url, text
- 函数签名：`exaSearch(query, numResults, signal?): Promise<SearchResponse>`

#### DuckDuckGo (`src/web_search/duckduckgo.ts`)

- API: `GET https://api.duckduckgo.com/?q=<query>&format=json&no_html=1`
- 免费，无需 API key
- 返回 `Abstract` + `AbstractText` + `AbstractURL` + `RelatedTopics`（含 `Text`, `FirstURL`）
- 函数签名：`duckduckgoSearch(query, numResults, signal?): Promise<SearchResponse>`

### 共享类型 (`src/web_search/types.ts`)

```typescript
interface SearchSource { title: string; url: string; snippet: string; }
interface SearchResponse { answer: string; sources: SearchSource[]; sourceLabel: string; }
```

## 工具二：deep_search

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `query` | string | 是 | — | 搜索查询 |

无 `numResults`，由服务端决定。

### 实现 (`src/deep_search/aliyun.ts`)

- API: `POST https://dashscope.aliyuncs.com/compatible-mode/v1/responses`（Responses API）
- Auth：`process.env.ALIYUN_API_KEY` → `ctx.modelRegistry.getApiKeyForProvider("aliyun")`
- 请求体：
  ```
  { model: "qwen3.7-plus", input: query,
    tools: [{ type: "web_search" }, { type: "web_extractor" }] }
  ```
- 官方推荐 `web_search` + `web_extractor` 同时开启以获最佳效果
- 从 `output` 解析：`web_search_call`（sources）、`web_extractor_call`（抽取内容）、最终 `message`（合成答案）
- sources 仅含 `{ type, url }`，无 title，用域名作为 title
- 函数签名：`aliyunDeepSearch(query, signal?, ctx?): Promise<DeepSearchResponse>`

### 共享类型 (`src/deep_search/types.ts`)

```typescript
interface DeepSearchSource { title: string; url: string; }
interface DeepSearchResponse { answer: string; sources: DeepSearchSource[]; }
```

## 工具三：image_search

统一入口，同时支持文搜图和图搜图。

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | string | 否 | 文本描述，用于文搜图 |
| `imageUrl` | string | 否 | 公网图片 URL，用于图搜图 |

> 至少提供 `query` 或 `imageUrl` 之一。两者都提供时，模型结合文本与图片进行搜索。

### 实现 (`src/image_search/aliyun.ts`)

- API: `POST https://dashscope.aliyuncs.com/compatible-mode/v1/responses`（Responses API）
- Auth：`process.env.ALIYUN_API_KEY` → `ctx.modelRegistry.getApiKeyForProvider("aliyun")`
- 文搜图（仅 `query`）：`tools: [{ type: "web_search_image" }]`，`input` 为文本
- 图搜图（有 `imageUrl`）：`tools: [{ type: "image_search" }]`，`input` 为多模态 `[{ input_text }, { input_image }]`
- 从 `output` 解析：`web_search_image_call` 或 `image_search_call` 的 `output`（JSON 数组 `[{ index, title, url }]`）+ 最终 `message` 文本
- 函数签名：`aliyunImageSearch(params, signal?, ctx?): Promise<ImageSearchResponse>`

### 共享类型 (`src/image_search/types.ts`)

```typescript
interface ImageResult { index: number; title: string; url: string; }
interface ImageSearchResponse { answer: string; images: ImageResult[]; }
```

## 工具四：web_fetch

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `url` | string | 是 | — | 目标 URL |
| `format` | `"text"` \| `"markdown"` \| `"html"` | 否 | `"markdown"` | 输出格式 |
| `timeout` | number | 否 | 30 | 1-120 秒 |

### 处理流程 (`src/web_fetch.ts`)

1. URL 校验（仅 http/https）
2. `fetch()` + `AbortSignal.timeout()`
3. Content-Type 路由：JSON 格式化 / HTML 转换 / 原文
4. HTML→Markdown：简易正则（h1-h6, strong, a, li, pre, p, br）
5. 超过 100K 字符截断并标注
6. 非 2xx 返回错误含截断 body

## 扩展入口 (`index.ts`)

- 导出默认函数 `(pi: ExtensionAPI) => void`
- 直接注册三个 tool
- 每个 tool 提供 `renderCall` / `renderResult`
- Tool description 中声明各源能力差异

## 配置

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `EXA_API_KEY` | Exa API key，不设则走 MCP free tier | — |
| `ALIYUN_API_KEY` | 阿里云百炼 API key | — |
| `ALIYUN_BASE_URL` | 阿里云百炼 compatible API base URL | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `ALIYUN_SEARCH_MODEL` | 阿里云百炼 deep_search 模型 | `qwen3.7-plus` |

Aliyun 额外支持 `ctx.modelRegistry.getApiKeyForProvider("aliyun")` 获取 key。

## 错误处理

- 网络超时：60s（搜索）/ 30s（fetch）
- 搜索源全部不可用 → `isError: true`，列出失败原因
- web_fetch 非 2xx → 返回错误含截断 body

## 类型系统

- peerDepends: `@earendil-works/pi-coding-agent >= 0.74.0`
- tool parameters: `typebox`
- TUI 渲染: `@earendil-works/pi-tui` (Text, theme)
- devDepends: typescript ~5.7, vitest ^3.0, @biomejs/biome ^2.5
