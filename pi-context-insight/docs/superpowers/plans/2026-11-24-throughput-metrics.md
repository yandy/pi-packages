# 吞吐与延迟指标增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 pi-context-insight 的现有耗时卡中补充整体／逐请求 TPS 与模型延迟指标，并提供可展开的逐请求明细。

**Architecture:** `computeTiming` 继续作为耗时统计的唯一计算入口，新增标量直接从已填充的 `Step[]` 派生；渲染层复用同一个逐请求 TPS 辅助函数，只负责格式化与 HTML。现有 schema、donut 和活跃时长条保持不变。

**Tech Stack:** TypeScript、Vitest、pi 会话条目与现有离线 HTML 渲染器。

**Spec:** `pi-context-insight/docs/superpowers/specs/2026-11-24-throughput-metrics-design.md`

## Global Constraints

- 不展示 TTFT、纯解码 TPS 或输入处理 TPS，不新增趋势图或报告分区。
- 不改变现有 `timing.tps = 总输出 token / 总模型时长` 的加权平均口径，不升级报告 schema。
- 逐请求 TPS 仅接受有限且大于 0 的输出 token 与模型时长；延迟统计接受所有有限且大于 0 的模型时长，包括估算时长。
- 最近一次 TPS 取最后一个有效请求；中位数在偶数样本时取两个中间值平均；P95 使用最近秩 `sorted[ceil(0.95 * n) - 1]`。
- 所有不可用指标显示 `—`，不得向 HTML 输出 `NaN` 或 `Infinity`；中英文文案必须齐全。

## Review Focus

- 缺失 usage、零／负／非有限时长不得进入逐请求统计；由 Task 1 的有效性测试覆盖。
- 最后一个请求无效时不得覆盖最近一次有效 TPS；由 Task 1 的最近值测试覆盖。
- 偶数样本中位数和小样本 P95 不得使用错误秩；由 Task 1 的固定数值样例覆盖。
- 估算模型时长必须保留 `≈` 标记，缺失值必须显示 `—`；由 Task 2 的明细边界测试覆盖。
- 整体 TPS 与逐请求中位数不得混算，活跃 TPS 必须使用 `activeMs`；由 Task 1 的整体口径测试覆盖。

---

### Task 1: 吞吐与延迟统计

**Files:**
- Modify: `pi-context-insight/src/session/timing.ts`
- Test: `pi-context-insight/tests/timing.test.ts`
- Include on commit: `pi-context-insight/docs/superpowers/specs/2026-11-24-throughput-metrics-design.md`, `pi-context-insight/docs/superpowers/plans/2026-11-24-throughput-metrics.md`

**Interfaces:**
- Produces: `stepOutputTps(step: Pick<Step, "actual" | "durationMs">): number | null`。
- Produces: `TimingReport` 新增 `activeTps`、`latestTps`、`medianTps`、`fastestTps`、`slowestTps`、`averageModelMs`、`p95ModelMs`，类型均为 `number | null`。
- Consumes: 现有 `Step.actual.output`、`Step.durationMs`、`activeMs` 与现有 `timing.tps`。

- [ ] **Step 1: 写整体口径与分布的失败测试**

在 `tests/timing.test.ts` 构造四个连续请求，时间戳依次为 `1000、2000、4000、8000ms`，模型时长依次为 `1000、2000、4000、8000ms`，输出 token 依次为 `100、100、400、200`。断言：

```ts
expect(timing.tps).toBeCloseTo(800 / 15, 5);
expect(timing.activeTps).toBeCloseTo(50, 5);
expect(timing.latestTps).toBe(25);
expect(timing.medianTps).toBe(75);
expect(timing.fastestTps).toBe(100);
expect(timing.slowestTps).toBe(25);
expect(timing.averageModelMs).toBe(3750);
expect(timing.p95ModelMs).toBe(8000);
```

- [ ] **Step 2: 写有效性和最近值的失败测试**

追加一个 `durationMs=1000` 但没有 usage 的最后步骤，断言 `latestTps` 仍为 `25`；直接测试 `stepOutputTps` 对缺失 usage、零／负／非有限输出、零／负／`NaN`／`Infinity` 时长返回 `null`。空步骤数组的所有新增字段必须为 `null`。

- [ ] **Step 3: 运行测试并确认失败**

Run: `npm test -w pi-context-insight -- tests/timing.test.ts`

Expected: 因新增属性或辅助函数尚不存在而 FAIL。

- [ ] **Step 4: 实现统计接口和计算**

在 `src/session/timing.ts` 中新增上述接口字段与 `stepOutputTps`。在现有步骤时长回填完成后收集有效样本，按既定口径计算新增字段；`activeTps` 使用全部实际输出 token 和 `activeMs`。不要把逐请求样本平均写回现有 `tps`。

- [ ] **Step 5: 运行统计测试并确认通过**

Run: `npm test -w pi-context-insight -- tests/timing.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交统计与设计文档**

```bash
git add pi-context-insight/src/session/timing.ts pi-context-insight/tests/timing.test.ts pi-context-insight/docs/superpowers/specs/2026-11-24-throughput-metrics-design.md pi-context-insight/docs/superpowers/plans/2026-11-24-throughput-metrics.md
git commit -m "feat: add session throughput metrics"
```

### Task 2: 耗时卡指标与逐请求明细

**Files:**
- Modify: `pi-context-insight/src/render/timing.ts`
- Modify: `pi-context-insight/src/render/style.ts`
- Modify: `pi-context-insight/src/i18n/en.ts`
- Modify: `pi-context-insight/src/i18n/zh.ts`
- Test: `pi-context-insight/tests/render-cards.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `TimingReport` 新字段与 `stepOutputTps(step)`。
- Produces: 现有耗时卡内的吞吐／延迟指标网格，以及带 `data-request-throughput` 的 `<details>` 逐请求表；不修改交互 payload。

- [ ] **Step 1: 写汇总指标与明细的失败测试**

扩展 `renderTimingCard` 测试，构造两个输出分别为 `100、50` token、时长分别为 `1000、2000ms` 的请求，断言卡片包含活跃、最近、中位、最快、最慢 TPS 和平均／P95 延迟的翻译标签，以及 `100`、`25`、`62.5`、`1.5s`、`2.0s` 等对应格式化值；断言保留 `data-tps="1"`，新增 `data-request-throughput`，表头包含 Step、Output、Model time、TPS。

- [ ] **Step 2: 写明细边界与中英文失败测试**

对缺失 usage 或有效时长的步骤断言对应单元格显示 `—`；对 `durationEstimated=true` 的时长断言带 `≈`；以 `lang: "zh"` 构建报告并断言中文标签。完整 HTML 不得包含 `NaN` 或 `Infinity`。

- [ ] **Step 3: 运行渲染测试并确认失败**

Run: `npm test -w pi-context-insight -- tests/render-cards.test.ts`

Expected: 因新标签、指标或明细尚不存在而 FAIL。

- [ ] **Step 4: 实现渲染、样式与双语文案**

在 `src/render/timing.ts` 保留现有模型 TPS chip，在 donut 下方增加紧凑指标网格；逐请求表直接遍历 `report.steps`，使用 `stepOutputTps`，列为步骤、输出 token、模型时长和 TPS。统一 TPS 格式为大于等于 10 时取整数，否则保留一位小数。仅新增小型网格／滚动样式，不调整其它卡片。

- [ ] **Step 5: 运行渲染测试并确认通过**

Run: `npm test -w pi-context-insight -- tests/render-cards.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交报告 UI**

```bash
git add pi-context-insight/src/render/timing.ts pi-context-insight/src/render/style.ts pi-context-insight/src/i18n/en.ts pi-context-insight/src/i18n/zh.ts pi-context-insight/tests/render-cards.test.ts
git commit -m "feat: show request throughput details"
```

### Task 3: 整包验证

**Files:**
- Verify only: `pi-context-insight/`

**Interfaces:**
- Consumes: Task 1 与 Task 2 的完整实现。

- [ ] **Step 1: 运行完整测试**

Run: `npm test -w pi-context-insight`

Expected: 所有测试 PASS。

- [ ] **Step 2: 运行类型检查与 lint**

Run: `npm run typecheck -w pi-context-insight && npm run lint -w pi-context-insight`

Expected: 两个命令均以退出码 0 完成。

- [ ] **Step 3: 检查最终差异**

Run: `git diff --check origin/main...HEAD && git status --short`

Expected: 无空白错误；工作区无未提交改动。
