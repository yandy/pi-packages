# Design: `memory` 工具 LLM 可见文案的精简空间（评估，暂不实施）

**Date:** 2026-10-03（评估记录：2026-06）
**Status:** deferred — 评估完成，当时决定不动手；本文件只保存测量、清单与候选方案，便于日后直接开工

## 背景

`memory` 的 `description` / `promptSnippet` / `promptGuidelines` / `parameters` 每轮都会进模型上下文：tool schema 每请求发送，`promptSnippet` 进 system prompt 的 "Available tools"，`promptGuidelines` 进 "Guidelines"。`extract` / `dream` 的 headless 子会话还会各注入一份自写的工具说明。本文件记录 2026-06 那次评估的实测数字、重复清单与两套候选方案；**当时决定不动手**，代码未做任何改动。

## 1. 实测（方法可复现）

用临时 vitest 调 `createMemoryTool` + `JSON.stringify(parameters)` 量取（脚本已删；需要时按此重建，约十分钟）：

| 通道 | 组成 | 合计 |
|---|---|---|
| 主会话每轮 | description 522 + promptSnippet 152 + promptGuidelines 1143（7 条）+ params JSON 1003 | **2823 chars ≈ 700 tokens**（dream 版含 `new_name` = 2969） |
| extract 子会话每次 `agent_end` | task 2914 + 子会话 system prompt 里的工具文案 1295（snippet + guidelines；宿主的 `_rebuildSystemPrompt` 对 customTools 也收集） | **4209 chars ≈ 1050 tokens**（dream = 4460） |

渲染通道（决定「省下来的是否真进账单」）：tool schema（`name` / `description` / `parameters`）每请求发送；`promptSnippet` → system prompt 的 "Available tools"；`promptGuidelines` → "Guidelines"；**`label` / `renderCall` / `renderResult` / 返回值的 `details` 不进 LLM**（`details` 是渲染字段）。

## 2. 重复清单（5/6-gram 实测）

- **逐字**：`extract.ts` 的 `## Storage model` 抄 `description`（10 词级逐字 3 处）；guideline 2 的 Bad/Good 整句、guideline 3 的 `Adding a name that already exists overwrites…` 与 extract task 逐字；extract `## Tools` 的 4 行重复参数 schema。
- **语义**：`description` 尾句 + `promptSnippet` 尾句 + guideline 2 + `params.description` **四处**都在说 self-contained；one-file / 索引一行（description + guideline 1）；撞名覆盖（description + guideline 3）；sessions search（description + `params.scope` + guideline 6）；容量行动指令（guideline 5 + `capacityWarning`）。guideline 与 description/params 之间只有 1 处 5-gram 重合 → 属 paraphrase 型冗余。
- **子会话错配**：guideline 6/7 对 extract / dream 无意义（子会话不会收到 `<relevant_memories>`，也不需要查历史会话），但照样注入。
- **漂移风险**：dream / extract 各手写一份工具说明、措辞不同（6-gram 零重合）→ 建议抽公共常量。

## 3. 候选方案（均未实施）

1. **零信息损失包**：给 `createMemoryTool` 加 `promptGuidelines` 覆盖选项，extract / dream 传精简版；extract task 删掉与 `description` 逐字重复的 3 条、`## Tools` 缩 1 行；`params.name` 按 actions 动态生成（去掉主 agent 不存在的 `rename`）。
2. **主会话压缩包**：合并 guideline 1/3/4、删 5/6、缩短 `params.description`、self-contained 只留一处强化 → 2823 降到 ~2050（省 ~190 tokens/轮）。代价：削弱刻意做的「四处重复」行为强化，**需先做行为确认**。

## 4. 为什么当时没有动手

- 这些文本都在**稳定前缀 / prefix-cache 覆盖内**：主会话的实际账单收益远小于字面 token 数。
- 真实收益在 **extract 子会话**（每轮一次、无缓存复用）与**降低两份手写说明的漂移风险**。
- 现有测试只钉了 `Saved "…"` 这类**返回值文本**，**没钉** `description` / `promptGuidelines` —— 改文案不会被测试拦住，必须人工核对；这正是方案 2 需要额外行为验证的原因。

## 5. 若日后开工

1. 按 §1 重建量取脚本，先测当前值（文案可能已随其他改动漂移）。
2. 先做方案 1（无行为风险）。
3. 方案 2 前先补一条**钉住关键 guideline / description 句子**的测试，避免下一次改文案悄悄丢掉行为约束；再设计「四条重复 → 一条强化」是否足够。
