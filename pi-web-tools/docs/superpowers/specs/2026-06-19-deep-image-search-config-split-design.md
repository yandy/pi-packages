# Design: deep_search / image_search 配置分离与 OpenAI SDK 改造

- 日期: 2026-06-19
- 状态: Approved

## 1. 背景与目标

`pi-web-tools` 是一个 pi package，提供 `web_search`、`deep_search`、`image_search`、`web_fetch` 四个工具。当前 `deep_search` 与 `image_search` 均通过裸 `fetch` 调用阿里云（百炼）的 OpenAI 兼容 Responses API，共用单一模型配置（`searchModel`），且 apiKey 仅从环境变量或 pi 的 `aliyun` provider 读取。

本次需求：

1. `deep_search` 与 `image_search` 的模型可分开配置。
2. `deep_search` 默认模型改为 `deepseek-v4-flash`。
3. 配置文件新增 `aliyunProviderKey`（string）。若该配置存在且 pi 已配置同名 provider，则从对应 provider 抽取 apiKey 与 baseUrl。移除原来从 pi 的 `aliyun` provider 读取的硬编码行为。
4. `deep_search` 改走 OpenAI 兼容 - Chat Completions API；`image_search` 仍走 OpenAI 兼容 - Responses API。
5. 对 OpenAI 兼容 API 的调用改用 `openai` 官方 SDK，不再裸发请求。

## 2. 关键约束与已确认决策

以下决策在 brainstorming 阶段与用户逐一确认：

| 决策点 | 结论 |
|--------|------|
| `aliyunProviderKey` 未配置时 | 仅从环境变量读 apiKey / baseUrl，不回退到 pi provider |
| `aliyunProviderKey` 已配置时 | env 优先，provider 作为回退；pi 无同名 provider 时回退到 config/env/默认 |
| 配置结构 | 单一 `aliyun` 块内含 `aliyunProviderKey` + `deepSearchModel` + `imageSearchModel` + `baseUrl` |
| `providerKey` 粒度 | 单一字符串，两工具共用同一 provider（apiKey/baseUrl 共享，仅模型不同） |
| 环境变量命名 | 保留 `ALIYUN_*` 前缀；模型变量拆为 `ALIYUN_DEEP_SEARCH_MODEL` / `ALIYUN_IMAGE_SEARCH_MODEL` |
| `searchModel` 向后兼容 | **不保留**，直接用新字段，旧字段废弃不读 |
| 文件命名 | 保留 `aliyun.ts`（本质是阿里云工具服务，openai 兼容只是调用形式） |
| 配置字段名 | `aliyunProviderKey`（非 `providerKey`，避免误解） |
| deep_search 行为退化 | 接受：Chat Completions 下 sources 恒为空，不再抽取网页正文 |
| deep_search 搜索策略 | `search_strategy: "turbo"`，`forced_search: true`（强制搜索） |
| deep_search 扩展能力 | 支持垂域搜索、时效性、限定来源站点、图文混合输出 |
| 调用签名顺序 | 统一为 `(params, signal, config?, ctx?)`，两工具一致 |
| SDK 选择 | `openai` 官方 SDK（与 pi-ai 现有实现一致），不用 `@ai-sdk/openai-compatible` |

### 2.1 Chat Completions API 能力限制（经阿里云文档研究确认）

阿里云 OpenAI 兼容协议的能力差异（来源：help.aliyun.com/zh/model-studio/web-search）：

| 能力 | DashScope | OpenAI 兼容-Chat Completions | OpenAI 兼容-Responses |
|------|-----------|------------------------------|----------------------|
| 基础联网搜索 | 支持 | `enable_search: true` | `tools: [{type:"web_search"}]` |
| 返回结构化来源 | 支持（`search_info`） | **不支持** | 通过 `web_search_call.sources` 项获取 |
| 网页抓取 web_extractor | 支持 | 仅 `agent_max` 策略（限 qwen3-max 思考模式） | `tools:[{type:"web_extractor"}]` |
| 垂域搜索 | 支持 | `search_options.enable_search_extension` | 不支持 |
| 时效性 | 支持 | `search_options.freshness`（仅 turbo） | 不支持 |
| 限定来源站点 | 支持 | `search_options.assigned_site_list` | 不支持 |
| 图文混合输出 | 支持 | `enable_text_image_mixed`（顶层） | 不支持 |

Chat Completions 响应无 `search_info` 字段，连"是否执行搜索"都无法明确判断。因此 `deep_search` 改走 Chat Completions 后：

- **sources 恒为空数组**（`DeepSearchResponse.sources` 类型保留，但 deep_search 永远返回 `[]`）。
- **不再使用 web_extractor**（默认模型 `deepseek-v4-flash` 不支持 `agent_max`）。
- 模型回答文本中可能内联 URL，但不解析为结构化来源。

### 2.2 阿里云扩展字段在 Node SDK 的传参方式

阿里云文档明确：Python SDK 通过 `extra_body` 传递非标准参数，**Node.js SDK 在顶层传入**。因此 `enable_search`、`search_options`、`enable_text_image_mixed` 等阿里云扩展字段作为 `client.chat.completions.create` / `client.responses.create` 第一个参数的顶层字段传入，用 TypeScript 类型断言（`as unknown as`）绕过 SDK 类型检查。

## 3. 架构设计

### 3.1 文件结构

```
src/
  config.ts            # 扩展配置类型与模型解析
  provider.ts          # 新增：集中凭证与 baseUrl 解析
  openai_client.ts     # 新增：OpenAI SDK 客户端构造
  deep_search/
    aliyun.ts          # 重写：Chat Completions API + openai sdk
    types.ts           # 不变
    index.ts           # 不变
  image_search/
    aliyun.ts          # 重写：Responses API + openai sdk
    types.ts           # 不变
    index.ts           # 不变
```

### 3.2 配置层 `src/config.ts`

```ts
interface WebToolsConfig {
  aliyun?: {
    baseUrl?: string;
    aliyunProviderKey?: string;
    deepSearchModel?: string;
    imageSearchModel?: string;
  };
}
```

- `loadConfig(cwd?)` 逻辑不变：读取 `.pi/agent/web-tools.json`，带缓存。
- `resolveSetting(value, configValue, defaultValue)` 保留，用于模型解析。
- 移除对 `searchModel` 的任何读取。

### 3.3 凭证解析层 `src/provider.ts`（新增）

导出 `resolveAliyunProvider`：

```ts
export async function resolveAliyunProvider(opts: {
  ctx?: ExtensionContext;
  config?: { aliyunProviderKey?: string; baseUrl?: string };
}): Promise<{ apiKey: string; baseUrl: string }>
```

**apiKey 解析优先级：**
1. `process.env.ALIYUN_API_KEY`（若已设置且非空）
2. 若 `config.aliyunProviderKey` 已配置：调用 `ctx.modelRegistry.getApiKeyForProvider(providerKey)`；若返回非空则使用
3. 抛错：「ALIYUN_API_KEY not configured. Set ALIYUN_API_KEY or configure aliyunProviderKey with a valid pi provider.」

**baseUrl 解析优先级：**
1. `process.env.ALIYUN_BASE_URL`（若已设置且非空）
2. 若 `config.aliyunProviderKey` 已配置且 pi 有同名 provider：取该 provider 首个 model 的 `baseUrl`（`ctx.modelRegistry.getAll().filter(m => m.provider === providerKey)[0]?.baseUrl`）
3. `config.baseUrl`（若已设置）
4. 默认 `https://dashscope.aliyuncs.com/compatible-mode/v1`

「pi 有同名 provider」的判断：`ctx.modelRegistry.getAll()` 中存在 `provider === providerKey` 的 model。

### 3.4 客户端层 `src/openai_client.ts`（新增）

```ts
import OpenAI from "openai";

export function createAliyunClient(opts: {
  apiKey: string;
  baseUrl: string;
}): OpenAI {
  return new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseUrl,
    maxRetries: 0,
  });
}
```

- `openai` sdk 6.26.0 作为 pi-ai 的传递依赖已存在，在 `package.json` 显式声明为 dependency。
- 超时与 signal 在每次请求时通过 `AbortSignal.any([signal, AbortSignal.timeout(120_000)])` 组合，作为 `{ signal }` 传入请求选项。

### 3.5 deep_search `src/deep_search/aliyun.ts`（重写）

```ts
const DEFAULT_DEEP_SEARCH_MODEL = "deepseek-v4-flash";
const TIMEOUT_MS = 120_000;

export interface DeepSearchOptions {
  enableSearchExtension?: boolean;
  freshness?: number;        // 7 | 30 | 180 | 365
  assignedSiteList?: string[];
  enableImageOutput?: boolean;
}

export async function aliyunDeepSearch(
  query: string,
  signal?: AbortSignal,
  config?: { baseUrl?: string; aliyunProviderKey?: string; deepSearchModel?: string },
  ctx?: ExtensionContext,
  searchOpts?: DeepSearchOptions,
): Promise<DeepSearchResponse> {
  const { apiKey, baseUrl } = await resolveAliyunProvider({ ctx, config });
  const model = resolveSetting(
    process.env.ALIYUN_DEEP_SEARCH_MODEL,
    config?.deepSearchModel,
    DEFAULT_DEEP_SEARCH_MODEL,
  );
  const client = createAliyunClient({ apiKey, baseUrl });

  const s = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
    : AbortSignal.timeout(TIMEOUT_MS);

  const { enableSearchExtension, freshness, assignedSiteList, enableImageOutput } = searchOpts ?? {};

  const searchOptions: Record<string, unknown> = {
    search_strategy: "turbo",
    forced_search: true,
    ...(enableSearchExtension && { enable_search_extension: true }),
    ...(freshness && { freshness }),
    ...(assignedSiteList?.length && { assigned_site_list: assignedSiteList }),
  };

  const completion = await client.chat.completions.create(
    {
      model,
      messages: [{ role: "user", content: query }],
      stream: false,
      // 阿里云扩展字段（Node SDK 顶层传入）
      enable_search: true,
      search_options: searchOptions,
      ...(enableImageOutput && { enable_text_image_mixed: true }),
    } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
    { signal: s },
  );

  const answer = completion.choices[0]?.message?.content || "No results";
  return { answer, sources: [] };
}
```

要点：
- 默认模型 `deepseek-v4-flash`。
- 固定 `enable_search: true`、`search_options.search_strategy: "turbo"`、`search_options.forced_search: true`。
- `sources` 恒为空数组。
- 移除原有 `parseSources` / `parseAnswer` / `AliyunResponse` 等本地解析逻辑。
- 移除原有 `resolveApiKey` 函数（改用 `resolveAliyunProvider`）。

### 3.6 image_search `src/image_search/aliyun.ts`（重写）

```ts
const DEFAULT_IMAGE_SEARCH_MODEL = "qwen3.7-plus";
const TIMEOUT_MS = 120_000;

export async function aliyunImageSearch(
  params: ImageSearchParams,
  signal?: AbortSignal,
  config?: { baseUrl?: string; aliyunProviderKey?: string; imageSearchModel?: string },
  ctx?: ExtensionContext,
): Promise<ImageSearchResponse> {
  const { query, imageUrl } = params;
  if (!query && !imageUrl) {
    throw new Error("At least one of query or imageUrl must be provided");
  }

  const { apiKey, baseUrl } = await resolveAliyunProvider({ ctx, config });
  const model = resolveSetting(
    process.env.ALIYUN_IMAGE_SEARCH_MODEL,
    config?.imageSearchModel,
    DEFAULT_IMAGE_SEARCH_MODEL,
  );
  const client = createAliyunClient({ apiKey, baseUrl });

  const s = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
    : AbortSignal.timeout(TIMEOUT_MS);

  let input: unknown;
  let tools: Array<{ type: string }>;

  if (imageUrl) {
    tools = [{ type: "image_search" }];
    const content: Array<{ type: string; [key: string]: unknown }> = [];
    if (query) content.push({ type: "input_text", text: query });
    content.push({ type: "input_image", image_url: imageUrl });
    input = [{ role: "user", content }];
  } else {
    tools = [{ type: "web_search_image" }];
    input = query;
  }

  const response = await client.responses.create(
    { model, input, tools } as unknown as OpenAI.Responses.ResponseCreateParams,
    { signal: s },
  );

  const images = parseImages(response.output);
  const answer = parseAnswer(response.output);
  return { answer, images };
}
```

要点：
- 仍走 Responses API。
- `input` / `tools` 构造逻辑与现有一致，仅把裸 `fetch` 换成 `client.responses.create`。
- 保留 `parseImages` / `parseAnswer` / `AliyunImageResponse` 解析逻辑（Responses API `output` 结构不变）。
- 移除原有 `resolveApiKey` 函数。
- 调用签名从 `(params, signal, ctx, config)` 调整为 `(params, signal, config, ctx)`，与 deep_search 对齐。

### 3.7 deep_search 工具参数扩展

`index.ts` 中 deep_search 的 `parameters` 从单一 `query` 扩展：

| 参数 | 类型 | 必填 | 默认 | 说明 | 对应阿里云字段 |
|------|------|------|------|------|--------------|
| `query` | string | 是 | — | 研究问题 | messages content |
| `enableSearchExtension` | boolean | 否 | false | 垂域搜索 | `search_options.enable_search_extension` |
| `freshness` | number | 否 | — | 时效性，取值 7/30/180/365 | `search_options.freshness` |
| `assignedSiteList` | string[] | 否 | — | 限定来源站点 | `search_options.assigned_site_list` |
| `enableImageOutput` | boolean | 否 | false | 图文混合输出 | `enable_text_image_mixed`（顶层） |

`aliyunDeepSearch` 签名新增第 5 个参数 `searchOpts?: DeepSearchOptions`（见 3.5）。`index.ts` 的 `execute` 中从工具参数提取扩展选项传入：

```ts
const result = await deepSearch(query, signal, cfg.aliyun, ctx, {
  enableSearchExtension: p.enableSearchExtension,
  freshness: p.freshness,
  assignedSiteList: p.assignedSiteList,
  enableImageOutput: p.enableImageOutput,
});
```

### 3.8 index.ts 调用签名调整

- `deepSearch(query, signal, cfg.aliyun, ctx)` —— 顺序已是 `(params, signal, config, ctx)` ✓
- `imageSearch(params, signal, cfg.aliyun, ctx)` —— 调整为 `(params, signal, config, ctx)`

## 4. 测试计划

### 4.1 `tests/deep_search.test.ts`（重写）

- `vi.mock("openai")` mock OpenAI 构造函数，返回 `{ chat: { completions: { create: vi.fn() } } }`。
- 用例：
  1. 调用 `chat.completions.create`，body 含 `enable_search: true`、`search_options.search_strategy: "turbo"`、`forced_search: true`。
  2. 传入扩展参数（freshness/assignedSiteList/enableSearchExtension/enableImageOutput）时，body 对应字段正确。
  3. 默认模型为 `deepseek-v4-flash`。
  4. 返回 `sources: []`，answer 取自 `choices[0].message.content`。
  5. `ALIYUN_API_KEY` 未配置时抛错。
  6. `aliyunProviderKey` 配置时从 `modelRegistry.getApiKeyForProvider` 取 key（mock ctx）。

### 4.2 `tests/image_search.test.ts`（重写）

- `vi.mock("openai")`，mock `{ responses: { create: vi.fn() } }`。
- 用例：
  1. 仅 query 时，body 含 `tools: [{type:"web_search_image"}]`、`input` 为 query 字符串。
  2. 含 imageUrl 时，body 含 `tools: [{type:"image_search"}]`、`input` 为含 `input_image` 的 content 数组。
  3. 解析 `output` 中的 images 与 answer（保留现有解析逻辑测试）。
  4. 默认模型为 `qwen3.7-plus`。

### 4.3 `tests/provider.test.ts`（新增）

测试 `resolveAliyunProvider` 优先级：
1. env apiKey 优先于 providerKey。
2. providerKey 配置且 pi 有同名 provider 时，从 provider 取 key/baseUrl。
3. providerKey 配置但 pi 无同名 provider 时，回退到 config.baseUrl/env/默认。
4. baseUrl 优先级：env > provider > config > 默认。

## 5. 文档与依赖更新

### 5.1 README.md

- 配置章节：移除 `aliyun.searchModel`，改为 `deepSearchModel` / `imageSearchModel` / `aliyunProviderKey`。
- 环境变量表：`ALIYUN_SEARCH_MODEL` → `ALIYUN_DEEP_SEARCH_MODEL` / `ALIYUN_IMAGE_SEARCH_MODEL`。
- deep_search 参数表：新增 `enableSearchExtension` / `freshness` / `assignedSiteList` / `enableImageOutput`。
- 说明 deep_search 现走 Chat Completions API，sources 恒为空；image_search 仍走 Responses API。
- 说明 `aliyunProviderKey` 的用途与优先级。

### 5.2 models.json

不变。provider 配置由 pi 管理，此文件仅声明 aliyun provider 与模型。

### 5.3 package.json

新增 `dependencies` 字段：
```json
"dependencies": { "openai": "^6.26.0" }
```

## 6. 数据流

### deep_search

```
用户调用 deep_search(query, opts)
  → loadConfig(cwd) 读取 .pi/agent/web-tools.json
  → resolveAliyunProvider({ ctx, config }) 解析 apiKey/baseUrl
    → env ALIYUN_API_KEY / ALIYUN_BASE_URL 优先
    → 否则从 ctx.modelRegistry 按 aliyunProviderKey 取
    → 否则 config.baseUrl / 默认值
  → createAliyunClient({ apiKey, baseUrl })
  → client.chat.completions.create({ model, messages, enable_search, search_options, ... })
  → completion.choices[0].message.content → answer
  → return { answer, sources: [] }
```

### image_search

```
用户调用 image_search({ query, imageUrl })
  → loadConfig(cwd)
  → resolveAliyunProvider({ ctx, config })
  → createAliyunClient({ apiKey, baseUrl })
  → client.responses.create({ model, input, tools })
  → parseImages(response.output) / parseAnswer(response.output)
  → return { answer, images }
```

## 7. 错误处理

- apiKey 解析失败：抛 `Error("ALIYUN_API_KEY not configured. Set ALIYUN_API_KEY or configure aliyunProviderKey with a valid pi provider.")`
- API 调用失败：openai sdk 自动抛出 `APIError`，包含 status/code/message；工具 `execute` 中 catch 后返回 `isError: true`。
- 超时：通过 `AbortSignal.timeout(TIMEOUT_MS)` 触发 `TimeoutError`。
- 外部中断：通过传入的 `signal` 触发 `AbortError`。
