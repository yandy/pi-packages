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

### Task 1: Config Schema — 新增类型和配置结构

**Files:**
- Modify: `pi-memory/src/config.ts`

**Interfaces:**
- Produces: `SessionPersistenceConfig`, `DefaultsConfig`, 更新后的 `MemoryConfig`, `DEFAULT_CONFIG`

- [ ] **Step 1: 在现有类型下方新增 `SessionPersistenceConfig` 和 `DefaultsConfig`**

在 `export type ThinkLevel = ...` 之后、`export interface AutoSurfacingConfig` 之前，插入：

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

- [ ] **Step 2: 在 MemoryConfig 中添加 defaults 和 per-task sessionPersistence**

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

注意：`autoSurfacing` 和 `extractMemories` 本身已有独立 interface（`AutoSurfacingConfig`、`ExtractMemoriesConfig`），这里用 `&` 交叉类型追加 `sessionPersistence` 字段，避免改动独立 interface 的对外导出。

- [ ] **Step 3: 更新 DEFAULT_CONFIG**

```ts
export const DEFAULT_CONFIG: MemoryConfig = {
	enabled: true,
	memoryDir: join(homedir(), CONFIG_DIR_NAME, "memory"),
	memIndexMaxLines: 200,
	memIndexMaxBytes: 25600,
	dream: {
		nudgeAfterSessions: 5,
		nudgeAfterHours: 24,
		thinkLevel: "high",
	},
	sessionSearch: { maxSessions: 10, maxMatches: 5 },
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
};
```

- [ ] **Step 4: 运行现有 config 测试确保无回归**

```bash
cd /home/yandy/workspace/pri/pi-packages/pi-memory && npx vitest run tests/config.test.ts
```

Expected: all 11 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/yandy/workspace/pri/pi-packages && git add pi-memory/src/config.ts && git commit -m "feat(pi-memory): add SessionPersistenceConfig, DefaultsConfig, extend MemoryConfig"
```

---

### Task 2: agent-runner — 条件创建 SessionManager

**Files:**
- Modify: `pi-memory/src/agent-runner.ts`
- Modify: `pi-memory/tests/agent-runner.test.ts`

**Interfaces:**
- Consumes: `SessionPersistenceConfig` from `./config`
- Produces: 更新后的 `HeadlessAgentOpts`（新增 `sessionPersistence` 字段）

- [ ] **Step 1: 修改 agent-runner.ts — 导入和接口**

在现有 import 中新增 `join`（需要它拼 session 路径）和 `SessionPersistenceConfig`：

```ts
import { join } from "node:path";
```

修改 `HeadlessAgentOpts`，新增 `sessionPersistence`：

```ts
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
	/** Session persistence config. When enabled, sessions are written to disk. */
	sessionPersistence?: import("./config").SessionPersistenceConfig;
}
```

- [ ] **Step 2: 修改 agent-runner.ts — session 创建逻辑**

将 step 4 中硬编码的 `SessionManager.inMemory(opts.cwd)` 改为条件创建：

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

同时更新 JSDoc：将 "in-memory" 改为更准确的描述：

```ts
/**
 * Run a headless memory-agent sub-session: create a session (in-memory by default,
 * persisted to disk when sessionPersistence.enabled is true), drive the turn loop,
 * collect the assistant response text, and dispose.
 *
 * Does NOT call bindExtensions — no extension hooks fire in the sub-session,
 * so pi-memory's own before_agent_start cannot recurse.
 */
```

- [ ] **Step 3: 运行现有 agent-runner 测试确保无回归**

```bash
cd /home/yandy/workspace/pri/pi-packages/pi-memory && npx vitest run tests/agent-runner.test.ts
```

Expected: all 6 tests PASS（现有测试不传 sessionPersistence，走 inMemory 分支）。

- [ ] **Step 4: 更新 agent-runner mock 并新增持久化测试**

在 `tests/agent-runner.test.ts` 的 `vi.mock` 中，给 `SessionManager` mock 新增 `create` 方法：

```ts
// 在 "SessionManager: { inMemory: vi.fn().mockReturnValue({ getSessionId: () => "s1" }) }," 后添加：
vi.mock("@earendil-works/pi-coding-agent", () => ({
	createAgentSession: mocks.createAgentSessionMock,
	DefaultResourceLoader: vi.fn().mockImplementation(() => ({
		reload: vi.fn().mockResolvedValue(undefined),
	})),
	SessionManager: {
		inMemory: vi.fn().mockReturnValue({ getSessionId: () => "s1" }),
		create: vi.fn().mockReturnValue({ getSessionId: () => "s2" }),
	},
	SettingsManager: { inMemory: vi.fn().mockReturnValue({}) },
	getAgentDir: vi.fn().mockReturnValue("/home/fake/.pi/agent"),
}));
```

新增测试用例（追加在 describe 块内末尾）：

```ts
	it("uses SessionManager.create when sessionPersistence.enabled is true", async () => {
		const { SessionManager } = await import("@earendil-works/pi-coding-agent");
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

		expect(SessionManager.create).toHaveBeenCalledWith("/mem", "/mem/sessions");
		expect(SessionManager.inMemory).not.toHaveBeenCalled();
	});

	it("uses custom sessionDir when sessionPersistence.sessionDir is set", async () => {
		const { SessionManager } = await import("@earendil-works/pi-coding-agent");
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

		expect(SessionManager.create).toHaveBeenCalledWith("/mem", "/custom/sessions");
	});
```

- [ ] **Step 5: 运行 agent-runner 测试**

```bash
cd /home/yandy/workspace/pri/pi-packages/pi-memory && npx vitest run tests/agent-runner.test.ts
```

Expected: 8 tests PASS（6 旧 + 2 新）。

- [ ] **Step 6: Commit**

```bash
cd /home/yandy/workspace/pri/pi-packages && git add pi-memory/src/agent-runner.ts pi-memory/tests/agent-runner.test.ts && git commit -m "feat(pi-memory): conditional session persistence in agent-runner"
```

---

### Task 3: task 接口层 — dream / extract / sideQuery 透传 sessionPersistence

**Files:**
- Modify: `pi-memory/src/dream.ts`
- Modify: `pi-memory/src/extract.ts`
- Modify: `pi-memory/src/inject.ts`

**Interfaces:**
- Consumes: `SessionPersistenceConfig` from `./config`
- Produces: 更新后的 `RunDreamOpts`, `RunExtractOpts`, `runSideQuery` 签名

- [ ] **Step 1: dream.ts — 新增 sessionPersistence 参数并透传**

在 `RunDreamOpts` 中添加字段：

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

在 `runHeadlessAgent` 调用中添加 `sessionPersistence`：

```ts
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
		timeoutMs: 600_000,
		sessionPersistence: opts.sessionPersistence,
	});
}
```

- [ ] **Step 2: extract.ts — 同上**

在 `RunExtractOpts` 中添加：

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

在 `runHeadlessAgent` 调用中添加：

```ts
	runHeadlessAgent({
		task,
		cwd: opts.memoryDir,
		modelRegistry: opts.modelRegistry,
		model: opts.model,
		parentModel: opts.parentModel,
		thinkLevel: opts.thinkLevel,
		maxTurns: 5,
		timeoutMs: 120_000,
		sessionPersistence: opts.sessionPersistence,
	}).catch(() => {
```

- [ ] **Step 3: inject.ts — runSideQuery 新增参数并透传**

在 `runSideQuery` 函数签名末尾加参数：

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
```

在 `runHeadlessAgent` 调用中添加：

```ts
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

- [ ] **Step 4: 运行现有测试确保无回归**

```bash
cd /home/yandy/workspace/pri/pi-packages/pi-memory && npx vitest run
```

Expected: 所有现有测试 PASS（新增参数为 optional，不影响现有调用）。

- [ ] **Step 5: Commit**

```bash
cd /home/yandy/workspace/pri/pi-packages && git add pi-memory/src/dream.ts pi-memory/src/extract.ts pi-memory/src/inject.ts && git commit -m "feat(pi-memory): thread sessionPersistence through dream/extract/sideQuery"
```

---

### Task 4: index.ts — resolve 函数 + call site 连线

**Files:**
- Modify: `pi-memory/index.ts`

**Interfaces:**
- Consumes: 各 task 的更新后接口（sessionPersistence 参数）
- Produces: 完整的 config resolution + call site 连线

- [ ] **Step 1: 在 index.ts 中添加 resolveDefault 工具函数**

在 `export default function (pi: ExtensionAPI) {` 之前添加：

```ts
import type { MemoryConfig, SessionPersistenceConfig } from "./src/config";

/** Resolve a per-task value: per-task override → defaults → undefined. */
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

- [ ] **Step 2: 替换 dream 调用点的 model 解析并添加 sessionPersistence**

找到 `session_start` handler 中的 dream 调用（约第 57-67 行），将：

```ts
					const dreamModel = config.dream.model;
					const dreamThinkLevel = config.dream.thinkLevel;
```

替换为：

```ts
					const dreamModel = resolveDefault(config, "dream", "model");
```

并在 `runDream` 调用中添加 `sessionPersistence`：

```ts
					runDream({
						model: dreamModel,
						thinkLevel: config.dream.thinkLevel,
						memoryDir: dir,
						modelRegistry: ctx.modelRegistry,
						parentModel: ctx.model,
						sessionPersistence: resolveDefault(config, "dream", "sessionPersistence"),
					})
```

同理更新 `registerCommand("dream", ...)` handler 中的 `runDream` 调用（约第 152-158 行）：

```ts
			runDream({
				model: resolveDefault(config, "dream", "model"),
				thinkLevel: config.dream.thinkLevel,
				memoryDir,
				modelRegistry: ctx.modelRegistry,
				parentModel: ctx.model,
				sessionPersistence: resolveDefault(config, "dream", "sessionPersistence"),
			})
```

- [ ] **Step 3: 替换 extractMemories 调用点**

在 `agent_end` handler 中（约第 106-120 行），将：

```ts
		runExtract({
			model: extractConfig.model,
			thinkLevel: extractConfig.thinkLevel,
			memoryDir,
			modelRegistry: ctx.modelRegistry,
			parentModel: ctx.model,
			messages: event.messages.map(...),
			maxContextTokens: extractConfig.maxContextTokens,
		}).catch(() => {
```

替换为：

```ts
		runExtract({
			model: resolveDefault(config, "extractMemories", "model"),
			thinkLevel: config.extractMemories.thinkLevel,
			memoryDir,
			modelRegistry: ctx.modelRegistry,
			parentModel: ctx.model,
			messages: event.messages.map(...),
			maxContextTokens: config.extractMemories.maxContextTokens,
			sessionPersistence: resolveDefault(config, "extractMemories", "sessionPersistence"),
		}).catch(() => {
```

- [ ] **Step 4: 替换 sideQuery 调用点**

在 `before_agent_start` handler 中（约第 94-107 行），`runSideQuery` 调用添加最后一个参数：

```ts
				const selected = await runSideQuery(
					manifest,
					event.prompt.slice(0, 4000),
					injectedTopics,
					autoSurfacing.maxFiles,
					autoSurfacing.thinkLevel,
					resolveDefault(config, "autoSurfacing", "model"),
					ctx.modelRegistry,
					ctx.model,
					memoryDir,
					resolveDefault(config, "autoSurfacing", "sessionPersistence"),
				);
```

- [ ] **Step 5: 运行全部测试**

```bash
cd /home/yandy/workspace/pri/pi-packages/pi-memory && npx vitest run
```

Expected: 所有测试 PASS。

- [ ] **Step 6: Commit**

```bash
cd /home/yandy/workspace/pri/pi-packages && git add pi-memory/index.ts && git commit -m "feat(pi-memory): wire defaults + sessionPersistence through call sites"
```

---

### Task 5: config.test.ts — 新增 defaults 和 sessionPersistence 测试

**Files:**
- Modify: `pi-memory/tests/config.test.ts`

**Interfaces:**
- Consumes: `loadConfig` from `../src/config`

- [ ] **Step 1: 新增测试 — defaults.sessionPersistence 传播到 per-task**

在 `describe("loadConfig", ...)` 末尾（最后一个 `it` 之后）新增：

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
		// defaults.sessionPersistence is inherited, per-task fields are undefined
		// (resolution happens at call site, not in loadConfig)
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

- [ ] **Step 2: 运行 config 测试**

```bash
cd /home/yandy/workspace/pri/pi-packages/pi-memory && npx vitest run tests/config.test.ts
```

Expected: 16 tests PASS（11 旧 + 5 新）。

- [ ] **Step 3: Commit**

```bash
cd /home/yandy/workspace/pri/pi-packages && git add pi-memory/tests/config.test.ts && git commit -m "test(pi-memory): add defaults + sessionPersistence config merge tests"
```

---

### Task 6: 全局回归 + clean up

- [ ] **Step 1: 运行全部测试**

```bash
cd /home/yandy/workspace/pri/pi-packages/pi-memory && npx vitest run
```

Expected: 所有测试 PASS。

- [ ] **Step 2: TypeScript 编译检查**

```bash
cd /home/yandy/workspace/pri/pi-packages/pi-memory && npx tsc --noEmit
```

Expected: no errors（如有 tsc 配置）。

- [ ] **Step 3: Commit（如有未提交变更）**

不单独提交，仅在整个实施无遗漏后确认所有变更已 commit。
