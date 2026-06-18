# pi-web-tools 设计文档

## 概述

`pi-web-tools` 是一个 pi 包，提供 `web_search` 和 `web_fetch` 两个工具。
遵循 pi 扩展约定，通过 `package.json` 的 `pi.extensions` 声明入口。

## 目录结构

```
pi-web-tools/
├── index.ts                     # 扩展入口，注册 web_search + web_fetch
├── src/
│   ├── web_search/
│   │   ├── types.ts             # SearchSource, SearchResponse 等共享类型
│   │   ├── exa.ts               # Exa 搜索后端 (REST API + MCP free tier)
│   │   ├── deepseek.ts          # DeepSeek server-side web_search tool
│   │   ├── bailian.ts           # Bailian/DashScope 联网搜索
│   │   └── index.ts             # Fallback 编排器
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
| `query` | string | 是 | — | 搜索查询，可包含自然语言时间/域名约束 |
| `numResults` | number | 否 | 10 | 1-20 |
| `source` | `"exa"` \| `"deepseek"` \| `"bailian"` | 否 | — | 指定源，不指定则自动 fallback |

> 无 `timeRange` 参数。时间约束通过 query 自然语言描述（"2026年最新"、"最近一周"），
> 各源自行理解。工具 description 中声明各源能力差异，LLM 可据此构造 query。

### Fallback 策略

1. 指定 `source` → 只尝试该源，失败返回错误
2. 未指定 → 按优先级 Exa → DeepSeek → Bailian 自动降级
3. 源未配置 API key 时**跳过**（不算失败），已配置但调用失败时**降级到下一个**
4. 全部不可用或全部失败 → 返回 `isError: true`
5. 结果中标注实际使用的源名

### 搜索源详情

#### Exa (`src/web_search/exa.ts`)

- **有 `EXA_API_KEY`**：REST API `POST https://api.exa.ai/search`，`type: "auto"`，`contents: { text: { maxCharacters: 3000 } }`
- **无 key**：MCP free tier `POST https://api.exa.ai/api/mcp`，150次/天，3 QPS。先 `initialize` 建会话，再 `tools/call` 调 `web_search` 工具
- 返回结构化 results：title, url, text
- 函数签名：`exaSearch(query, numResults, signal?): Promise<SearchResponse>`

#### DeepSeek (`src/web_search/deepseek.ts`)

- API: `POST https://api.deepseek.com/anthropic/v1/messages`（Anthropic Messages 兼容）
- Server-side tool: `web_search_20260209`（当前唯一支持的 server tool）
- Auth 优先级：`process.env.DEEPSEEK_API_KEY` → `ctx.modelRegistry.getApiKeyForProvider("deepseek")`
- SSE stream 解析，分离 answer 文本和 web_search_tool_result 中的 sources
- 返回 LLM 合成答案 + 结构化 sources（title, url, pageAge）+ token 统计
- 函数签名：`deepseekSearch(query, signal?, onProgress?, ctx?): Promise<SearchResponse>`

#### Bailian (`src/web_search/bailian.ts`)

- API: `POST https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`
- Auth 优先级：`process.env.ALIYUN_CN_API_KEY` → `ctx.modelRegistry.getApiKeyForProvider("aliyun-cn")`
- 参数：`enable_search: true`，model: `qwen-plus`（可通过 `DASHSCOPE_SEARCH_MODEL` 覆盖）
- 返回 LLM 合成答案（Chat Completions API 不返回结构化 sources）
- 函数签名：`bailianSearch(query, signal?): Promise<SearchResponse>`

### 编排器 (`src/web_search/index.ts`)

- 导出 `search(query, numResults, signal?, onProgress?, ctx?, specifiedSource?): Promise<SearchResponse>`
- 统一超时 60 秒
- 有 `specifiedSource` 时只调指定源；无指定时按优先级尝试
- 每个源先检查配置可用性（无 key 即跳过），不可用时继续下一个
- 全部不可用时 throw，由 tool execute 捕获转 isError

### 共享类型 (`src/web_search/types.ts`)

```typescript
interface SearchSource {
  title: string;
  url: string;
  snippet: string;
}

interface SearchResponse {
  answer: string;           // 格式化文本，直接给 LLM
  sources: SearchSource[];  // 结构化结果，放 details
  sourceLabel: string;      // 实际使用的源名
  tokens?: number;          // 消耗 token 数（deepseek 有）
}
```

## 工具二：web_fetch

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `url` | string | 是 | — | 目标 URL，仅支持 http/https |
| `format` | `"text"` \| `"markdown"` \| `"html"` | 否 | `"markdown"` | 输出格式 |
| `timeout` | number | 否 | 30 | 1-120 秒 |

### 处理流程 (`src/web_fetch.ts`)

1. URL 校验（仅 http/https）
2. `fetch(url, { redirect: "follow", signal })`，超时控制通过 `AbortSignal.timeout()`
3. Content-Type 路由：
   - `application/json` → 格式化 JSON
   - `text/html` → 根据 format: html 原文返回 / markdown 简易转换 / text 去标签
   - 其他 text/\* → 原文返回
4. 超过 100K 字符截断并标注
5. 非 2xx → 返回错误含截断 body（最多 500 字符）

### HTML→Markdown 转换

简易正则实现，不引入第三方库：h1-h6、strong/b、em/i、code、pre、a、li、p、br。HTML 实体解码。

## 扩展入口 (`index.ts`)

- 导出默认函数 `(pi: ExtensionAPI) => void`
- 直接注册两个 tool（不在事件回调里），无需 session 生命周期
- 每个 tool 提供：`renderCall`（TUI 调用展示）、`renderResult`（折叠/展开结果渲染）
- Tool description 中包含各源能力声明，让 LLM 作出知情选择

## 配置

所有配置通过环境变量，无 CLI flag 或配置文件：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `EXA_API_KEY` | Exa API key，不设则走 MCP free tier | — |
| `DEEPSEEK_API_KEY` | DeepSeek API key | — |
| `ALIYUN_CN_API_KEY` | 阿里云百炼 API key | — |
| `DASHSCOPE_BASE_URL` | Bailian compatible API base URL | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `DASHSCOPE_SEARCH_MODEL` | Bailian 搜索模型 | `qwen-plus` |
| `DEEPSEEK_SEARCH_MODEL` | DeepSeek 搜索模型 | `deepseek-v4-flash` |

DeepSeek 和 Bailian 额外支持通过 pi 的 `ctx.modelRegistry.getApiKeyForProvider()` 获取 key。

## 错误处理

- 网络超时：统一 60s（搜索）/ 30s（fetch），通过 `AbortSignal.timeout()` 实现
- HTTP 错误：解析 body 作为错误详情，截断到合理长度
- 全部搜索源失败：返回 `isError: true`，错误信息列出每个源的失败原因
- web_fetch 非 2xx：返回错误含截断 body

## 类型系统

- 包 peerDepends on `@earendil-works/pi-coding-agent >= 0.74.0`
- 使用 `typebox` 定义 tool parameters schema
- 使用 `@earendil-works/pi-tui` (Text, theme) 做 TUI 渲染
- devDepends: typescript ~5.7, vitest ^3.0, @biomejs/biome ^2.5
