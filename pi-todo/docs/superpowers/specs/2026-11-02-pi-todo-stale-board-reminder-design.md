# pi-todo：看板漂移提醒（stale-board reminder）设计

**Status:** implemented（待发版）
**前置：** [2026-10-10-pi-todo-update-discipline-design.md](2026-10-10-pi-todo-update-discipline-design.md)（T1/T2 已发，T3-B 发布前删除，T3-A/T3-C 列为候选）

## Summary

用户再次反馈同一个现象：LLM 用 pi-todo 时总忘记更新。上一轮的结论是「提示词过软 + 状态对模型不可见」，并为此写了 4 条 guidelines（`Mark a task done as soon as it passes — never batch completions to the end of the run` 等）。本轮先用本地会话数据检验这 4 条到底有没有用，再据此决定是否动用上一轮被推迟的注入方案。

结论：**提示词这条杠杆已经用尽**（详见 §1 测量），而上一轮删除 T3-B 的三条理由在新方案下全部不成立。因此新增一个**请求级、可退避的提醒**，走 `context` 钩子而不是 `before_agent_start`。

## 1. 测量：提示词纪律没有改变行为分布

数据来源：`~/.pi/agent/sessions/**/*.jsonl` 全量扫描，筛出「确实用了 pi-todo」的会话（按 ack 文本形态 `(x/y done)` / `◉ #` / `· next: #` / `✓ all N tasks done` 识别），解析每条 `todo` 工具调用的参数与返回 `details.todos`。

**对照组**：内置/旧版 `todo`（ack 是裸 `OK`）41 个会话；**实验组**：pi-todo 40 个会话。

| 指标 | 旧 todo（41） | pi-todo（40） |
|---|---|---|
| `set` 后从未 `update` | 15（37%） | **12（30%）** |
| 计划 ≥3 项但 update ≤ 项数/3 | 17（41%） | **17（43%）** |
| 会话结束时板上仍有未完成项 | 12（29%） | **13（33%）** |
| `done` 之前没有对应 `in_progress` | — | **145/191（76%）** |
| 连续补 ≥3 条 `done`（最多一次连补 15 条） | — | 20 处 |
| 最后一次 todo 调用距会话结束的轮数 | 中位 26 | 中位 **28**（均值 35.7） |
| 从不调用 `list` | — | 35/40 |

两点读法：

1. **分布没变。** 30% vs 37%、43% vs 41%、33% vs 29% 的差异都在噪声范围内，没有证据表明 T1+T2 改善了更新频率。
2. **76% 最能说明问题。** 它不是「忘了标完成」，而是**事后批量补账**：`done` 之前没有 `in_progress`，且 20 处出现连续补录（最长 15 条）。这同时解释了用户「板子一直是旧的、突然全绿」的观感。

补充一个前提核验：这 40 个会话的系统提示里**都**含本包的 `promptGuidelines`（`Mark a task done as soon as it passes` 命中 40/40），所以本轮失败**不能**归因于「提示词没到位」。

## 2. 为什么提示词必然输

- **没有触发器。** guideline 是静态策略（「完成后立即标 done」），而模型的操作单位是「这一轮请求」，一批工具调用内部没有「某个任务刚刚结束」这个事件。没有事件就没有触发点。
- **状态不回流。** 看板只存在于旧 tool result 里；widget 是纯 UI。实测最后一次 todo 调用到会话结束中位 28 轮，这段时间模型手里没有任何复述。
- **成本不对称。** 跳过 todo 没有任何可观测后果（没有测试失败、没有报错）；跳过一次 `edit`/`bash` 立刻炸。软动作每次都输给真活儿。
- **同一 prompt 里有反方向指令。** `pi-superpowers` 的 `supo-executing-plans` 明写 `Track progress in a ledger file, not only in todos` 与 `Bookkeeping rides along with work … never in a call of its own`；skills 段实测 10.3k 字符，比整个 `<rules>` 段（6k / 45 条）还大。
- **`set` 重编号惩罚保留引用。** 实测 50 次在任务在飞时调 `set`，手里的 id 全部失效；最省事的恢复路径是「放弃看板，最后重写一遍」。

## 3. 为什么这次不是 T3-B 重演

上一轮删除 T3-B（`before_agent_start` 注入 `<todo-state>` 快照）的三条理由，逐条对照：

| 删除理由（2026-10-10） | 本方案 |
|---|---|
| **价值未证明，且实验设计无法证明** | 本轮有 n=40 的基线（§1），落地后可用同一脚本量「开启后」的同一批指标。基线是观测数据，不是单次脚本化跑动 |
| **触发点与病因错位**（`before_agent_start` 只在 run 边界触发一次） | 用 `context`：**每次 provider 请求**都跑，覆盖「一句话 → 几十次工具调用」这种真实现场 |
| **副作用是结构性的**（每 user turn 一份永久留在上下文，多份并存时必有「冒充当下、实为过去」的指令） | `context` 的结果**只作用于本次请求**（0.80.2 `runner.js:694`；1.4.0 `runner.js:1006`），不落 session、不进 `/tree`、不影响 resume/compaction。且措辞只说「你已经 N 轮没更新」，不断言「现在的看板长这样」 |

另外，上一轮 spec 自己写的后续条件是「若将来要真解 run 内漂移……候选是 T3-A（tool_result 尾追，需限频）或 T3-C（turn_end + context_edit）」，并要求**先做 A/B**。本方案取了 T3-A 的「限频 + run 内」内核，但把注入点换到不落盘的 `context`，因此拿到了 T3-A 的效果而避开它的 token 与持久化代价。

## 4. 设计

### 4.1 状态机（`src/reminder.ts`）

```ts
const nagger = new ReminderScheduler();  // turns + interval
```

- `onTurn()`：`turn_end` 累加（`turn_end` 在 0.80.2/1.4.0 都是**纯通知**，返回值被忽略，不能在这里注入）。
- `onTodoCall()`：任何 `todo` 调用（含报错）→ `turns = 0`，退避回到基线。
- `takeDue()`：`turns >= interval` 时返回已静默轮数并重置计时，同时把 `interval` 翻倍（封顶 40）。「取走」语义是刻意的：调用方发现没什么可催时，这一次到期就作废，而不是排队等下一轮。

阈值取 **5** 的依据：实测 `in_progress → done` 的跨度中位 7 轮，5 保证在模型本会关掉任务之前至少提醒一次。退避 5 → 10 → 20 → 40 让长跑只拿到个位数次提醒。

### 4.2 注入点（`index.ts`）

```ts
pi.on("context", async (event) => {
  const staleTurns = nagger.takeDue();
  if (staleTurns === undefined) return;
  const text = formatReminder(todos, staleTurns);
  if (!text) return;                       // 空板 / 全绿 / 全阻塞：连消息都不加
  return { messages: [...event.messages, { role: "user", content: [{ type: "text", text }], timestamp: Date.now() }] };
});
```

不修改 `event.messages`，返回新数组；宿主自己会在请求后还原上下文。

### 4.3 文案（`formatReminder`）

两条分支，都以 `<todo-reminder>` 包裹（避免被当成用户的新指令），第三人称、只陈述「多久没更新 + 该做什么」：

- 有在飞任务：点名（最多 2 个 + `+N`），要求「完成后立即 `update` 到 done，不要攒到最后」；
- 无在飞任务但有可领任务：要求「把正在做的标 `in_progress`，做完即标 `done`」，并附 `Next up: #id title`（复用 `pickNext`，已排除阻塞项）。

**不提醒**：看板为空、全部 `done`、以及剩余任务全被 `blockedBy` 挡住（此时催了只会让模型去动不该动的）。注意「全阻塞」在 set/update 阶段会被依赖校验拦下，只有从旧会话重建出悬空 `blockedBy` 时才可能出现——这条守卫是为那种输入准备的。

上限：单条 ≤ 320 字符（测试钉住），典型约 250。

## 5. 验证

### 5.1 单测（已入库）

- `tests/reminder.test.ts`（11 条）：阈值、取走即重置、todo 调用清空退避、翻倍与封顶、两条文案分支、`+N` 折叠、长 title 截断与长度上限、全阻塞静默。
- `tests/extension.test.ts`：`turn_end` 只计数、注入只走 `context`；未到期不注入；到期注入一条 `user` 消息且不改写已有消息；`todo` 调用后重新安静；空板/全绿静默。原来的回归门「只注册 session_start/session_tree」按新决策改写为「必须注册 context/turn_end，且仍然不得注册 before_agent_start」。

### 5.2 对着真实宿主 runner 的一次性验证（不入库）

用**全局安装的 pi 1.4.0** 的 `ExtensionRunner`（`dist/core/extensions/runner.js`）直接跑 `emitContext`，绕开本仓库自写的 `ExtensionAPI` stub：

| 断言 | 结果 |
|---|---|
| 未到期：`emitContext([system, user])` | 2 条，system 在最前 |
| 到期：同上 | **3 条**：`[system, user, <todo-reminder>…]` |
| system 消息是否被吃掉 | 否，仍在 index 0（1.4.0 的 `restoreSystemMessages` 会重放 system；0.80.2 直接透传） |
| 已有消息是否被改写 | 否（返回新数组） |
| 紧接着的下一次请求 | 2 条 —— 「取走即重新计时」生效，不会连续两轮刷 |

踩到的坑（复现时别再踩）：1.4.0 的 `getCurrentSystemMessage` 要求 system 消息带 `timestamp`（真实 transcript 都有，手搓的 `{role:"system", content}` 没有），否则 `restoreSystemMessages` 认为「没有 system 可还原」，注入结果里 system 会**看起来**丢了 —— 这是测试夹具失真，不是产品缺陷。

### 5.3 落地后的 A/B —— **已取消（2026-11-03）**

原计划（上一轮 spec 的强制前置）：发版后用脚本重扫新会话，对比 §1 的四项判据，四项都没改善就删功能。

**用户决定不做 A/B**，为此写的三个件（`scripts/todo-audit.ts`、`scripts/todo-nag-spy.ts`、`scripts/experiments/todo-nag/`）连同 PR #219 一并撤掉，仓库里不留测量脚手架。

后果要写清楚：**本功能现在没有数据化验收，只剩 §1 的观测基线**（40 个会话：30% 的 `set` 之后从未 update、43% 计划后闲置、76% 的 `done` 无前置 `in_progress`）。所以它的验收口径退化为主观判断：实际使用中若觉得提醒多余、或觉得没效果，直接删掉 `src/reminder.ts` 与 `index.ts` 里的两个钩子即可。这条退路同时是 D6（拒绝加配置项）成立的前提，取消 A/B 之后它比原来更重要。

## 6. 决策记录

| # | 问题 | 结论 |
|---|---|---|
| D1 | 提示词再加一轮？ | **否**。§1 已经证明同样措辞跑在 40 个真实会话上没有改变分布 |
| D2 | 用 `turn_end` 注入？ | **否**。0.80.2/1.4.0 的 `turn_end` 返回 `void`（纯通知）；要注入得写 session entry（T3-C，已否决） |
| D3 | 用 `tool_result` 尾追（T3-A）？ | **否**。会持久化进 transcript，且替换 content 有丢 `structuredContent` 的陷阱 |
| D4 | 用 `context`（请求级）？ | **是**。每次请求都触发、不落盘、不动 system prompt 前缀 |
| D5 | 阈值与退避 | 首次 5 轮，之后 ×2，封顶 40；依据是中位 7 轮的 in_progress→done 跨度 |
| D6 | 要不要配置项 | **不要**。上轮 spec 的口径是「硬编码则噪声不可回退」，但本方案的噪声自身上界（封顶间隔 + 全绿/全阻塞静默）已把它压到个位数次/长跑。真出问题按 §5.3 直接删功能，而不是加旋钮 |
| D7 | 版本 | `0.4.2 → 0.5.0`（行为变化，0.x 用 minor） |
| D8 | 落地后做 A/B？ | **否，已取消（2026-11-03）**。测量脚手架（audit / spy / run.sh）随之删除；代价是本功能失去数据化验收，退化为「看着不对就整块删」（见 §5.3） |
