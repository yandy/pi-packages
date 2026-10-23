# Design: pi-todo — `update` 的 ack 点名「还在飞」的任务

**Date:** 2026-10-23
**Status:** implemented（0.4.0）

## 意图与为什么

真实事故（pi-superpowers 升 v7.0.1 那次会话）：开局 `set` 时把 #1 直接建成 `in_progress`，此后四条 `update` 的 ack 全是 `✓ #N … done (x/6 done) · next: #N+1`，**没有任何一条提到 #1**；只有最后一条「无处可推」才退化成 `· 1 in flight`（只报数量、不点名）。我据 `(5/6 done)` 才察觉漏标，还得再调一次 `list` 才知道漏的是 #1。

机制上的原因（见 `2026-10-10-pi-todo-update-discipline-design.md` 的 ack 规则表）：`pickNext` 只从 `pending` 里挑，`in_progress` 一律排除（这是对的，防重复派发），于是「谁还挂着」在 ack 里只剩最后那个计数分支。widget 只给用户看、不进模型上下文，**ack 是模型侧唯一的状态反馈** —— 所以卡住的在飞项对模型是不可见的。

## 目标 / 非目标 / 反目标

**目标**：`update` 的 ack 在存在「不是本次更新的在飞项」时**点名**它们（id + title，超 2 项折叠）；本次更新把某项标成 `done` 时用更强的措辞，提示「你还挂着这些」。

**非目标**（明确不做）：

- 不限制 `set` 直接 seed `in_progress`（曾设想的结构性限制已由用户撤回）
- 不改 widget / `/todos` overlay（模型侧不可见性不是它们的问题）
- 不引入时间戳或「陈旧 in_progress 检测」
- 不新增配置项
- 不做 `tool_result` 尾追提醒（T3-A 仍为 deferred）
- 不改 `set` 的清单返回、不加重编号警告

**反目标**：让每条 ack 都背上恒定摘要（噪音）；让合法的并行派发看起来像错误；让 ack 行长失控。

## 约束

- ack 是**单行纯文本**，且是模型侧唯一反馈；`details.todos` 只服务 UI 与状态重建。
- 既有语义不变：`pickNext` 只看 `pending`；多份 `in_progress` 合法（并行派发）；`set` 仍是整表替换 + 重编号。
- 现有测试逐字断言 ack 文案（`tests/extension.test.ts`、`tests/todo-store.test.ts`），必须同步更新。
- README 英文/中文必须对称（历史上曾出现不对称，见上一版 spec 的 M8）。

## Approaches（已选定 A + C）

| 方案 | 做法 | 取舍 |
|---|---|---|
| **A 有条件追加** | 只要存在其它在飞项就追加 `· ◉ also in flight: #1 …, #3 …` | 信噪比最好：真有时才说话，日常单在飞零噪音 |
| B 恒定摘要 | 每条 ack 末尾带 `· 1◉ 4✓ 1○` 计数 | 状态永远可见，但每条多 ~10 token，日常是纯噪音 |
| C 仅 `done` 时点名 | 只有标 `done` 时点名剩余在飞项 | 最省 token，但 `set → in_progress` 阶段不提示，暴露时机偏晚 |

**选定：A + C 组合。** 触发条件用 A（任何 `update`，只要存在其它在飞项），措辞分两档把 C 的判断用上：「刚收工」这个时刻用 `still in flight`，其余用 `also in flight`。

**被否：B**（噪音，且本例只有一条在飞也已出错，计数型摘要治不了「只有一条所以看着正常」）。**被否：「>1 条在飞才警告」** —— 本次事故只有一条在飞，这类规则抓不到。**被否：改 `set` 结构性限制** —— 用户已撤回；且现有测试与 README 都把「dispatch 时标 in_progress」当作合法用法。

## 决定的 how（`formatAck`）

在现有 head（+ 可选 ` · next: …`）之后追加一段，规则：

1. `others` = 所有 `status === "in_progress"` 且 `id !== 本次更新的 id` 的任务。
2. `others` 为空 → **一个字都不加**（与现状一致）。
3. `others` 非空 → 追加 ` · ◉ {label}: {names}`：
   - `label`：本次更新使其变成 `done` → `still in flight`；其它情形（`in_progress` / `pending`）→ `also in flight`
   - `names`：前 2 项 `#{id} {clipTitle(title)}`，用 `, ` 连接；超过 2 项追加 ` +N`
4. 现有「无 `next` 可领、仍有在飞」分支的 `· N in flight` **被上面的点名形式取代**（同一行不报两遍，也不保留只报数的版本）。
5. 早返回分支不变：`✓ all N tasks done`、`Task not found: …` + 内联清单。

示例（改动后）：

```
✓ #2 ref 改 v7.0.1 done (1/6 done) · next: #3 审查 diff · ◉ still in flight: #1 创建 worktree
◉ #2 数文件 in_progress (0/3 done · 1 pending) · ◉ also in flight: #1 读 README
✓ #1 A done (1/2 done) · ◉ still in flight: #2 B          ← 原本是 `· 1 in flight`
✓ #2 修 CI done (2/3 done) · ◉ still in flight: #1 读 README, #3 报告 +1
```

**留给 builder 的自由度**：折叠上限（取值 2）、分隔符与措辞的精确字符串。测试以最终确定的精确串为准。

## 影响面

| 位置 | 改动 |
|---|---|
| `src/todo-store.ts` | `formatAck` 尾部追加逻辑（内部 helper，复用 `clipTitle`）；无导出面变化 |
| `tests/todo-store.test.ts` | 更新既有 ack 断言；新增：单在飞、3+ 折叠、本次自己 in_progress、`done` 的措辞、无其它在飞时一字不加 |
| `tests/extension.test.ts` | `parallel dispatch` 两条用例的 ack 逐字断言随之更新 |
| `README.md` / `README.zh.md` | 更新 ack 契约那一条 bullet 与并行示例，EN/ZH 对称 |
| 版本 | `0.3.0 → 0.4.0`（行为变化按仓库惯例走 minor；无 schema/破坏性变更） |

## 验证

- 单测覆盖上表全部情形；`npm test -w pi-todo` 绿。
- 仓库 `npm run typecheck`、`npm run lint` 绿。
- 复现原事故：6 步清单、第 1 步在飞，从第 2 次 `update` 起每条 ack 都点名 #1；`#1` 标 `done` 后不再出现。
