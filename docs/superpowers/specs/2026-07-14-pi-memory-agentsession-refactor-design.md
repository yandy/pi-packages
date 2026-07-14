# pi-memory — 从 pi-subagents 迁移到 AgentSession API

> **目标：** pi-memory 移除对 `@yandy0725/pi-subagents` 的依赖，改为直接调用 pi 的 `createAgentSession` API 运行无头 memory-agent 子会话。

> 历史背景：pi-memory v2 曾直接手动组装 `createAgentSession`（见 `2026-07-12-dream-subagents-refactor-design.md`），后重构为 pi-subagents 的 `SubagentsService`。本次"走回去"，但从 v2 的手动组装升级为更干净的无头会话方案。

**Status:** Draft — 待用户审阅

---

## 1. 动机

pi-memory 当前通过 pi-subagents 的 `getSubagentsService()` + `SubagentsService` 契约 + `WorkspaceProvider` + `pi.events` 事件总线间接运行子代理。这层间接耦合带来：

- **泄漏**：`extract.ts` 注册 `WorkspaceProvider` 后丢弃 disposer（资源泄漏）
- **单例冲突**：`WorkspaceProvider` 全局唯一，dream 与 extract 并发时第二个注册抛 "already registered"
- **递归检测脆弱**：依赖 `!selectedTools.includes("subagent")`（pi-subagents 特有约定）识别子代理
- **文件系统约定**：`memory-agent.md` 依赖 pi-subagents 的 `AgentTypeRegistry` 发现

而 pi 的 `ExtensionContext`（hook 的 `ctx`）已直接暴露 `cwd` / `modelRegistry` / `model` / `getSystemPrompt()` / `sessionManager`，**正是创建子会话所需的全部输入**。直接用 `createAgentSession` 可一次性消除上述所有问题。

---

## 2. 关键技术发现

1. **`createAgentSession()` 不会自动 `bindExtensions()`** — 它返回 `{ session, extensionsResult }` 但不绑定扩展到运行时。若不调用 `bindExtensions`，扩展钩子不在子会话触发。

2. **更彻底**：用 `DefaultResourceLoader({ noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true })`，扩展/skill/AGENTS.md 等根本不加载，递归预防从"不 bind"升级为"根本不加载"。

3. **内置工具不依赖扩展**：`read`/`write`/`edit`/`ls` 是 SDK 工具，通过 `createAgentSession` 的 `tools` 选项启用，`noExtensions` 不影响。

4. **AgentSession 自己触发 `before_agent_start`**：无头子会话用 `noExtensions` 创建，pi-memory 扩展不在子会话中，所以不会触发 `before_agent_start` → 不会再次 `runSideQuery` → 递归路径从根源切断。

5. **`ExtensionContext` 跨异步有效**：`ctx.ui` 绑定到会话（非 handler），会话存活期间 `ctx.ui.notify/setStatus` 可用。当前 `session_start` nudge 的 `setTimeout` 已在异步用捕获的 `ctx.ui`。

---

## 3. 架构

### 3.1 文件变更总览

```
pi-memory/src/
  ├── agent-runner.ts    【新增】runHeadlessAgent()：创建纯净内存中子会话 → prompt → 收集响应 → dispose
  ├── model-resolver.ts  【新增】模型字符串→Model 实例解析（精确+模糊匹配，~50行）
  ├── extract.ts         【改写】runExtract → runHeadlessAgent（fire-and-forget）
  ├── dream.ts           【改写】runDream → runHeadlessAgent（fire-and-forget）
  ├── inject.ts          【改写】runSideQuery → runHeadlessAgent（await + 超时返回 []）
  ├── agent-types.ts     【删除】不再写 memory-agent.md
  ├── config.ts          【改】三处 model 从 `string` 改为 `string | undefined`，去掉 "auto" 默认值
  └── ...其他不变

pi-memory/index.ts       【改写】删除 ensureAgentTypes()、isSubagent 检测改用 `<active_agent>`、传 ctx.modelRegistry/model、去 setTimeout(0)
pi-memory/package.json   【改】peerDependencies 移除 @yandy0725/pi-subagents
```

### 3.2 核心模块：`agent-runner.ts`

```typescript
interface HeadlessAgentOpts {
  task: string;           // 任务提示（新会话无父上下文，task 即全部指令）
  cwd: string;            // 子会话工作目录
  modelRegistry: ModelRegistry; // 来自父 ctx，复用凭证
  model?: string;         // config 原始值；undefined → 继承 parentModel
  parentModel?: Model;    // 父会话当前模型（继承用）
  thinkLevel?: ThinkingLevel; // config 已含默认值，直接传入
  maxTurns?: number;      // 软限制（steer 收尾）；undefined = 无限
  timeoutMs?: number;     // 超时

// → Promise<最终 assistant 响应文本>
async function runHeadlessAgent(opts: HeadlessAgentOpts): Promise<string> {
  // 1. Model 解析
  //    !opts.model → parentModel（未配置即继承）
  //    否则 resolveModel(opts.model, registry)（模糊解析）；解析失败 → parentModel 兜底
  //    ※ 不再有 "auto" 概念；thinkLevel 由调用方传入（config 已含默认值），runner 不做默认

  // 2. 构造纯净资源加载器
  //    const loader = new DefaultResourceLoader({
  //      cwd, agentDir: getAgentDir(), settingsManager,
  //      noExtensions: true, noSkills: true, noContextFiles: true,
  //      noPromptTemplates: true, noThemes: true,
  //    });
  //    await loader.reload();
  //    ※ 不加载任何扩展/skill/AGENTS.md/prompt模板/主题

  // 3. 创建 AgentSession
  //    const { session } = await createAgentSession({
  //      cwd,
  //      tools: ["read", "write", "edit", "ls"],
  //      model: resolvedModel,
  //      thinkingLevel: opts.thinkLevel,
  //      modelRegistry,
  //      sessionManager: SessionManager.inMemory(cwd),
  //      settingsManager: SettingsManager.inMemory(),
  //      resourceLoader: loader,
  //    });

  // 4. 响应收集 + turn 计数
  //    - message_start → 重置文本缓冲
  //    - message_update && assistantMessageEvent.type === "text_delta" → 累积 .delta
  //    - agent_end / turn_end → turn++；达 maxTurns → session.steer("收尾")；达 maxTurns+3 → session.abort()
  //    ※ 软限制 + 硬限制，给 agent 收尾机会

  // 5. await (timeoutMs ? Promise.race([session.prompt(task), timeoutReject]) : session.prompt(task))

  // 6. return 收集的响应文本

  // 7. finally: session.dispose() — 无论成功/失败/超时都清理
}
```

设计要点：

- **model/thinkLevel 解析统一**：model 解析集中在 runner 内 — 未配置（undefined）→ 继承 parentModel；配置了具体值 → 模糊解析（失败兜底 parentModel）。三调用点只传 config 原始值。thinkLevel 由 config 已含默认值直接传入（runner 不做默认）。
- **纯净会话**：`noExtensions/noSkills/noContextFiles/...` 确保子会话不加载任何外部资源，递归预防靠"根本不加载"而非"加载但不 bind"。
- **内存中**：`SessionManager.inMemory` + `SettingsManager.inMemory`，无磁盘碎片，资源即用即弃。
- **复用父 modelRegistry**：API key 解析与父会话一致。
- **统一 dispose**：`finally` 块保证清理，修复当前 extract 的 disposer 泄漏。
- **软+硬 maxTurns**：达 maxTurns 先 `steer("收尾")` 给 agent 一个 turn 做总结；达 maxTurns+3 时 `abort()` 硬终止。

### 3.3 `model-resolver.ts`

复刻 pi-subagents 的 `resolveModel`（~50 行）：

- 精确匹配 `"provider/modelId"`（仅限已配置 auth 的可用模型）
- 模糊匹配（id/name 包含查询串，打分选最佳，阈值 ≥20）
- 失败返回 `undefined`（runner 用 parentModel 兜底，不抛错 — fire-and-forget 友好）

**统一语义**：`agent-runner` 内部 `!opts.model ? parentModel : resolveModel(opts.model, registry) ?? parentModel`。三调用点只传 config 原始 `model`（可能为 undefined）+ `parentModel`，解析逻辑不重复、一致。**不再有 "auto" 配置值**（见 4.6）。

### 3.4 TOOLS 常量

```typescript
const MEMORY_AGENT_TOOLS = ["read", "write", "edit", "ls"] as const;
```

所有三个任务使用统一工具集。不再需要 `memory-agent.md` 文件约定。

---

## 4. 三个调用点的改写

### 4.1 Session 环境对比（统一后）

| 维度 | extract | dream | sideQuery |
|------|---------|-------|-----------|
| tools | read, write, edit, ls | read, write, edit, ls | read, write, edit, ls |
| cwd | memoryDir | memoryDir | memoryDir |
| model | config（未配置 = 继承父） | config（未配置 = 继承父）| config（未配置 = 继承父）|
| thinkLevel | config（默认 high）| config（默认 high）| config（默认 off）|
| maxTurns | 5 | ∞ | 1 |
| 等待方式 | fire-and-forget | fire-and-forget | await + 超时 |
| 超时/失败处理 | 静默 catch | notify 错误 | 返回 [] |

### 4.2 extract.ts（fire-and-forget）

```typescript
export async function runExtract(opts: RunExtractOpts): Promise<void> {
  if (opts.messages.length === 0) return;
  const task = buildExtractTask(opts.memoryDir, opts.messages, opts.maxContextTokens);
  // fire-and-forget：不 await，runner 内部统一解析 model + finally dispose
  runHeadlessAgent({
    task,
    cwd: opts.memoryDir,
    modelRegistry: opts.modelRegistry,
    model: opts.model,
    parentModel: opts.parentModel,
    thinkLevel: opts.thinkLevel,
    maxTurns: 5,
  }).catch(() => { /* 静默，当前行为保留 */ });
}
```

删除：`getSubagentsService` / `WorkspaceProvider` / `registerWorkspaceProvider`。新增依赖：`modelRegistry`、`parentModel`（从 index.ts 的 ctx 传入）。model 传 config 原始值（具体模型或 undefined），解析由 runner 统一处理。

### 4.3 dream.ts（fire-and-forget）

```typescript
export async function runDream(opts: RunDreamOpts): Promise<void> {
  const task = buildDreamTask(opts.memoryDir, 200);
  // 返回 Promise，调用方挂 .then/.catch 处理通知
  return runHeadlessAgent({
    task,
    cwd: opts.memoryDir,
    modelRegistry: opts.modelRegistry,
    model: opts.model,
    parentModel: opts.parentModel,
    thinkLevel: opts.thinkLevel,
    maxTurns: undefined, // 无限（软限制 50，硬限制 53）
  });
}
```

- 删除：`signal`、`events`、`WorkspaceProvider`、事件订阅、`getRecord` 逻辑
- 仍返回 Promise：调用方拿到后挂 `.then/.catch` 处理通知（见 4.5）
- 不暴露 abort（fire-and-forget，如需取消可后续加句柄）

### 4.4 inject.ts / runSideQuery（await + 超时返回 []）

```typescript
export async function runSideQuery(
  prompt: string,
  manifest: TopicManifest[],
  maxFiles: number,
  thinkLevel: ThinkLevel,
  model: string | undefined,
  modelRegistry: ModelRegistry,
  parentModel: Model | undefined,
  memoryDir: string,
): Promise<string[]> {
  const candidates = manifest.filter(t =>
    !prompt.includes(`[already injected] ${t.filename}`)
  );
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
    return parseSelectedFiles(result, candidates, maxFiles); // 正则解析 JSON
  } catch {
    return []; // 超时/失败均返回空 list，不降级
  }
}
```

- 删除：`keywordMatch`（无降级）、`foreground/bypassQueue`（无队列概念）、`getSubagentsService`、事件订阅
- 超时/失败 → `[]`（不注入任何 memory，可接受）
- **model/thinkLevel 与其他两点一致**：model 传 `config.autoSurfacing.model`（未配置 = 继承父模型，解析由 runner 统一）；thinkLevel 传 `config.autoSurfacing.thinkLevel`（默认 `off`）
- **cwd 改为 memoryDir**：sideQuery 只读 manifest（已在 prompt 里）不操作文件，但用 memoryDir 作 cwd 更安全——万一 agent 误写，限制在 memory 目录内

### 4.5 index.ts 改写

- 删除 `ensureAgentTypes()` 调用和 import
- **`before_agent_start`**：
  - `isSubagent` 检测改为 `event.systemPrompt.includes("<active_agent")`（pi-subagents 在所有子 agent 系统提示中注入 `<active_agent name="..."/>` 标签。比 `parentSession` 更精确：fork session 也有 parentSession 会造成误判）
  - 传 `ctx.modelRegistry` + `ctx.model` + `config.autoSurfacing.model` + `config.autoSurfacing.thinkLevel` + `memoryDir` 给 `runSideQuery`
- **`agent_end`**：传 `ctx.modelRegistry` + `ctx.model` 给 `runExtract`（fire-and-forget 不阻塞）
- **`session_start` nudge dream**：去掉 `setTimeout(0)`（不再需等 pi-subagents 的 session_start），直接 fire-and-forget：

```typescript
ctx.ui.setStatus("dream", "Consolidating memory...");
runDream({
  model: config.dream.model,
  thinkLevel: config.dream.thinkLevel,
  memoryDir,
  modelRegistry: ctx.modelRegistry,
  parentModel: ctx.model,
})
  .then(async (summary) => {
    await writeDreamMeta(memoryDir, sessions);
    ctx.ui.notify(summary, "info");
  })
  .catch((e) => ctx.ui.notify(`Dream failed: ${e.message}`, "error"))
  .finally(() => ctx.ui.setStatus("dream", undefined));
```

- **`/dream` 命令**：同样 fire-and-forget（命令立即返回，后台完成通知）：

```typescript
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
  .catch((e) => ctx.ui.notify(`Dream failed: ${e.message}`, "error"))
  .finally(() => ctx.ui.setStatus("dream", undefined));
```

- 删除 `pi.events` 传递（不再用事件总线）

### 4.6 config.ts 改动

**去掉 `"auto"` 配置值** — `"auto"` 与"未配置"语义重复（都是继承 parent session），无存在意义。改动：

1. **类型**：三个 config 接口的 `model: string` → `model?: string`（可选）
   - `dream.model?`、`extractMemories.model?`、`autoSurfacing.model?`
2. **默认值**：`DEFAULT_CONFIG` 中三处 `model: "auto"` → **删除**（即 `undefined`）
3. **thinkLevel 不变**：默认值已是 dream `"high"`、extract `"high"`、autoSurfacing `"off"`，符合要求

**不做向后兼容**：`"auto"` 本是默认值，用户无需显式写；显式写 `"auto"` 属配置错误，不归一化、不兜底（`resolveModel("auto")` 会走模糊匹配，由用户自行修正配置）。

**统一语义**：三调用点的 model/thinkLevel 处理一致 —
- **model**：读 config，未配置（undefined）→ 继承 parent session（解析逻辑集中在 `agent-runner`，调用点只传 config 原始值）
- **thinkLevel**：读 config（已含各自默认值 dream:high / extract:high / sidequery:off），直接传入 runner

---

## 5. 数据流

```
父会话 hook (ctx: ExtensionContext)
  ├─ ctx.modelRegistry, ctx.model ─────┐
  ├─ config (model/thinkLevel) ────────┤
  ├─ task (buildXxxTask) ──────────────┤
  └─ memoryDir ────────────────────────┤
                                       ▼
                              runHeadlessAgent(opts)
                                │
                                │  DefaultResourceLoader({ noExtensions, noSkills, ... })
                                │  + SessionManager.inMemory
                                │  + SettingsManager.inMemory
                                │  + createAgentSession({ tools, model, modelRegistry, resourceLoader })
                                │  + 不 bindExtensions
                                │
                                │  session.prompt(task)
                                │  subscribe: 流式收集文本 + turn 计数 + 软/硬 maxTurns
                                ▼
                              响应文本 → 调用方处理（notify / 解析 JSON / 丢弃）
                                │
                                finally: session.dispose()
```

---

## 6. 错误处理

| 调用方 | 成功 | 失败/超时 |
|--------|------|-----------|
| extract | 不处理（fire-and-forget）| 静默 `.catch(() => {})` |
| dream | `.then(summary => notify)` | `.catch(e => notify error)` |
| sideQuery | 解析 JSON 返回文件列表 | 返回 `[]` |

---

## 7. 测试策略

- **`agent-runner.test.ts`**（新增）：mock `createAgentSession`，验证 turn 循环、maxTurns 软/硬限制、响应收集、dispose 清理、abort、timeout、model 解析（未配置→继承、配置但失败→兜底）
- **`model-resolver.test.ts`**（新增）：精确/模糊匹配、失败兜底
- **`extract/dream/inject.test.ts`**：mock 目标从 `@yandy0725/pi-subagents` 改为 `./agent-runner`，验证传给 `runHeadlessAgent` 的参数（task、cwd、maxTurns、timeoutMs）；dream 验证 fire-and-forget（不 await）；inject 验证超时/失败返回 `[]`、删 keywordMatch 测试
- **`index-wiring.test.ts`**：删 `isSubagent` 测试；验证 `session_start` nudge 不再用 `setTimeout`；验证 `ctx.modelRegistry` 传递

---

## 8. 删除/移除清单

- `src/agent-types.ts`（整文件）
- `package.json` peerDependencies 的 `@yandy0725/pi-subagents`
- 所有 `import ... from "@yandy0725/pi-subagents"`
- `index.ts` 的 `isSubagent` 检测逻辑（改为 `event.systemPrompt.includes("<active_agent")`）
- `inject.ts` 的 `keywordMatch` 函数
- `dream.ts` 的 `signal` / `events` / 事件订阅逻辑
- `session_start` nudge 的 `setTimeout(callback, 0)`

---

## 9. 顺手修正的异味

1. ✅ extract 的 disposer 丢弃 → runner 统一 `finally dispose`
2. ✅ WorkspaceProvider 单例冲突 → 无 WorkspaceProvider 概念
3. ✅ isSubagent 检测依赖 "subagent" 工具 → 改为 `event.systemPrompt.includes("<active_agent")`
4. ✅ memory-agent.md 文件约定 → 内嵌 TOOLS 常量
5. ✅ sideQuery 的 foreground/bypassQueue → 无队列概念，自然简化
6. ✅ session_start 的 setTimeout(0)（为等 pi-subagents）→ 直接 fire-and-forget

---

## 10. 范围外（不做）

- 不改 pi-subagents 包（pi-permission-system 仍依赖它）
- 不改 pi-memory 对外功能（extract/dream/sideQuery 行为等价，仅机制替换）
- 不加并发限制（extract 仅 agent_end 触发，并发极低；sideQuery 串行；dream 罕见）
- dream 不支持 abort（fire-and-forget；如需可后续加句柄）
