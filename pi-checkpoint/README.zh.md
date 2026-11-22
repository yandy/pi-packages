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

新的成功 entry 会记录持有该快照的仓库的 git common dir，因此查询可以在任意 checkout 中验证快照。查询有三种结果：

1. **可用** —— ref 仍解析到该 run 记录的 result commit。命令打印 ref、baseline/result commit ID，以及带正确仓库上下文的可执行命令：
   ```bash
   git --git-dir=<commonDir> diff <baselineCommit> <resultCommit>
   ```
2. **确认不可用** —— 记录的 ref 已不存在，或解析到另一个 commit。命令明确说明这一点，只打印已持久化的摘要与预览，绝不输出无法执行的 diff 命令。
3. **无法确认** —— 检查本身失败（找不到 `git`、不在 Git worktree 中、Git 出错、子进程被中断）。命令说明无法确认可用性，不会声称快照已被清理。

该字段出现之前写入的旧 entry 没有 `commonDir`；查询退回当前目录，并使用非断言文案（`可能已清理或属于其他仓库`）。无参数或编号非法时显示用法；查询范围是当前对话分支。本包不注册 LLM 工具。

查看或清扫旧检查点：

```text
/checkpoint prune [--dry-run]
```

`prune --dry-run` 生成与真实执行完全相同的删除计划并报告，但不会改动任何 ref；`prune` 才执行删除。详见[保留策略](#保留策略)。

## 限制与保留策略

- **ignored 文件不会被捕获。** 其它 untracked 文件都会写入本地 Git object database。运行前请先 ignore 敏感文件；hidden ref 不是加密或保密边界。
- 隐藏 ref 不出现在普通分支历史中，但 `git log --all`、`git for-each-ref`、备份、对象库副本和 mirror 操作仍可能暴露它们。
- 不递归捕获 submodule 内部，只记录 superproject 的 gitlink 状态。
- sparse checkout、`assume-unchanged` / `skip-worktree` 和特殊嵌套仓库遵循 Git plumbing 行为。无法可靠表示时会报告错误，不会声称已经得到可靠快照。
- 进程在 `agent_settled` 前退出时，可能留下只有 baseline 的 ref。本包不会伪造 result；该 ref 不会被自动清理，只能手动删除（见[保留策略](#保留策略)）。
- 不在 Git worktree 中或找不到 `git` 时跳过捕获，每个 session 最多提醒一次；后续 run 会重新探测。

### 保留策略

每个 run 恰好一个 ref，因此仓库中 ref 数量等于 run 数量。保留规则只约束**已完成**的 ref：

- 已完成的 ref 只有 commit 日期不超过 **30 天** **且**属于该仓库最新 **200 个**已完成 ref 时才保留。两个条件必须同时成立，即日期截断与数量截断取交集，较严格的一侧生效。
- `RETENTION_DAYS = 30` 与 `MAX_REFS_PER_REPO = 200` 是代码内常量，没有设置项。
- 只有最新 commit 是本包 **result** 快照的 ref 才进入候选。仍指向 **baseline** 快照的 ref（进行中的 run 或崩溃残留）永远不会被自动删除，也不占用数量配额。

一个 ref 只有在以下条件全部满足时才算已完成：

- commit subject 恰好为 `pi-checkpoint result ref=<该 ref>`，且该 commit 恰好有一个 parent；
- 该 parent 的 subject 恰好为 `pi-checkpoint baseline ref=<同一 ref>`，即 result 与本包为同一 ref 写入的 baseline 相连——仅复制 subject 不算；
- 若当前 session 记录了该 run，entry 中的 `baselineCommit` 与 `resultCommit` 也必须逐字匹配。

边界：任何本地写入者都能构造出这样的 subject 与 parent 关系，Git 无法证明来源。结构校验能挡住意外碰撞（其它工具的 commit、复用了 subject 的手写 commit、属于其它 ref 的 result commit）；但在 `refs/pi/checkpoint/` 下刻意伪造的一对 commit 与真实检查点无法区分，仍可能被清理。该命名空间视为本包所有。

清扫按仓库（`git-common-dir`）进行，因而跨 session：一次清扫可能删掉其它 session 的旧检查点，包括 linked worktree 中的（它们共享同一个 refs 命名空间）。这些 run 的 session entry 与预览不受影响。

- `session_start` 每 session 每仓库执行一次静默、best-effort 清扫，上限 10 秒。不在 worktree 中、找不到 `git`、Git 失败或超时都不会外露：没有通知、没有 session entry、不会让 run 失败。
- `/checkpoint prune` 立即强制清扫并报告 `Pruned N checkpoint ref(s) (E older than 30 days, O beyond the newest 200); M kept`、`Checkpoint prune skipped: ...` 或 `Checkpoint prune failed: ...`。`/checkpoint prune --dry-run` 不删除任何 ref，报告同一计划：`Checkpoint prune (dry run): would delete N of C completed checkpoint ref(s) (...); M would be kept`。
- `M` 只计清扫后仍保留的已完成 ref。只有 baseline 的 ref 与无法识别的 ref 既不计入 `N`、`E`、`O`，也不计入 `M`；存在这类 ref 时，报告会附上「未触碰的 baseline-only ref」数量。
- 删除是一次 `git update-ref --stdin` 批量写入，内容为带条件的 `delete <ref> <commit>` 行，且只作用于形状为 `refs/pi/checkpoint/<sessionKey>/<runId>` 的已完成 ref。Git 整体原子执行该批，并拒绝任何 ref 已不再指向枚举时那个 commit 的行，因此在枚举与删除之间被改写的 ref 不会被删；整批被拒时从新枚举重算一次再试。
- 被截断或被 kill 的枚举结果不用于删除：不完整的 `git for-each-ref` 输出既不会选中也不会删除任何 ref。baseline 查询同理：被截断、被 kill、非零退出或记录歧义时，不选中任何 ref。
- baseline-only ref 不会自动过期，因此崩溃残留可能无限增长。这是已接受的限制：本包无法区分被放弃的 baseline 与其它进程中仍然存活的 run，而删掉活跃 run 的 baseline 会让它的 result 捕获失败。确认没有 run 在使用时，由用户手动清理：
  ```bash
  git for-each-ref --format='%(subject) %(refname)' refs/pi/checkpoint
  git update-ref -d <full-ref>
  ```
  只删除 subject 以 `pi-checkpoint baseline ` 开头的 ref；`result` ref 属于已完成的 run，由保留策略处理。

**不提供 restore，也不主动回收对象。** 本包不会运行 `git gc`、`repack` 或 `prune`。ref 删除后其 commit 变为 unreachable，由 Git 自身的 auto-gc 在 `gc.pruneExpire`（默认两周）之后回收；在此之前对象仍然存在。

Session entry 从不修改也不删除，因此被清扫的 run 在时间线上仍保留已存的摘要与 patch 预览。`/checkpoint <n>` 会用 entry 校验 ref，而不是假设快照仍然完整：可用时保留 diff 命令；ref 缺失或已改写时只打印已持久化的摘要与预览；检查失败时说明无法确认可用性。删除 ref 不等于删除对象，因此在 Git 的 auto-gc 运行之前，可用的 diff 命令通常仍然有效。

## UI 能力

| 方法 | 守卫 | 非 TUI |
|------|------|--------|
| `pi.registerEntryRenderer`（时间线检查点条目） | `none`（renderer 仅由 TUI 消费） | 所有模式仍保留 session entry 与 Git ref，但没有可视化时间线 |
| `ctx.ui.notify`（命令输出、告警） | `none` | RPC 为 fire-and-forget，可能被丢弃；print/json 不保证显示。承载 `/checkpoint <n>` 输出、`/checkpoint prune` 结果（含清扫失败）与捕获告警。核心捕获与 `session_start` 的自动清扫不依赖通知是否送达；清扫本身完全不产生 UI |

## License

MIT
