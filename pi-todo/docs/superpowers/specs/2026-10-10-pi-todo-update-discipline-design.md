# Design: pi-todo — 让 LLM 真正持续更新 todo（提示词 + 反馈闭环 + 状态可见性）

**Date:** 2026-10-10
**Status:** implemented（0.2.0，T1+T2+T3-B 合并发布，待合并后 release）

## Summary

用户实测反馈：**LLM 用 `todo action="set"` 建清单没问题，但之后总不记得 `update`**。

排查结论：这不是单一的「提示词写得不好」，而是三个因素叠加，其中**提示词只占次要地位**：

1. **提示词过软**——description 只讲「有哪些 action」，不讲「何时必须调用」；两条 guidelines 是软措辞，混在 `<rules>` 的 20+ 条 bullet 里。
2. **状态对模型不可见**（根因）——widget 只渲染给用户；`set` 之后 todo 列表只存在于一条 toolResult 里，随对话推进不断远离生成点，没有任何周期性复述；`update` 只回 `"OK"`，模型得不到闭环反馈。
3. **`update` 调用摩擦大**——id 是模型自编的 uuid，`update`/`blockedBy` 都要精确复现，抄错即 `Task not found`，失败一次模型就倾向于不再更新。

对应三层方案：**T1 提示词重写**、**T2 反馈闭环 + 降低 update 摩擦**、**T3 把状态周期性送回模型眼前**。建议按阶段分别发布，以便归因。

### 关键决策摘要

| 决策 | 结论 | 理由 |
|------|------|------|
| 病因定性 | 提示词弱 + 状态不可见 + update 摩擦大，三者叠加；**根因是状态不可见** | 证据见「背景事实」与「问题诊断」 |
| T1 提示词重写 | **采纳，必做** | 零风险、10 行改动，但单独做不足以解决遗忘 |
| T2.1 `update` 回显进度与下一个任务 | **采纳** | 把 `"OK"` 换成带状态的 ack，形成正反馈闭环 |
| T2.2 短 id + 宽松引用解析 | **采纳** | 消除 uuid 抄错；错误信息带候选列表，让模型一次自纠 |
| T3-B `before_agent_start` 注入快照（`display:false` 的 custom message） | **采纳，T3 首选** | 缓存友好（追加在新一轮尾部）、约 20 行、无 session 膨胀 |
| T3-A `tool_result` 尾追提醒（Claude Code 式） | **列为可选增强**，实测 B 不足再上 | 效果最强但有噪声、token 成本与 `structuredContent` 陷阱 |
| T3-C `turn_end` 追加 `custom_message` | **暂不采纳** | 每轮刷新但每轮往 session 写 entry，长 run 条目膨胀，影响 `/tree`、resume、compaction |
| T3-D 改 `systemPromptOptions.sections.todo` | **否决** | 每次 run 改 system prompt → 整条 prompt cache 前缀失效；刷新频率并不比 B 高 |
| 是否引入配置文件 | 仅当采纳 T3-A 时需要（提醒模式/频率） | B 无需配置；A 硬编码则噪声不可回退 |
| 兼容性 | 不破坏旧 session：`details.todos` 结构不变，`id` 仍可为任意字符串 | `reconstructTodos` 只依赖 `details.todos` |
| 版本 | `0.1.2 → 0.2.0`（T1+T2），T3 另起 minor | 0.x 用 minor 承载行为/schema 变化，与 pi-coding-tools 的约定一致 |

## 背景事实（决策依据，均已在 pi 1.1.0 核对）

### 提示词的落点与权重

- 工具级 `promptSnippet` → 系统提示 `<tools>` 一行；`promptGuidelines` → 按工具名收集进 `toolGuidelines`（`dist/core/agent-session.js:2844-2849`），再由 `buildRules` 拼成 `<rules>` 的 bullet（`dist/core/system-prompt.js:31-64`，第 61 行遍历 `promptGuidelines`）。
- `buildRules` 只对 **active**（`selectedTools` 且未 hidden）的工具注入 guidelines；todo 默认注册即激活，所以两条都会出现。
- bullet 去重按 trim 后的字符串（`system-prompt.js:33-40`）。
- 当前实际注入内容：
  - `<tools>`：`- todo: Track tasks with a todo list (set/update/list actions).`（`index.ts:58`）
  - `<rules>`：两条（`index.ts:59-62`），与 bash/edit/read/write/ast-grep/lsp/ask-user/memory 等包的 guidelines 混排，总量 20+ 条。
- 结论：注入通道是通的，**问题在文案本身没有触发条件与强制语气**。

### 模型看不到 todo 状态

- widget 走 `ctx.ui.setWidget(WIDGET_ID, lines)`（`index.ts:21`），`docs/tui.md:13` 明确其为「编辑器附近的持久内容」——**纯 UI，不进模型上下文**。
- `update` 的返回文本是常量 `"OK"`（`index.ts:143`）；只有 `set`/`list` 才回 `listTodos(todos)`。
- 状态持久化靠 toolResult `details.todos` + `session_start`/`session_tree` 重建（`src/todo-store.ts:115-127`）。这对**分支安全**是正确的，但它只服务重建，不会主动回到模型眼前。

### update 的摩擦点

- `setTodos` 原样接受 items、**不生成 id**（`src/todo-store.ts:56-60`）；schema 里 `items[].id` 是必填 `Type.String()`（`index.ts:38`），description 又把它描述成 uuid → 模型自编长随机串。
- `updateTodo` 精确匹配 id，未命中即 `Task not found: ${id}`（`src/todo-store.ts:73`），错误信息不含候选列表，模型只能再调一次 `list` 才能自纠。
- `blockedBy` 同样要引用这些 id（`validateDependencies`，`src/todo-store.ts:14-53`），抄错会连带 set 失败。

### 宿主可用的注入点（T3 的技术基础）

| 注入点 | 机制 | 已核对证据 |
|---|---|---|
| `before_agent_start` 返回 `{ message }` | 追加一条 `role:"custom"` 消息到本次 run 的消息列表，并持久化为 `custom_message` entry | `agent-session.js:1615-1624`（收集 `result.messages`）、`agent-session.js:1822`（`appendCustomMessageEntry`） |
| custom message 如何进 LLM | 投影为 **user 角色**消息；`display` 只影响 TUI 渲染，**不影响是否发给模型** | `dist/core/messages.js:89-95`（`case "custom"` → `role:"user"`）、`session-manager.js:179-183` |
| `tool_result` 返回 `{ content }` | 改写后的 content **写回 transcript 并持久化**（不是仅本次请求） | `agent-session.js:349-385`（`_afterToolCall`） |
| `tool_result` 的组合语义 | `details`/`isError`/`usage` 不返回即保留原值；**替换 content 而不返回 `structuredContent` 会删除 structuredContent** | `dist/core/extensions/runner.js:900-957`（912-915 行 delete）、`types.d.ts:1085-1096` 注释亦明示 |
| `turn_end` / `agent_before_settle` | 可链式追加 `custom`/`custom_message`/`context_edit`/`compaction` entry，`continue:true` 才触发下一次请求 | `types.d.ts:730-760`（`BoundaryResult`）、`agent-session.js:588`、`docs/extensions.md:117` |
| 注入 custom message 会否干扰模型路由 | 不会：虚拟模型路由的 `userTurn` 判定用 AgentMessage 的 `role === "user"`，`custom` 不算 | `agent-session.js:463-464` |

## 问题诊断

「建清单没问题、之后不更新」这个**具体现象**能被上述三点完整解释：

- `set` 发生在模型刚写完计划的那一刻，任务与意图在同一注意力窗口内，**不需要提醒**就会调用；
- `update` 需要在几十轮工具调用之间**自发想起**，而上下文中：
  - 没有任何一条消息复述当前 todo 状态（widget 模型看不到）；
  - 上一次 `update` 的回报只有 `"OK"`，没有「还剩几个 / 下一个是谁」的强化信号；
  - 系统提示里只有 `mark tasks in_progress/done as you complete them` 这种无触发条件、无强制语气的软措辞；
  - 调用本身还要求精确复现 uuid，失败成本高于收益。
- 对照 Claude Code 的 `TodoWrite`：它的描述里写死了 7 条使用场景 + `Mark tasks complete IMMEDIATELY after finishing (don't batch completions)` + `Exactly ONE task must be in_progress at any time`，并且宿主会在 tool result 后挂 `<system-reminder>` 复述 todo 状态。**pi-todo 缺的正是「强措辞 + 周期性复述」这两层。**

## T1：提示词重写（必做）

设计原则：**每条规则都带触发时机（when）+ 动作（then）**，用强制词（IMMEDIATELY / exactly one / never batch），并显式告知「状态不会自动回显给你」。

### `description` 草案

```
Track a task list for multi-step work.
Actions: "set" replaces the whole list with items (plan up front); "update" changes one task by id; "list" returns the current list.
Item fields: id (short, e.g. "1"), title, status (pending|in_progress|done), optional blockedBy (ids this task waits on).
Use it for any work needing 3+ distinct steps, a user-provided task list, or multi-file changes. Skip it for a single trivial task.
Update discipline (required):
- Mark a task in_progress BEFORE you start it. Exactly one task in_progress at a time.
- Mark it done IMMEDIATELY after it finishes. Never batch completions, never defer to the end of the run.
- After each tool batch, re-check the list: if a finished task is still pending/in_progress, update it now.
- Only mark done when fully achieved (tests pass, nothing left over); otherwise keep it in_progress.
- The list is NOT re-shown to you automatically. Call action "list" whenever you are unsure, and keep it current — the user watches a live widget driven by your updates.
```

### `promptGuidelines` 草案（落到 `<rules>`）

```ts
promptGuidelines: [
  'Use todo to plan multi-step work: action "set" lists all tasks up front.',
  'Before starting a task: todo update → in_progress. Exactly one in_progress at a time.',
  'Immediately after finishing a task: todo update → done. Never batch completions or defer them to the end.',
  'The todo state is not re-shown to you automatically; call todo action "list" when unsure and keep the list current.',
],
```

`promptSnippet` 可微调为：`Track a task list (set/update/list); keep statuses current.`

### 意图说明

| 文案 | 针对的失败模式 |
|---|---|
| `BEFORE you start it` / `Exactly one in_progress` | 可校验的硬约束，模型能自查；也避免「全部 pending 直到最后一次性刷 done」 |
| `IMMEDIATELY` / `Never batch` | 直接对齐 Claude Code 的措辞强度，压制「批量补记」倾向 |
| `After each tool batch, re-check` | 给出**周期性触发点**，弥补没有 reminder 的空档 |
| `NOT re-shown to you automatically` | 让模型知道 widget 是给用户的、自己必须主动 `list` |
| `the user watches a live widget` | 给出更新的**外部动机**（不只是自我记录） |

## T2：反馈闭环 + 降低 update 摩擦

### T2.1 `update` 返回进度 ack（替换 `"OK"`）

新增 `src/todo-store.ts` 导出：

```ts
/** update 成功后的单行 ack：进度 + 下一个可做任务，给模型闭环反馈。 */
export function formatAck(todos: TodoItem[], id: string): string;
```

输出规格：

| 情形 | 文本示例 |
|---|---|
| 常规 | `✓ #2 done (3/5) · next: #3 写测试` |
| 下一个被阻塞 | `✓ #1 done (1/5) · next: #3 写测试 (blocked by #2)` |
| 全部完成 | `✓ all 5 tasks done` |
| 标记 in_progress | `◉ #3 写测试 in_progress (2/5 done)` |

`index.ts:143` 改为：`params.action === "update" ? formatAck(todos, params.id) : listTodos(todos)`。渲染层（`renderResult` 的 update 分支）保持前缀 `✓` 即可，无需改动。

### T2.2 短 id + 宽松引用解析

- `setTodos`：`item.id` 缺失或空串 → 按位置分配 `"1".."n"`；显式 id 原样保留（**兼容旧 session 的 uuid**）。
- schema：`items[].id` 由必填改 `Type.Optional(Type.String())`；description 中把 id 说明为短 id，不再要求 uuid。
- 新增解析器：

```ts
/** 把模型给的引用解析成唯一任务。顺序：精确 id → 唯一前缀 → 1-based 序号 → 规范化 title 包含匹配。 */
export function resolveTodoRef(todos: TodoItem[], ref: string): { item?: TodoItem; candidates: TodoItem[] };
```

- `updateTodo` 改用 `resolveTodoRef`；未命中/歧义时错误信息**内联候选与完整列表**，例如：
  `Ambiguous ref "写": #2 写测试, #4 写文档\n当前列表：\n○ #1 … ✓ #2 …`
  → 模型无需额外 `list` 调用即可自纠（省一轮往返，也降低「失败后放弃更新」的概率）。
- `blockedBy` 的引用同样过 `resolveTodoRef`（在 `validateDependencies` 之前做一次归一化），避免依赖校验因 id 写法不一致而误报。

### T2.3 兼容与风险

- `details.todos` 结构完全不变 → `reconstructTodos`、widget、`renderResult` 全部不受影响。
- 自动短 id 在 `set` 全量替换时是稳定的（按位置），但**追加式修改列表会让 id 语义漂移**；因为 `set` 的语义本来就是「整表替换 + 重新规划」，可接受。文档需写明：改结构后请以最新 `set`/`update` 回显的 id 为准。
- 宽松匹配是「先精确、后模糊」，不会让原本正确的调用行为发生变化。

## T3：把状态周期性送回模型眼前

### T3-B（首选）：`before_agent_start` 注入快照

```ts
pi.on("before_agent_start", async () => {
  if (!hasOpenTodos(todos)) return undefined;
  return { message: { customType: "pi-todo", content: buildSnapshot(todos), display: false } };
});
```

`buildSnapshot` 输出（**必须**用 XML 标签包裹 + 第三人称，避免被当成用户指令）：

```
<todo-state>
2/5 done. in_progress: #3 写测试. pending: #4 修 CI, #5 更新文档.
Discipline: mark #3 done as soon as it passes, then set #4 in_progress. Never batch completions.
</todo-state>
```

成本与风险：

- 每个 user prompt 多一条 **user 角色**消息（`messages.js:89-95`）。措辞需明确这是状态回显而非用户请求；`<todo-state>` 标签 + 无祈使句指向用户，可降低误读。
- **一次 run 内不刷新**：长 run（几十轮工具调用）仍可能遗忘 → 这是保留 T3-A 的原因。
- `display:false` → 用户看不到，但 entry 会写进 session（`agent-session.js:1822`），resume/`/tree` 时存在；单条几十 token，可忽略。
- 缓存：追加在新一轮用户消息之后，**不动 system prompt，前缀缓存完好**。
- 与 `reconstructTodos` 无冲突：它只扫 `role==="toolResult" && toolName==="todo"`（`todo-store.ts:115-127`）。

### T3-A（可选增强）：`tool_result` 尾追提醒

```ts
let sinceTodoCall = 0;
pi.on("tool_result", async (event) => {
  if (event.toolName === "todo") { sinceTodoCall = 0; return undefined; }
  if (!hasOpenTodos(todos)) return undefined;
  if (++sinceTodoCall < REMIND_EVERY) return undefined; // 默认 4
  sinceTodoCall = 0;
  return {
    content: [...event.content, { type: "text", text: buildReminder(todos) }],
    ...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
  };
});
```

必须遵守的坑（均已核对）：

1. **追加而非重组**：`[...event.content, extra]`。若把文本抽出来重新拼，会丢掉图片块。
2. **透传 `structuredContent`**：替换 content 而不返回它，宿主会 `delete currentEvent.structuredContent`（`runner.js:912-915`），破坏带 `outputSchema` 的工具。
3. **不要回传 `details`**：不返回即保留原值（`runner.js:917-920`）；显式回传 `undefined` 之外的值会覆盖其他包的渲染数据。
4. **永久写入 transcript**：`_afterToolCall` 的结果会被持久化（`agent-session.js:349-385`），所以**必须限频**，每条一行。
5. **前序 handler 的组合**：拿到的是 `currentEvent`，已含其他扩展的修改；本包按扩展加载顺序最后追加即可。
6. **可见性**：内置 bash/read/edit 走 `details` 渲染，追加文本用户基本看不到；以 content 渲染的自定义工具会露出 `<todo-state>` 一行——可接受，但需在 README 说明。

触发条件可优于纯计数：**「in_progress 陈旧」检测**——连续 N 次工具调用且 `in_progress` 项未变 → 提醒；全部 pending 且已有 K 轮无任何 todo 调用 → 提醒「你似乎忘了维护清单」。

### T3-C（替代，暂不做）：`turn_end` 追加 `custom_message`

每轮都能刷新，但每轮往 session 写 entry，长 run 条目膨胀，且 `/tree`、resume、compaction 都要带着它。除非 B+A 实测不足，否则不引入。

### T3-D（否决）：改 `systemPromptOptions.sections.todo`

system prompt 位于请求最前，任何改动都会让**整条前缀缓存失效**；而刷新频率与 B 相同（都是每 run 一次）。pi-memory 为 `memory_index` 付这个代价，是因为索引必须常驻系统提示（见 `pi-memory/src/inject.ts:190-206`）；todo 状态不需要，故否决。

## 配置（仅当采纳 T3-A）

首版建议硬编码常量；若 A 上线，参照 pi-coding-tools 的 `coding-tools.json` 模式提供 `todo.json`：

| 键 | 默认 | 说明 |
|---|---|---|
| `reminder` | `"run"` | `off` \| `run`（仅 B）\| `tool_result`（B+A） |
| `remindEvery` | `4` | A 模式每 N 次非 todo 工具调用提醒一次 |

## 兼容性 / 迁移

- 版本：`0.1.2 → 0.2.0`（T1+T2：新增行为 + schema 放宽），T3 各阶段另起 minor。
- 旧 session：`details.todos` 结构不变，resume/fork 后状态照常重建；uuid id 仍能精确命中。
- `items[].id` 必填 → 可选：老调用完全不受影响。
- 新增 `customType: "pi-todo"` 的 `custom_message` entry：`display:false`，不参与状态重建。
- README / README.zh.md 需补：更新纪律说明、（若做 A）提醒行为与开关、id 规则变化。

## 测试计划（`tests/`，遵循 `docs/guides/testing.md`）

- `todo-store`
  - 短 id 自动分配（缺失/空串）、显式 id 保留、混合情形。
  - `resolveTodoRef`：精确 / 唯一前缀 / 序号 / title 包含 / 歧义（返回 candidates）/ 未命中。
  - `formatAck`：done、in_progress、next 存在、next 被阻塞、全部完成。
  - `blockedBy` 归一化后依赖校验仍拦截自依赖与环。
- 提示词：对 `description`/`promptGuidelines` 断言少量关键短语（`IMMEDIATELY`、`Exactly one`、`not re-shown`），避免整串快照造成脆断言。
- 注入（mock `ExtensionAPI`）
  - `before_agent_start`：有开放任务时返回 `message` 且 `display === false`、内容含进度与 `in_progress`；空列表/全 done 时返回 `undefined`。
  - （若做 A）`tool_result`：content 为**追加**、`structuredContent` 透传、`details` 未被覆盖、限频计数正确、`todo` 自身结果不追加、全 done 后不再追加。

## 分阶段落地

| 阶段 | 内容 | 版本 | 验收 |
|---|---|---|---|
| 1 | T1 提示词 + T2.1 ack + T2.2 短 id/宽松匹配 | 0.2.0 | 真实会话中 update 频次明显上升；无 `Task not found` 反复失败 |
| 2 | T3-B `before_agent_start` 快照 | 0.3.0 | 长任务跨多轮后仍持续更新 |
| 3 | T3-A `tool_result` 限频提醒 + 配置 | 0.4.0 | 单次 run 内数十轮工具调用后仍不脱轨；噪声可关 |

每阶段单独发布：提示词效果与注入效果必须能分开归因，否则无法判断哪一层真正起作用。

## 未解决 / 需评审

1. **短 id vs uuid**：是否有用户依赖 id 的跨 `set` 稳定性？建议默认自动短 id、允许显式指定（当前方案）。
2. **user 角色注入的误读风险**：B 的快照会以 user 消息进入上下文，是否会被模型当成用户新指令（例如误答「好的，我来…」）？需实测；必要时改为 `turn_end` 的 `custom_message`（C）。
3. **`REMIND_EVERY` 默认值**：太小 → 噪声与 token 浪费；太大 → 无效。需实测标定。
4. **是否引入「陈旧 in_progress」检测**替代纯计数触发（更精准，但需要记录轮次与状态快照）。
5. **是否给 `list` 加轻量默认**：例如每个 run 首次工具调用前自动等价一次 `list`（与 B 重叠，倾向不做）。

## 参考

| 来源 | 借鉴点 |
|---|---|
| Claude Code `TodoWrite` 工具描述 | 使用场景枚举 + `IMMEDIATELY` / `Exactly ONE in_progress` 强措辞；tool result 后挂 `<system-reminder>` 复述状态 |
| pi 宿主 `dist/core/extensions/types.d.ts` | `BeforeAgentStartEventResult.message`、`ToolResultEventResult`、`BoundaryResult.entries` 三个注入点契约 |
| `pi-memory/src/inject.ts` | system prompt section 注入的代价与「null 陷阱」，本次据此否决 T3-D |
| `pi-coding-tools` `coding-tools.json` | 若采纳 T3-A 的配置文件模式 |

## 落地补记（0.2.0，2026-10-10）

- T1 / T2 / T3-B 全部实现；三层合并在同一个 `0.2.0`（原计划分 0.2.0 / 0.3.0 以便归因，实际按用户选择一起做，代价是贡献无法单独归因）。
- **§T2.2 的 `blockedBy` 归一化在实施计划里被漏掉**，全分支评审时发现并补上：`set` 与 `update` 的依赖引用现在都走 `resolveTodoRef`，解析不出/歧义的才交给 `validateDependencies` 报错。教训：spec 的要求如果没进任何测试断言，就会在 spec→plan 这一跳丢失。
- 评审带出的三个规格外缺陷已修：注入的 discipline 行会把当前 `in_progress` 任务再指为下一个（自相矛盾）；单字符 title 引用会静默命中错误任务（英文标题尤其容易）；`in_progress` 段无上限且不提示「同时只能一个」。
- 已知代价（评审提出、本轮不修）：**每个 user turn 注入一条快照且永久留在上下文**，N 轮提问就有 N 份 `<todo-state>`，靠 recency 取对的那份。彻底修法需要 `turn_end` + `context_edit` 替换上一条（即被否决的 T3-C 家族）；是否要做，等真实会话里量化了占用再定。
- 注入文本第二行是自报身份的框定语（`Automatic status echo …, not a request from the user.`），对齐宿主 compaction/branch-summary 的惯例；「模型会不会把它当用户指令」仍需按 §未解决 #2 实测确认。
