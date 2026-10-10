# pi-todo

一个极简的 pi 扩展包，添加单个 `todo` 工具，并附带编辑器上方可视化的任务跟踪组件。

## 功能

- **一个工具**，三种操作：`set`（规划所有任务）、`update`（更改一个任务）、`list`（查看进度）
- **提示词里写死更新纪律**：工具描述与 guidelines 明确了何时必须更新（每个在飞任务各一个 `in_progress`、完成后立即 `done`）
- **每次 update 都有反馈**：`update` 返回进度与下一个任务（`✓ #2 写单测 done (2/5 done) · next: #3 修 CI`），不再只是一个 `OK`
- **三种状态**：`pending` → `in_progress` → `done`
- **依赖关系**：可选的 `blockedBy` 数组，含自依赖和循环检测
- **紧凑组件**悬于编辑器上方：`○` pending · `◉` in_progress · `✓` done · `🔒` blocked
- **分支安全的持久化**：状态从会话分支重建，因此 `/fork` 和 `/resume` 会保留正确的待办列表

## 安装

```bash
pi install npm:@yandy0725/pi-todo
```

或在 `~/.pi/agent/settings.json` 中添加：

```json
{
  "packages": ["npm:@yandy0725/pi-todo"]
}
```

## 工具参考

```
todo(action: "set" | "update" | "list", items?, id?, status?, title?, blockedBy?)
```

- `set` — 用 `items` 替换整个列表（在规划阶段使用）
- `update` — 根据 `id` 更新任务（`status`、`title`、`blockedBy` 可选）
- `list` — 返回当前列表

### 任务 id

- id 归工具所有：`set` 按位置分配短 id `1..n`，并忽略 items 里模型传来的任何 `id`。
- `update` 的 `id` 必须是那些 id 之一且逐字精确（发 `3`，不是 `#3`）；`blockedBy` 同样只接受精确 id。
- 写错不猜测：`Task not found` 会回显当前清单（已截断，最多 20 行），本轮就能自纠。
- `set` 是整表替换，id 会重新编号；请以最新 `set`/`update` 回显的 id 为准。

`update` 成功时返回单行 ack：本次变更、进度，以及下一个任务。

### 并行工作与 subagent

看板属于**单个会话**：subagent 跑的是它自己的 `todo` 实例，看不到也改不动你这张板。所以让父会话保持唯一写者 —— 把 #2 交给 subagent 的是你，标状态的也是你。

并行派发是支持的：

- 派出去就标 `in_progress`，结果回来标 `done`；允许多个任务同时 `in_progress`
- `next` 不会推荐已经在飞的任务；无任务可领时 ack 会回 `· 2 in flight` 而不是沉默
- `set` 是整表替换并重新编号：若有任务在飞，返回里会附一行 `⚠ ids renumbered` 点名它们，因为你手里的 id 刚刚失效

全部任务完成后，组件会自动隐藏。
