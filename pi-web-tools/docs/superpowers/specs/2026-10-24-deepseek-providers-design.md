# deepseek websearch/webfetch provider 设计文档

## 概述

为 `websearch` 和 `webfetch` 各新增 deepseek provider（基于 DeepSeek Search/Fetch API），同时复活 `web-tools.json` 扩展配置用于指定默认 provider，并将 websearch 的 `source` 参数统一改名为 `provider`。

## 决策记录（已与维护者确认）

| 决策 | 结论 |
|------|------|
| websearch 链条 | exa → deepseek → aliyun，`provider` 参数可显式指定（独占） |
| webfetch 链条 | local → deepseek，`provider` 参数可显式指定（独占） |
| 参数命名 | 两个工具统一叫 `provider`（websearch 原 `source` 改名，破坏性变更，按仓惯例升 minor） |
| 配置文件 | `web-tools.json` 可指定各工具默认 provider；优先级：**参数 > 配置 > 内置链**；指定即独占（失败不回退） |

## 当前状态

- `websearch`：源链 exa → aliyun，`source` 参数（enum `["exa", "aliyun"]`）独占指定。aliyun key 从 pi provider 配置（`getApiKeyForProvider`）或 `ALIYUN_API_KEY` 取。
- `webfetch`：纯本地 HTTP GET + turndown/stripTags 转换，**无 provider 概念**。
- `src/config.ts`：`loadConfig` 读全局（`getAgentDir()/web-tools.json`）+ 项目（`<cwd>/<CONFIG_DIR_NAME>/web-tools.json`）配置并按段合并，但目前**无调用方**（aliyun 段是 deep_search/image_search 删除后的遗留死代码）。

## DeepSeek API 要点

鉴权与 DeepSeek API 相同（`Authorization: Bearer <key>`，`Content-Type: application/json`），Base URL `https://api.deepseek.com`。

**Search** `POST /v1/tools/search`：请求 `{ query, count }`（`query` 1-128 Unicode 字符；`count` 1-50，默认 10；`need_content` 默认 false）。响应 `{ results: [{ rerank_score, title, url, snippet, summary, content, site_name, site_icon, date, authority }] }`。`snippet` 100-200 字符（适合展示），`summary` 600-800 字符（官方说明"适用于给模型阅读"）。query 支持 `site:`/`-site:`/`lang:`/`after:`/`before:`/`"..."` 搜索语法（原样透传）。空结果返回空数组。

**Fetch** `POST /v1/tools/fetch`：请求 `{ url }`（≤8192 字符，含 host 的 http/https URL，不能带 userinfo）。响应 `{ title, content }`，content 为 Markdown 正文。403 安全策略拒绝；404 无可提取正文（含内容类型不支持）。

**错误**：OpenAI 兼容格式 `{ error: { message, type, param: null, code } }`；408/429/5xx 可重试（重试留给调用方，本包不做）。

**计费**：按成功请求计费（Search 需 results 非空、Fetch 需返回正文），5元/1000次；失败与空结果不计费。QPS：Search 100、Fetch 25（账号级）。

## 目标架构

```
src/
├── config.ts              # 改：WebToolsConfig 换为 websearch/webfetch 段
├── web_fetch.ts           # 改：引入 provider 路由（local/deepseek），新增 deepseekFetch
└── web_search/
    ├── types.ts           # 改：SearchResponse.sourceLabel → providerLabel
    ├── deepseek.ts        # 新增：DeepSeek Search REST 源
    ├── exa.ts             # 不变
    ├── aliyun.ts          # 不变
    └── index.ts           # 改：链 exa → deepseek → aliyun；specifiedSource → specifiedProvider

index.ts                   # 改：两个工具的参数 schema（provider）、key 解析、配置解析
```

## 命名约定

| 概念 | 命名 |
|------|------|
| 参数（两个工具） | `provider` |
| websearch 合法值 | `"exa"` \| `"deepseek"` \| `"aliyun"` |
| webfetch 合法值 | `"local"` \| `"deepseek"` |
| 文件 / 导出函数 | `deepseek.ts` / `deepseekSearch`；`deepseekFetch`（web_fetch.ts 内） |
| providerLabel | `"deepseek"` |
| 环境变量 | `DEEPSEEK_API_KEY` |
| 内部类型/函数改名 | `SourceEntry` → `ProviderEntry`；`buildSources` → `buildProviders`；`search(specifiedSource, sources)` → `search(specifiedProvider, providers)` |
| 保持不变 | `SearchSource`（指搜索结果条目，与"搜索提供商"语义不同，正好消除歧义） |

## 一、websearch：deepseek provider

### `src/web_search/deepseek.ts`

- 函数签名对齐 aliyun：`deepseekSearch(query, numResults, signal?, apiKey?)`，apiKey 参数优先，回落 `process.env.DEEPSEEK_API_KEY`；无 key 抛 `DEEPSEEK_API_KEY not set. Get one at https://platform.deepseek.com`。
- REST 调用：`POST https://api.deepseek.com/v1/tools/search`，body `{ query, count: numResults }`（`need_content` 省略，保持默认 false——工具定位是返回搜索结果而非正文）。
- 超时 60s（与 exa/aliyun 一致）。
- 响应映射：`title` → title，`url` → url，snippet 字段取 `summary || snippet`（summary 为模型阅读设计且 API 天然限长，不做额外截断；exa/aliyun 的 500 截断是因其原文无界）。空 results → `No results found for: {query}`。
- 非 2xx：解析 OpenAI 格式错误体，抛 `DeepSeek API {status}: {error.message}`（解析失败回落 statusText）。

### orchestrator（`src/web_search/index.ts`）

- `buildProviders(apiKeys)` 返回 `[{exa}, {deepseek}, {aliyun}]`，链序 **exa → deepseek → aliyun**。
- 无 key 的 provider 沿用 aliyun 现状：留在链中、被轮到时快速失败（链式调用捕获后继续），显式指定时报清晰错误。错误信息 `Unknown source` 改为 `Unknown provider`。

### 工具注册（index.ts，websearch）

- 参数：`source` → `provider`，enum `["exa", "deepseek", "aliyun"]`，description 说明各 provider 特性与前置条件。
- key 解析：`getApiKeyForProvider("deepseek")`（配了 deepseek 模型的 pi 用户零配置）。
- description / promptSnippet 更新为三源链。

## 二、webfetch：provider 路由

### `src/web_fetch.ts`

拆分现有逻辑并新增：

- `localFetch(...)`：现有 HTTP GET + turndown/stripTags 逻辑原样迁移。
- `deepseekFetch(url, apiKey, timeout, signal, fetchImpl?)`：`POST https://api.deepseek.com/v1/tools/fetch`，body `{ url }`；客户端预校验 URL 长度 ≤8192；响应 `{ title, content }` → content（Markdown）；非 2xx 同样解析错误体。key 无则抛错（同 deepseekSearch 文案）。
- **截断**：deepseek 返回的 content 同样走 `MAX_CONTENT_CHARS`（100k）截断与同款截断文案——限制目的是保护模型上下文，与 provider 无关。
- **FetchResult 既有字段（deepseek 路径，我的裁定）**：`contentType: "text/markdown"`、`status: 200`、`url` 为请求 URL（deepseek 不暴露最终跳转地址）。
- `webFetch(url, format, timeout, signal?, _fetch?, opts?)`：URL/协议校验保持在入口（与 provider 无关），然后路由：
  - **显式 provider（参数或配置解析后传入）**：独占。`"local"` → 仅 local；`"deepseek"` → 仅 deepseek（无 key 报错，不回退）。例外：`format: "html"` 时 deepseek 无法产出（服务端只返回 Markdown），自动走 local 并在结果 provider 字段如实标注。
  - **未指定**：链 **local → deepseek**。回落触发条件：
    1. **硬失败**：local 网络错误 / 超时 / 非 2xx → 尝试 deepseek；deepseek 也失败 → 抛 `All fetch providers failed`（聚合两端错误，与 search 一致）。
    2. **薄内容**：local 返回 200 但转换后内容"薄"（见下方 `isThinContent`，仅 text/markdown 格式）→ 尝试 deepseek；deepseek 失败则**返回 local 的原结果而非报错**（聊胜于无）。同时通过 onUpdate 提示回落原因（如 `Local fetch returned thin content, trying deepseek...`）。
    3. `format: "html"` → 永不回落（deepseek 产不出 html）。
    4. 无 deepseek key → 永不回落，local 错误直接透传。

    `isThinContent(content, contentType)`：JSON 响应豁免（数据响应非渲染页）；其余按行过滤疑似垃圾行（纯 HTML 标签行、JS/CSS 语句行如 `var/let/const/function/window./document./@media` 开头、括号/分号开头、注释行、少空格超长压缩行），剩余有效文本 < 200 字符即薄。启发式是尽力而为、保守设计：误判只会多一次 deepseek 尝试（不成功不计费）；漏判则返回 local 原结果。该检测同时覆盖空壳页与无效 js tag 堆积页（维护者实测案例）。阈值为内部常量，不暴露为配置。
- `format: "text"` + deepseek：返回 Markdown 原文（Markdown 即文本），文档注明。
- `FetchResult` 增加 `provider: "local" | "deepseek"` 与可选 `title`（deepseek 返回的页面标题）。
- 超时：deepseek 复用现有 `timeout` 参数（每次尝试独立计时）。

### 工具注册（index.ts，webfetch）

- 新参数 `provider`，enum `["local", "deepseek"]`。
- 输出 header 保持统一形状：`URL:` + `Content-Type:` 两行不变，增加 `Title:` 行（有则显示）；结尾追加 `*Provider: {provider}*`。**websearch 的 `*Source: x*` 脚注同步改为 `*Provider: x*`**，`details.source` 键改为 `details.provider`（`details.sources` 搜索结果列表保持不变，消除歧义）。
- details 增加 `provider` 与 `title`（有则带）字段。

## 三、配置文件（web-tools.json）

### schema

```json
{
  "websearch": { "provider": "exa | deepseek | aliyun" },
  "webfetch": { "provider": "local | deepseek" }
}
```

- 复用现有 `loadConfig`（全局 + 项目按段合并、按 cwd 缓存），`mergeConfigs` 的段列表从 `["aliyun"]` 改为 `["websearch", "webfetch"]`，删除死掉的 `aliyun` 段。
- `index.ts` 各工具 `execute()` 中解析：`provider = 参数 ?? 配置值`（参数 > 配置 > 内置链）。
- **配置值非法**（不在合法集内）→ 工具返回明确错误（指明来自 web-tools.json、期望值列表），不静默忽略。

## 四、测试策略

沿用现有模式（模块动态 import + `vi.stubEnv` + mock fetch / InMemoryTransport MCP）。

**`describe("deepseekSearch")`**：无 key 抛错；成功调用（Bearer 头、body `{query, count}`）；summary 优先映射 / 缺失回落 snippet；非 2xx 错误信息提取；空 results 返回 No results。

**`describe("search orchestrator")`**：链序 exa → deepseek → aliyun（exa 失败回落 deepseek；deepseek 再失败回落 aliyun）；`provider: "deepseek"` 独占；未知 provider 报错；现有 `source` 用例全部改名适配。

**`describe("webFetch 路由")`**：local 成功不碰 deepseek；local 硬失败回落 deepseek（有 key）；无 key 时 local 错误透传；`format: "html"` 显式 deepseek 自动走 local；`provider: "local"` 独占（local 失败不回落）；两者失败聚合错误；deepseek 成功结果含 title/provider 字段；薄内容回落（空壳页、js tag 堆积页 → 回落 deepseek；JSON 响应豁免不回落；薄内容 + deepseek 失败 → 返回 local 原结果不报错）。

**`describe("loadConfig")`**：新段加载与全局/项目合并；现有 aliyun 段用例改为新 schema。

**index.ts 层**（如现有测试结构允许）：配置值非法时报错文案。

## 五、文档与发布

- README.md / README.zh.md 同步：工具表来源列（websearch "Exa → DeepSeek → Aliyun"、webfetch "Local → DeepSeek"）、provider 参数、配置文件章节（路径、schema、优先级、独占语义）、`DEEPSEEK_API_KEY` 环境变量、各 provider 特性说明。
- 破坏性变更（`source` → `provider` 改名）按仓惯例升 **minor**；README 不放破坏性变更块，写入 GitHub Release notes。

## 六、非目标

- 配置文件不支持 API key（key 走环境变量 / pi provider 配置）。
- 不做 `need_content: true` 的带正文搜索。
- 不做 408/429/5xx 自动重试（透传错误，由调用方决定）。
- 参数 enum 不按 key 可用性动态生成（静态 enum + 运行时清晰报错）。

## 七、不变的部分

- `exa.ts`、`aliyun.ts`、`mcp.ts` 逻辑不变。
- `turndown` 转换、`stripTags`、`MAX_CONTENT_CHARS` 截断等 local fetch 行为不变。
