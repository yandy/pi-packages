# pi-ask-user: 浮窗高度预算与滚动

## 需求

修复浮窗内容过多时的展示问题：内容超出浮窗高度时被 pi-tui 直接截断，没有滚动条，选项甚至帮助行不可见，用户无法读到完整内容。

## 背景：pi-tui 的裁剪行为

overlay 的 `maxHeight` 为终端行数的 85%（`margin: 1` 再各占一行），超出 `maxHeight` 的行在 `compositeOverlays` 中被**直接 slice 丢弃**，无滚动、无提示。因此浮窗组件必须自我约束总高度，不能依赖宿主兜底。

## 设计

### 高度预算

`AskComponent.render()` 以 `budgetHeight = min(floor(rows × 0.85), rows − 2)` 为硬上限，各区域实测高度后手动组装：

```
top border (1)
spacer (1)
title (实测，通常 1)
spacer (1)
header 视口 = question + 空行 + context（可滚动，预算内 clamp）
spacer (1)
交互区 = 选项列表 / 编辑器（列表按行预算窗口化）
spacer (1)
help (实测，常见宽度下折行 2 行)
spacer (1)
bottom border (1)
```

固定开销 `ASK_OVERLAY_FIXED_LINES = 7`（2 边框 + 5 spacer），title 与 help **实测计入**而非假定 1 行。

### 空间分配

可用行数 `available = budgetHeight − chromeLines`，在 header 与交互区之间分配：

1. `headerBudget = min(header 自然高度, headerCap)`，`headerCap = max(1, floor(available × 0.5))`
2. `modeBudget = min(mode 自然高度, max(4, available − headerBudget))`——交互区保底 4 行，保证选项可用
3. 未用完的行回流给 header：`headerBudget = min(header 自然高度, max(1, available − modeBudget))`
4. 微型终端下地板值之和仍超出预算时，以 `available` 为准硬性收缩

### Header 滚动视口

question+context 超出 `headerBudget` 时：

- 窗口 `[offset, offset + budget − 1)`，末行固定为指示行：`↑ N lines above · ↓ N lines below · pgup/pgdn scroll`（dim）
- `pageUp`/`pageDown` 按页滚动（页大小 = 可见行数 − 1），offset 在 render 时 clamp 到合法区间
- 指示行常驻（内容被 clamp 时），保证区域高度稳定、无布局跳动
- 仅选项选择模式拦截这两个键；freeform/comment 模式下 `pageUp`/`pageDown` 归编辑器（`tui.editor.pageUp/pageDown`）所有，此时 header 仍会被 clamp，但不可滚动（按 esc 回选择模式滚动，草稿保留）

### 选项列表窗口化

- `windowSelectedBlocks()`（`src/single-select-layout.ts` 导出）：以选中项为锚点向前后扩展填满行预算，追加 `(n/m)` 指示行；`renderSingleSelectRows` 与 `MultiSelectList` 共用
- `MultiSelectList.setMaxVisibleRows(rows)`：语义为**行预算**（此前为 10 个条目、每条目可多行）
- 单选列表 split-pane 的预览列同样受 `maxVisibleRows` 约束（`buildPreviewLines` 已有 `…` 截断）

## 验证

- `tests/overlay-layout.test.ts`：忠实 mock（换行、padding、多行 Text/Spacer），覆盖预算 clamp、滚动交互、多选窗口化、小终端
- `tests/overlay-real-stack.test.ts`：无 mock 的真实管线集成测试——真实 pi-tui 差分渲染 + `compositeOverlays` 切片 + 真实按键序列（`\x1b[6~`/`\x1b[5~`），FakeTerminal 捕获输出帧

## 已知边界

- 编辑器模式下 header 被 clamp 但不可滚动（键位归编辑器）
- 极小终端（约 < 13 行）下地板值收缩，仅保证不溢出，不保证可用性
- 指示行文案为英文，与 help 行风格一致
