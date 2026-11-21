# pi-checkpoint

pi 的只读 Git 检查点包：在每次完整 agent run 前后捕获整个工作区，并直接从对话时间线追溯这一轮的净差异。捕获过程绝不改变当前分支、`HEAD`、真实 Git index 或工作区文件。

## 功能

- **run 级历史**：一个检查点覆盖 `before_agent_start → agent_settled`，不按每次模型响应或工具调用拆分。同一 busy period 内的重试、压缩重试、steering 和排队 follow-up 属于同一个 run。
- **真实净变化**：捕获整个当前 worktree 中的 tracked 修改、删除、mode 变化和未忽略 untracked 文件；即使 pi 从仓库子目录启动也一样。
- **对话关联**：正常完成、中断和没有代码变化的 run 都产生持久 session entry。entry 不进入 LLM 上下文。
- **只读查看**：折叠条目显示变更摘要；展开条目显示 ref、短 commit ID 和有上限的 patch 预览。
- **故障隔离**：Git 失败留下错误记录，但不会让 agent run 失败；预览失败也不会破坏已捕获的快照。
- **有界保留**：completed checkpoint ref 按 Git common dir 按时间与数量回收；快照被清理后，session entry 仍保留摘要和预览。

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

展开条目即可查看 patch。预览上限为 **16 KiB**；截断会明确标记，不会删除 Git 对象中的任何内容。空差异显示 `No workspace changes`，中断的 run 标记为 `aborted`。renderer 不同步探测 Git，因此时间线不显示快照是否仍然存在。

使用命令：

```text
/checkpoint 3
```

命令会先验证记录的 ref 仍指向记录的 result commit，只有验证通过才返回完整隐藏 ref、baseline/result commit ID，以及可直接执行的命令：

```bash
git diff <baselineCommit> <resultCommit>
```

ref 缺失或指向其他 commit 时，命令打印 `snapshot unavailable` 及原因，并继续展示保留的 shortstat 和预览（旧 entry 中超过 16 KiB 的预览会按显示上限再次截断）；不会把缺失的快照伪装成可用的 diff 命令。Git 无法执行验证时报告 `snapshot unconfirmed`，不会把“验证失败”说成“已清理”。新 entry 记录 Git common dir；缺少该字段的旧 entry 在当前工作目录中验证，并使用不断言快照去向的文案。

无参数或编号非法时显示用法；查询范围是当前对话分支。本包不注册 LLM 工具。

## 保留与清理

完整 Git 快照只在保留策略允许的期限内存在。清理不会重写或删除 session entry：run 编号、shortstat、patch 预览、commit ID 和 ref 都会保留。

### 策略

默认 `retentionDays: 30`、`maxRefs: 1000`。patch 预览固定为 16 KiB，不提供配置面。

```json
{
  "retentionDays": 30,
  "maxRefs": 1000
}
```

- 只读取全局文件 `~/.pi/agent/checkpoint.json`，忽略项目级配置：仓库内的文件不能向共享的 Git common dir 下发破坏性保留策略。
- 文件不存在时使用两个默认值。每个字段接受正整数或 `null`；`null` 关闭对应维度，两者都为 `null` 时完全禁用清理（手动命令只会提示清理已禁用）。
- 配置在 `session_start` 和每次手动 `/checkpoint prune` 时重新读取，不监听文件变化；同一 session 内的自动 sweep 沿用 session start 时加载的策略。
- JSON 无法解析、字段类型错误、非正整数或超出安全整数范围时 fail closed：给出不含文件内容的警告，不删除任何 ref，捕获继续工作。无效配置绝不会回退到默认值。

### 作用域与选择

- 一次 sweep 只处理一个 Git common dir，因此同一仓库的所有 session 和 linked worktree 共享同一份预算。不根据 session 文件推断 ref 所有权，也不为单个 session 预留永久份额。
- 只有 completed ref 参与：ref 必须指向 subject 为 `pi-checkpoint result ref=<完整 ref>` 的 commit。baseline-only ref（`pi-checkpoint baseline ...`）、未知 subject、tag、tree 和 blob 永不被自动删除，也不占用 `maxRefs` 的 completed 配额；baseline-only 可能属于进行中的 run 或崩溃残留，仅凭年龄无法区分。
- 先 TTL：committer 时间早于 `retentionDays` 的 completed ref 入选，且不再占用 `maxRefs` 预算。
- 再 LRU：剩余 ref 按时间从旧到新排序（时间相同按完整 refname），超出 `maxRefs` 的最旧部分入选。
- 两个选择合并去重为一份计划；`--dry-run` 使用完全相同的计划，不改动任何 ref。
- `maxRefs` 是每次成功 sweep 后的目标上限，不是跨进程硬锁：并发 run 和 baseline-only ref 可以让实际数量暂时高于预算。

### 删除安全

删除是一次 `git update-ref --stdin` 事务，每条 `delete` 都以枚举时看到的完整 object ID 作为 expected-old。枚举后 ref 被其他进程更新会让整个事务失败：不宣称删除成功，也不会退化为不带 expected-old 的重试，后续 sweep 会重新枚举。枚举输出被截断或无法解析时同样零删除。

### 自动触发

`session_start` 和每个 run 结算（checkpoint entry 追加完成后）都会为当前仓库请求一次 sweep。不在 Git worktree、`git` 不可用，或两个维度都为 `null` 时跳过。同一 common dir 的 sweep 串行执行；额外的自动请求最多合并为一个排队 sweep。

自动通知是 best-effort，不影响捕获和 agent loop：实际删除 ref 时报告数量及 TTL/overflow 分类；失败给出警告；没有删除时不通知。

### 手动清理

`/checkpoint prune` 重新读取全局配置，并在当前仓库执行同一份计划。`--dry-run` 只报告计划、不触碰 ref：参与计算的 completed 数量、过期数量、超额数量，以及将要删除的唯一 ref 数量。实际执行报告删除了多少个 completed ref，以及相同的分类。

参数错误、配置无效、策略关闭（`retentionDays` 与 `maxRefs` 均为 `null`）或不在 Git 工作区时，不删除任何 ref，并给出警告。

baseline-only ref 不参与自动清理，也没有对应命令参数。确认没有 run 在使用后可显式删除：

```bash
git update-ref -d <full-ref>
```

### Git 对象回收是延迟的

清理只删除 ref。本包不执行 `git gc`、`git prune`、`repack` 或 `pack-refs`，也不承诺磁盘占用立即下降：不可达对象要等普通 Git GC 按 Git 自身规则回收。

## 限制

- **ignored 文件不会被捕获。** 其它 untracked 文件都会写入本地 Git object database。运行前请先 ignore 敏感文件；hidden ref 不是加密或保密边界。
- 隐藏 ref 不出现在普通分支历史中，但 `git log --all`、`git for-each-ref`、备份、对象库副本和 mirror 操作仍可能暴露它们。
- 不递归捕获 submodule 内部，只记录 superproject 的 gitlink 状态。
- sparse checkout、`assume-unchanged` / `skip-worktree` 和特殊嵌套仓库遵循 Git plumbing 行为。无法可靠表示时会报告错误，不会声称已经得到可靠快照。
- 进程在 `agent_settled` 前退出时，可能留下只有 baseline 的 ref。本包不会伪造 result，也永不清理 baseline-only ref；确认没有 run 在使用后可显式删除：

  ```bash
  git update-ref -d <full-ref>
  ```

- 不提供 restore 命令。completed ref 由上面的保留策略清理，但 session entry 在 Git 快照消失后仍作为历史元数据保留。
- 不在 Git worktree 中或找不到 `git` 时跳过捕获，每个 session 最多提醒一次；后续 run 会重新探测。

## UI 能力

| 方法 | 守卫 | 非 TUI |
|------|------|--------|
| `pi.registerEntryRenderer`（时间线检查点条目） | `none`（renderer 仅由 TUI 消费） | 所有模式仍保留 session entry 与 Git ref，但没有可视化时间线 |
| `ctx.ui.notify`（查询输出、清理结果、保留与清理警告） | `none` | RPC 为 fire-and-forget，可能被丢弃；print/json 不保证显示。清理不新增终端组件、对话框或 RPC 专属 UI 分支，捕获与清理都不依赖通知是否送达 |

## License

MIT
