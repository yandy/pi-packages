# Design: pi-memory Session 持久化 & defaults 共享配置

**Date:** 2026-07-14
**Status:** approved

## Summary

pi-memory 中 3 个 sub-task（dream / extractMemories / autoSurfacing side-query）都通过 `runHeadlessAgent()` 创建 `SessionManager.inMemory()` 的 session，不持久化到磁盘。需求是为其增加 session 持久化配置，同时引入 `defaults` 共享配置层，支持 `model`、`sessionPersistence` 的共用 + per-task 覆盖。

## Scope

### Files to modify

| File | Change |
|------|--------|
| `pi-memory/src/config.ts` | 新增 `SessionPersistenceConfig`、`DefaultsConfig`，扩展 `MemoryConfig`，更新 `DEFAULT_CONFIG` |
| `pi-memory/src/agent-runner.ts` | `HeadlessAgentOpts` 新增 `sessionPersistence` 参数，条件创建 `SessionManager.create` vs `inMemory` |
| `pi-memory/src/dream.ts` | `RunDreamOpts` 新增 `sessionPersistence`，透传到 `runHeadlessAgent` |
| `pi-memory/src/extract.ts` | `RunExtractOpts` 新增 `sessionPersistence`，透传到 `runHeadlessAgent` |
| `pi-memory/src/inject.ts` | `runSideQuery` 新增 `sessionPersistence` 参数，透传到 `runHeadlessAgent` |
| `pi-memory/index.ts` | 新增 resolve 函数，应用 defaults + per-task 覆盖，传 `sessionPersistence` 给各 task |
| `pi-memory/tests/config.test.ts` | 新增 defaults / sessionPersistence 相关测试 |
| `pi-memory/tests/agent-runner.test.ts` | 新增 persistence 模式测试 |

### 不涉及变更

- session 格式、session-search 逻辑
- `RunDreamOpts.thinkLevel`、`RunExtractOpts.thinkLevel` 等必填字段保持必填

## Design

### 1. Config Schema

```ts
interface SessionPersistenceConfig {
  enabled: boolean;
  sessionDir?: string; // 默认 memoryDir/sessions/
}

interface DefaultsConfig {
  model?: string;
  sessionPersistence?: SessionPersistenceConfig;
}

interface MemoryConfig {
  // ... existing fields unchanged ...
  defaults?: DefaultsConfig;
  dream: {
    nudgeAfterSessions: number;
    nudgeAfterHours: number;
    model?: string;
    thinkLevel: ThinkLevel;             // 必填，不参与继承
    sessionPersistence?: SessionPersistenceConfig;
  };
  autoSurfacing: {
    enabled: boolean;
    model?: string;
    thinkLevel: ThinkLevel;             // 必填，不参与继承
    maxFiles: number;
    maxTopicBytes: number;
    maxInjectionBytes: number;
    sessionPersistence?: SessionPersistenceConfig;
  };
  extractMemories: {
    enabled: boolean;
    model?: string;
    thinkLevel: ThinkLevel;             // 必填，不参与继承
    maxContextTokens: number;
    sessionPersistence?: SessionPersistenceConfig;
  };
}
```

### 2. Config Resolution

**Resolution 链（model / sessionPersistence）**：
```
user per-task → user defaults → DEFAULT_CONFIG 兜底
```

**thinkLevel**：不参与继承，直接取 per-task 配置。DEFAULT_CONFIG 中各 task 已有默认值。

**defaults 默认值**：
```ts
DEFAULT_CONFIG = {
  defaults: {
    model: undefined,
    sessionPersistence: undefined,
  },
  // ...
}
```

**sessionPersistence 兜底**：`{ enabled: false }`（即 in-memory）

### 3. agent-runner 变更

```ts
interface HeadlessAgentOpts {
  // ... existing fields ...
  sessionPersistence?: SessionPersistenceConfig;
}

// session 创建
const sessionManager = opts.sessionPersistence?.enabled
  ? SessionManager.create(
      opts.cwd,
      opts.sessionPersistence.sessionDir ?? join(opts.cwd, "sessions"),
    )
  : SessionManager.inMemory(opts.cwd);
```

Session 文件默认位于 `memoryDir/sessions/`，天然项目隔离（`memoryDir` 已含 project hash）。

### 4. Call Site (index.ts)

```ts
function resolveDefault<K extends "model" | "sessionPersistence">(
  cfg: MemoryConfig,
  task: "dream" | "autoSurfacing" | "extractMemories",
  key: K,
) {
  return cfg[task][key] ?? cfg.defaults?.[key];
}

// dream 调用
runDream({
  model: resolveDefault(cfg, "dream", "model"),
  thinkLevel: cfg.dream.thinkLevel,
  sessionPersistence: resolveDefault(cfg, "dream", "sessionPersistence"),
  // ...
});
// extractMemories / sideQuery 同理
```

### 5. 场景矩阵（sessionPersistence）

| 场景 | dream | autoSurfacing | extract |
|------|-------|---------------|---------|
| 不配任何值 | 不持久化 | 不持久化 | 不持久化 |
| `defaults: {enabled: true}` | 持久化到 memoryDir/sessions/ | 持久化 | 持久化 |
| `defaults: {enabled: true}` + `dream: {enabled: false}` | 不持久化 | 持久化 | 持久化 |
| 仅 `dream: {enabled: true, sessionDir: "/custom"}` | 持久化到 /custom | 不持久化 | 不持久化 |

### 6. 场景矩阵（model）

| 场景 | dream | autoSurfacing | extract |
|------|-------|---------------|---------|
| 不配任何值 | undefined → agent-runner 用 parentModel | 同左 | 同左 |
| `defaults.model: "deepseek/flash"` | "deepseek/flash" | 同左 | 同左 |
| `defaults: "deepseek/flash"` + `dream: "tencent/glm-5.2"` | "tencent/glm-5.2" | "deepseek/flash" | "deepseek/flash" |

### 7. 场景矩阵（thinkLevel）

不受 defaults 影响，per-task DEFAULT_CONFIG 值：

| task | 默认 thinkLevel |
|------|----------------|
| dream | `"high"` |
| autoSurfacing | `"off"` |
| extractMemories | `"high"` |

## Testing

- `config.test.ts`：defaults 合并逻辑、per-task 覆盖、向后兼容（defaults 缺失时行为不变）
- `agent-runner.test.ts`：sessionPersistence.enabled=true 时调用 `SessionManager.create`，false 时调用 `inMemory`
