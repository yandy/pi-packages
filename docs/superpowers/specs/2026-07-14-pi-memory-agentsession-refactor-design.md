# pi-memory: 从 pi-subagents 迁移到 AgentSession API

> **Goal:** 移除 `pi-memory` 对 `@yandy0725/pi-subagents` 的依赖，改为直接使用 `@earendil-works/pi-coding-agent` 的 AgentSession API 实现 dream / extract / side-query 三个子任务。

**Status:** 已确认 — 等待实现

---

## 1. Motivation

`pi-memory` 当前通过 `pi-subagents` 的 `SubagentsService.spawn()` API 执行三个子任务：

- **dream**: 记忆合并（多轮文件操作）
- **extract**: 从对话中提取记忆（fire-and-forget）
- **side-query**: 根据用户问题选出相关的 topic 文件（同步返回值）

`pi-memory` 仅使用了 pi-subagents 的 `spawn` / `registerWorkspaceProvider` / 事件监听 / `getRecord` / `abort`，这些功能在 AgentSession API 中都有等价对应，无需引入额外依赖。迁移后：

- 减少一个 peerDependency
- 删除 `agent-types.ts`（不再需要注册自定义 agent type）
- 统一 dream/extract/side-query 的实现模式
- 用 `runMemoryTask` 封装 session 创建 + 保护运行 + 清理

## 2. Architecture

### 2.1 依赖变化

```diff
package.json peerDependencies:
- "@yandy0725/pi-subagents": "*"
+ // 无需新增 — @earendil-works/pi-coding-agent 已是 peerDependency
+ // @earendil-works/pi-ai 已是 peerDependency
```

### 2.2 `runMemoryTask` — 统一的子任务执行器

`src/run-task.ts` 提供单一入口，封装 session 创建 + 保护运行 + 清理：

```
runMemoryTask(opts)
  ├─ createTaskSession(opts)          // 最小化 AgentSession
  │    ├─ createAgentSessionServices  // 无 extensions/skills/prompts/themes/context-files
  │    └─ createAgentSessionFromServices
  └─ runProtected(opts)               // maxTurns + timeout 保护
       ├─ session.subscribe(agent_end) + 计数 → maxTurns 时 abort
       ├─ setTimeout → timeout 时 abort
       ├─ await session.prompt(task)  // 等待 agent 完成
       └─ finally: session.dispose()
```

### 2.3 Model 处理

```
config.dream.model = "" | "provider/modelId"
        │
        ▼
runMemoryTask({ model: config.dream.model })
        │
        ▼
createTaskSession({ model: opts.model })
        │
        ├─ falsy ("" / undefined) → getModel(undefined) = undefined → AgentSession 用默认
        └─ truthy ("deepseek/...") → getModel("deepseek/...") → Model 对象
```

所有三个任务使用相同的 model 处理逻辑，不再有 `=== "auto"` 判断。

### 2.4 各任务参数

| 任务 | 工具 | maxTurns | timeoutMs | 模式 |
|------|------|----------|-----------|------|
| dream | read, write, edit, ls | 50 | 600_000 (10min) | fire-and-forget |
| extract | read, write, edit | 5 | 120_000 (2min) | fire-and-forget |
| side-query | 无 (noTools: "all") | 1 | 30_000 (30s) | await 结果 |

## 3. File Changes

### 3.1 新增文件

**`src/run-task.ts`** — 共享的子任务执行器

- `createTaskSession(opts)` — 创建最小化 AgentSession（无 extensions/skills/prompts/themes/context-files）
- `runProtected(opts)` — maxTurns + timeout 保护 + session.dispose
- `runMemoryTask(opts)` — 组合上述两个，session 从创建到销毁全部封装

### 3.2 修改文件

**`src/config.ts`**

- `DEFAULT_CONFIG` 中的 model 默认值从 `"auto"` 改为 `""`（falsy = 用默认）

**`src/dream.ts`**

- `runDream()`: 重写，调用 `runMemoryTask`
- `RunDreamOpts`: 移除 `events`、`service`、`signal`；新增 `onComplete?`、`onError?`、`timeoutMs?`
- `model` 类型改为 `string | undefined`

**`src/extract.ts`**

- `runExtract()`: 重写，调用 `runMemoryTask`
- `RunExtractOpts`: 移除 `service`

**`src/inject.ts`**

- `runSideQuery()`: 重写，调用 `runMemoryTask` + await 结果
- 移除 `getSubagentsService` 导入
- 新增 `model` 参数
- 移除 `events` 参数
- cwd 改为 `memoryDir`（保持统一）

**`index.ts`**

- 移除 `ensureAgentTypes()` 导入和调用（line ~16）
- nudge flow: 移除 `setTimeout(..., 0)`，直接调用 `runDream`（fire-and-forget）
- `/dream` 命令: fire-and-forget `runDream`，立即 `writeDreamMeta`
- `runSideQuery` 调用处: 传入 `autoSurfacing.model`
- subagent 检测逻辑保留（防止 pi-subagents 子agent 递归）

**`package.json`**

- 移除 `@yandy0725/pi-subagents` peerDependency

### 3.3 删除文件

**`src/agent-types.ts`** — 不再需要注册自定义 agent type

### 3.4 测试变化

| 文件 | 变化 |
|------|------|
| `tests/dream.test.ts` | mock `runMemoryTask` 替代 mock pi-subagents service |
| `tests/extract.test.ts` | 同上 |
| `tests/inject.test.ts` | 移除 `vi.mock("@yandy0725/pi-subagents")`；mock `runMemoryTask` |

---

## 4. Protection Mechanism

### maxTurns

```typescript
let turns = 0;
const unsub = session.subscribe((event) => {
  if (event.type === "agent_end" && ++turns >= maxTurns) {
    session.abort();
    finish(`Reached max turns (${maxTurns})`);
  }
});
```

### timeout

```typescript
const timeout = setTimeout(() => {
  session.abort();
  finish(`Timed out after ${timeoutMs}ms`);
}, timeoutMs);
```

### 双重触发保护

`finish()` 内部用 `settled` flag 防止 timeout 和 maxTurns 同时触发时重复调用 `dispose()`。

## 5. Nudge Flow 简化

**旧实现**（需要 setTimeout 延迟到 session_start handler 全部执行完）：

```typescript
setTimeout(async () => {
  const summary = await runDream({ ... });
  await writeDreamMeta(memoryDir, sessions);
  ctx.ui.notify(summary, "info");
}, 0);
```

**新实现**（fire-and-forget，立即写 meta）：

```typescript
runDream({
  model: config.dream.model,
  thinkLevel: config.dream.thinkLevel,
  memoryDir,
  onComplete: (summary) => ctx.ui.notify(summary, "info"),
  onError: (err) => ctx.ui.notify(`Dream failed: ${err}`, "error"),
});
await writeDreamMeta(memoryDir, sessions);
```
