# pi-todo

一个极简的 pi 扩展包，添加单个 `todo` 工具，并附带编辑器上方可视化的任务跟踪组件。

## 功能

- **一个工具**，三种操作：`set`（规划所有任务）、`update`（更改一个任务）、`list`（查看进度）
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

全部任务完成后，组件会自动隐藏。
