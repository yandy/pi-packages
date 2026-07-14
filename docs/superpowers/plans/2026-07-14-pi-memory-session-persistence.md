# pi-memory Session 持久化 & defaults 共享配置 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 pi-memory 的三个 headless sub-agent session 增加持久化配置（默认 in-memory），同时引入 `defaults` 共享配置层支持 model/sessionPersistence 的共用 + per-task 覆盖。

**Architecture:** Config 层新增 `DefaultsConfig` 和 `SessionPersistenceConfig` 类型；`agent-runner.ts` 按 `sessionPersistence.enabled` 条件选择 `SessionManager.create`（持久化）或 `inMemory`；call site (`index.ts`) 新增 resolve 函数，将 defaults → per-task 覆盖后的值传入各 task。

**Tech Stack:** TypeScript, vitest, `@earendil-works/pi-coding-agent` SessionManager

## Global Constraints

- session 默认持久化目录：`memoryDir/sessions/`，可通过 `sessionDir` 自定义
- `thinkLevel` 不参与 defaults 继承，保持 per-task 必填
- 向后兼容：`defaults` 缺失时行为与当前一致
- 所有现有测试必须通过
- **TDD：每个 task 先写测试（红），再实现（绿），最后 commit**

---

## File Structure

| File | Responsibility |
|------|---------------|
| `pi-memory/src/config.ts` | Config schema: 新增类型定义、扩展 MemoryConfig、更新 DEFAULT_CONFIG |
| `pi-memory/src/agent-runner.ts` | HeadlessAgentOpts 新增 sessionPersistence，条件创建 SessionManager |
| `pi-memory/src/dream.ts` | RunDreamOpts 新增 sessionPersistence，透传 |
| `pi-memory/src/extract.ts` | RunExtractOpts 新增 sessionPersistence，透传 |
| `pi-memory/src/inject.ts` | runSideQuery 新增 sessionPersistence 参数，透传 |
| `pi-memory/index.ts` | 新增 resolveConfig，wire sessionPersistence 到各 task call site |
| `pi-memory/tests/config.test.ts` | 测试 defaults 合并、sessionPersistence 传播、向后兼容 |
| `pi-memory/tests/agent-runner.test.ts` | 测试 sessionPersistence 条件创建 SessionManager |

---

### Task 1: Config — 先写测试，再添加类型和配置

**Files:**
- Modify: `pi-memory/tests/config.test.ts`
- Modify: `pi-memory/src/config.ts`

**Interfaces:**
- Produces: `SessionPersistenceConfig`, `DefaultsConfig`, 更新后的 `MemoryConfig`, `DEFAULT_CONFIG`

- [ ] **Step 1: 在 config.test.ts 中新增 defaults 和 sessionPersistence 测试（RED）**

在 `describe("loadConfig", ...)` 块末尾（最后一个 `it` 之后）新增以下测试：

```ts
	it("propagates defaults.sessionPersistence to all tasks", async () => {
		await writeFile(
			join(globalDir, "memory.json"),
			JSON.stringify({ defaults: { sessionPersistence: { enabled: true } } }),
		);
		const cfg = await loadConfig({
			cwd: projectDir,
			isProjectTrusted: () => true,
			_globalDir: globalDir,
			_configDirName: ".pi",
		});
		expect(cfg.defaults?.sessionPersistence).toEqual({ enabled: true });
		expect(cfg.dream.sessionPersistence).toBeUndefined();
		expect(cfg.autoSurfacing.sessionPersistence).toBeUndefined();
		expect(cfg.extractMemories.sessionPersistence).toBeUndefined();
	});

	it("per-task sessionPersistence overrides defaults", async () => {
		await writeFile(
			join(globalDir, "memory.json"),
			JSON.stringify({
				defaults: { sessionPersistence: { enabled: true } },
				dream: { sessionPersistence: { enabled: false } },
			}),
		);
		const cfg = await loadConfig({
			cwd: projectDir,
			isProjectTrusted: () => true,
			_globalDir: globalDir,
			_configDirName: ".pi",
		});
		expect(cfg.defaults?.sessionPersistence).toEqual({ enabled: true });
		expect(cfg.dream.sessionPersistence).toEqual({ enabled: false });
	});

	it("defaults.model propagates correctly", async () => {
		await writeFile(
			join(globalDir, "memory.json"),
			JSON.stringify({ defaults: { model: "deepseek/flash" } }),
		);
		const cfg = await loadConfig({
			cwd: projectDir,
			isProjectTrusted: () => true,
			_globalDir: globalDir,
			_configDirName: ".pi",
		});
		expect(cfg.defaults?.model).toBe("deepseek/flash");
		expect(cfg.dream.model).toBeUndefined();
	});

	it("per-task model overrides defaults.model", async () => {
		await writeFile(
			join(globalDir, "memory.json"),
			JSON.stringify({
				defaults: { model: "deepseek/flash" },
				dream: { model: "tencent/glm" },
			}),
		);
		const cfg = await loadConfig({
			cwd: projectDir,
			isProjectTrusted: () => true,
			_globalDir: globalDir,
			_configDirName: ".pi",
		});
		expect(cfg.dream.model).toBe("tencent/glm");
	});

	it("backward compatible: no defaults, no sessionPersistence in config", async () => {
		const cfg = await loadConfig({
			cwd: projectDir,
			isProjectTrusted: () => true,
			_globalDir: globalDir,
			_configDirName: ".pi",
		});
		expect(cfg.defaults).toBeUndefined();
		expect(cfg.dream.thinkLevel).toBe("high");
		expect(cfg.dream.sessionPersistence).toBeUndefined();
	});
```

- [ ] **Step 2: 运行测试，确认失败（RED）**

```bash
cd /home/yandy/workspace/pri/pi-packages/pi-memory && npx vitest run tests/config.test.ts 2>&1 | tail -20
```

Expected: 5 个新测试 FAIL——因为 `sessionPersistence`、`defaults` 字段尚未定义，TypeScript 编译报错。

- [ ] **Step 3: 实现 config.ts 类型和 DEFAULT_CONFIG（GREEN）**

在 `export type ThinkLevel = ...` 之后、`export interface AutoSurfacingConfig` 之前，新增类型：

```ts
/** Session persistence configuration for headless memory-agent sub-sessions. */
export interface SessionPersistenceConfig {
	/** Enable disk persistence (default: false = in-memory). */
	enabled: boolean;
	/** Custom session directory. Defaults to memoryDir/sessions/. */
	sessionDir?: string;
}

/** Shared defaults that per-task configs inherit. Per-task fields override these. */
export interface DefaultsConfig {
	model?: string;
	sessionPersistence?: SessionPersistenceConfig;
}
```

修改 `MemoryConfig` interface：在 `enabled` 后加 `defaults`，在每个 task 子对象中加 `sessionPersistence`：

```ts
export interface MemoryConfig {
	enabled: boolean;
	/** Shared defaults for model and sessionPersistence. Per-task configs override. */
	defaults?: DefaultsConfig;
	memoryDir: string;
	memIndexMaxLines: number;
	memIndexMaxBytes: number;
	dream: {
		nudgeAfterSessions: number;
		nudgeAfterHours: number;
		model?: string;
		thinkLevel: ThinkLevel;
		sessionPersistence?: SessionPersistenceConfig;
	};
	sessionSearch: { maxSessions: number; maxMatches: number };
	autoSurfacing: AutoSurfacingConfig & {
		sessionPersistence?: SessionPersistenceConfig;
	};
	extractMemories: ExtractMemoriesConfig & {
		sessionPersistence?: SessionPersistenceConfig;
	};
}
```

- [ ] **Step 4: 运行测试，确认通过（GREEN）**

```bash
cd /home/yandy/workspace/pri/pi-packages/pi-memory && npx vitest run tests/config.test.ts
```

Expected: 16 tests PASS（11 旧 + 5 新）。

- [ ] **Step 5: Commit**

```bash
cd /home/yandy/workspace/pri/pi-packages && git add pi-memory/tests/config.test.ts pi-memory/src/config.ts && git commit -m "feat(pi-memory): add SessionPersistenceConfig, DefaultsConfig, extend MemoryConfig"
```

---

### Task 2: agent-runner — 先写测试，再实现条件创建 SessionManager

**Files:**
- Modify: `pi-memory/tests/agent-runner.test.ts`
- Modify: `pi-memory/src/agent-runner.ts`

**Interfaces:**
- Consumes: `SessionPersistenceConfig` from `./config`
- Produces: 更新后的 `HeadlessAgentOpts`（新增 `sessionPersistence` 字段）

- [ ] **Step 1: 更新 agent-runner mock + 新增 persistence 测试（RED）**

**1a. 将 SessionManager mock 移入 hoisted mocks**（替换现有 mock，使 inMemory/create 可以在 beforeEach 中清除）：

```ts
// 在 vi.hoisted() 中新增 inMemoryMock 和 createMock
const mocks = vi.hoisted(() => ({
	promptMock: vi.fn(),
	abortMock: vi.fn(),
	steerMock: vi.fn(),
	disposeMock: vi.fn(),
	subscribeMock: vi.fn(),
	createAgentSessionMock: vi.fn(),
	inMemoryMock: vi.fn().mockReturnValue({ getSessionId: () => "s1" }),
	createSessionMock: vi.fn().mockReturnValue({ getSessionId: () => "s2" }),
}));

// vi.mock 中引用 hoisted mocks
vi.mock("@earendil-works/pi-coding-agent", () => ({
	createAgentSession: mocks.createAgentSessionMock,
	DefaultResourceLoader: vi.fn().mockImplementation(() => ({
		reload: vi.fn().mockResolvedValue(undefined),
	})),
	SessionManager: {
		inMemory: mocks.inMemoryMock,
		create: mocks.createSessionMock,
	},
	SettingsManager: { inMemory: vi.fn().mockReturnValue({}) },
	getAgentDir: vi.fn().mockReturnValue("/home/fake/.pi/agent"),
}));

// 解构 mocks（在已有解构中加入）
const { promptMock, abortMock, steerMock, disposeMock, subscribeMock, createAgentSessionMock, inMemoryMock, createSessionMock } = mocks;

// beforeEach 中新增清除
beforeEach(() => {
	promptMock.mockClear();
	abortMock.mockClear();
	steerMock.mockClear();
	disposeMock.mockClear();
	subscribeMock.mockClear();
	createAgentSessionMock.mockClear();
	inMemoryMock.mockClear();
	createSessionMock.mockClear();
});
```

**1b. 在 describe 块末尾新增 persistence 测试：**

```ts
	it("uses SessionManager.create when sessionPersistence.enabled is true", async () => {
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
			parentModel: {} as any,
			sessionPersistence: { enabled: true },
		});

		expect(createSessionMock).toHaveBeenCalledWith("/mem", "/mem/sessions");
		expect(inMemoryMock).not.toHaveBeenCalled();
	});

	it("uses custom sessionDir when sessionPersistence.sessionDir is set", async () => {
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
			parentModel: {} as any,
			sessionPersistence: { enabled: true, sessionDir: "/custom/sessions" },
		});

		expect(createSessionMock).toHaveBeenCalledWith("/mem", "/custom/sessions");
		expect(inMemoryMock).not.toHaveBeenCalled();
	});
```

- [ ] **Step 2: 运行测试，确认失败（RED）**

```bash
cd /home/yandy/workspace/pri/pi-packages/pi-memory && npx vitest run tests/agent-runner.test.ts 2>&1 | tail -20
```

Expected: 2 个新测试 FAIL——`HeadlessAgentOpts` 尚无 `sessionPersistence` 字段，TypeScript 编译报错。

- [ ] **Step 3: 实现 agent-runner.ts 的条件 session 创建（GREEN）**

在 agent-runner.ts 顶部 import 中加入：

```ts
import { join } from "node:path";
```

在 `HeadlessAgentOpts` 中加字段：

```ts
	/** Session persistence config. When enabled, sessions are written to disk. */
	sessionPersistence?: import("./config").SessionPersistenceConfig;
```

将 step 4 中硬编码的 `SessionManager.inMemory(opts.cwd)` 替换为：

```ts
	// 4. Create session (in-memory or persisted based on config)
	const sessionManager = opts.sessionPersistence?.enabled
		? SessionManager.create(
				opts.cwd,
				opts.sessionPersistence.sessionDir ?? join(opts.cwd, "sessions"),
			)
		: SessionManager.inMemory(opts.cwd);

	const created = await createAgentSession({
		cwd: opts.cwd,
		tools: [...MEMORY_AGENT_TOOLS],
		model: resolvedModel as any,
		thinkingLevel: opts.thinkLevel as any,
		modelRegistry: opts.modelRegistry,
		sessionManager,
		settingsManager,
		resourceLoader: loader,
	});
```

更新 JSDoc：将首行 "in-memory" 改为更准确描述：

```ts
/**
 * Run a headless memory-agent sub-session: create a session (in-memory by default,
 * persisted to disk when sessionPersistence.enabled is true), drive the turn loop,
 * collect the assistant response text, and dispose.
```

- [ ] **Step 4: 运行测试，确认通过（GREEN）**

```bash
cd /home/yandy/workspace/pri/pi-packages/pi-memory && npx vitest run tests/agent-runner.test.ts
```

Expected: 8 tests PASS（6 旧 + 2 新）。

- [ ] **Step 5: Commit**

```bash
cd /home/yandy/workspace/pri/pi-packages && git add pi-memory/tests/agent-runner.test.ts pi-memory/src/agent-runner.ts && git commit -m "feat(pi-memory): conditional session persistence in agent-runner"
```

---

### Task 3: task 接口层 + index.ts 连线 — 先更新测试，再改源码

**Files:**
- Modify: `pi-memory/src/dream.ts`
- Modify: `pi-memory/src/extract.ts`
- Modify: `pi-memory/src/inject.ts`
- Modify: `pi-memory/index.ts`
- Modify: `pi-memory/tests/dream.test.ts`
- Modify: `pi-memory/tests/extract.test.ts`

**Interfaces:**
- Consumes: `SessionPersistenceConfig` from `./config`
- Produces: 更新后的 `RunDreamOpts`, `RunExtractOpts`, `runSideQuery` 签名，index.ts 的 resolveDefault + call site 连线

- [ ] **Step 1: 更新 dream.test.ts + extract.test.ts，验证 sessionPersistence 透传（RED）**

**dream.test.ts** — 在 `describe("runDream", ...)` 块末尾新增（直接使用已有的 `runHeadlessAgentMock`）：

```ts
	it("passes sessionPersistence through to runHeadlessAgent", async () => {
		runHeadlessAgentMock.mockResolvedValueOnce("ok");
		await runDream({
			thinkLevel: "high",
			memoryDir: "/mem/x",
			modelRegistry: {} as any,
			sessionPersistence: { enabled: true, sessionDir: "/custom" },
		});
		expect(runHeadlessAgentMock).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionPersistence: { enabled: true, sessionDir: "/custom" },
			}),
		);
	});
```

**extract.test.ts** — 在 `describe("runExtract", ...)` 块末尾新增（直接使用已有的 `runHeadlessAgentMock`，注意 `runExtract` 是 fire-and-forget，不需要 `await`）：

```ts
	it("passes sessionPersistence through to runHeadlessAgent", () => {
		runHeadlessAgentMock.mockClear();
		runExtract({
			thinkLevel: "high",
			memoryDir: "/mem/x",
			messages: [{ role: "user", content: "hi" }],
			maxContextTokens: 1000,
			modelRegistry: {} as any,
			sessionPersistence: { enabled: true },
		});
		expect(runHeadlessAgentMock).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionPersistence: { enabled: true },
			}),
		);
	});
```

- [ ] **Step 2: 运行测试，确认失败（RED）**

```bash
cd /home/yandy/workspace/pri/pi-packages/pi-memory && npx vitest run tests/dream.test.ts tests/extract.test.ts 2>&1 | tail -20
```

Expected: 新测试 FAIL——TypeScript 编译报错，`RunDreamOpts` / `RunExtractOpts` 尚无 `sessionPersistence` 字段。

- [ ] **Step 3: 实现 dream.ts / extract.ts / inject.ts 透传 + index.ts 连线（GREEN）**

**dream.ts** — `RunDreamOpts` 新增字段 + 透传：

```ts
import type { SessionPersistenceConfig } from "./config";

export interface RunDreamOpts {
	model?: string;
	thinkLevel: ThinkLevel;
	memoryDir: string;
	modelRegistry: ModelRegistry;
	parentModel?: Model<any>;
	sessionPersistence?: SessionPersistenceConfig;
}
```

在 `runHeadlessAgent` 调用中添加 `sessionPersistence: opts.sessionPersistence`。

**extract.ts** — 同上：

```ts
import type { SessionPersistenceConfig } from "./config";

export interface RunExtractOpts {
	model?: string;
	thinkLevel: ThinkLevel;
	memoryDir: string;
	messages: Array<{ role: string; content: string }>;
	maxContextTokens: number;
	modelRegistry: ModelRegistry;
	parentModel?: Model<any>;
	sessionPersistence?: SessionPersistenceConfig;
}
```

在 `runHeadlessAgent` 调用中添加 `sessionPersistence: opts.sessionPersistence`。

**inject.ts** — `runSideQuery` 末尾加参数并透传：

```ts
export async function runSideQuery(
	manifest: TopicManifest[],
	userPrompt: string,
	injectedTopics: Set<string>,
	maxFiles: number,
	thinkLevel: ThinkLevel,
	model: string | undefined,
	modelRegistry: ModelRegistry,
	parentModel: Model<any> | undefined,
	memoryDir: string,
	sessionPersistence?: import("./config").SessionPersistenceConfig,
): Promise<string[]> {
	// ...
		const result = await runHeadlessAgent({
			task,
			cwd: memoryDir,
			modelRegistry,
			model,
			parentModel,
			thinkLevel,
			maxTurns: 1,
			timeoutMs: 30_000,
			sessionPersistence,
		});
```

**index.ts** — 在 `export default` 之前添加 resolve 函数：

```ts
import type { MemoryConfig, SessionPersistenceConfig } from "./src/config";

function resolveDefault<K extends "model" | "sessionPersistence">(
	cfg: MemoryConfig,
	task: "dream" | "autoSurfacing" | "extractMemories",
	key: K,
): K extends "model" ? string | undefined : SessionPersistenceConfig | undefined {
	const perTask = cfg[task][key];
	if (perTask !== undefined) return perTask as any;
	return cfg.defaults?.[key] as any;
}
```

然后替换三个 call site：

1. **dream**（session_start handler 和 registerCommand handler）：`model` 改用 `resolveDefault(config, "dream", "model")`，添加 `sessionPersistence: resolveDefault(config, "dream", "sessionPersistence")`
2. **extractMemories**（agent_end handler）：`model` 改用 `resolveDefault(config, "extractMemories", "model")`，添加 `sessionPersistence: resolveDefault(config, "extractMemories", "sessionPersistence")`
3. **sideQuery**（before_agent_start handler）：`autoSurfacing.model` 改用 `resolveDefault(config, "autoSurfacing", "model")`，添加最后一个参数 `resolveDefault(config, "autoSurfacing", "sessionPersistence")`

- [ ] **Step 4: 运行测试，确认通过（GREEN）**

```bash
cd /home/yandy/workspace/pri/pi-packages/pi-memory && npx vitest run
```

Expected: 所有测试 PASS。

- [ ] **Step 5: Commit**

```bash
cd /home/yandy/workspace/pri/pi-packages && git add pi-memory/src/dream.ts pi-memory/src/extract.ts pi-memory/src/inject.ts pi-memory/index.ts pi-memory/tests/dream.test.ts pi-memory/tests/extract.test.ts && git commit -m "feat(pi-memory): wire defaults + sessionPersistence through all call sites"
```

---

### Task 4: 全局回归

- [ ] **Step 1: 运行全部测试**

```bash
cd /home/yandy/workspace/pri/pi-packages/pi-memory && npx vitest run
```

Expected: 所有测试 PASS。

- [ ] **Step 2: TypeScript 编译检查**

```bash
cd /home/yandy/workspace/pri/pi-packages/pi-memory && npx tsc --noEmit 2>&1
```

Expected: no errors。
