# pi-checkpoint

pi 的只读 Git 检查点包：在每次完整 agent run 前后捕获整个工作区，并直接从对话时间线追溯这一轮的净差异。捕获过程绝不改变当前分支、`HEAD`、真实 Git index 或工作区文件。

## 功能

- **run 级历史**：一个检查点覆盖 `before_agent_start → agent_settled`，不按每次模型响应或工具调用拆分。同一 busy period 内的重试、压缩重试、steering 和排队 follow-up 属于同一个 run。
- **真实净变化**：捕获整个当前 worktree 中的 tracked 修改、删除、mode 变化和未忽略 untracked 文件；即使 pi 从仓库子目录启动也一样。
- **对话关联**：正常完成、中断和没有代码变化的 run 都产生持久 session entry。entry 不进入 LLM 上下文。
- **只读查看**：折叠条目显示变更摘要；展开条目显示 ref、短 commit ID 和有上限的 patch 预览。
- **故障隔离**：Git 失败留下错误记录，但不会让 agent run 失败；预览失败也不会破坏已捕获的快照。

## 安装

```bash
pi install npm:@yandy0725/pi-checkpoint
```

或添加到 `~/.pi/agent/settings.json`：

```json
{
  "packages": ["npm:@yandy0725/pi-checkpoint"]
}
```

要求 pi >= 1.5.0，并可执行 `git`。

## 检查点的含义

run 开始时捕获 **baseline B**；最终空闲时捕获 **result R**。用户中断前已经产生的变化也会进入 R。没有文件变化的 run 同样创建 result commit。

```text
本轮开始时的 HEAD（若存在）
        ↑
   baseline B ──────→ result R
   tree = before      tree = after
                       ↑
             refs/pi/checkpoint/.../<runId>
```

每个 run 只有一个 ref：

```text
refs/pi/checkpoint/<base64url(sessionId)>/<runId>
```

R 以 B 为唯一 parent，因此本轮工作区净差异为：

```bash
git diff <baselineCommit> <resultCommit>
# 当 ref 指向 R 时，也可以：
git diff <full-ref>^1 <full-ref>
```

这是**状态差异，不是作者归因**。run 期间的人工编辑、外部进程、提交和切分支造成的变化，都会与 LLM 驱动的变化一起计入。

捕获使用临时 `GIT_INDEX_FILE`、`read-tree`、`add -A`、`write-tree`、`commit-tree` 和原子 `update-ref`。不会把文件加入真实 index、移动 `HEAD`、触发普通 commit hooks，或恢复/清理工作区。

## 查看一轮

TUI 时间线会显示：

```text
[checkpoint #3] 2 files changed, 8 insertions(+), 1 deletion(-)
```

展开条目即可查看 patch。预览上限为 **128 KiB**；截断会明确标记，不会删除 Git 对象中的任何内容。空差异显示 `No workspace changes`，中断的 run 标记为 `aborted`。

使用命令：

```text
/checkpoint 3
```

命令返回完整隐藏 ref、baseline/result commit ID，以及可直接执行的命令：

```bash
git diff <baselineCommit> <resultCommit>
```

无参数或编号非法时显示用法；查询范围是当前对话分支。本包不注册 LLM 工具。

## 限制与保留策略

- **ignored 文件不会被捕获。** 其它 untracked 文件都会写入本地 Git object database。运行前请先 ignore 敏感文件；hidden ref 不是加密或保密边界。
- 隐藏 ref 不出现在普通分支历史中，但 `git log --all`、`git for-each-ref`、备份、对象库副本和 mirror 操作仍可能暴露它们。
- 不递归捕获 submodule 内部，只记录 superproject 的 gitlink 状态。
- sparse checkout、`assume-unchanged` / `skip-worktree` 和特殊嵌套仓库遵循 Git plumbing 行为。无法可靠表示时会报告错误，不会声称已经得到可靠快照。
- 进程在 `agent_settled` 前退出时，可能留下只有 baseline 的 ref。本包不会伪造 result，也不会自动删除它。
- 不提供 restore 命令，也不自动清理。删除检查点只能显式执行 Git 操作：

  ```bash
  git update-ref -d <full-ref>
  ```

  Session entry 会作为历史元数据保留；失去引用的对象以后可能由普通 Git GC 回收。
- 不在 Git worktree 中或找不到 `git` 时跳过捕获，每个 session 最多提醒一次；后续 run 会重新探测。

## UI 能力

| 方法 | 守卫 | 非 TUI |
|------|------|--------|
| `pi.registerEntryRenderer`（时间线检查点条目） | `none`（renderer 仅由 TUI 消费） | 所有模式仍保留 session entry 与 Git ref，但没有可视化时间线 |
| `ctx.ui.notify`（命令输出、告警） | `none` | RPC 为 fire-and-forget，可能被丢弃；print/json 不保证显示。核心捕获不依赖通知是否送达 |

## License

MIT
