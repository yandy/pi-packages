# pi-memory 直接使用 agentsession API 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** pi-memory 移除对 `@yandy0725/pi-subagents` 的依赖，改为直接调用 pi 的 `createAgentSession` API 运行无头 memory-agent 子会话。

**Architecture:** 新增 `agent-runner.ts`（`runHeadlessAgent` 统一封装三种调用语义）+ `model-resolver.ts`（模型字符串解析）+ `agent-config.ts`（内嵌工具常量）。子会话用 `DefaultResourceLoader` 禁用所有外部资源 + `SessionManager.inMemory` + 复用父 `ctx.modelRegistry`，不 `bindExtensions` 天然防递归。三个调用点（extract/dream/sideQuery）改为调用 `runHeadlessAgent`，dream/extract 改 fire-and-forget，sideQuery 超时返回 `[]`。

**Tech Stack:** TypeScript, pi SDK (`@earendil-works/pi-coding-agent` 的 `createAgentSession`/`DefaultResourceLoader`/`SessionManager`/`SettingsManager`/`getAgentDir`), vitest, biome.

## Global Constraints

- 工作在 worktree `/home/yandy/workspace/pri/pi-packages/.worktrees/pi-memory-direct-agentsession`，分支 `pi-memory-direct-agentsession`
- 用 `uv`/node 既有工具链；测试命令：`npm run test --workspace pi-memory`（等价 `cd pi-memory && npx vitest run`）
- lint：`npx biome check pi-memory` 或 `npx biome check --write pi-memory`（修复）
- TDD：先写失败测试，再实现，再验证通过，再提交
- 不改 pi-subagents 包（pi-permission-system 仍依赖它）
- config `model?: string`，默认 undefined（无 `"auto"` 值）；解析 `!model ? parentModel : resolveModel(model) ?? parentModel`
- thinkLevel 默认值：dream `high`、extract `high`、sideQuery `off`（已存在，不改）
- 设计规格：`docs/superpowers/specs/2026-07-13-pi-memory-direct-agentsession-design.md`

## File Structure

| 文件 | 职责 | 动作 |
|------|------|------|
| `pi-memory/src/agent-config.ts` | 内嵌 `MEMORY_AGENT_TOOLS` 常量 | 新增 |
| `pi-memory/src/model-resolver.ts` | `resolveModel(input, registry)` 模型字符串解析 | 新增 |
| `pi-memory/src/agent-runner.ts` | `runHeadlessAgent(opts)` 统一无头子会话封装 | 新增 |
| `pi-memory/src/config.ts` | `model` 改可选，默认 undefined | 改 |
| `pi-memory/src/extract.ts` | `runExtract` → `runHeadlessAgent`（fire-and-forget） | 改写 |
| `pi-memory/src/dream.ts` | `runDream` → `runHeadlessAgent`（fire-and-forget） | 改写 |
| `pi-memory/src/inject.ts` | `runSideQuery` → `runHeadlessAgent`（超时返回 `[]`） | 改写 |
| `pi-memory/index.ts` | 删 ensureAgentTypes/isSubagent、传 modelRegistry/model、去 setTimeout | 改写 |
| `pi-memory/src/agent-types.ts` | 不再需要 | 删除 |
| `pi-memory/package.json` | 移除 pi-subagents peerDependency | 改 |
| `pi-memory/tests/*` | mock 目标改 `./agent-runner`、更新断言 | 改 |

**接口契约（跨任务依赖）：**
- `agent-config.ts` 导出 `MEMORY_AGENT_TOOLS = ["read","write","edit","ls"] as const`
- `model-resolver.ts` 导出 `resolveModel(input: string, registry: ModelRegistry): Model<any> | undefined`
- `agent-runner.ts` 导出 `interface HeadlessAgentOpts` + `runHeadlessAgent(opts): Promise<string>`
- `extract.ts` 的 `RunExtractOpts` 新增 `modelRegistry: ModelRegistry`、`parentModel?: Model<any>`，移除 `service`
- `dream.ts` 的 `RunDreamOpts` 新增 `modelRegistry`、`parentModel`，移除 `signal`/`events`/`service`
- `inject.ts` 的 `runSideQuery` 新增 `model/modelRegistry/parentModel/memoryDir` 参数

---

### Task 1: 内嵌 agent 配置常量

**Files:**
- Create: `pi-memory/src/agent-config.ts`
- Test: `pi-memory/tests/agent-config.test.ts`

**Interfaces:**
- Produces: `MEMORY_AGENT_TOOLS`（`readonly ["read","write","edit","ls"]`）

- [ ] **Step 1: 写失败测试**

创建 `pi-memory/tests/agent-config.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { MEMORY_AGENT_TOOLS } from "../src/agent-config";

describe("MEMORY_AGENT_TOOLS", () => {
	it("contains read/write/edit/ls only", () => {
		expect([...MEMORY_AGENT_TOOLS]).toEqual(["read", "write", "edit", "ls"]);
		expect(MEMORY_AGENT_TOOLS).not.toContain("bash");
		expect(MEMORY_AGENT_TOOLS).not.toContain("websearch");
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd pi-memory && npx vitest run tests/agent-config.test.ts`
Expected: FAIL — `Cannot find module '../src/agent-config'`

- [ ] **Step 3: 写实现**

创建 `pi-memory/src/agent-config.ts`：

```ts
/** Tools available to the headless memory-agent sub-session (file I/O only). */
export const MEMORY_AGENT_TOOLS = ["read", "write", "edit", "ls"] as const;
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd pi-memory && npx vitest run tests/agent-config.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: 提交**

```bash
git add pi-memory/src/agent-config.ts pi-memory/tests/agent-config.test.ts
git commit -m "feat(pi-memory): add agent-config with MEMORY_AGENT_TOOLS constant"
```

---

### Task 2: 模型解析器

**Files:**
- Create: `pi-memory/src/model-resolver.ts`
- Test: `pi-memory/tests/model-resolver.test.ts`

**Interfaces:**
- Consumes: `ModelRegistry` from `@earendil-works/pi-coding-agent`
- Produces: `resolveModel(input: string, registry: ModelRegistry): Model<any> | undefined` — 精确匹配 `"provider/modelId"`（仅可用模型），否则模糊匹配（id/name 包含），阈值 ≥20，失败返回 `undefined`

- [ ] **Step 1: 写失败测试**

创建 `pi-memory/tests/model-resolver.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { resolveModel } from "../src/model-resolver";

function makeRegistry(models: Array<{ provider: string; id: string; name: string }>) {
	return {
		find: (provider: string, modelId: string) =>
			models.find((m) => m.provider === provider && m.id === modelId) as any,
		getAvailable: () => models as any[],
		getAll: () => models as any[],
	} as any;
}

describe("resolveModel", () => {
	const models = [
		{ provider: "deepseek", id: "deepseek-v4-flash", name: "DeepSeek Flash" },
		{ provider: "deepseek", id: "deepseek-v4-pro", name: "DeepSeek Pro" },
		{ provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku" },
	];

	it("exact match provider/modelId", () => {
		const m = resolveModel("deepseek/deepseek-v4-flash", makeRegistry(models));
		expect(m).toBeDefined();
		expect(m.id).toBe("deepseek-v4-flash");
	});

	it("fuzzy match by id substring (haiku)", () => {
		const m = resolveModel("haiku", makeRegistry(models));
		expect(m).toBeDefined();
		expect(m.id).toBe("claude-haiku-4-5");
	});

	it("fuzzy match by name substring", () => {
		const m = resolveModel("Pro", makeRegistry(models));
		expect(m).toBeDefined();
		expect(m.id).toBe("deepseek-v4-pro");
	});

	it("returns undefined when no match", () => {
		const m = resolveModel("nonexistent-model-xyz", makeRegistry(models));
		expect(m).toBeUndefined();
	});

	it("returns undefined for empty input", () => {
		const m = resolveModel("", makeRegistry(models));
		expect(m).toBeUndefined();
	});

	it("exact match is case-insensitive", () => {
		const m = resolveModel("DeepSeek/DeepSeek-V4-Flash", makeRegistry(models));
		expect(m).toBeDefined();
		expect(m.id).toBe("deepseek-v4-flash");
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd pi-memory && npx vitest run tests/model-resolver.test.ts`
Expected: FAIL — `Cannot find module '../src/model-resolver'`

- [ ] **Step 3: 写实现**

创建 `pi-memory/src/model-resolver.ts`：

```ts
import type { Model, ModelRegistry } from "@earendil-works/pi-coding-agent";

interface ModelEntry {
	id: string;
	name: string;
	provider: string;
}

/**
 * Resolve a model string to a Model instance.
 * Tries exact "provider/modelId" match (only available models), then fuzzy match.
 * Returns the Model on success, or undefined on failure (caller falls back to parent model).
 */
export function resolveModel(input: string, registry: ModelRegistry): Model<any> | undefined {
	if (!input) return undefined;
	const all = (registry.getAvailable?.() ?? registry.getAll()) as ModelEntry[];
	if (all.length === 0) return undefined;
	const availableSet = new Set(all.map((m) => `${m.provider}/${m.id}`.toLowerCase()));

	// 1. Exact match: "provider/modelId" — only if available (has auth)
	const slashIdx = input.indexOf("/");
	if (slashIdx !== -1) {
		const provider = input.slice(0, slashIdx);
		const modelId = input.slice(slashIdx + 1);
		if (availableSet.has(input.toLowerCase())) {
			const found = registry.find(provider, modelId);
			if (found) return found;
		}
	}

	// 2. Fuzzy match against available models
	const query = input.toLowerCase();
	let bestMatch: ModelEntry | undefined;
	let bestScore = 0;

	for (const m of all) {
		const id = m.id.toLowerCase();
		const name = m.name.toLowerCase();
		const full = `${m.provider}/${m.id}`.toLowerCase();

		let score = 0;
		if (id === query || full === query) {
			score = 100;
		} else if (id.includes(query) || full.includes(query)) {
			score = 60 + (query.length / id.length) * 30;
		} else if (name.includes(query)) {
			score = 40 + (query.length / name.length) * 20;
		} else if (
			query
				.split(/[\s\-/]+/)
				.every((part) => id.includes(part) || name.includes(part) || m.provider.toLowerCase().includes(part))
		) {
			score = 20;
		}

		if (score > bestScore) {
			bestScore = score;
			bestMatch = m;
		}
	}

	if (bestMatch && bestScore >= 20) {
		const found = registry.find(bestMatch.provider, bestMatch.id);
		if (found) return found;
	}

	return undefined;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd pi-memory && npx vitest run tests/model-resolver.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: 提交**

```bash
git add pi-memory/src/model-resolver.ts pi-memory/tests/model-resolver.test.ts
git commit -m "feat(pi-memory): add model-resolver (exact + fuzzy model resolution)"
```

---

### Task 3: 无头子会话封装 agent-runner

**Files:**
- Create: `pi-memory/src/agent-runner.ts`
- Test: `pi-memory/tests/agent-runner.test.ts`

**Interfaces:**
- Consumes: `MEMORY_AGENT_TOOLS` (Task 1), `resolveModel` (Task 2), `createAgentSession`/`DefaultResourceLoader`/`SessionManager`/`SettingsManager`/`getAgentDir` from `@earendil-works/pi-coding-agent`
- Produces: `interface HeadlessAgentOpts`、`runHeadlessAgent(opts: HeadlessAgentOpts): Promise<string>`

```ts
interface HeadlessAgentOpts {
  task: string;
  cwd: string;
  modelRegistry: ModelRegistry;
  model?: string;          // undefined → 继承 parentModel
  parentModel?: Model<any>;
  thinkLevel?: ThinkLevel;
  maxTurns?: number;       // undefined = 无限
  signal?: AbortSignal;
  timeoutMs?: number;
}
```

- [ ] **Step 1: 写失败测试**

创建 `pi-memory/tests/agent-runner.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock createAgentSession — returns a fake session capturing prompt/subscribe/dispose
const promptMock = vi.fn().mockResolvedValue(undefined);
const abortMock = vi.fn().mockResolvedValue(undefined);
const steerMock = vi.fn().mockResolvedValue(undefined);
const disposeMock = vi.fn();
const subscribeMock = vi.fn().mockReturnValue(() => {});

const createAgentSessionMock = vi.fn().mockResolvedValue({
	session: {
		prompt: promptMock,
		subscribe: subscribeMock,
		abort: abortMock,
		steer: steerMock,
		dispose: disposeMock,
		getActiveToolNames: () => ["read", "write", "edit", "ls"],
		setActiveToolsByName: vi.fn(),
	},
	extensionsResult: {},
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
	createAgentSession: createAgentSessionMock,
	DefaultResourceLoader: vi.fn().mockImplementation(() => ({
		reload: vi.fn().mockResolvedValue(undefined),
	})),
	SessionManager: { inMemory: vi.fn().mockReturnValue({ getSessionId: () => "s1" }) },
	SettingsManager: { inMemory: vi.fn().mockReturnValue({}) },
	getAgentDir: vi.fn().mockReturnValue("/home/fake/.pi/agent"),
}));

import { runHeadlessAgent } from "../src/agent-runner";

const fakeRegistry = {
	find: vi.fn((_p: string, id: string) => (id === "deepseek-v4-flash" ? { id } : undefined)),
	getAvailable: () => [{ provider: "deepseek", id: "deepseek-v4-flash", name: "Flash" }],
	getAll: () => [{ provider: "deepseek", id: "deepseek-v4-flash", name: "Flash" }],
} as any;

beforeEach(() => {
	promptMock.mockClear();
	abortMock.mockClear();
	steerMock.mockClear();
	disposeMock.mockClear();
	subscribeMock.mockClear();
	createAgentSessionMock.mockClear();
});

describe("runHeadlessAgent", () => {
	it("creates session with inMemory managers, no bindExtensions, disposes in finally", async () => {
		// subscribe captures the listener; we emit agent_end to let prompt resolve
		subscribeMock.mockImplementation((listener: any) => {
			// emit turn_end + message sequence after prompt is called
			queueMicrotask(() => {
				listener({ type: "message_start", message: {} });
				listener({
					type: "message_update",
					message: {},
					assistantMessageEvent: { type: "text_delta", delta: "Hello ", contentIndex: 0 },
				});
				listener({
					type: "message_update",
					message: {},
					assistantMessageEvent: { type: "text_delta", delta: "world", contentIndex: 0 },
				});
				listener({ type: "message_end", message: {} });
				listener({ type: "turn_end", message: {}, toolResults: [] });
				listener({ type: "agent_end", messages: [], willRetry: false });
			});
			return () => {};
		});

		const result = await runHeadlessAgent({
			task: "do something",
			cwd: "/mem",
			modelRegistry: fakeRegistry,
			parentModel: { id: "parent-model" } as any,
			thinkLevel: "high",
		});

		expect(result).toBe("Hello world");
		expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
		// tools restricted to memory agent tools
		const opts = createAgentSessionMock.mock.calls[0][0];
		expect(opts.tools).toEqual(["read", "write", "edit", "ls"]);
		expect(opts.sessionManager).toBeDefined(); // inMemory
		// disposed
		expect(disposeMock).toHaveBeenCalledTimes(1);
	});

	it("inherits parentModel when model is undefined", async () => {
		subscribeMock.mockImplementation((listener: any) => {
			queueMicrotask(() => {
				listener({ type: "message_end", message: {} });
				listener({ type: "turn_end", message: {}, toolResults: [] });
				listener({ type: "agent_end", messages: [], willRetry: false });
			});
			return () => {};
		});

		await runHeadlessAgent({
			task: "x",
			cwd: "/mem",
			modelRegistry: fakeRegistry,
			parentModel: { id: "parent-model" } as any,
		});

		const opts = createAgentSessionMock.mock.calls[0][0];
		expect(opts.model).toEqual({ id: "parent-model" });
	});

	it("resolves configured model string via resolver", async () => {
		subscribeMock.mockImplementation((listener: any) => {
			queueMicrotask(() => {
				listener({ type: "message_end", message: {} });
				listener({ type: "turn_end", message: {}, toolResults: [] });
				listener({ type: "agent_end", messages: [], willRetry: false });
			});
			return () => {};
		});

		await runHeadlessAgent({
			task: "x",
			cwd: "/mem",
			modelRegistry: fakeRegistry,
			model: "deepseek/deepseek-v4-flash",
			parentModel: { id: "parent" } as any,
		});

		const opts = createAgentSessionMock.mock.calls[0][0];
		expect(opts.model).toEqual({ id: "deepseek-v4-flash" });
	});

	it("disposes even when prompt throws", async () => {
		promptMock.mockRejectedValueOnce(new Error("boom"));
		await expect(
			runHeadlessAgent({
				task: "x",
				cwd: "/mem",
				modelRegistry: fakeRegistry,
				parentModel: {} as any,
			}),
		).rejects.toThrow("boom");
		expect(disposeMock).toHaveBeenCalledTimes(1);
	});

	it("aborts on signal", async () => {
		const controller = new AbortController();
		subscribeMock.mockImplementation((listener: any) => {
			queueMicrotask(() => {
				listener({ type: "message_end", message: {} });
				listener({ type: "turn_end", message: {}, toolResults: [] });
				listener({ type: "agent_end", messages: [], willRetry: false });
			});
			return () => {};
		});

		const p = runHeadlessAgent({
			task: "x",
			cwd: "/mem",
			modelRegistry: fakeRegistry,
			parentModel: {} as any,
			signal: controller.signal,
		});
		controller.abort();
		await p;
		expect(abortMock).toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd pi-memory && npx vitest run tests/agent-runner.test.ts`
Expected: FAIL — `Cannot find module '../src/agent-runner'`

- [ ] **Step 3: 写实现**

创建 `pi-memory/src/agent-runner.ts`：

```ts
import {
	type AgentSession,
	type AgentSessionEvent,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	createAgentSession,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { MEMORY_AGENT_TOOLS } from "./agent-config";
import { resolveModel } from "./model-resolver";
import type { ThinkLevel } from "./config";

export interface HeadlessAgentOpts {
	task: string;
	cwd: string;
	modelRegistry: import("@earendil-works/pi-coding-agent").ModelRegistry;
	model?: string;
	parentModel?: Model<any>;
	thinkLevel?: ThinkLevel;
	maxTurns?: number;
	signal?: AbortSignal;
	timeoutMs?: number;
}

const GRACE_TURNS = 1;

/**
 * Run a headless memory-agent sub-session: create an in-memory, resource-free
 * session, drive the turn loop, collect the assistant response text, and dispose.
 *
 * Does NOT call bindExtensions — no extension hooks fire in the sub-session,
 * so pi-memory's own before_agent_start cannot recurse.
 */
export async function runHeadlessAgent(opts: HeadlessAgentOpts): Promise<string> {
	// 1. Resolve model: undefined → parentModel; otherwise fuzzy resolve (fallback parent)
	const resolvedModel = !opts.model
		? opts.parentModel
		: resolveModel(opts.model, opts.modelRegistry) ?? opts.parentModel;

	// 2. Build a pure resource loader (no extensions/skills/context files/etc.)
	const settingsManager = SettingsManager.inMemory();
	const loader = new DefaultResourceLoader({
		cwd: opts.cwd,
		agentDir: getAgentDir(),
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await loader.reload();

	// 3. Create the in-memory session (no bindExtensions)
	const { session } = await createAgentSession({
		cwd: opts.cwd,
		tools: [...MEMORY_AGENT_TOOLS],
		model: resolvedModel as any,
		thinkingLevel: opts.thinkLevel as any,
		modelRegistry: opts.modelRegistry,
		sessionManager: SessionManager.inMemory(opts.cwd),
		settingsManager,
		resourceLoader: loader,
	});

	// 4. Collect response text + enforce turn limits
	let text = "";
	let turnCount = 0;
	let softLimitReached = false;
	const unsubscribe = (session as AgentSession).subscribe((event: AgentSessionEvent) => {
		if (event.type === "message_start") {
			text = "";
		} else if (
			event.type === "message_update" &&
			event.assistantMessageEvent.type === "text_delta"
		) {
			text += event.assistantMessageEvent.delta;
		} else if (event.type === "turn_end") {
			turnCount++;
			if (opts.maxTurns != null) {
				if (!softLimitReached && turnCount >= opts.maxTurns) {
					softLimitReached = true;
					void (session as AgentSession).steer("You have reached your turn limit. Finish now.");
				} else if (softLimitReached && turnCount >= opts.maxTurns + GRACE_TURNS) {
					void (session as AgentSession).abort();
				}
			}
		}
	});

	// 5. Forward abort signal
	const onAbort = (): void => {
		void (session as AgentSession).abort();
	};
	opts.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		// 6. Drive prompt (with optional timeout)
		const promptPromise = (session as AgentSession).prompt(opts.task);
		if (opts.timeoutMs != null) {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			const timeoutPromise = new Promise<never>((_, reject) => {
				timeoutId = setTimeout(() => reject(new Error(`headless agent timed out after ${opts.timeoutMs}ms`)), opts.timeoutMs);
			});
			await Promise.race([promptPromise, timeoutPromise]).finally(() => {
				if (timeoutId) clearTimeout(timeoutId);
			});
		} else {
			await promptPromise;
		}
		return text;
	} finally {
		opts.signal?.removeEventListener("abort", onAbort);
		unsubscribe();
		(session as AgentSession).dispose?.();
	}
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd pi-memory && npx vitest run tests/agent-runner.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: 提交**

```bash
git add pi-memory/src/agent-runner.ts pi-memory/tests/agent-runner.test.ts
git commit -m "feat(pi-memory): add runHeadlessAgent — pure in-memory headless sub-session"
```

---

### Task 4: config 去 "auto" —— model 改可选

**Files:**
- Modify: `pi-memory/src/config.ts`
- Test: `pi-memory/tests/config.test.ts`

**Interfaces:**
- Produces: `dream.model?`、`extractMemories.model?`、`autoSurfacing.model?`（均为 `string | undefined`），`DEFAULT_CONFIG` 三处 model 删除（即 undefined）

- [ ] **Step 1: 更新 config 测试断言**

修改 `pi-memory/tests/config.test.ts`。把所有 `model: "auto"` / `.toBe("auto")` 断言改为 undefined。具体替换：

- 第 12 行：`expect(DEFAULT_CONFIG.dream.model).toBe("auto");` → `expect(DEFAULT_CONFIG.dream.model).toBeUndefined();`
- 第 77-95 行的 autoSurfacing / extractMemories `toEqual` 块中删除 `model: "auto",` 行（或改为 `model: undefined,`，但 toEqual 中省略 undefined 字段更简洁——注意 toEqual 对 undefined 字段：对象有该键且值为 undefined 仍相等。最稳妥是删除该行）

更新后的两处 toEqual 应为：

```ts
// autoSurfacing defaults (删除 model 行)
expect(cfg.autoSurfacing).toEqual({
	enabled: true,
	thinkLevel: "off",
	maxFiles: 5,
	maxTopicBytes: 4096,
	maxInjectionBytes: 20480,
});

// extractMemories defaults (删除 model 行)
expect(cfg.extractMemories).toEqual({
	enabled: true,
	thinkLevel: "high",
	maxContextTokens: 2000,
});
```

并删除/修正以下断言（这些断言 `model` 默认值）：
- 第 109 行 `expect(cfg1.autoSurfacing.model).toBe("auto"); // default preserved` → 改为 `expect(cfg1.autoSurfacing.model).toBeUndefined();`
- 第 120 行 `expect(cfg.autoSurfacing.model).toBe("auto"); // default preserved` → 改为 `expect(cfg.autoSurfacing.model).toBeUndefined();`

- [ ] **Step 2: 运行测试确认失败**

Run: `cd pi-memory && npx vitest run tests/config.test.ts`
Expected: FAIL — 断言 `"auto"` 与实际 `undefined` 不符

- [ ] **Step 3: 改 config.ts**

修改 `pi-memory/src/config.ts`：

1. `AutoSurfacingConfig.model: string;` → `model?: string;`
2. `ExtractMemoriesConfig.model: string;` → `model?: string;`
3. `MemoryConfig.dream` 中 `model: string;` → `model?: string;`
4. `DEFAULT_CONFIG` 中删除三处 `model: "auto",`（dream / autoSurfacing / extractMemories）

具体编辑（3 处接口 + 3 处默认值）：

```ts
// AutoSurfacingConfig
export interface AutoSurfacingConfig {
	enabled: boolean;
	model?: string;
	thinkLevel: ThinkLevel;
	maxFiles: number;
	maxTopicBytes: number;
	maxInjectionBytes: number;
}

// ExtractMemoriesConfig
export interface ExtractMemoriesConfig {
	enabled: boolean;
	model?: string;
	thinkLevel: ThinkLevel;
	maxContextTokens: number;
}

// MemoryConfig.dream
	dream: { nudgeAfterSessions: number; nudgeAfterHours: number; model?: string; thinkLevel: ThinkLevel };

// DEFAULT_CONFIG — 删除三处 model 行
	dream: { nudgeAfterSessions: 5, nudgeAfterHours: 24, thinkLevel: "high" },
	autoSurfacing: {
		enabled: true,
		thinkLevel: "off",
		maxFiles: 5,
		maxTopicBytes: 4096,
		maxInjectionBytes: 20480,
	},
	extractMemories: {
		enabled: true,
		thinkLevel: "high",
		maxContextTokens: 2000,
	},
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd pi-memory && npx vitest run tests/config.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add pi-memory/src/config.ts pi-memory/tests/config.test.ts
git commit -m "refactor(pi-memory): make config model optional (drop 'auto' value)"
```

---

### Task 5: 改写 extract.ts（fire-and-forget）

**Files:**
- Modify: `pi-memory/src/extract.ts`
- Test: `pi-memory/tests/extract.test.ts`

**Interfaces:**
- Consumes: `runHeadlessAgent` (Task 3)
- Produces: `RunExtractOpts { model?: string; thinkLevel; memoryDir; messages; maxContextTokens; modelRegistry; parentModel? }`，`runExtract(opts): Promise<void>`（fire-and-forget，不 await runner）

- [ ] **Step 1: 重写 extract 测试**

将 `pi-memory/tests/extract.test.ts` 的 `runExtract` 部分整体替换为 mock `./agent-runner`：

```ts
import { describe, it, expect, vi } from "vitest";
import { buildExtractTask, runExtract } from "../src/extract";

const { runHeadlessAgentMock } = vi.hoisted(() => ({
	runHeadlessAgentMock: vi.fn().mockResolvedValue("done"),
}));
vi.mock("../src/agent-runner", () => ({
	runHeadlessAgent: runHeadlessAgentMock,
}));

describe("buildExtractTask", () => {
	it("builds extraction task prompt with context", () => {
		const messages = [
			{ role: "user", content: "how to debug SSH?" },
			{ role: "assistant", content: "Use ssh -vvv user@host" },
		];
		const task = buildExtractTask("/tmp/mem", messages, 2000);
		expect(task).toContain("memory extraction agent");
		expect(task).toContain("/tmp/mem");
		expect(task).toContain("how to debug SSH?");
		expect(task).toContain("ssh -vvv");
	});

	it("truncates long messages", () => {
		const longMsg = "x".repeat(5000);
		const task = buildExtractTask("/tmp/mem", [{ role: "user", content: longMsg }], 100);
		expect(task.length).toBeLessThan(5000);
	});
});

describe("runExtract", () => {
	it("calls runHeadlessAgent with maxTurns=5 and configured thinkLevel (fire-and-forget)", () => {
		runHeadlessAgentMock.mockClear();
		runExtract({
			thinkLevel: "high",
			memoryDir: "/mem/x",
			messages: [{ role: "user", content: "hello" }],
			maxContextTokens: 2000,
			modelRegistry: {} as any,
			parentModel: { id: "parent" } as any,
		});

		expect(runHeadlessAgentMock).toHaveBeenCalledTimes(1);
		expect(runHeadlessAgentMock).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/mem/x",
				thinkLevel: "high",
				maxTurns: 5,
				parentModel: { id: "parent" },
			}),
		);
		// task contains memory dir
		expect(runHeadlessAgentMock.mock.calls[0][0].task).toContain("/mem/x");
	});

	it("passes configured model string when set", () => {
		runHeadlessAgentMock.mockClear();
		runExtract({
			model: "deepseek/deepseek-v4-flash",
			thinkLevel: "medium",
			memoryDir: "/mem/x",
			messages: [{ role: "user", content: "hello" }],
			maxContextTokens: 2000,
			modelRegistry: {} as any,
		});

		expect(runHeadlessAgentMock.mock.calls[0][0]).toMatchObject({
			model: "deepseek/deepseek-v4-flash",
			thinkLevel: "medium",
		});
	});

	it("skips when messages array is empty", () => {
		runHeadlessAgentMock.mockClear();
		runExtract({
			thinkLevel: "high",
			memoryDir: "/mem/x",
			messages: [],
			maxContextTokens: 2000,
			modelRegistry: {} as any,
		});
		expect(runHeadlessAgentMock).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd pi-memory && npx vitest run tests/extract.test.ts`
Expected: FAIL — `runExtract` 仍用旧签名（缺 modelRegistry / 仍 import pi-subagents）

- [ ] **Step 3: 改写 extract.ts**

将 `pi-memory/src/extract.ts` 整体替换为（保留 `buildExtractTask` 不变，仅改 `runExtract` + import + opts）：

```ts
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ThinkLevel } from "./config";
import { runHeadlessAgent } from "./agent-runner";

export interface RunExtractOpts {
	model?: string;
	thinkLevel: ThinkLevel;
	memoryDir: string;
	messages: Array<{ role: string; content: string }>;
	maxContextTokens: number;
	modelRegistry: ModelRegistry;
	parentModel?: Model<any>;
}

/** Build extraction task prompt. (unchanged) */
export function buildExtractTask(
	memoryDir: string,
	messages: Array<{ role: string; content: string }>,
	maxTokens: number,
): string {
	const fromUser = messages.find((m) => m.role === "user");
	const fromAssistant = messages.findLast((m) => m.role === "assistant");
	const userText = fromUser?.content ?? "";
	const assistantText = fromAssistant?.content ?? "";

	const maxChars = maxTokens * 4;
	const truncatedUser = userText.slice(0, maxChars / 2);
	const truncatedAssistant = assistantText.slice(0, maxChars / 2);

	return [
		`You are a memory extraction agent. Your cwd is the memory directory at ${memoryDir}.`,
		"",
		"Analyze the conversation snippet below. If you find valuable learnings, write them to topic files in this directory using ONLY file read/write/edit tools. Do NOT use bash, web search, or any other tools.",
		"The memory directory contains topic files with this frontmatter format:",
		"",
		"```yaml",
		"---",
		"name: Topic Name",
		"description: Brief summary for relevance matching",
		"type: feedback  # one of: user, feedback, project, reference",
		"updated: 2026-07-13",
		"---",
		"",
		"## Entry Title",
		"Entry content here.",
		"```",
		"",
		"And MEMORY.md index:",
		"- [Name](file.md) — one-line hook summary",
		"",
		"Worth remembering:",
		"- User preferences, coding style choices, tooling preferences",
		"- Project conventions, architecture decisions, naming patterns",
		"- Debugging insights, workarounds, gotchas discovered",
		'- "Always do X" / "Never do Y" rules',
		"- References to external systems or documentation",
		"",
		"NOT worth remembering:",
		"- One-time task instructions or ephemeral details",
		"- Code snippets or file paths derivable from the project",
		"- Information already captured in CLAUDE.md or AGENTS.md",
		"- Git history or recent changes",
		"",
		"When writing memories:",
		"- Use descriptive, self-contained entry titles (only index lines are injected into future sessions)",
		"- Choose the appropriate type: user, feedback, project, reference",
		'- Default type is "feedback"',
		"- Be concise but complete",
		"- If unsure, do NOT write anything",
		"- Use the write/edit tools to directly modify topic files and MEMORY.md",
		"",
		"=== Conversation ===",
		`User: ${truncatedUser}`,
		`Assistant: ${truncatedAssistant}`,
	].join("\n");
}

/** Fire-and-forget memory extraction. Does not await the headless agent. */
export async function runExtract(opts: RunExtractOpts): Promise<void> {
	if (opts.messages.length === 0) return;
	const task = buildExtractTask(opts.memoryDir, opts.messages, opts.maxContextTokens);
	// fire-and-forget: runner disposes internally via finally
	runHeadlessAgent({
		task,
		cwd: opts.memoryDir,
		modelRegistry: opts.modelRegistry,
		model: opts.model,
		parentModel: opts.parentModel,
		thinkLevel: opts.thinkLevel,
		maxTurns: 5,
	}).catch(() => {
		/* silently ignore extract errors */
	});
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd pi-memory && npx vitest run tests/extract.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add pi-memory/src/extract.ts pi-memory/tests/extract.test.ts
git commit -m "refactor(pi-memory): rewrite extract.ts to use runHeadlessAgent (fire-and-forget)"
```

---

### Task 6: 改写 dream.ts（fire-and-forget）

**Files:**
- Modify: `pi-memory/src/dream.ts`
- Test: `pi-memory/tests/dream.test.ts`

**Interfaces:**
- Consumes: `runHeadlessAgent` (Task 3)
- Produces: `RunDreamOpts { model?: string; thinkLevel; memoryDir; modelRegistry; parentModel? }`，`runDream(opts): Promise<string>`（fire-and-forget 由调用方决定，函数本身返回 Promise；不再有 signal/events）

- [ ] **Step 1: 重写 dream 测试**

将 `pi-memory/tests/dream.test.ts` 的 `runDream` 部分整体替换为 mock `./agent-runner`：

```ts
import { describe, it, expect, vi } from "vitest";
import { buildDreamTask, runDream } from "../src/dream";

const { runHeadlessAgentMock } = vi.hoisted(() => ({
	runHeadlessAgentMock: vi.fn(),
}));
vi.mock("../src/agent-runner", () => ({
	runHeadlessAgent: runHeadlessAgentMock,
}));

describe("buildDreamTask", () => {
	it("includes memory dir + consolidation instructions + line limit", () => {
		const task = buildDreamTask("/mem/abc123", 200);
		expect(task).toContain("/mem/abc123");
		expect(task).toContain("200");
		expect(task).toContain("## Entry Title");
		expect(task).toContain("MEMORY.md");
		expect(task).toMatch(/deduplicat|consolidat/i);
		expect(task).toContain("meaningful name");
		expect(task).toContain("one line per topic file");
	});

	it("builds four-phase dream task prompt", () => {
		const task = buildDreamTask("/tmp/mem", 200);
		expect(task).toContain("Phase 1 — Orient");
		expect(task).toContain("Phase 2 — Gather Signal");
		expect(task).toContain("Phase 3 — Consolidate");
		expect(task).toContain("Phase 4 — Prune & Index");
		expect(task).toContain("~150 chars");
	});
});

describe("runDream", () => {
	it("calls runHeadlessAgent with no maxTurns (unlimited) and resolves with its result", async () => {
		runHeadlessAgentMock.mockResolvedValueOnce("merged 3 entries");
		const summary = await runDream({
			thinkLevel: "high",
			memoryDir: "/mem/x",
			modelRegistry: {} as any,
			parentModel: { id: "parent" } as any,
		});
		expect(runHeadlessAgentMock).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/mem/x",
				thinkLevel: "high",
				maxTurns: undefined,
				parentModel: { id: "parent" },
			}),
		);
		expect(summary).toBe("merged 3 entries");
	});

	it("passes configured model string when set", async () => {
		runHeadlessAgentMock.mockResolvedValueOnce("ok");
		await runDream({
			model: "deepseek/deepseek-v4-flash",
			thinkLevel: "medium",
			memoryDir: "/mem/x",
			modelRegistry: {} as any,
		});
		expect(runHeadlessAgentMock.mock.calls[0][0]).toMatchObject({
			model: "deepseek/deepseek-v4-flash",
			thinkLevel: "medium",
		});
	});

	it("propagates failure from runHeadlessAgent", async () => {
		runHeadlessAgentMock.mockRejectedValueOnce(new Error("dream failed"));
		await expect(
			runDream({ thinkLevel: "high", memoryDir: "/mem/x", modelRegistry: {} as any }),
		).rejects.toThrow("dream failed");
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd pi-memory && npx vitest run tests/dream.test.ts`
Expected: FAIL — `runDream` 仍用旧签名

- [ ] **Step 3: 改写 dream.ts**

将 `pi-memory/src/dream.ts` 整体替换为（保留 `buildDreamTask` 不变）：

```ts
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ThinkLevel } from "./config";
import { runHeadlessAgent } from "./agent-runner";

/** Build dream consolidation task. (unchanged) */
export function buildDreamTask(memoryDir: string, maxLines: number): string {
	return `You are a memory consolidation agent. Your job is to read all memory files
and consolidate them into a clean, deduplicated memory store.

Phase 1 — Orient:
- List all files in ${memoryDir}
- Read MEMORY.md to understand current index
- Skim each topic file to understand its contents

Phase 2 — Gather Signal:
- Find duplicate entries within and across topic files
- Identify contradictory information
- Spot outdated or obsolete entries
- Note temporal references that should be absolute dates

Phase 3 — Consolidate:
- Merge duplicates into single entries
- Resolve contradictions — pick the most accurate version
- Convert relative dates (today, last week) to absolute dates
- Update outdated information
- Move entries to more appropriate topic files when needed
- Delete entries that are no longer relevant

Phase 4 — Prune & Index:
- For each topic file, update frontmatter:
  name: meaningful name for the topic
  description: specific summary that helps LLM match queries (be specific!)
  type: one of user, feedback, project, reference
  updated: today's date
- Generate a compact hook (~150 chars) for each topic summarizing its entries
- Rebuild MEMORY.md with one line per topic file (max ${maxLines} lines):
  - [Name](file.md) — hook
- Remove topic files that have no remaining entries

CRITICAL for hooks and descriptions:
- Only the MEMORY.md index is injected into future coding sessions.
  Topic file content is NOT seen by the coding agent unless explicitly
  read or auto-surfaced. The hook and description must be specific
  enough that the LLM can correctly decide relevance.
- Bad: "Debugging tips"
- Good: "SSH port 2222 on staging; MySQL 30s timeout; Redis auth fix"
- Each topic file's \`## Entry Title\` blocks contain the actual memory entries.
  The MEMORY.md line is just a pointer — only ONE line per topic file.
- When done, output a concise summary of changes (merged N, removed N, moved N, updated N).`;
}

export interface RunDreamOpts {
	model?: string;
	thinkLevel: ThinkLevel;
	memoryDir: string;
	modelRegistry: ModelRegistry;
	parentModel?: Model<any>;
}

/** Run dream consolidation via a headless agent. Fire-and-forget (caller decides await). */
export async function runDream(opts: RunDreamOpts): Promise<string> {
	const task = buildDreamTask(opts.memoryDir, 200);
	return runHeadlessAgent({
		task,
		cwd: opts.memoryDir,
		modelRegistry: opts.modelRegistry,
		model: opts.model,
		parentModel: opts.parentModel,
		thinkLevel: opts.thinkLevel,
		maxTurns: undefined,
	});
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd pi-memory && npx vitest run tests/dream.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add pi-memory/src/dream.ts pi-memory/tests/dream.test.ts
git commit -m "refactor(pi-memory): rewrite dream.ts to use runHeadlessAgent (fire-and-forget)"
```

---

### Task 7: 改写 inject.ts 的 runSideQuery（超时返回空）

**Files:**
- Modify: `pi-memory/src/inject.ts`
- Test: `pi-memory/tests/inject.test.ts`

**Interfaces:**
- Consumes: `runHeadlessAgent` (Task 3)
- Produces: `runSideQuery(prompt, manifest, maxFiles, thinkLevel, model, modelRegistry, parentModel, memoryDir): Promise<string[]>`（超时/失败返回 `[]`，无降级）

- [ ] **Step 1: 重写 inject 测试的 runSideQuery 部分**

修改 `pi-memory/tests/inject.test.ts`：
1. 删除顶部的 `vi.mock("@yandy0725/pi-subagents", ...)` 和所有 `await import("@yandy0725/pi-subagents")` 用法
2. 改为 mock `./agent-runner`：

```ts
const { runHeadlessAgentMock } = vi.hoisted(() => ({
	runHeadlessAgentMock: vi.fn(),
}));
vi.mock("../src/agent-runner", () => ({
	runHeadlessAgent: runHeadlessAgentMock,
}));
```

3. 将整个 `describe("runSideQuery", ...)` 块替换为：

```ts
describe("runSideQuery", () => {
	it("calls runHeadlessAgent with maxTurns=1, timeoutMs=30000, thinkLevel, and parses selected_files", async () => {
		runHeadlessAgentMock.mockResolvedValueOnce('{"selected_files":["a.md"]}');
		const manifest = [
			{ filename: "a.md", name: "A", description: "desc", type: "feedback" as const, mtimeMs: 100 },
		];
		const result = await runSideQuery(
			"prompt without already-injected", manifest, 5, "off",
			undefined, {} as any, {} as any, "/mem",
		);
		expect(runHeadlessAgentMock).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/mem",
				thinkLevel: "off",
				maxTurns: 1,
				timeoutMs: 30_000,
			}),
		);
		expect(result).toEqual(["a.md"]);
	});

	it("forwards configured model string", async () => {
		runHeadlessAgentMock.mockResolvedValueOnce('{"selected_files":[]}');
		const manifest = [
			{ filename: "a.md", name: "A", description: "desc", type: "feedback" as const, mtimeMs: 100 },
		];
		await runSideQuery(
			"prompt", manifest, 5, "off",
			"deepseek/deepseek-v4-flash", {} as any, {} as any, "/mem",
		);
		expect(runHeadlessAgentMock.mock.calls[0][0]).toMatchObject({
			model: "deepseek/deepseek-v4-flash",
		});
	});

	it("returns [] on timeout/failure (no fallback)", async () => {
		runHeadlessAgentMock.mockRejectedValueOnce(new Error("timed out"));
		const manifest = [
			{ filename: "debugging.md", name: "D", description: "SSH tips", type: "project" as const, mtimeMs: 100 },
		];
		const result = await runSideQuery(
			"I need to debug SSH", manifest, 5, "off",
			undefined, {} as any, {} as any, "/mem",
		);
		expect(result).toEqual([]);
	});

	it("returns [] when response has no valid JSON", async () => {
		runHeadlessAgentMock.mockResolvedValueOnce("not json at all");
		const manifest = [
			{ filename: "a.md", name: "A", description: "desc", type: "feedback" as const, mtimeMs: 100 },
		];
		const result = await runSideQuery(
			"prompt", manifest, 5, "off",
			undefined, {} as any, {} as any, "/mem",
		);
		expect(result).toEqual([]);
	});

	it("returns [] when no candidates remain", async () => {
		const result = await runSideQuery(
			"some prompt", [], 5, "off",
			undefined, {} as any, {} as any, "/mem",
		);
		expect(result).toEqual([]);
		expect(runHeadlessAgentMock).not.toHaveBeenCalled();
	});

	it("filters out already-injected candidates", async () => {
		runHeadlessAgentMock.mockResolvedValueOnce('{"selected_files":["a.md"]}');
		const manifest = [
			{ filename: "a.md", name: "A", description: "desc", type: "feedback" as const, mtimeMs: 100 },
		];
		// prompt marks a.md as already injected
		const result = await runSideQuery(
			"blah [already injected] a.md blah", manifest, 5, "off",
			undefined, {} as any, {} as any, "/mem",
		);
		expect(result).toEqual([]);
		expect(runHeadlessAgentMock).not.toHaveBeenCalled();
	});
});
```

注意：保留 `inject.test.ts` 中其他 `describe` 块（loadIndexSnapshot / buildInjection / scanTopics / buildSurfacingPrompt / injectSurfacedContent）不变。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd pi-memory && npx vitest run tests/inject.test.ts`
Expected: FAIL — `runSideQuery` 仍用旧签名/import pi-subagents

- [ ] **Step 3: 改写 inject.ts 的 runSideQuery**

修改 `pi-memory/src/inject.ts`：
1. 删除 `import { getSubagentsService } from "@yandy0725/pi-subagents";`
2. 添加 `import type { Model } from "@earendil-works/pi-ai";`、`import type { ModelRegistry } from "@earendil-works/pi-coding-agent";`、`import { runHeadlessAgent } from "./agent-runner";`
3. 删除整个旧 `runSideQuery` 函数和 `keywordMatch` 函数
4. 新增提取的 `buildSideQueryTask` + 新 `runSideQuery`：

```ts
/** Build the side-query task prompt. Extracted for testability. */
export function buildSideQueryTask(prompt: string, maxFiles: number): string {
	return [
		"You are a memory relevance selector. Below is a list of memory topic files and a user message.",
		`Select up to ${maxFiles} topic files that are relevant to the user's current query.`,
		"Response format: JSON with a 'selected_files' array of filenames.",
		"",
		"=== Topic Files ===",
		...[], // (lines built by caller from manifest; here prompt already includes them)
		"",
		"=== User Message ===",
		prompt,
		"",
		'Return: {"selected_files": ["a.md", "b.md"]}',
	].join("\n");
}

/** Parse selected_files JSON from headless agent response. */
function parseSelectedFiles(result: string, candidates: TopicManifest[], maxFiles: number): string[] {
	try {
		const jsonMatch = result.match(/\{[^}]*"selected_files"[^}]*\}/s);
		if (!jsonMatch) return [];
		const parsed = JSON.parse(jsonMatch[0]);
		const files: string[] = parsed.selected_files ?? [];
		return files.filter((f: string) => candidates.some((c) => c.filename === f)).slice(0, maxFiles);
	} catch {
		return [];
	}
}

/** Run a lightweight headless side-query to select relevant topic files.
 *  Returns [] on timeout/failure — no fallback. */
export async function runSideQuery(
	prompt: string,
	manifest: TopicManifest[],
	maxFiles: number,
	thinkLevel: ThinkLevel,
	model: string | undefined,
	modelRegistry: ModelRegistry,
	parentModel: Model<any> | undefined,
	memoryDir: string,
): Promise<string[]> {
	const candidates = manifest.filter((t) => !prompt.includes(`[already injected] ${t.filename}`));
	if (candidates.length === 0) return [];
	const task = buildSideQueryTask(prompt, maxFiles);
	try {
		const result = await runHeadlessAgent({
			task,
			cwd: memoryDir,
			modelRegistry,
			model,
			parentModel,
			thinkLevel,
			maxTurns: 1,
			timeoutMs: 30_000,
		});
		return parseSelectedFiles(result, candidates, maxFiles);
	} catch {
		return [];
	}
}
```

注意：`buildSideQueryTask` 中 `...[]` 那行是占位，实际 topic 清单已在传入的 `prompt` 中（由 `buildSurfacingPrompt` 生成）。为简洁，将 `buildSideQueryTask` 简化为不含 `=== Topic Files ===` 列表（因 prompt 已含），最终实现：

```ts
export function buildSideQueryTask(prompt: string, maxFiles: number): string {
	return [
		"Respond with ONLY a JSON object.",
		"",
		"Below is a list of memory topic files and a user query.",
		`Select up to ${maxFiles} topic files MOST relevant to the user's current query.`,
		'If nothing is relevant, return {"selected_files": []}.',
		"",
		prompt,
		"",
		'Respond with EXACTLY: {"selected_files": [...]}',
	].join("\n");
}
```

5. 删除文件底部 `import type { ThinkLevel } from "./config";`（如已在上文 import ThinkLevel，确保不重复）。确认 `ThinkLevel` 已在文件顶部 import。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd pi-memory && npx vitest run tests/inject.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add pi-memory/src/inject.ts pi-memory/tests/inject.test.ts
git commit -m "refactor(pi-memory): rewrite runSideQuery to use runHeadlessAgent (timeout→[])"
```

---

### Task 8: 改写 index.ts + 删除 agent-types.ts

**Files:**
- Modify: `pi-memory/index.ts`
- Modify: `pi-memory/tests/index-wiring.test.ts`
- Delete: `pi-memory/src/agent-types.ts`

**Interfaces:**
- Consumes: `runHeadlessAgent`（间接，经 extract/dream/inject）、`ctx.modelRegistry`、`ctx.model`
- Produces: 删除 `ensureAgentTypes()` 调用、删除 `isSubagent` 检测；`runExtract`/`runDream`/`runSideQuery` 调用传 `modelRegistry`/`parentModel`；session_start dream 去 setTimeout 直接 fire-and-forget

- [ ] **Step 1: 更新 index-wiring 测试**

修改 `pi-memory/tests/index-wiring.test.ts`：
1. mock config 块中，把 `dream: { ..., model: "auto" }`、`autoSurfacing: { ..., model: "auto" }`、`extractMemories: { ..., model: "auto" }` 的 `model: "auto"` 行删除（与 Task 4 一致）
2. 把 "skips auto-surfacing for subagents" 测试改为验证新机制。由于子会话不 bindExtensions，主会话 hook 永远只在主会话跑——该测试原本验证"subagent 跳过 surfacing"。新设计下，**子会话根本不触发 pi-memory hook**，所以这个测试在 index 层面失去意义。改为：删除该测试，替换为"主会话有 prompt 时跑 auto-surfacing"的强化断言（与已有 "runs auto-surfacing for main agents" 合并即可，避免重复）。

具体：删除整个 `it("skips auto-surfacing for subagents ...")` 块。保留 `it("runs auto-surfacing for main agents ...")`。

更新 mock config（删除 model 行）：

```ts
vi.mock("../src/config", () => ({
	loadConfig: vi.fn().mockResolvedValue({
		enabled: true,
		memoryDir: MOCK_BASE,
		memIndexMaxLines: 200,
		memIndexMaxBytes: 25600,
		dream: { nudgeAfterSessions: 5, nudgeAfterHours: 24, thinkLevel: "high" },
		sessionSearch: { maxSessions: 10, maxMatches: 5 },
		autoSurfacing: {
			enabled: true,
			maxFiles: 5,
			maxTopicBytes: 4096,
			maxInjectionBytes: 20480,
			thinkLevel: "off",
		},
		extractMemories: {
			enabled: false,
			maxContextTokens: 2000,
			thinkLevel: "high",
		},
	}),
}));
```

3. 在 "runs auto-surfacing for main agents" 测试中，给 fakeCtx 加 `modelRegistry` 和 `model`（因为 index.ts 会用），并确认 runSideQueryMock 被调用时收到 modelRegistry。但注意：该测试 mock 了 `runSideQuery`，所以 index.ts 调用 runSideQuery 的参数会被 mock 捕获。验证 runSideQueryMock 收到 modelRegistry：

在该测试末尾追加断言：
```ts
expect(runSideQueryMock).toHaveBeenCalledWith(
	expect.any(String), expect.any(Array), 5, "off",
	undefined, expect.any(Object), undefined, MOCK_BASE,
);
```

注意 `before_agent_start` 的 ctx 在该测试传 `{ cwd: tmpDir, hasUI: false }`，无 modelRegistry/model。需更新 fakeCtx 让 before_agent_start 的 ctx 含 modelRegistry/model。但 before_agent_start 的 ctx 是主会话 ctx。在该测试 `noUiCtx2 = { cwd: tmpDir, hasUI: false }` 改为 `{ cwd: tmpDir, hasUI: false, modelRegistry: {}, model: undefined }`。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd pi-memory && npx vitest run tests/index-wiring.test.ts`
Expected: FAIL — index.ts 仍 import agent-types / 用 isSubagent / dream 用 setTimeout

- [ ] **Step 3: 改写 index.ts**

修改 `pi-memory/index.ts`：
1. 删除 `import { ensureAgentTypes } from "./src/agent-types";` 和模块级 `ensureAgentTypes();` 调用
2. `agent_end` 中 `runExtract({...})` 添加 `modelRegistry: ctx.modelRegistry, parentModel: ctx.model`（注意：`agent_end` handler 当前签名 `async (event)` 没有 ctx —— 需改为 `async (event, ctx)`）
3. `before_agent_start` 中：
   - 删除 `isSubagent` 检测逻辑（`const agentTools = ...; const isSubagent = ...` 及 `!isSubagent` 条件）
   - `runSideQuery(...)` 调用改为新签名，传 `config.autoSurfacing.model`、`ctx.modelRegistry`、`ctx.model`、`memoryDir`
4. `session_start` nudge dream：去掉 `setTimeout(0)`，直接 fire-and-forget：
   ```ts
   ctx.ui.setStatus("dream", "Consolidating memory...");
   runDream({
	   model: dreamModel,
	   thinkLevel: dreamThinkLevel,
	   memoryDir: dir,
	   modelRegistry: ctx.modelRegistry,
	   parentModel: ctx.model,
   })
	   .then(async (summary) => { await writeDreamMeta(dir, sessions); ctx.ui.notify(summary, "info"); })
	   .catch((e) => ctx.ui.notify(`Dream failed: ${e.message}`, "error"))
	   .finally(() => ctx.ui.setStatus("dream", undefined));
   ```
   注意：`dreamModel`/`dreamThinkLevel` 从 config 读取（config.dream.model / thinkLevel）。由于去 setTimeout，删除原 `setTimeout(async () => {...}, 0)` 包装。
5. `/dream` 命令 handler：改为 fire-and-forget（不 await runDream），同样挂 `.then/.catch/.finally`，传 `ctx.modelRegistry`/`ctx.model`。

完整 `index.ts` 改写（关键改动后的版本）—— 以下为需替换的片段。先看当前 before_agent_start 的 auto-surfacing 段，替换为：

```ts
	pi.on("before_agent_start", async (event, ctx) => {
		if (!config?.enabled || !indexSnapshot || !memoryDir) return;

		const autoSurfacing = config.autoSurfacing;
		// biome-ignore lint/suspicious/noExplicitAny: message injection result
		let injectedMessage: any;
		if (autoSurfacing?.enabled && event.prompt) {
			try {
				if (ctx.hasUI) ctx.ui.setStatus("surfacing", "Searching relevant memories…");
				const manifest = await scanTopics(memoryDir);
				if (manifest.length > 0) {
					const queryPrompt = buildSurfacingPrompt(manifest, event.prompt.slice(0, 4000), injectedTopics);
					const selected = await runSideQuery(
						queryPrompt, manifest, autoSurfacing.maxFiles, autoSurfacing.thinkLevel,
						autoSurfacing.model, ctx.modelRegistry, ctx.model, memoryDir,
					);
					if (selected.length > 0) {
						const content = await injectSurfacedContent(
							memoryDir, selected, autoSurfacing.maxTopicBytes, autoSurfacing.maxInjectionBytes,
						);
						if (content) {
							for (const f of selected) injectedTopics.add(f);
							injectedMessage = { customType: "memory-auto-surfacing", content, display: false };
						}
					}
				}
			} catch {
				/* silently skip auto-surfacing on error */
			} finally {
				if (ctx.hasUI) ctx.ui.setStatus("surfacing", undefined);
			}
		}

		return {
			systemPrompt: buildInjection(event.systemPrompt, indexSnapshot),
			...(injectedMessage ? { message: injectedMessage } : {}),
		};
	});
```

agent_end 段（改签名加 ctx，加 modelRegistry/parentModel）：

```ts
	pi.on("agent_end", async (event, ctx) => {
		if (!config?.enabled || !memoryDir) return;
		const extractConfig = config.extractMemories;
		if (!extractConfig?.enabled) return;
		if (!event.messages || event.messages.length === 0) return;
		runExtract({
			model: extractConfig.model,
			thinkLevel: extractConfig.thinkLevel,
			memoryDir,
			modelRegistry: ctx.modelRegistry,
			parentModel: ctx.model,
			messages: event.messages.map((m) => ({
				// biome-ignore lint/suspicious/noExplicitAny: pi event message union type
				role: String((m as any).role ?? ""),
				content:
					// biome-ignore lint/suspicious/noExplicitAny: pi event message union type
					typeof (m as any).content === "string"
						? // biome-ignore lint/suspicious/noExplicitAny: pi event message union type
							(m as any).content
						: // biome-ignore lint/suspicious/noExplicitAny: pi event message union type
							typeof (m as any).output === "string"
							? // biome-ignore lint/suspicious/noExplicitAny: pi event message union type
								(m as any).output
							: // biome-ignore lint/suspicious/noExplicitAny: pi event message union type
								JSON.stringify((m as any).content ?? ""),
			})),
			maxContextTokens: extractConfig.maxContextTokens,
		}).catch(() => {
			/* silently ignore extract errors */
		});
	});
```

session_start nudge 段（去 setTimeout，fire-and-forget）：

```ts
		if (ctx.hasUI) {
			const { nudge, message, sessions } = await shouldNudge(memoryDir, config, ctx.cwd);
			if (nudge) {
				const ok = await ctx.ui.confirm("Memory Consolidation", `${message}\n\nConsolidate memory files now?`);
				if (ok) {
					const dreamModel = config.dream.model;
					const dreamThinkLevel = config.dream.thinkLevel;
					const dir = memoryDir;
					ctx.ui.setStatus("dream", "Consolidating memory...");
					runDream({
						model: dreamModel,
						thinkLevel: dreamThinkLevel,
						memoryDir: dir,
						modelRegistry: ctx.modelRegistry,
						parentModel: ctx.model,
					})
						.then(async (summary) => {
							await writeDreamMeta(dir, sessions);
							ctx.ui.notify(summary, "info");
						})
						// biome-ignore lint/suspicious/noExplicitAny: error catch
						.catch((e: any) => {
							ctx.ui.notify(`Dream failed: ${e.message}`, "error");
						})
						.finally(() => {
							ctx.ui.setStatus("dream", undefined);
						});
				}
			}
		}
```

/dream 命令 handler 段（fire-and-forget）：

```ts
	pi.registerCommand("dream", {
		description: "Consolidate all memory files via a headless agent",
		handler: async (_args, ctx) => {
			if (!config || !memoryDir) {
				ctx.ui.notify("Memory not initialized.", "info");
				return;
			}
			const ok = await ctx.ui.confirm("Dream", "Consolidate all memory files? This rewrites them in-place.");
			if (!ok) return;
			ctx.ui.setStatus("dream", "Consolidating memory...");
			runDream({
				model: config.dream.model,
				thinkLevel: config.dream.thinkLevel,
				memoryDir,
				modelRegistry: ctx.modelRegistry,
				parentModel: ctx.model,
			})
				.then(async (summary) => {
					const sessions = (await SessionManager.list(ctx.cwd)).length;
					await writeDreamMeta(memoryDir, sessions);
					ctx.ui.notify(summary, "info");
				})
				// biome-ignore lint/suspicious/noExplicitAny: command handler ctx
				.catch((e: any) => {
					ctx.ui.notify(`Dream failed: ${e.message}`, "error");
				})
				.finally(() => {
					ctx.ui.setStatus("dream", undefined);
				});
		},
	});
```

4. 删除 `pi-memory/src/agent-types.ts`

- [ ] **Step 4: 运行测试确认通过**

Run: `cd pi-memory && npx vitest run tests/index-wiring.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add pi-memory/index.ts pi-memory/tests/index-wiring.test.ts
git rm pi-memory/src/agent-types.ts
git commit -m "refactor(pi-memory): rewrite index.ts (drop isSubagent/ensureAgentTypes, pass modelRegistry, fire-and-forget dream)"
```

---

### Task 9: 移除 pi-subagents 依赖 + 全量验证

**Files:**
- Modify: `pi-memory/package.json`

- [ ] **Step 1: 移除 peerDependency**

修改 `pi-memory/package.json`，从 `peerDependencies` 中删除 `@yandy0725/pi-subagents` 整行。

- [ ] **Step 2: 确认无残留 import**

Run: `cd pi-memory && grep -rn "pi-subagents" src/ index.ts tests/ || echo "no references"`
Expected: `no references`

- [ ] **Step 3: 运行全量测试**

Run: `cd pi-memory && npx vitest run`
Expected: 全部 PASS（12+ 测试文件）

- [ ] **Step 4: 运行 lint**

Run: `npx biome check pi-memory`
Expected: 无错误（如有格式问题，`npx biome check --write pi-memory` 修复后重新运行）

- [ ] **Step 5: 类型检查**

Run: `cd pi-memory && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 6: 提交**

```bash
git add pi-memory/package.json
git commit -m "refactor(pi-memory): remove @yandy0725/pi-subagents peerDependency"
```

---

## Self-Review

**1. Spec coverage（规格覆盖）：**
- agent-runner.ts（runHeadlessAgent 统一封装）→ Task 3 ✓
- model-resolver.ts → Task 2 ✓
- agent-config.ts（内嵌工具）→ Task 1 ✓
- config 去 "auto"（model 可选）→ Task 4 ✓
- extract fire-and-forget → Task 5 ✓
- dream fire-and-forget → Task 6 ✓
- sideQuery 超时返回 []、删 keywordMatch、cwd=memoryDir、model=config → Task 7 ✓
- index.ts 删 ensureAgentTypes/isSubagent、传 modelRegistry、去 setTimeout → Task 8 ✓
- 删 agent-types.ts → Task 8 ✓
- 移除 pi-subagents 依赖 → Task 9 ✓
- 测试更新 → 各 Task 内 ✓

**2. Placeholder scan：** Task 7 buildSideQueryTask 有两版（初版含占位 `...[]`，最终版简化）——实现时用最终简化版。无其他占位。✓

**3. Type consistency：**
- `MEMORY_AGENT_TOOLS`（Task 1）→ Task 3 用 `[...MEMORY_AGENT_TOOLS]` ✓
- `resolveModel(input, registry): Model | undefined`（Task 2）→ Task 3 用 ✓
- `HeadlessAgentOpts`（Task 3）→ Task 5/6/7 调用一致（task/cwd/modelRegistry/model/parentModel/thinkLevel/maxTurns/timeoutMs）✓
- `RunExtractOpts`（Task 5）/ `RunDreamOpts`（Task 6）含 `modelRegistry` + `parentModel?`，index.ts（Task 8）传 `ctx.modelRegistry`/`ctx.model` ✓
- `runSideQuery` 新签名 8 参数（Task 7）→ index.ts（Task 8）调用 8 参数 ✓
- config `model?`（Task 4）→ extract/dream/sideQuery 读 `opts.model`（可 undefined）✓

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-13-pi-memory-direct-agentsession.md`.
