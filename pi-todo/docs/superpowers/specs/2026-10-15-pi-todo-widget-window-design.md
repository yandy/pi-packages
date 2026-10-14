# Design: pi-todo — widget 窗口化 + `/todos` 全量视图

**Date:** 2026-10-15
**Status:** implemented（0.3.0）

## Summary

现象：任务多时编辑上方的 widget 尾部被替换成 `... (widget truncated)`，且被吃掉的是**列表尾部**——通常正是在飞任务和剩余待办。真正该看的信息消失，留下一屏已完成任务的删除线。

排查结论：这句提示不是 pi-todo 写的，是宿主对字符串数组 widget 的保护机制；但触发的直接原因是 pi-todo 的渲染选择——一行一项、全量渲染、done 也占行。方案分两层：

1. **widget 窗口化**：自己持有行预算，锚定在飞任务取窗口，逐行按终端宽度截断；
2. **全量清单**改由 `/todos` 的 overlay 视图承载（只读、可导航）。

### 关键决策摘要

| 决策 | 结论 | 理由 |
|------|------|------|
| widget 形式 | **字符串数组 → 组件工厂** | 数组形式拿不到 `render(width)`，无法按显示宽度裁行（CJK/emoji 用字符数会算错） |
| 行预算归属 | **pi-todo 自己持有**（`WIDGET_MAX_ROWS = 8`，含标记与汇总行） | 低于宿主 10 行上限，永不触发宿主截断；不依赖宿主常量 |
| 窗口规则 | 锚定第一个 `in_progress`（无则第一条未完成）→ **先向后铺 → 有余量再回头补** | 在飞任务与即将执行的 pending 是「一眼要看」的部分；done 属于历史 |
| 两端标记 | `↑ n` / `↓ n`（dim），**汇总行独立一行放最后** | 隐藏量显式化；进度（`✓ 6/18 · ○ 11 · 🔒 1`）在任何宽度下都可读 |
| 逐行截断 | 每项一行 + `truncateToWidth(line, width, "…")` | 行数 = 项数，预算精确；不会因折行把预算吃穿 |
| 全量视图 | **`/todos` 命令 + overlay**（`width 92%` / `maxHeight 85%` / `margin 1`） | 长清单不挤 dock；overlay 由用户主动开关；命令不占键位 |
| 视图交互 | 只读；`↑↓`/`j k` 移动、`g`/`G` 首尾、`Esc`/`q` 关闭；表头带 `(当前/总数)` | 视图只负责看；改动看板仍只有 `todo` 工具一条路径 |
| 非 TUI 模式 | `ctx.mode !== "tui"` → `notify` 完整清单 | 不静默失败（RPC 无终端组件） |
| 不做滚动 | **否决**，见下 | 三个硬伤 |
| 版本 | `0.2.0 → 0.3.0` | 用户可见行为变化，0.x 用 minor 承载 |

## 背景事实（决策依据，均在 pi 1.2.0 核对）

### 宿主的 10 行上限只对数组形式生效

- `setExtensionWidget()`（`dist/modes/interactive/interactive-mode.js`）在 `Array.isArray(content)` 分支里 `content.slice(0, MAX_WIDGET_LINES)`，`MAX_WIDGET_LINES = 10`，超出再补一行 `... (widget truncated)`。
- 组件工厂分支不做任何裁剪：`content(this.ui, theme)` 的返回值直接进 widget 容器。
- 数组形式的每行是 `new Text(line, 1, 0)`，而 `Text` 是**折行**的（`pi-tui/dist/components/text.js`），所以「渲染行数」与「数组长度」是两件事。

### widget 的高度由 dock 决定，超了就从底部裁

- `createChatViewport()`（`dist/modes/interactive/chat-viewport.js`）：transcript 是 `ScrollView`，编辑器一侧是 dock `VStack`，其中 `widgetsAbove` 条目为 `{ shrink: 1, minSize: 0 }`，dock 本身 `{ basis: "auto", grow: 0, shrink: 1 }`。
- 布局从底部裁剪（`pi-tui/dist/layout.js` 的 `firstRow = max(rect.y, clip.y)` / `lastRow = min(rect.y + height, clipBottom)`）。即：**用组件工厂绕过 10 行上限，只会把丢尾部的位置从宿主提示换成静默裁剪**。
- `setStatus` 是另一条路但只能一行：footer 把所有 extension status 用空格拼成一行并 `truncateToWidth`（`dist/modes/interactive/components/footer.js`）。

### 为什么 widget 不做滚动

- **只有全屏 + 鼠标滚轮**：滚轮靠坐标命中 `ScrollView`（`pi-tui/dist/tui-alt-screen.js` 的 `routeWheel` → `getScrollViewsAt`），而键盘的 scrollUp/scrollDown/PageUp 永远只发给主 transcript 的 `ScrollView`（`getPrimaryScrollView()`）。主屏（非全屏）模式下没有命中测试，完全滚不了。
- **滚动位置会被重置**：`setExtensionWidget` 每次调用都 `dispose()` 旧组件、重新执行工厂函数；每次 `todo` 更新后 widget 都是新实例。要保住位置得自己维持稳定实例 + 手动 `tui.requestRender()`。
- **产品形态差**：10 行窗口没有「我在列表哪个位置」的 affordance，用户要边滚边看它变。
- 结论：窗口化本身就是「自动滚动」——窗口跟着在飞任务走。手动浏览归 `/todos`。

### overlay 不是「无限制」，但足够

- `showOverlay` 的 `resolveOverlayLayout`（`pi-tui/dist/tui.js`）：默认宽 `min(80, 终端宽)`；`maxHeight` 一旦给出，渲染时 `overlayLines.slice(0, maxHeight)` **硬裁**，框架不提供滚动。
- 所以 `/todos` 自己算内容行预算（`floor(terminal.rows * 0.85) - 4` 条 chrome），保证组件渲染行数 ≤ overlay 的 `maxHeight`，不会被硬裁。

### 参考实现：pi-ask-user

- overlay 参数（`pi-ask-user/index.ts`）：`anchor: center` / `width: "92%"` / `minWidth: 40` / `maxHeight: "85%"` / `margin: 1`；显示模式可配置（`overlay` / `inline`）。
- 高度预算按实际换行数算（`countStaticLines` + `setMaxVisibleRows`），不写死常数。
- 窗口算法在纯函数里（`pi-ask-user/src/single-select-layout.ts`），可在无终端环境下单测；优先级是「选中项 → 向后 → 向前」，与本文的 widget 窗口同源。
- overlay 藏/显靠 `onHandle` + `ctx.ui.onTerminalInput`（隐藏的 overlay 收不到输入）。

## 实现

### `src/widget.ts`

- `selectWindow(items, anchorIndex, maxRows, { align })` → `{ visible, hiddenAbove, hiddenBelow }`；`align: "start"` 先向后铺、有余量再回头补，`align: "center"` 把锚点放在窗口上半部（供 `/todos` 使用）。
- `formatProgress(items)` → `✓ 6/18 · ○ 11 · 🔒 1`（pending/blocked 为 0 时省略对应段）。
- `renderWidgetLines(items, theme, { width, maxRows })`：无任务或全 done 返回 `null`；预算含标记与汇总行，标记行数取决于窗口大小，故迭代到稳定（`contentRows` 单调，最多 3 轮）；末尾统一 `truncateToWidth`。
- `TodoWidget implements Component`：只持有 items/theme，`render(width)` 现算，`invalidate()` 为空（无缓存）。

### `src/todo-view.ts`

- `renderTodoViewLines(items, theme, { width, rows, selectedIndex })`：`─` 分隔线 + 表头（进度 + `(当前/总数)`）+ 窗口列表（选中行 `→`，done 带删除线）+ 键位提示 + 分隔线；chrome 固定 4 行。
- `TodoView implements Component`：打开时把光标放在第一个在飞任务上（与 widget 锚点一致）；`render(width)` 用 `terminal.rows` 算预算；`handleInput` 支持 `tui.select.*` 注入键位 + 方向键/`j k`/`g`/`G`/`Esc`/`q`/`ctrl+c`。

### `index.ts`

- `refreshWidget` 改组件工厂，隐藏规则不变（空 / 全 done → `setWidget(key, undefined)`）。
- 新增 `pi.registerCommand("todos", …)`：空看板 → `notify("No todos")`；非 TUI → `notify(进度 + listTodos)`；TUI → `ctx.ui.custom` overlay。

## 验证点（可复现）

- `renderWidgetLines`：任务数 1..25 × `maxRows ∈ {4,6,8}` 时行数 ≤ `maxRows`。
- 长 CJK 标题在 `width ∈ {20,24,30}` 下每行 `visibleWidth(line) ≤ width`，且长标题不整段出现。
- 窗口：锚点在首/中/尾、`maxRows = 1`、锚点越界、空列表、`align: "center"` 的两端夹紧。
- `/todos`：`rows ∈ {6,8,12}` 时渲染行数 ≤ `rows`；`maxHeight` 断言为 `"85%"`；`↑↓`/`g`/`G`/`Esc`/`q` 行为。

## 未被采纳的备选

| 方案 | 否决理由 |
|------|----------|
| widget 内 `ScrollView` | 见「为什么 widget 不做滚动」 |
| 用组件工厂 + 全量渲染（只去掉截断） | 只是把丢尾部从显式变成静默（dock 压缩 + 底部裁剪） |
| 只折叠 done、不设窗口 | 长 pending 列表仍会溢出，需要裁剪规则兜底 |
| 锚点居中（B3） | 上下都留省略行，行数利用率最低 |
| done 完全不显示 | 会丢掉「刚完成什么」的上下文 |
| 额外注册打开全量视图的快捷键 | 占用用户键位；命令先行，需要再加 |
