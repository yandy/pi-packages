# pi-subagents 提示词模式（prompt_mode）设计

日期：2026-10-29
状态：已批准，已实现（pi-subagents 0.8.0）

## 意图

`prompt_mode` 今天只决定"包装方式"，两种模式都把**父级渲染完的整段 system prompt** 当前缀
（`src/session/prompts.ts:44,64,71`）。结果是两种模式各有一套错：

- **replace**：本想做"独立规范"，却继承了父级的工具清单、由父级工具集推导的 guidelines、
  父级 cwd/date，以及被 `noContextFiles: true` 刻意屏蔽的项目上下文
  （`src/lifecycle/create-subagent-session.ts:183-185`）。
- **append**：用 `systemPromptOverride` 把整段 prompt 替换掉
  （`src/lifecycle/create-subagent-session.ts:184`），于是 harness 为**子代理自己的工具集**
  渲染的提示词被整体丢弃，代之以父级那份，产生四个可观测缺陷：工具清单与子代理实际
  工具不符、guidelines 由父级工具集推导、skills 索引重复（父级一份 + harness 追加的子代理
  一份，`dist/core/system-prompt.js:37-40`）、cwd/date 三处并存且 cwd 覆盖为 worktree 时矛盾。
  `noContextFiles: true` 想屏蔽的 AGENTS.md 又经 snapshot 原样回流。

目标：让两种模式各自名副其实——replace 是干净房间，append 是"由 harness 正确渲染 + 追加角色"。

## 非目标

- 不改 `inherit_context`（对话分叉）语义。
- 不改 `tools:` 白名单与递归守卫（移除 subagent 系列工具）。
- 不改 skills 注入行为（replace 仍由 harness 追加 skills 索引）。
- ~~不修 `README.zh.md` 已有的其它漂移~~（2026-10-29 修订：改为**修**。逐节核对后发现中文版因 #209 只改英文而缺 5 处：示例缺 `timeout: 300`、缺 `max_turns`/`timeout` 优先级段落、`subagent` 表缺 `timeout` 行、`/subagents:settings` 描述缺超时、`持久化设置` 整节缺表格与优先级段落。同时修正两语皆错的 `Explore` 模型行（`haiku` → `deepseek/deepseek-v4-flash`，不可用时回退父级）。EN+ZH 必须同步是本仓约定。）
- 不做任何 KV cache 优化；本次只是**移除**一个不成立的 cache 理由。

## 反目标

- 让"父级提示词"以任何形式出现在 replace 的 system prompt 里。
- 让子代理的提示词依赖父级的实时状态（工具集、cwd、项目上下文）而不可复现。
- 顺手扩大范围到 append 之外的其它 prompt 相关内容（例如 memory 注入、skills 选择）。

## 约束与既成事实

1. harness 会**在** `systemPromptOverride` **之后**追加 append 段、项目上下文文件、skills
   索引、date/cwd（`dist/core/system-prompt.js:9-46`），因此 replace 必须同时屏蔽
   `noContextFiles` 与 `appendSystemPromptOverride`。
2. `noContextFiles: true` 同时屏蔽全局 `agentDir/AGENTS.md` 与项目链
   （`dist/core/resource-loader.js:322-328`）。
3. `applyRecursionGuard` → `setActiveToolsByName` 会触发 `_rebuildSystemPrompt`
   （`dist/core/agent-session.js:550-563`），所以 harness 渲染发生在工具集确定之后，
   子代理拿到的是自己真实的工具清单。
4. `<active_agent name="..."/>` 是下游扩展的公共契约：pi-memory 扫描
   `event.systemPrompt` 判断是否子代理（`pi-memory/index.ts:369-372`），而该事件携带的是
   `_baseSystemPrompt`（`dist/core/agent-session.js:803`），即含 append 段的完整提示词。
   因此标签放进 append 段仍然可见。
5. 父级渲染产物里的工具清单/guidelines 是**位置相关、由工具集推导**的文本，无法用字符串
   后处理安全改写——只能在组装层解决。
6. **cwd 那时可以被改变，但不是工具参数。** `subagent` 工具从来就没有 `cwd` 参数；当时唯一的
   途径是另一个扩展注册 `WorkspaceProvider` 注入 `Workspace { cwd }`，最终成为
   `cfg.effectiveCwd`。"子代理在 worktree、父级在主干"因此曾经是**真实可发生**的组合——
   这正是本节要消除的多源 cwd。
   （2026-10-29 后续：该 provider 接缝随后被整体删除，见
   `2026-10-29-drop-workspace-provider-decision.md`。现在子代理永远跑在父级 cwd，
   多源 cwd 在结构上不再可能出现。）

## 方案

### A. 只文档化（不选）

保留父级前缀，README 说明 replace 只改包装。零风险，但把矛盾留给用户，且 append 的四个
缺陷继续存在。

### B. 两种模式都退到 genericBase（不选）

一致、可预测，但代价落在默认代理（`general-purpose`、内置 `Explore`）上：项目规则、语言
偏好全部消失，用户需在每个 `.md` 重申。属于静默回归——今天 append 子代理**已经**通过
snapshot 拿到这些规则。

### C. replace 干净房间 + append 交还 harness（已选）

- `replace`：system prompt 完全由 `<active_agent> + env + 正文` 组成，是 agent 配置的纯函数；
  **不再前置任何通用人格**——正文就是该 agent 的全部角色声明（空正文时才回落到一段不含
  角色、不含能力断言的中性提示词）。loader 传 `systemPromptOverride`、`noContextFiles: true`、
  `appendSystemPromptOverride: () => []`。
  （2026-10-29 修订：初版为 `genericBase + tag + env + 正文`，会使 replace 代理同时带有
  "You are a general-purpose coding agent" 与自身角色两个互相矛盾的断言，例如内置 `Explore`。
  经你拍板去掉前置人格。）
- `append`：**不**传 `systemPromptOverride`，由 harness 按子代理自身工具集渲染基础提示词
  （工具清单、guidelines、skills、AGENTS.md、SYSTEM.md/APPEND_SYSTEM.md、date/cwd），
  我们只通过 `appendSystemPromptOverride` 追加一段
  `bridge + <active_agent> + env + <agent_instructions>`；`noContextFiles: false`。

## 已由你拍板

- replace 采用方案 C 的干净房间形态（不使用父级提示词）。
- append 采用"交还 harness 渲染"，并且**允许** `SYSTEM.md` / `APPEND_SYSTEM.md` 生效。
- append 子代理**加载** `AGENTS.md`（项目 + 全局）。

## 我做的判断（请检查）

1. **replace 正文为空**时不报错：产出 `中性兜底提示词 + tag + env`，与 append 空正文
   "纯克隆"的对称行为一致。该兜底不声明任何角色或能力。
2. **删除 `ParentSnapshot.systemPrompt`** 与 `AssemblerContext.parentSystemPrompt`：两种模式
   都不再用父级提示词，保留它只会诱导回退。
3. **`SessionConfig.systemPrompt` 改名为 `promptMode` + `promptSection`**：append 下这段文本
   是"追加段"而非完整提示词，旧名会误导读调用方。
4. **envBlock 去掉 cwd，只保留 git branch/platform。** 两种模式下 harness 都会在提示词渲染
   `Current working directory: <会话 cwd>`（`dist/core/system-prompt.js:44-45`），envBlock
   再写一遍是重复；而"同源却写两遍"正是本次要消除的味道。分支与平台 harness 不渲染，
   保留。
5. **不改 `README.zh.md` 的其它漂移**，只同步本次新增的 `prompt_mode` 章节。
6. **行为破坏性**：既有 `prompt_mode: replace` 的 agent 会失去继承来的项目规则。按仓库
   发布约定走 minor 版本，破坏性变更写进 GitHub Release notes，不写进 README。

## 兼容与迁移
- `prompt_mode` 缺省或未知值仍为 `append`（`src/config/custom-agents.ts:66` 不变）。
- replace 用户若依赖过继承的项目指令/工具提示，需在自己 `.md` 里重申；README 明确写清
  "replace 不继承工具清单、工具指引、项目上下文与工作目录"。
- 无 schema/配置迁移，无数据迁移。

## 测试策略

- 单元：`buildReplacePrompt`（顺序、不含 bridge/wrapper、空正文、纯函数）、
  `buildAppendSection`（前置空行、bridge、wrapper 有无、env 内容）。- 组装：`assembleSessionConfig` 按 `promptMode` 路由到正确 builder，并透传 `promptMode`。
- 工厂：`createSubagentSession` 对 replace 传 override + `noContextFiles: true` + 空 append；
  对 append 不传 override + `noContextFiles: false` + 追加段在末尾（保留既有 base）。
- 快照：`buildParentSnapshot` 不再产出 `systemPrompt`。
- 回归：`<active_agent>` 在两种模式的最终提示词中都存在（用真实 `buildSystemPrompt`
  组合断言，覆盖"标签进入 harness 追加段后仍可见"这一契约）。
- 手工核验：pi-memory 的子代理判定依赖 `event.systemPrompt`，无需改动，但在 PR 描述中说明。

## 留给实现者

- 具体函数签名与文件划分（`prompts.ts` 两个 builder；`session-config.ts` 的路由与
  `SessionConfig` 形状；`create-subagent-session.ts` 的 loader 分支写法）。
- 测试文件的具体组织与命名。
- 任务拆分与提交粒度由实现计划给出。
