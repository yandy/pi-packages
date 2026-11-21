# pi-checkpoint 保留与清理设计

## 1. 意图

将 checkpoint 的完整 Git 快照视为有期限的调试数据，将 Pi 会话中的 checkpoint entry 视为长期保留的轻量摘要。清理不再依赖 session 被删除，也不修改、压缩或删除 Pi 会话文件。

默认策略同时限制 checkpoint 的年龄和仓库级数量：

```text
retentionDays = 30
maxRefs = 1000
patchPreviewBytes = 16 KiB
```

`retentionDays` 控制正常过期，`maxRefs` 控制高频使用时的 completed checkpoint refs 总量。Git 对象不由扩展直接删除；删除 refs 后，失去可达性的对象由普通 Git GC 按 Git 自身规则回收。

## 2. 目标与非目标

### 目标

- 在 session 长期存在的情况下，持续回收旧 checkpoint refs。
- 以 Git common dir 为作用域执行全局 TTL 与 LRU，覆盖同一仓库的多个 session 和 linked worktrees。
- 保留会话中的 run 编号、shortstat、有限 diff preview 和 commit/ref 元数据。
- 快照被清理后，查询命令明确区分“仍可用”和“只能查看保留预览”，不输出伪称可靠的 diff 命令。
- 自动删除在配置无效、枚举不完整或 ref 已变化时 fail closed。
- 保留现有捕获语义：每 run 仍有 baseline/result 两个 commit 和一个 ref，无变化 run 也照常记录。

### 非目标

- 不删除或重写 Pi session entries，不为清理追加墓碑 entry。
- 不自动清理 baseline-only refs；它们可能是其他进程的活跃 run，也可能是崩溃残留，不能只凭年龄区分。
- 不实现 restore，不改变工作区、真实 index、HEAD 或普通分支。
- 不执行 `git gc`、`git prune`、`repack` 或 `pack-refs`，不承诺删除 ref 后磁盘立即缩小。
- 不按对象字节数做配额。Git 对象去重与跨 ref 共享使单 ref 字节归因昂贵且容易重复计算。
- 不引入常驻定时器、外部数据库或独立清理守护进程。
- 不自动捕获 ignored 文件，也不通过跳过未忽略大文件来缩减快照。

## 3. 方案取舍

| 方案 | 取舍 | 结论 |
|---|---|---|
| session 删除时清理 | 所有权明确，但 session 通常长期保留，无法控制增长 | 不作为主要机制 |
| 每 session 保留最近 N 条 | 每段对话都有近期快照，但总量随 session 数增长 | 不采用 |
| 仅 TTL | 简单，但高频运行时窗口内 refs 仍可无上限增长 | 不单独采用 |
| 仅全局 LRU | 数量可控，但低峰时旧快照可能长期占用空间 | 不单独采用 |
| 仓库级 TTL + 全局 LRU | 正常过期与数量上限互补，不依赖 session 生命周期 | **采用** |
| 字节配额 | 更接近磁盘目标，但对象共享导致归因复杂 | 留待独立设计 |

不为每个 session 设置永久保护份额。checkpoint 用于近期完整状态追溯，过期后仍保留会话摘要；全局 LRU 可以在超限时清理任何已完成 run，但不清理活跃 run 的 baseline-only ref。

## 4. 配置

保留策略只读取全局文件：

```text
<getAgentDir()>/checkpoint.json
```

示例：

```json
{
  "retentionDays": 30,
  "maxRefs": 1000
}
```

规则：

- 文件不存在时使用默认值 `30 / 1000`。
- 两个字段均可设为正整数或 `null`；`null` 表示关闭对应维度。
- 两者均为 `null` 时禁用自动清理；手动 `/checkpoint prune` 没有候选策略，仅提示未配置保留策略。
- 不读取项目级配置。仓库内文件不能向共享 Git common dir 下发破坏性保留策略。
- 配置在 session start 与手动 prune 时重新读取；不监听文件变化。
- JSON 无法解析、字段类型错误或值越界时，自动清理 fail closed，并给出不含文件内容的警告；捕获功能继续运行。不能以默认值覆盖无效配置后继续删除。
- `patchPreviewBytes` 第一版固定为 `16 * 1024`，不暴露额外配置面。

## 5. 清理作用域与候选模型

### 5.1 仓库身份

- 使用 `git rev-parse --path-format=absolute --git-common-dir` 解析 common dir，并先做 `resolve()` 规范化。
- 每次 sweep 只处理该 common dir 下的 `refs/pi/checkpoint/`。
- linked worktrees 因共享 common dir 而共享同一预算。
- 不根据 session 文件是否存在推断 ref 所有权，也不按 session 分组保留。

### 5.2 completed 与 baseline-only

枚举时使用有上限的 `git for-each-ref` 输出，至少包含：

```text
refname / full object id / committer unix timestamp / commit subject
```

只有 object 为 commit 且 subject 符合本包生成的 `pi-checkpoint result ...` 形式的 refs 才进入 completed 集合。`pi-checkpoint baseline ...` 以及其他无法识别的 refs 不参与自动删除，也不占用 `maxRefs` 的 completed 配额。

输出上限为 16 MiB；输出截断、命令失败或记录无法可靠解析时，本次 sweep 不删除任何 ref。

### 5.3 TTL + LRU 算法

设枚举完成的 completed refs 为 `C`：

1. 计算 `expired = { r ∈ C | r.timestamp < now - retentionDays }`；`retentionDays = null` 时为空。
2. 从 `C - expired` 中按 timestamp 从旧到新排序；timestamp 相同按完整 refname 排序，保证确定性。
3. 若剩余数量超过 `maxRefs`，将最旧的超额部分加入删除集合；`maxRefs = null` 时不做数量清理。
4. 对两个原因的并集执行一次删除计划。dry-run 使用完全相同的计划，但不执行删除。
5. 删除后报告唯一 ref 数量；对象回收交给 Git。

并发运行和 baseline-only refs 可以使实际 ref 数暂时高于预算；`maxRefs` 表示每次成功 sweep 后 completed 集合的目标上限，不是跨进程的实时硬锁。

## 6. 并发与删除安全

- 同一扩展进程内按 common dir 串行执行 sweep；运行期间收到新请求时最多合并为一个后续 sweep，避免扫描风暴。
- 删除使用 `git update-ref --stdin` 的批量 `delete <ref> <oldOid>` 形式，枚举到的 full OID 必须作为 expected-old。
- 不根据 refname 无条件删除。扫描后 ref 若被其他进程更新，对应事务失败，不能把新 result 当作旧候选删除。
- 任一批量删除失败时本次不宣称成功，也不重试为不带 old-OID 的删除；后续 sweep 可重新枚举。
- 不清理其他进程正在使用的临时 index 目录，不删除 baseline-only refs。
- 清理失败不中断 agent run，不改变已捕获的 checkpoint，也不影响后续 run。

## 7. 触发与命令

### 7.1 自动触发

- `session_start`：读取配置并对当前仓库请求一次 sweep。
- `agent_settled`：现有捕获与 entry 追加完成后，对当前仓库请求一次 sweep。
- 非 Git worktree、Git 不可用或两个保留维度均关闭时跳过。
- 自动通知仅用于 best-effort 汇总与告警；功能不得依赖通知送达。

### 7.2 手动命令

命令语法扩展为：

```text
/checkpoint <runNumber>
/checkpoint prune [--dry-run]
```

- `prune` 读取同一全局配置，生成并执行当前仓库的清理计划。
- `prune --dry-run` 只报告将删除的唯一 refs 数量及按 TTL/LRU 分类的候选数量，不修改 refs。
- 参数错误、配置无效或无可用策略时不删除。
- 第一版不提供自动或手动 orphan 清理参数；baseline-only 仍通过 README 中的完整 ref Git 命令由用户显式处理。

## 8. 会话摘要与快照可用性

### 8.1 Entry 兼容

- 保留现有 `version: 1` entry，不重写已有数据。
- 新成功 entry 增加可选 `commonDir?: string`，值来自 result snapshot；旧 entry 没有该字段仍必须正常解析与渲染。
- `shortstat`、`patchPreview`、`previewTruncated`、commit IDs 和 ref 永久保留在 session 中，即使 Git ref 后续被清理。
- renderer 不同步探测 Git，也不承诺在时间线上实时显示 pruned 状态；快照可用性由 `/checkpoint <runNumber>` 在查询时确认。

### 8.2 预览体积

- 新 entry 的持久 patch preview 上限从 128 KiB 降为 **16 KiB**，仍按 UTF-8 安全边界截断并标记。
- 既有 entry 即使含更大的 preview 也照常解析和展示，不做迁移。
- 完整补丁仍通过 Git 获取；扩展本身不把无上限 patch 输出到通知或 stdout。

### 8.3 查询命令

`/checkpoint <runNumber>` 找到成功 entry 后：

1. 使用 entry 的 `commonDir` 验证 ref；旧 entry 缺少该字段时退化为当前 `ctx.cwd`。
2. 只有 ref 能解析为 entry 中的 `resultCommit` 时，才显示原有的完整 ref、baseline/result 与可执行 `git diff <baseline> <result>` 命令。
3. ref 缺失或指向其他对象时，显示 snapshot unavailable，并展示保留的 shortstat/preview。对带 `commonDir` 的 entry 可明确说明快照已清理或不可用；旧 entry 使用“当前仓库中未找到，可能已清理或来源仓库不同”的非断言文案。
4. Git 不可用或验证失败时显示无法确认可用性，不把“验证失败”等同于“已清理”。
5. error entry 保持现有错误展示，不伪造 result 可用性。

## 9. 错误与模式约束

- 清理和查询都只通过现有 `RunGit` 执行，继续清理继承的仓库选择环境变量。
- 所有自动清理错误都隔离于捕获和 agent loop；手动命令通过 `ctx.ui.notify` 返回结果。
- 不新增终端组件或对话框，不新增 RPC 专属 UI 分支；README 的 UI surface 仅补充 prune 命令的通知行为。
- 不把配置内容、环境变量、完整 patch 或敏感文件内容写入清理日志。
- Windows 路径比较必须先 `resolve()`；refname 始终使用 Git 的 `/` 语法，不当作文件系统路径处理。

## 10. 测试与验收

遵循 `docs/guides/testing.md`，使用临时全局配置目录与真实临时 Git 仓库。

### 配置与计划

- 缺省配置、单维度 `null`、全 `null`、非法 JSON/字段值的 fail-closed 行为。
- TTL 边界、确定性排序、先 TTL 后 LRU、两种原因去重。
- `maxRefs` 跨 session 生效；linked worktrees 使用同一 common dir。
- baseline-only、未知 subject、非 commit 和邻近命名空间 refs 不进入候选。
- dry-run 与实际执行使用同一计划，dry-run 前后 refs 不变。
- 枚举输出截断或解析失败时零删除。

### Git 与生命周期

- 删除命令携带 old-OID；ref 在枚举后变化时事务失败，不删除新值。
- 同进程 sweep 串行与请求合并；失败不传播到 capture/agent handler。
- 不调用 `git gc`、`git prune` 或其他对象维护命令。
- session start、settled 和手动命令的触发、无 Git 降级与通知行为。

### 会话与展示

- 新旧 entry 均可解析；`commonDir` 缺失时使用旧兼容路径。
- ref 存活且 OID 匹配时保留原 diff 命令输出；缺失、不匹配和验证失败分别显示正确语义。
- 被清理 entry 的 shortstat 与 preview 仍渲染。
- 16 KiB 多字节 UTF-8 截断不越界、不产生替换字符，旧的大 preview 不受影响。
- 现有捕获、HEAD/index/worktree 不变等测试保持通过。

### 全仓验证

- `pi-checkpoint` test、typecheck、lint 通过。
- 根全仓 test、typecheck、lint 通过。
- `check:dev-deps`、`check:host-deps`、`check:license` 通过。
- Ubuntu 与 Windows CI 通过。

## 11. 文档与实现边界

- 更新 `pi-checkpoint/README.md` 与 `README.zh.md`：默认策略、全局配置、命令语法、completed/orphan 边界、session 摘要语义、16 KiB 预览以及 Git GC 的非即时性。
- 主要新增独立 retention/prune 模块，避免把捕获算法与删除策略耦合；`CheckpointStore` 的 capture API 保持原有职责。
- coordinator 只在成功 snapshot 中补充 `commonDir`，索引层负责生命周期触发与命令编排。
- 具体模块命名、Git 输出字段分隔与通知排版留给实现者，但不得改变上述 fail-closed、old-OID 和会话兼容约束。
