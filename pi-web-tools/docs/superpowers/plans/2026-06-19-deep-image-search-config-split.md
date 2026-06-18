# deep_search / image_search 配置分离与 OpenAI SDK 改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 deep_search 和 image_search 的模型配置分离，新增 aliyunProviderKey 从 pi provider 抽取凭证，deep_search 改走 Chat Completions API，image_search 仍走 Responses API，全部改用 openai 官方 SDK。

**Architecture:** 新增 `src/provider.ts`（集中凭证解析）和 `src/openai_client.ts`（SDK 客户端构造），重写 `deep_search/aliyun.ts`（Chat Completions + 扩展搜索参数）和 `image_search/aliyun.ts`（Responses API），扩展 `config.ts` 配置类型，更新 `index.ts` 工具参数与调用签名。

**Tech Stack:** TypeScript, openai sdk 6.26.0, vitest, @biomejs/biome, typebox

**Spec:** `docs/superpowers/specs/2026-06-19-deep-image-search-config-split-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/config.ts` | Modify | 扩展配置类型，移除 searchModel，新增 deepSearchModel/imageSearchModel/aliyunProviderKey |
| `src/provider.ts` | Create | 集中解析 apiKey/baseUrl：env 优先 → provider 回退 → config → 默认 |
| `src/openai_client.ts` | Create | 构造 OpenAI SDK 客户端实例 |
| `src/deep_search/aliyun.ts` | Rewrite | Chat Completions API 调用 + 扩展搜索参数 |
| `src/deep_search/types.ts` | Modify | 新增 DeepSearchOptions 接口 |
| `src/image_search/aliyun.ts` | Rewrite | Responses API 调用（改用 openai sdk），调整签名顺序 |
| `index.ts` | Modify | deep_search 工具参数扩展，image_search 调用签名调整 |
| `package.json` | Modify | 新增 dependencies.openai |
| `tests/provider.test.ts` | Create | 测试 resolveAliyunProvider 优先级 |
| `tests/deep_search.test.ts` | Rewrite | mock openai sdk，测试 Chat Completions 调用 |
| `tests/image_search.test.ts` | Rewrite | mock openai sdk，测试 Responses API 调用 |
| `README.md` | Modify | 更新配置、环境变量、参数文档 |

---

## Task 1: 扩展配置类型与新增 openai 依赖

**Files:**
- Modify: `src/config.ts`
- Modify: `package.json`

- [ ] **Step 1: 修改 `src/config.ts` 配置类型**

将 `src/config.ts` 的 `WebToolsConfig` 接口替换为：

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

完整文件应为：

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface WebToolsConfig {
	aliyun?: {
		baseUrl?: string;
		aliyunProviderKey?: string;
		deepSearchModel?: string;
		imageSearchModel?: string;
	};
}

let cachedConfig: WebToolsConfig | null = null;
let cachedCwd: string | null = null;

export function loadConfig(cwd?: string): WebToolsConfig {
	const dir = cwd || process.cwd();
	if (cachedConfig && cachedCwd === dir) return cachedConfig;

	try {
		const path = resolve(dir, ".pi/agent/web-tools.json");
		const raw = readFileSync(path, "utf-8");
		cachedConfig = JSON.parse(raw) as WebToolsConfig;
		cachedCwd = dir;
		return cachedConfig;
	} catch {
		cachedConfig = {};
		cachedCwd = dir;
		return cachedConfig;
	}
}

export function resolveSetting(
	value: string | undefined,
	configValue: string | undefined,
	defaultValue: string,
): string {
	return value || configValue || defaultValue;
}
```

- [ ] **Step 2: 在 `package.json` 新增 dependencies**

在 `package.json` 的 `"pi"` 字段后、`"peerDependencies"` 前插入 `dependencies` 字段：

```json
	"dependencies": {
		"openai": "^6.26.0"
	},
```

- [ ] **Step 3: 安装依赖**

Run: `cd /home/yandy/workspace/pri/pi-packages/pi-web-tools && npm install`
Expected: 安装成功，openai 出现在 node_modules

- [ ] **Step 4: 验证类型检查通过**

Run: `cd /home/yandy/workspace/pri/pi-packages/pi-web-tools && npm run typecheck`
Expected: 无错误（config.ts 类型变更不影响现有代码，因 aliyun 字段是可选的）

- [ ] **Step 5: Commit**

```bash
cd /home/yandy/workspace/pri/pi-packages/pi-web-tools && git add src/config.ts package.json package-lock.json && git commit -m "refactor: split config types and add openai dependency"
```

---

## Task 2: 新增凭证解析层 `src/provider.ts`

**Files:**
- Create: `src/provider.ts`
- Test: `tests/provider.test.ts`

- [ ] **Step 1: 编写 `tests/provider.test.ts` 失败测试**

创建 `tests/provider.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

let resolveAliyunProvider: typeof import("../src/provider.js").resolveAliyunProvider;

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

beforeEach(async () => {
	vi.resetModules();
	vi.unstubAllEnvs();
	const mod = await import("../src/provider.js");
	resolveAliyunProvider = mod.resolveAliyunProvider;
});

describe("resolveAliyunProvider", () => {
	it("uses env ALIYUN_API_KEY when set", async () => {
		vi.stubEnv("ALIYUN_API_KEY", "env-key");
		vi.stubEnv("ALIYUN_BASE_URL", "");
		const result = await resolveAliyunProvider({ config: {} });
		expect(result.apiKey).toBe("env-key");
	});

	it("throws when no apiKey configured", async () => {
		vi.stubEnv("ALIYUN_API_KEY", "");
		await expect(resolveAliyunProvider({ config: {} })).rejects.toThrow("ALIYUN_API_KEY not configured");
	});

	it("uses provider apiKey when aliyunProviderKey set and provider exists", async () => {
		vi.stubEnv("ALIYUN_API_KEY", "");
		const mockCtx = {
			modelRegistry: {
				getApiKeyForProvider: vi.fn().mockResolvedValue("provider-key"),
				getAll: () => [{ provider: "aliyun", baseUrl: "https://provider.example.com/v1" }],
			},
		} as any;
		const result = await resolveAliyunProvider({
			ctx: mockCtx,
			config: { aliyunProviderKey: "aliyun" },
		});
		expect(result.apiKey).toBe("provider-key");
	});

	it("throws when aliyunProviderKey set but provider has no apiKey and env not set", async () => {
		vi.stubEnv("ALIYUN_API_KEY", "");
		const mockCtx = {
			modelRegistry: {
				getApiKeyForProvider: vi.fn().mockResolvedValue(undefined),
				getAll: () => [{ provider: "aliyun", baseUrl: "https://provider.example.com/v1" }],
			},
		} as any;
		await expect(
			resolveAliyunProvider({ ctx: mockCtx, config: { aliyunProviderKey: "aliyun" } }),
		).rejects.toThrow("ALIYUN_API_KEY not configured");
	});

	it("baseUrl: env > provider > config > default", async () => {
		// env wins
		vi.stubEnv("ALIYUN_API_KEY", "env-key");
		vi.stubEnv("ALIYUN_BASE_URL", "https://env.example.com/v1");
		let result = await resolveAliyunProvider({ config: {} });
		expect(result.baseUrl).toBe("https://env.example.com/v1");

		// provider second
		vi.stubEnv("ALIYUN_BASE_URL", "");
		const mockCtx = {
			modelRegistry: {
				getApiKeyForProvider: vi.fn().mockResolvedValue("provider-key"),
				getAll: () => [{ provider: "aliyun", baseUrl: "https://provider.example.com/v1" }],
			},
		} as any;
		result = await resolveAliyunProvider({ ctx: mockCtx, config: { aliyunProviderKey: "aliyun" } });
		expect(result.baseUrl).toBe("https://provider.example.com/v1");

		// config third
		vi.stubEnv("ALIYUN_API_KEY", "env-key");
		result = await resolveAliyunProvider({ config: { baseUrl: "https://config.example.com/v1" } });
		expect(result.baseUrl).toBe("https://config.example.com/v1");

		// default
		result = await resolveAliyunProvider({ config: {} });
		expect(result.baseUrl).toBe(DEFAULT_BASE_URL);
	});

	it("falls back to config baseUrl when providerKey set but no matching provider", async () => {
		vi.stubEnv("ALIYUN_API_KEY", "env-key");
		vi.stubEnv("ALIYUN_BASE_URL", "");
		const mockCtx = {
			modelRegistry: {
				getApiKeyForProvider: vi.fn().mockResolvedValue(undefined),
				getAll: () => [{ provider: "other", baseUrl: "https://other.example.com/v1" }],
			},
		} as any;
		const result = await resolveAliyunProvider({
			ctx: mockCtx,
			config: { aliyunProviderKey: "aliyun", baseUrl: "https://config.example.com/v1" },
		});
		expect(result.baseUrl).toBe("https://config.example.com/v1");
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /home/yandy/workspace/pri/pi-packages/pi-web-tools && npx vitest run tests/provider.test.ts`
Expected: FAIL — 模块 `../src/provider.js` 不存在

- [ ] **Step 3: 实现 `src/provider.ts`**

创建 `src/provider.ts`：

```ts
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

interface ProviderConfig {
	baseUrl?: string;
	aliyunProviderKey?: string;
}

interface ResolvedProvider {
	apiKey: string;
	baseUrl: string;
}

export async function resolveAliyunProvider(opts: {
	ctx?: ExtensionContext;
	config?: ProviderConfig;
}): Promise<ResolvedProvider> {
	const { ctx, config } = opts;
	const providerKey = config?.aliyunProviderKey;

	// --- apiKey ---
	let apiKey: string | undefined;

	const envApiKey = process.env.ALIYUN_API_KEY;
	if (envApiKey) {
		apiKey = envApiKey;
	}

	if (!apiKey && providerKey && ctx) {
		const providerKeyResult = await ctx.modelRegistry.getApiKeyForProvider(providerKey);
		if (providerKeyResult) {
			apiKey = providerKeyResult;
		}
	}

	if (!apiKey) {
		throw new Error(
			"ALIYUN_API_KEY not configured. Set ALIYUN_API_KEY or configure aliyunProviderKey with a valid pi provider.",
		);
	}

	// --- baseUrl ---
	let baseUrl: string | undefined;

	const envBaseUrl = process.env.ALIYUN_BASE_URL;
	if (envBaseUrl) {
		baseUrl = envBaseUrl;
	}

	if (!baseUrl && providerKey && ctx) {
		const allModels = ctx.modelRegistry.getAll();
		const matchingModel = allModels.find((m) => m.provider === providerKey);
		if (matchingModel?.baseUrl) {
			baseUrl = matchingModel.baseUrl;
		}
	}

	if (!baseUrl && config?.baseUrl) {
		baseUrl = config.baseUrl;
	}

	if (!baseUrl) {
		baseUrl = DEFAULT_BASE_URL;
	}

	return { apiKey, baseUrl };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /home/yandy/workspace/pri/pi-packages/pi-web-tools && npx vitest run tests/provider.test.ts`
Expected: PASS — 全部 6 个用例通过

- [ ] **Step 5: Commit**

```bash
cd /home/yandy/workspace/pri/pi-packages/pi-web-tools && git add src/provider.ts tests/provider.test.ts && git commit -m "feat: add resolveAliyunProvider for centralized credential resolution"
```

---

## Task 3: 新增 OpenAI SDK 客户端层 `src/openai_client.ts`

**Files:**
- Create: `src/openai_client.ts`

- [ ] **Step 1: 实现 `src/openai_client.ts`**

创建 `src/openai_client.ts`：

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

- [ ] **Step 2: 验证类型检查通过**

Run: `cd /home/yandy/workspace/pri/pi-packages/pi-web-tools && npm run typecheck`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
cd /home/yandy/workspace/pri/pi-packages/pi-web-tools && git add src/openai_client.ts && git commit -m "feat: add createAliyunClient OpenAI SDK wrapper"
```

---

## Task 4: 扩展 deep_search 类型定义

**Files:**
- Modify: `src/deep_search/types.ts`

- [ ] **Step 1: 在 `src/deep_search/types.ts` 末尾追加 DeepSearchOptions**

将 `src/deep_search/types.ts` 完整内容改为：

```ts
export interface DeepSearchSource {
	title: string;
	url: string;
}

export interface DeepSearchResponse {
	answer: string;
	sources: DeepSearchSource[];
}

export interface DeepSearchOptions {
	enableSearchExtension?: boolean;
	freshness?: number;
	assignedSiteList?: string[];
	enableImageOutput?: boolean;
}
```

- [ ] **Step 2: Commit**

```bash
cd /home/yandy/workspace/pri/pi-packages/pi-web-tools && git add src/deep_search/types.ts && git commit -m "feat: add DeepSearchOptions type for extended search params"
```

---

## Task 5: 重写 deep_search/aliyun.ts（Chat Completions API）

**Files:**
- Rewrite: `src/deep_search/aliyun.ts`
- Test: `tests/deep_search.test.ts`

- [ ] **Step 1: 重写 `tests/deep_search.test.ts`**

将 `tests/deep_search.test.ts` 完整内容替换为：

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreate = vi.fn();
vi.mock("openai", () => {
	return {
		default: class MockOpenAI {
			chat = {
				completions: {
					create: mockCreate,
				},
			};
		},
	};
});

let deepSearch: typeof import("../src/deep_search/index.js").deepSearch;

beforeEach(async () => {
	vi.resetModules();
	mockCreate.mockReset();
	vi.stubEnv("ALIYUN_API_KEY", "test-key");
	vi.stubEnv("ALIYUN_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1");
	const mod = await import("../src/deep_search/index.js");
	deepSearch = mod.deepSearch;
});

describe("deepSearch", () => {
	it("calls chat.completions.create with enable_search and turbo strategy", async () => {
		mockCreate.mockResolvedValueOnce({
			choices: [{ message: { content: "Answer text" } }],
		});

		const result = await deepSearch("test query");
		expect(mockCreate).toHaveBeenCalledTimes(1);
		const body = mockCreate.mock.calls[0][0];
		expect(body.enable_search).toBe(true);
		expect(body.search_options.search_strategy).toBe("turbo");
		expect(body.search_options.forced_search).toBe(true);
		expect(body.model).toBe("deepseek-v4-flash");
		expect(body.messages).toEqual([{ role: "user", content: "test query" }]);
		expect(result.answer).toBe("Answer text");
		expect(result.sources).toEqual([]);
	});

	it("passes extension params when provided", async () => {
		mockCreate.mockResolvedValueOnce({
			choices: [{ message: { content: "Answer" } }],
		});

		await deepSearch("query", undefined, undefined, undefined, {
			enableSearchExtension: true,
			freshness: 7,
			assignedSiteList: ["baidu.com"],
			enableImageOutput: true,
		});
		const body = mockCreate.mock.calls[0][0];
		expect(body.search_options.enable_search_extension).toBe(true);
		expect(body.search_options.freshness).toBe(7);
		expect(body.search_options.assigned_site_list).toEqual(["baidu.com"]);
		expect(body.enable_text_image_mixed).toBe(true);
	});

	it("does not set extension fields when not provided", async () => {
		mockCreate.mockResolvedValueOnce({
			choices: [{ message: { content: "Answer" } }],
		});

		await deepSearch("query");
		const body = mockCreate.mock.calls[0][0];
		expect(body.search_options.enable_search_extension).toBeUndefined();
		expect(body.search_options.freshness).toBeUndefined();
		expect(body.search_options.assigned_site_list).toBeUndefined();
		expect(body.enable_text_image_mixed).toBeUndefined();
	});

	it("throws when ALIYUN_API_KEY not configured", async () => {
		vi.stubEnv("ALIYUN_API_KEY", "");
		await expect(deepSearch("test")).rejects.toThrow("ALIYUN_API_KEY not configured");
	});

	it("uses config model when provided", async () => {
		mockCreate.mockResolvedValueOnce({
			choices: [{ message: { content: "Answer" } }],
		});

		await deepSearch("query", undefined, { deepSearchModel: "custom-model" });
		const body = mockCreate.mock.calls[0][0];
		expect(body.model).toBe("custom-model");
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /home/yandy/workspace/pri/pi-packages/pi-web-tools && npx vitest run tests/deep_search.test.ts`
Expected: FAIL — 当前 aliyun.ts 仍用 fetch，不匹配 mock

- [ ] **Step 3: 重写 `src/deep_search/aliyun.ts`**

将 `src/deep_search/aliyun.ts` 完整内容替换为：

```ts
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import OpenAI from "openai";
import { resolveSetting } from "../config";
import { createAliyunClient } from "../openai_client";
import { resolveAliyunProvider } from "../provider";
import type { DeepSearchOptions, DeepSearchResponse } from "./types";

const DEFAULT_DEEP_SEARCH_MODEL = "deepseek-v4-flash";
const TIMEOUT_MS = 120_000;

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

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /home/yandy/workspace/pri/pi-packages/pi-web-tools && npx vitest run tests/deep_search.test.ts`
Expected: PASS — 全部 5 个用例通过

- [ ] **Step 5: Commit**

```bash
cd /home/yandy/workspace/pri/pi-packages/pi-web-tools && git add src/deep_search/aliyun.ts tests/deep_search.test.ts && git commit -m "feat: rewrite deep_search to use Chat Completions API via openai sdk"
```

---

## Task 6: 重写 image_search/aliyun.ts（Responses API + openai sdk）

**Files:**
- Rewrite: `src/image_search/aliyun.ts`
- Test: `tests/image_search.test.ts`

- [ ] **Step 1: 重写 `tests/image_search.test.ts`**

将 `tests/image_search.test.ts` 完整内容替换为：

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreate = vi.fn();
vi.mock("openai", () => {
	return {
		default: class MockOpenAI {
			responses = {
				create: mockCreate,
			};
		},
	};
});

let imageSearch: typeof import("../src/image_search/index.js").imageSearch;

beforeEach(async () => {
	vi.resetModules();
	mockCreate.mockReset();
	vi.stubEnv("ALIYUN_API_KEY", "test-key");
	vi.stubEnv("ALIYUN_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1");
	const mod = await import("../src/image_search/index.js");
	imageSearch = mod.imageSearch;
});

describe("imageSearch", () => {
	it("uses web_search_image tool when only query provided", async () => {
		mockCreate.mockResolvedValueOnce({
			output: [
				{
					type: "web_search_image_call",
					output: JSON.stringify([{ index: 1, title: "Image 1", url: "https://img.com/1.jpg" }]),
				},
				{
					type: "message",
					content: [{ type: "output_text", text: "Found images" }],
				},
			],
		});

		const result = await imageSearch({ query: "find cats" });
		const body = mockCreate.mock.calls[0][0];
		expect(body.tools).toEqual([{ type: "web_search_image" }]);
		expect(body.input).toBe("find cats");
		expect(body.model).toBe("qwen3.7-plus");
		expect(result.images).toHaveLength(1);
		expect(result.answer).toBe("Found images");
	});

	it("uses image_search tool when imageUrl provided", async () => {
		mockCreate.mockResolvedValueOnce({
			output: [
				{
					type: "image_search_call",
					output: JSON.stringify([{ index: 1, title: "Similar", url: "https://img.com/2.jpg" }]),
				},
				{
					type: "message",
					content: [{ type: "output_text", text: "Similar images found" }],
				},
			],
		});

		await imageSearch({ imageUrl: "https://example.com/photo.jpg" });
		const body = mockCreate.mock.calls[0][0];
		expect(body.tools).toEqual([{ type: "image_search" }]);
		const content = body.input[0].content;
		expect(content.some((c: any) => c.type === "input_image")).toBe(true);
	});

	it("combines query and imageUrl", async () => {
		mockCreate.mockResolvedValueOnce({
			output: [
				{
					type: "image_search_call",
					output: JSON.stringify([{ index: 1, title: "Result", url: "https://img.com/3.jpg" }]),
				},
				{ type: "message", content: [{ type: "output_text", text: "Combined result" }] },
			],
		});

		await imageSearch({ query: "cats", imageUrl: "https://example.com/cat.jpg" });
		const body = mockCreate.mock.calls[0][0];
		const content = body.input[0].content;
		expect(content.some((c: any) => c.type === "input_text")).toBe(true);
		expect(content.some((c: any) => c.type === "input_image")).toBe(true);
	});

	it("throws when neither query nor imageUrl provided", async () => {
		await expect(imageSearch({})).rejects.toThrow("query or imageUrl");
	});

	it("throws when ALIYUN_API_KEY not configured", async () => {
		vi.stubEnv("ALIYUN_API_KEY", "");
		await expect(imageSearch({ query: "cats" })).rejects.toThrow("ALIYUN_API_KEY not configured");
	});

	it("uses config model when provided", async () => {
		mockCreate.mockResolvedValueOnce({
			output: [
				{ type: "web_search_image_call", output: "[]" },
				{ type: "message", content: [{ type: "output_text", text: "Done" }] },
			],
		});

		await imageSearch({ query: "cats" }, undefined, { imageSearchModel: "custom-image-model" });
		const body = mockCreate.mock.calls[0][0];
		expect(body.model).toBe("custom-image-model");
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /home/yandy/workspace/pri/pi-packages/pi-web-tools && npx vitest run tests/image_search.test.ts`
Expected: FAIL — 当前 aliyun.ts 仍用 fetch

- [ ] **Step 3: 重写 `src/image_search/aliyun.ts`**

将 `src/image_search/aliyun.ts` 完整内容替换为：

```ts
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import OpenAI from "openai";
import { resolveSetting } from "../config";
import { createAliyunClient } from "../openai_client";
import { resolveAliyunProvider } from "../provider";
import type { ImageResult, ImageSearchParams, ImageSearchResponse } from "./types";

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
		if (query) {
			content.push({ type: "input_text", text: query });
		}
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

interface AliyunImageResponse {
	output?: Array<{
		type: string;
		output?: string;
		content?: Array<{ type?: string; text?: string }>;
	}>;
}

function parseImages(output: AliyunImageResponse["output"] = []): ImageResult[] {
	for (const item of output) {
		if (item.type === "web_search_image_call" || item.type === "image_search_call") {
			try {
				return JSON.parse(item.output || "[]") as ImageResult[];
			} catch {
				return [];
			}
		}
	}
	return [];
}

function parseAnswer(output: AliyunImageResponse["output"] = []): string {
	const messages = output.filter((item) => item.type === "message");
	const texts = messages.flatMap((m) =>
		(m.content || []).filter((c) => c.type === "output_text").map((c) => c.text || ""),
	);
	return texts.join("\n") || "No results";
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /home/yandy/workspace/pri/pi-packages/pi-web-tools && npx vitest run tests/image_search.test.ts`
Expected: PASS — 全部 6 个用例通过

- [ ] **Step 5: Commit**

```bash
cd /home/yandy/workspace/pri/pi-packages/pi-web-tools && git add src/image_search/aliyun.ts tests/image_search.test.ts && git commit -m "feat: rewrite image_search to use openai sdk and align signature order"
```

---

## Task 7: 更新 index.ts 工具参数与调用签名

**Files:**
- Modify: `index.ts`

- [ ] **Step 1: 扩展 deep_search 工具参数定义**

在 `index.ts` 中，找到 deep_search 的 `parameters: Type.Object({...})` 块（约第 100-102 行），替换为：

```ts
		parameters: Type.Object({
			query: Type.String({ minLength: 2, description: "The search query." }),
			enableSearchExtension: Type.Optional(
				Type.Boolean({ description: "Enable vertical domain search for more precise results." }),
			),
			freshness: Type.Optional(
				Type.Number({
					enum: [7, 30, 180, 365],
					description: "Time range filter: 7/30/180/365 days. Only effective with turbo strategy.",
				}),
			),
			assignedSiteList: Type.Optional(
				Type.Array(Type.String(), {
					description: "Restrict search to specific sites (e.g. [\"baidu.com\", \"sina.cn\"]).",
				}),
			),
			enableImageOutput: Type.Optional(
				Type.Boolean({ description: "Enable mixed text-image output in the response." }),
			),
		}),
```

- [ ] **Step 2: 更新 deep_search execute 调用**

在 `index.ts` 中，找到 deep_search 的 `execute` 函数内（约第 123-146 行），将参数提取和调用部分替换为：

```ts
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const p = params as {
				query: string;
				enableSearchExtension?: boolean;
				freshness?: number;
				assignedSiteList?: string[];
				enableImageOutput?: boolean;
			};
			const query = p.query?.trim();
			if (!query) {
				return { content: [{ type: "text", text: "Error: query is required." }], details: {}, isError: true };
			}

			onUpdate?.({ content: [{ type: "text", text: "Deep searching..." }], details: {} });

			try {
				const cfg = loadConfig(ctx.cwd);
				const result = await deepSearch(query, signal, cfg.aliyun, ctx, {
					enableSearchExtension: p.enableSearchExtension,
					freshness: p.freshness,
					assignedSiteList: p.assignedSiteList,
					enableImageOutput: p.enableImageOutput,
				});
				const sourcesText = result.sources.length
					? `\n\nSources:\n${result.sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join("\n")}`
					: "";
				return {
					content: [{ type: "text", text: result.answer + sourcesText }],
					details: { sources: result.sources },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: `Deep search failed: ${message}` }], details: {}, isError: true };
			}
		},
```

- [ ] **Step 3: 更新 image_search execute 调用签名**

在 `index.ts` 中，找到 image_search 的 `execute` 函数内（约第 203-204 行），将调用签名从 `imageSearch({ query: p.query, imageUrl: p.imageUrl }, signal, ctx, cfg.aliyun)` 改为 `imageSearch({ query: p.query, imageUrl: p.imageUrl }, signal, cfg.aliyun, ctx)`：

```ts
				const result = await imageSearch({ query: p.query, imageUrl: p.imageUrl }, signal, cfg.aliyun, ctx);
```

- [ ] **Step 4: 更新 deep_search 描述与 promptGuidelines**

在 `index.ts` 中，找到 deep_search 的 `description` 字段（约第 92-93 行），替换为：

```ts
		description:
			"Deep search powered by Aliyun (Bailian) using Chat Completions API with web search. The model searches the web and synthesizes a comprehensive answer. Supports vertical domain search, time range filtering, site restriction, and mixed image output.",
```

找到 `promptGuidelines`（约第 96-99 行），替换为：

```ts
		promptGuidelines: [
			"Use deep_search for complex research questions that benefit from web search synthesis.",
			"deep_search is powered by Aliyun Chat Completions API. Configure ALIYUN_API_KEY or use aliyunProviderKey in config.",
		],
```

- [ ] **Step 5: 验证类型检查通过**

Run: `cd /home/yandy/workspace/pri/pi-packages/pi-web-tools && npm run typecheck`
Expected: 无错误

- [ ] **Step 6: 运行全部测试**

Run: `cd /home/yandy/workspace/pri/pi-packages/pi-web-tools && npm test`
Expected: 全部通过（web_search、web_fetch 测试不受影响）

- [ ] **Step 7: Commit**

```bash
cd /home/yandy/workspace/pri/pi-packages/pi-web-tools && git add index.ts && git commit -m "feat: update tool params and call signatures for config split"
```

---

## Task 8: 更新 README.md 文档

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 更新工具表格与前置条件**

在 `README.md` 中，将工具表格中 deep_search 的 Source 列从 `Aliyun (Bailian) Responses API` 改为 `Aliyun (Bailian) Chat Completions API`。

将 image_search 的 Source 列保持 `Aliyun (Bailian) Responses API`。

在 "### API Keys" 章节后，将环境变量表格更新为：

```markdown
| Variable | Description | Default |
|----------|-------------|---------|
| `EXA_API_KEY` | Exa API key. If not set, uses MCP free tier (150 calls/day) | — |
| `ALIYUN_API_KEY` | Aliyun (Bailian) API key | — |
| `ALIYUN_BASE_URL` | Aliyun API base URL | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `ALIYUN_DEEP_SEARCH_MODEL` | Model for deep_search | `deepseek-v4-flash` |
| `ALIYUN_IMAGE_SEARCH_MODEL` | Model for image_search | `qwen3.7-plus` |
```

- [ ] **Step 2: 更新配置文件示例**

将 "### Project Config" 章节的 JSON 示例替换为：

```json
{
  "aliyun": {
    "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "aliyunProviderKey": "aliyun",
    "deepSearchModel": "deepseek-v4-flash",
    "imageSearchModel": "qwen3.7-plus"
  }
}
```

- [ ] **Step 3: 更新配置表格**

将配置表格替换为：

```markdown
| Config Key | Env Variable (overrides) | Default | Description |
|------------|--------------------------|---------|-------------|
| `aliyun.baseUrl` | `ALIYUN_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | Aliyun API base URL |
| `aliyun.aliyunProviderKey` | — | — | Pi provider name to extract apiKey/baseUrl from |
| `aliyun.deepSearchModel` | `ALIYUN_DEEP_SEARCH_MODEL` | `deepseek-v4-flash` | Model for deep_search |
| `aliyun.imageSearchModel` | `ALIYUN_IMAGE_SEARCH_MODEL` | `qwen3.7-plus` | Model for image_search |
```

在配置表格后添加说明段落：

```markdown
**aliyunProviderKey:** When set, deep_search and image_search will extract apiKey and baseUrl from the corresponding pi provider (via `modelRegistry`). Environment variables take precedence over provider values. If the provider is not found, falls back to `aliyun.baseUrl` config or default.

> **Note:** deep_search uses Chat Completions API and does not return structured sources. image_search uses Responses API.
```

- [ ] **Step 4: 更新 deep_search 参数表**

将 "### deep_search" 章节的参数表替换为：

```markdown
**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | yes | — | Research question |
| `enableSearchExtension` | boolean | no | false | Enable vertical domain search |
| `freshness` | number | no | — | Time range: 7/30/180/365 days |
| `assignedSiteList` | string[] | no | — | Restrict search to specific sites |
| `enableImageOutput` | boolean | no | false | Enable mixed text-image output |

> Requires `ALIYUN_API_KEY` or `aliyunProviderKey` config. Uses Chat Completions API with forced search (turbo strategy). Sources are not returned.
```

- [ ] **Step 5: Commit**

```bash
cd /home/yandy/workspace/pri/pi-packages/pi-web-tools && git add README.md && git commit -m "docs: update README for config split and Chat Completions migration"
```

---

## Task 9: 最终验证

- [ ] **Step 1: 运行全部测试**

Run: `cd /home/yandy/workspace/pri/pi-packages/pi-web-tools && npm test`
Expected: 全部测试通过

- [ ] **Step 2: 运行类型检查**

Run: `cd /home/yandy/workspace/pri/pi-packages/pi-web-tools && npm run typecheck`
Expected: 无错误

- [ ] **Step 3: 运行 lint**

Run: `cd /home/yandy/workspace/pri/pi-packages/pi-web-tools && npm run lint`
Expected: 无错误

- [ ] **Step 4: 运行 biome check**

Run: `cd /home/yandy/workspace/pri/pi-packages/pi-web-tools && npm run check`
Expected: 无错误

- [ ] **Step 5: 如果有任何 lint/format 问题，修复并提交**

```bash
cd /home/yandy/workspace/pri/pi-packages/pi-web-tools && npm run format && git add -A && git commit -m "style: fix lint and formatting"
```
