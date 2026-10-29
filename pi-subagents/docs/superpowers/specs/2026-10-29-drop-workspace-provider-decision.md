# 删除 `WorkspaceProvider` 接缝 — 决策记录

日期：2026-10-29
状态：已实施（破坏性：公开 API `registerWorkspaceProvider` 移除，按 minor 发布）
相关：`2026-10-29-prompt-modes-design.md`（其约束 6 引用了本接缝）

## 决定

删除 pi-subagents 的生成式扩展接缝 `WorkspaceProvider`：

- `src/lifecycle/workspace.ts`（`WorkspaceProvider` / `Workspace` / `WorkspacePrepareContext` /
  `WorkspaceDisposeOutcome` / `WorkspaceDisposeResult`）
- `src/lifecycle/workspace-bracket.ts`（prepare/dispose 的配对持有者）
- `SubagentsService.registerWorkspaceProvider()` 及其在 adapter / manager 的实现
- `SubagentExecution.{baseCwd, getWorkspaceProvider}`、`SubagentManagerOptions.baseCwd`
- `CreateSubagentSessionParams.cwd`、`AssemblerOptions.cwd`
- 对应测试（`tests/lifecycle/workspace-bracket.test.ts` 及三处 describe）

现在子代理**永远**运行在父会话的 cwd：`effectiveCwd = snapshot.cwd`。

## 为什么

### 1. 零消费者

删除前全仓没有任何扩展注册它。唯一真实使用者是 pi-memory 的 dream，它用完第二天就改回
直接 `createAgentSession`（见 `pi-memory/docs/superpowers/specs/2026-07-13-pi-memory-direct-agentsession-design.md`），
理由写得很具体：

- 泄漏：`extract.ts` 注册后丢弃 disposer
- 单例冲突：dream 与 extract 并发时第二个注册抛 "already registered"
- 递归检测脆弱：靠 `!selectedTools.includes("subagent")` 识别子代理
- 文件系统约定耦合：`memory-agent.md` 依赖 `AgentTypeRegistry` 发现

而在"自己建会话"的场景里，dream 只需要传 `cwd: opts.memoryDir` —— 接缝是多余的一层。

### 2. 它的承诺超过它的能力

设计意图是"隔离执行环境"（git worktree / 容器 / tmpdir / 远程沙箱），但实际只能表达
一个 cwd：

- 单例，无法组合（worktree + 容器做不了），且没有 per-call opt-in
- 只给 cwd，给不了 env、挂载、网络、资源上限 —— 容器场景真正需要的东西一个都没有
- 全局生效：一旦注册，**包括 LLM 通过 `subagent` 工具发起**的所有 spawn 都被接管

### 3. `prepare()` 不受墙钟超时保护

`Subagent.run()` 先 `startTimeoutGuard()` 再 `await prepare()`，但超时只做
`abortController.abort()` —— 那时 session 还不存在，abort 没有监听者。

代码里确有一个补丁：`await createSubagentSession(...)` 之后检查 `_timedOut`，如果预算在会话
建好之前就耗尽，就 fail fast（`Timed out … before the session started`）。但它只覆盖
"`await` 最终返回、只是慢"的情况：**永久 pending 的 `prepare()` 永远不会被超时打断**，
整个 spawn 无限期挂住。

### 4. 未文档化

`README.md` / `README.zh.md` 从头到尾没提过这个公开的跨扩展 API。既没人能发现它，
也没人为它负责。

## 代价

放弃"让子代理在别处跑"这个能力。将来若真的需要：

- **不要再把它做成核心的参数或隐藏接缝**。需要的粒度（env / 挂载 / 网络 / 生命周期）远超
  一个 cwd，应该按当时的真实用例重新设计（例如 spawn 级 `isolation` 策略对象，
  或"调用方自建 session"）。
- 现有替代：调用方自己建 `AgentSession` 就是最直接的隔离方式 —— pi-memory 已经这么做了
  （`src/agent-runner.ts`：`noExtensions` + `noTools: "builtin"` + 自定义工具）。

## 验证

- `cd pi-subagents && npx vitest run` → 59 文件 / 900 用例通过（删除了接缝自身的 26 条用例，
  新增 4 条契约用例：没有 provider 注册接缝、cwd 只有父级一个来源）
- `npm run typecheck -w pi-subagents`、`npm run lint -w pi-subagents` → exit 0（29 条既有 warning）
- `grep -rn "WorkspaceProvider\|registerWorkspaceProvider\|workspaceBracket\|baseCwd" pi-subagents/src pi-subagents/tests`
  → 只命中新契约测试里那两条 `"registerWorkspaceProvider" in …` 断言（故意的反向守卫）
