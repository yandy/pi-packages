# pi-todo

一个极简的 pi 扩展包，添加单个 `todo` 工具，并附带编辑器上方可视化的任务跟踪组件。

## 功能

- **一个工具**，三种操作：`set`（规划所有任务）、`update`（更改一个任务）、`list`（查看进度）
- **提示词里写死更新纪律**：工具描述与 guidelines 明确了何时必须更新（每个在飞任务各一个 `in_progress`、完成后立即 `done`）
- **每次 update 都有反馈**：`update` 返回进度、下一个任务，以及仍在飞的任务（`✓ #2 写单测 done (2/5 done) · next: #3 修 CI · ◉ still in flight: #4 发布`），不再只是一个 `OK`
- **三种状态**：`pending` → `in_progress` → `done`
- **依赖关系**：可选的 `blockedBy` 数组，含自依赖和循环检测
- **紧凑组件**悬于编辑器上方：`○` pending · `◉` in_progress · `✓` done · `🔒` blocked；清单变长时自动开窗（锚定在飞任务），并常驻一行进度
- **分支安全的持久化**：状态从会话分支重建，因此 `/fork` 和 `/resume` 会保留正确的待办列表
- **模型安静了就催一次**：看板还有未完成任务、且一段时间没有 `todo` 调用时，会在下一次请求里注入一条短提醒（仅本次请求，不写进会话）

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

`update` 成功时返回单行 ack：本次变更、进度、下一个任务，以及其余仍在飞的任务。

### 并行工作与 subagent

看板属于**单个会话**：subagent 跑的是它自己的 `todo` 实例，看不到也改不动你这张板。所以让父会话保持唯一写者 —— 把 #2 交给 subagent 的是你，标状态的也是你。

并行派发是支持的：

- 派出去就标 `in_progress`，结果回来标 `done`；允许多个任务同时 `in_progress`
- `next` 不会推荐已经在飞的任务；每条 ack 都会点名其余仍在飞的任务（前两条逐一点名，其余折叠为 ` +N`，如 `· ◉ still in flight: #2 修 CI`），卡住的 `in_progress` 会在下一次 update 时被点名，而不是被静默丢掉
- `set` 是整表替换并重新编号：若有任务在飞，返回里会附一行 `⚠ ids renumbered` 点名它们，因为你手里的 id 刚刚失效

全部任务完成后，组件会自动隐藏。

## 模型安静了会催一次

光靠提示词约束不住看板的新鲜度：在 40 个确实拿到了这些 guidelines 的真实会话里，30% 的会话 `set` 之后再没更新过，43% 的会话设了 3 条以上的计划却只做了不到三分之一数量的更新，76% 的 `done` 在标记前根本没有对应的 `in_progress` —— 模型是在最后一次性补账，而不是边做边记。

所以扩展会主动提醒：它统计距离上一次 `todo` 调用过了多少个 assistant 轮，当看板还有未完成任务且轮数到阈值时，往下一次模型请求末尾追加一条短提醒：

```
<todo-reminder>The pi-todo board has not been updated for 6 turns. Still in_progress: #2 修 CI. When one of them is finished, call todo action "update" with its id and status "done" right away — do not batch completions to the end of the run.</todo-reminder>
```

几个值得知道的细节：

- **只作用于本次请求**：提醒只加在发出去的请求里，从不落盘。因此它不会在长跑里累积成多份互相矛盾的「当下状态」，会话文件也保持干净（`/tree`、resume 不受影响）。
- **有节流**：第一次在 5 轮后提醒，之后每次等待翻倍（5 → 10 → 20 → 40）。长任务里只有几次提醒，不是每轮一次。
- **会自己闭嘴**：任何一次 `todo` 调用（包括报错的那次）都会重置计时，所以按时维护看板的模型不会被打断。
- **无事可催时不出声**：没有看板、全部完成、或剩下的任务全被依赖挡住，都不会产生提醒。

## Widget 与全量视图

编辑器上方的 **widget** 是常驻摘要，最多 8 行。清单超过预算时它渲染的是窗口，而不是被宿主截断：

- 窗口锚定第一个 `in_progress`（没有在飞任务时退到第一条未完成），先向后铺满，行有余量再回头补前面的任务；
- `↑ n` / `↓ n` 标记两端各隐藏了多少条；
- 最后一行固定是全局进度（`✓ 6/18 · ○ 11 · 🔒 1`）；
- 每行按终端宽度截断并加省略号，既不折行，也不会出现宿主的 `widget truncated`。

清单为空或全部完成时 widget 自动隐藏。RPC 客户端收到的是同样的窗口（纯文本行，组件形式只在 TUI 生效），所以那里不做宽度截断。

**全量视图**是一个命令：`/todos` 在浮层里显示完整清单（`↑`/`↓` 或 `j`/`k` 移动，`g`/`G` 跳首尾，`Esc` 或 `q` 关闭），表头带进度，清单长于窗口时额外显示 `(当前/总数)` 位置。视图只读，不会改动看板。非 TUI 模式下降级为一条含完整清单的通知：RPC 会转发它，print/json 没有 UI、不产生输出。
