# pi-checkpoint 检查点保留策略设计

给 `refs/pi/checkpoint/*` 增加有界保留与手动清扫，使单个仓库的检查点 ref 数量不再随 run 数线性增长。

## 1. 意图

当前每个 run 产生 1 个 ref 与至少 2 个 commit，且永久保留；唯一的清理方式是用户手动 `git update-ref -d`。这依赖两个不成立的前提：

- **会话文件会被删除。** 实际上 Pi 会话文件通常不删，因此「按 session 存活做所有权 GC」无法约束增长。
- **ref 数量不影响其他 Git 操作。** `git fetch` 的协商与连通性检查、`git for-each-ref`、`git log --all` 都会读取每个 ref 背后的对象；ref 多了之后这些操作变慢，而它们常常出现在用户自己的 hook 里（提交、拉取、语言服务器、agent 的 SessionStart）。linked worktree 共享同一个 refs 命名空间，多 worktree 并行开发时累积更快。

关键事实：**ref 不是查询入口。** run 的 `baselineCommit` / `resultCommit` / `shortstat` / `patchPreview` 都持久化在 session entry 中，`/checkpoint <n>` 与时间线渲染只读 entry。ref 的唯一作用是让这两个 commit 不被 `git gc` 回收。因此删除旧 ref 不会让旧 run 从时间线消失——折叠与展开的预览仍在，只有「从 Git 对象取完整 diff」的能力随之失效。

## 2. 目标 / 非目标

目标：

- 单个仓库的 `refs/pi/checkpoint/*` 数量有界，且不依赖 session 生命周期。
- 清理是幂等的、静默的、失败隔离的；不影响 agent run，也不影响用户仓库的可观察状态（分支、`HEAD`、index、工作区）。
- 失效代价对用户可解释：旧 run 保留会话内预览，完整 diff 可能不再可查。

非目标：

- 不删除 commit/tree/blob，不调用 `git gc` / `repack` / `prune`；对象回收交给 Git 自身。
- 不删除或改写任何 session entry，不做 per-session 配额。
- 不引入配置文件或设置项；两个保留参数是代码内常量。
- 不改变捕获布局、ref 命名、commit 图或 entry schema。
- 不提供 restore。

## 3. 约束

- **每仓库一个 ref。** 现有布局（`refs/pi/checkpoint/<base64url(sessionId)>/<runId>`）不改；`baseline` 与 `result` 写同一个 ref，因此 ref 数等于 run 数。
- **删除必须带 old value。** 写入一*批* `git update-ref --stdin`，每行为 `delete <ref> <enumerated-oid>`：Git 整体原子执行，某行的 ref 已不指向枚举时的 commit（被 `captureResult` 推进成新 result，或被另一个清扫进程改过）时整批拒绝。ref 名包含随机 UUID 永不复用，但「枚举到删除」之间它会被本包自己推进，因此不能再假设 ref 在窗口中静止。
- **失败重算一次。** 整批被拒后重新枚举、用同一个 `now` 重算删除集，再用新 OID 重试一次；第二次失败就抛给清扫器（`failed`）。两个进程并发清扫时，后一个的带 old value 删除会失败，重枚举后已无陈旧 ref，返回 `{ deleted: 0, kept: n }`，因此并发仍然非致命。
- **枚举一次并带 OID。** `git for-each-ref --format='%(committerdate:unix) %(objectname) %(refname)' refs/pi/checkpoint` 同时给出日期、当前 commit 与名称，在仓库子目录执行也覆盖整个 worktree。
- **不完整的枚举一律拒绝。** 枚举进程被截断输出或被 kill（`truncated || killed`）时不解析、不删除，直接抛错让清扫器报 `failed`：截断与退出码存在竞态，部分列表会被当成完整 ref 集合，从而选中从未枚举到的 ref。
- **绝不解引用符号 ref。** 删除事务必须是 `git update-ref --no-deref --stdin`，且枚举用 `%(symref)` 把符号 ref 直接跳过。否则一个指向 `refs/heads/<branch>` 的 checkpoint symref 会让 git 删掉那条分支、而 symref 自身留下。捕获写入 ref 同样使用 `--no-deref`。
- **删除不执行仓库 hooks。** `update-ref` 会触发 `reference-transaction` hook，它可能改动工作区或永久阻塞；删除事务与捕获一样带一个空的临时 `core.hooksPath`。for-each-ref 不触发 hooks，无需隔离。
- **只碰自己的命名空间。** 只删除同时满足「前缀为 `refs/pi/checkpoint/`」与「形状为 `<sessionKey>/<runId>`」的 ref；其他 ref、其他命名空间、形状不符的条目一律不动。
- **不主动回收对象。** 删 ref 后对象变为 unreachable，Git 自身的 auto-gc 在 `gc.pruneExpire`（默认 2 周）后回收。本包不启动 `gc`、`repack`、`prune`，避免在用户仓库里发起长时间、带锁的维护操作。
- **清扫不阻塞会话。** 在 `session_start` 触发，best-effort、静默、带超时；失败不 throw、不 notify、不写 entry。
- **每会话每仓库至多一次。** 以 `git-common-dir` 去重，避免每个会话都重复枚举。扩展实例是每会话一份（子代理会话也加载同一扩展，因而有独立实例），因此去重粒度是「每个会话每仓库一次」，不是进程级。
- **进行中的 run 不靠白名单保护，靠选择规则。** 其 ref 指向的 baseline commit 是 run 开始附近写入且通常属于最新 N 个，所以两条删除规则通常不命中它；清扫器不跟踪活跃 run，也不承诺绝不命中。只要该 ref 的 commit 日期或排序落出保留集，它就会被选中：闲置超过 30 天、run 未结束期间仓库新增至少 200 个更新的检查点、系统时钟回拨、仓库中已存在带未来日期的 ref，都会造成这一结果；同秒时间戳按 ref 名排序，因此「更新」是排序而非保证。此时 ref 可能被删，该 run 随后的 `captureResult` 会因 old value 不匹配而失败，留下捕获错误 entry 而不是 result。

## 4. 方案取舍

| 方案 | 内容 | 结论 |
|------|------|------|
| A 保留期清扫 | 保持一 run 一 ref；按日期 + 数量删旧 ref，删后用会话内预览兜底 | **采用**。只改一件事，就能同时压住 ref 数与对象数的增长 |
| B 降基数（每仓库单 ref 链） | 每轮 result 串进同一条链，ref 数 O(1) | 不采用。链要跨 session、跨 worktree 串接，并发或中途失败会静默造成孤儿提交被 gc；`git log --all` 语义变得难以解释 |
| C 搬出仓库对象库 | 检查点存到 pi 自己的 bare 仓库，用 alternates 指回原 odb | 不采用。用户仓库零 ref，但 `/checkpoint` 的 `git diff <sha>` 退化为 `git --git-dir=... diff`，破坏「可复制粘贴的普通 git 命令」这一既有契约；alternates 在源仓库对象被回收后失效 |

## 5. 保留策略

一个 ref 被删除，当且仅当它不满足保留条件。保留条件（两个都要满足）：

1. `committerdate` 距今不超过 **30 天**；
2. 属于该仓库最新的 **200 个** ref。

即：先按日期截断，再按数量截断，取更严格的一侧。日常活跃仓库（每天几十个 run）由数量上限主导，约保留最近一周；偶尔使用的仓库由日期上限主导。

- 两个常量写死在 `src/` 中（`RETENTION_DAYS = 30`、`MAX_REFS_PER_REPO = 200`），不加设置项。需要调整时改常量并随版本发布。
- `committerdate` 由本包写入（`Pi Checkpoint` 身份），是可信的捕获时间；中断 run 留下指向 `baseline` 的 ref 时，取到的是 baseline 时间。
- **清理是 per-repository 的，跨 session。** 这是有界的必要条件，代价是当前会话的清扫可能删掉其他会话的旧 run。其他会话的 entry 与预览不受影响，`/checkpoint` 会明确提示对象已被回收。
- 数量上限取 200 的依据：ref 数进入「影响 fetch」的区间需要上万量级；200 留出两个数量级余量，同时保证最近一周的完整 diff 基本可用。

## 6. 执行路径

- 新增 `src/retention.ts`：`pruneCheckpointRefs(cwd, options?) => Promise<PruneResult | null>`，`options` 为 `{ runGit?, now?, retentionDays?, maxRefs?, signal? }`，`PruneResult` 为 `{ deleted: number; kept: number }`（`kept` 只计枚举接受且保留下来的 ref）。非 Git worktree 返回 `null`（不视为错误）。
- 仓库解析复用捕获路径的同一套 plumbing（`--path-format=absolute --show-toplevel` / `--git-common-dir`）；`CheckpointStore` 已有的解析逻辑需要暴露或在 retention 内以相同方式实现，两者的仓库身份判断必须一致。
- 流程：枚举（带 OID）→ 过滤出符合形状的 ref → 按日期降序计算保留集（先日期后数量）→ 把删除集按 `delete <ref> <oid>` 行写入一次 `git update-ref --stdin` → 整批被拒则重枚举重算一次再用新 OID 重试 → 返回计数。`deleted` 是成功那一批删掉的 ref 数，`kept` 是该批枚举数减 `deleted`。
- `index.ts`：`session_start` 触发一次 fire-and-forget 清扫（`git-common-dir` 去重）；`/checkpoint prune` 绕过该去重立即执行一次。
- 命令：`/checkpoint prune` 输出删除与保留计数（`ctx.ui.notify`），失败时显示清洗后的短错误；单独 `/checkpoint` 仍显示用法，`/checkpoint <runNumber>` 行为不变。
- `/checkpoint <runNumber>` 增加一次 best-effort 存在性检查（`rev-parse --verify --quiet <ref>`）：ref 已不存在时追加一行说明 ref 已被清扫、`git diff` 可能失效、已存预览仍可用；git 不可用或检查失败时省略该行，不影响原有输出。

## 7. 错误与降级

- 清扫：任何失败（非 Git 仓库、git 缺失、枚举失败、`update-ref` 失败、超时）都静默结束，不产生通知、entry 或异常。超时默认 10 秒，超时后取消子进程。
- `prune` 命令：失败通过 `notify` 报告清洗后的短错误（不含 stack、env、文件内容）。
- 对象已被回收的 run：时间线照常渲染 entry 中已持久化的预览，只有完整 diff 不可取；不因此修改或补写 entry。

## 8. 测试

真实临时 Git 仓库，遵循 `docs/guides/testing.md` 的 mkdtemp、环境恢复与跨平台路径规则。

- 数量边界：`MAX_REFS + k` 个 ref，删除最旧的 k 个，保留最新 `MAX_REFS` 个；恰好等于上限时不删。
- 日期边界：超过 `RETENTION_DAYS` 的 ref 被删；未超过的保留；两个条件同时命中与只命中其一时都按交集处理。
- 幂等：重复清扫不改变结果；删除集中包含已被删掉的 ref 时，整批被拒、重枚举后只删剩下的（计数只算成功那批）。
- 并发与竞态：ref 在枚举与删除之间被推进（`update-ref` 换成新 commit）时，带 old value 的删除不生效，重枚举后该 ref 因日期新而保留；枚举被截断（`truncated`）时不调用 `update-ref`，清扫报 `failed`。
- 继承环境：`GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE` 被外部进程设置时不影响捕获 commit 的 committer date。
- 隔离：`refs/heads`、`refs/tags`、`refs/pi/checkpoint` 之外的自定义命名空间、形状不符的同前缀条目全部保持原样。
- 共享仓库：linked worktree 与主 worktree 看到同一批 ref，清扫任一侧都作用于整仓；同一会话内的 `git-common-dir` 去重使重复 `session_start` 只枚举一次。
- 失败隔离：注入 `for-each-ref` / `update-ref` 失败与超时，会话启动不受影响、无 entry、无异常外泄。
- 命令：`/checkpoint prune` 的计数与错误路径；`/checkpoint <n>` 在 ref 存在/缺失两种状态下的输出差异。
- 回归：捕获路径的既有测试全部保持通过（本设计不改变 layout 与 schema）。

## 9. 文档

- `README.md` / `README.zh.md` 的 `Limits and retention` / `限制与保留策略` 写明：每 run 一个 ref、保留期规则（30 天与最新 200 个的交集）、`/checkpoint prune` 强制清扫、`session_start` 自动清扫、对象回收依赖 Git 自身的 `gc.pruneExpire`，以及对象已回收时旧 run 只剩预览。
- README 与代码不得保留「不自动清理检查点」这类与自动清扫矛盾的表述。

## 10. 已确认决策

- 采用方案 A（保留期清扫），不采用单 ref 链与外置对象库方案。
- 不主动调用 `git gc` / `repack` / `prune`。
- 清理粒度为仓库，跨 session；接受「旧 run 只剩会话内预览、完整 diff 可能不可查」。
