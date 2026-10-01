# pi-memory v2 — Per-Entry Storage 设计

> 来源：与 Claude Code 2.1.286 auto memory 的逐项对比分析（28 项 gap）。
> 本设计的核心是**更换存储模型**：从「topic 文件内含多个 `##` 条目」改为「一个 entry 一个文件」，并据此重写写入路径、注入路径与提取流程。
> 破坏性变更，落地版本 **2.0.0**。

**日期：** 2026-10-01
**状态：** 待 review

---

## 1. 背景

### 1.1 现状

pi-memory 1.4.0 的存储模型是 v3 设计定下的「每 topic 一个文件，文件内含多个 `## Entry` 段」：

```
~/.pi/memory/git/github.com__owner__repo/
  MEMORY.md          # 每 topic 一行：- [Name](debugging.md) — hook
  debugging.md       # 内含 ## SSH Gotcha / ## MySQL Timeout 等多个条目
```

### 1.2 这个模型的结构性缺陷

MEMORY.md 里一行要概括一个 topic 下的全部条目，而这一行是**唯一每轮进入模型上下文**的记忆文本。条目数越多，这一行越不可能表达全部语义。当前实现用 `entries.map(e => e.title).join("; ").slice(0, 150)` 生成它（`src/memory-tool.ts:101-105`），后果是：

- 第 4 条之后的条目被 150 字符**硬切**掉 —— 对未来会话静默消失，无任何提示；
- `hook`（索引行）与 `description`（frontmatter，供侧查询）被写成同一个值，而两者的消费者与预算完全不同；
- `src/inject.ts` 的侧查询又对 description 做 `slice(0,80)` 二次截断，实际判别依据只有 80 字符。

这不是实现 bug，是**存储粒度与索引粒度不匹配**的必然结果。Claude Code 没有这个问题，因为它是 one memory per file。

### 1.3 目标

1. 采用 CC 的存储语义：一个 entry 一个文件、索引一行一个 entry、读写同口径 200 行 / 25KB。
2. 消除 memory 目录的双写入路径，使写入可加锁、可快照、可回滚、可单测。
3. 修复 P0 级正确性问题：并发覆盖、数据丢失、prompt injection、幂等缺失、compaction 后 `injectedTopics` 不复位。
4. 提升提取保真度与用户可见性。

### 1.4 非目标

- 不引入子 agent 独立记忆（CC 的 `memory: user|project|local`）。
- 不实现 `/memory` 的交互式浏览/编辑/删除 TUI。
- 不做 `/memory on|off` 持久化、环境变量禁用开关。
- 不做 memory 目录的 retention 清理与孤儿目录 GC。
- 不做索引的 type 分组（保持平铺）。

---

## 2. 决策记录

| # | 决策 | 理由 / 被否决的选项 |
|---|---|---|
| D1 | 一个 entry = 一个文件 | 消除「一行概括 N 条」的合成问题；对齐 CC。**否**：保留 topic 多条目 + 双字段（H2）—— 仍需维护 hook 与条目的一致性，且并发追加会互相覆盖 hook |
| D2 | 索引一行一个 entry | 与 D1 配套。**否**：每 topic 一行（旧模型） |
| D3 | 读写同口径 200 行 / 25KB | D1 使索引行数 = entry 数，20 行的注入预算下只有前 20 个记忆可见，比现状更糟。CC 的「一行一记忆」本就与 200 行/25KB 配套 |
| D4 | 抽 `src/memory-store.ts` 作为唯一写入通道 | 当前存在两条互不相识的写入路径（工具走 `withFileMutationQueue`，dream 走裸 `read/write/edit`），这是并发覆盖的根因。逐项打补丁会让锁与快照逻辑重复两份 |
| D5 | 单一 `description` 字段，取消 `hook` | D1 之后两者描述同一个记忆，无区分必要 |
| D6 | 索引行分隔符保留 `—` | 无实际互操作收益；可复用现有解析器与测试资产 |
| D7 | 新增 `created`，`updated` → `modified`（ISO 8601） | 对齐 CC，且能表达记忆新旧 |
| D8 | 索引保持平铺，不按 type 分组 | 用户明确排除 |
| D9 | 索引满 200 行后：写入成功 + 向模型返回可操作错误 | 对齐 CC。D3 已让注入预算能显示 200 行，所以这个上限是诚实的 |
| D10 | 迁移在首次 `session_start` 自动执行 | 避免用户升级后记忆「消失」 |
| D11 | 净化只在注入时进行，不改磁盘内容 | 磁盘文件必须保持用户可读可编辑的原始形态 |
| D12 | 每个 agent session 只注册它自己的工具子集 | dream 的 `rename` / `rebuild_index` 只在 dream 的 headless session 内注册，不进主 agent 的 schema —— 既省每轮上下文，也避免主 agent 误用破坏结构的能力 |
| D13 | 索引 section 的值在**整个 session 内不变** | `diffSystemPromptSections` 在内容恒等时返回 `undefined` → 一条消息都不追加。而 `memory_index` 是 system prompt 的**最后一段**，一旦值变化，折叠路径（Anthropic 默认）下其后的**整段对话**失去缓存。理由的完整推导见 §9.1(b) |
| D14 | 索引来源：新 session 从磁盘读；`resume`/`fork`/`reload` 用 transcript 的录制值；`session_compact` 从磁盘重读 | 冻结保证缓存；compaction 是边际缓存成本最低、收益最高的唯一刷新点 |

---

## 3. 存储布局

```
~/.pi/memory/git/<host__owner__repo>/
  MEMORY.md                     # 索引，一行一个 entry
  use-real-db-in-tests.md       # 一个 entry 一个文件
  ssh-port-staging.md
  .lock                         # 跨进程锁
  .migrated                     # 迁移完成标记
  .dream-meta.json              # 上次 dream 时间与 session 数
  .backups/<ts>/                # 写前快照
  sessions/                     # 可选：headless session 落盘（sessionPersistence.enabled）
```

`local/<absolute-path>/` 布局不变。

### 3.1 Entry 文件格式

```markdown
---
name: Use real DB in tests
description: 集成测试必须连真实 PostgreSQL，不要 mock
type: feedback
created: 2026-10-01
modified: 2026-10-01T09:12:33.123Z
---
集成测试必须连真实 PostgreSQL。mock 曾在上季度掩盖过 migration 顺序问题。
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 人类可读标题。索引行的链接文本；`remove` / `replace` 的定位键 |
| `description` | 是 | 一行摘要。同时用于索引行与侧查询清单。建议 ≤ 200 字符 |
| `type` | 是 | `user` / `feedback` / `project` / `reference`，缺省 `feedback` |
| `created` | 是 | `YYYY-MM-DD` |
| `modified` | 是 | ISO 8601 带时间戳。**由 store 写入，不接受调用方传入** |

正文即条目内容，**不再有 `## Title` 段落**。

### 3.2 文件命名

由 `name` 派生，保留 Unicode（中文标题直接作为文件名）：

1. 替换文件系统不安全字符 `/ \ : * ? " < > |` 与控制字符为 `_`；
2. 去除首尾空白与 `.`；折叠连续空白为 `-`；
3. 结果为空、或为 `.`/`..` → 回退 `entry-<sha256(name) 前 8 位>`；
4. 截断到 100 字节（按码点边界）；
5. 冲突时追加 `-2`、`-3`……（检测方式为目录内已存在同名文件，或在同一批写入中已分配）。

碰撞与截断的结果必须**确定**（同一 `name` 在同一目录状态下总是得到同一文件名），否则 `remove` 无法定位。

### 3.3 索引格式

```markdown
# Memory Index
- [Use real DB in tests](use-real-db-in-tests.md) — 集成测试必须连真实 PostgreSQL，不要 mock
- [SSH port staging](ssh-port-staging.md) — staging 的 SSH 用 2222 端口
```

- 一行一个 entry，顺序为**追加顺序（升序）**。
- 选择升序而非「最新在前」的理由：行位置稳定，§8 的按行外科式修改才不会因重排而失效。截断风险由 D9（超限报错）兜底。
- 无法被解析的行（例如用户手写的 `## Project` 分组标题、注释）在索引写入时**原样保留**，不被丢弃。

---

## 4. `src/memory-store.ts`

唯一写入通道。所有对 memory 目录的修改都经由它。

### 4.1 只读 API

```ts
interface EntrySummary { file: string; name: string; description: string; type: EntryType; modified: string; }
interface Entry extends EntrySummary { created: string; body: string; }

listEntries(): Promise<EntrySummary[]>              // 走 §9.2 的进程内缓存（缓存由 store 持有并维护）
readEntry(ref: string): Promise<Entry>              // ref = 文件名或 name
readIndex(): Promise<string>                        // MEMORY.md 原文
searchEntries(query: string): Promise<Entry[]>
```

### 4.2 写原语

```ts
addEntry(input: { name: string; description?: string; type?: EntryType; body: string }): Promise<{ file: string }>
replaceEntry(ref: string, patch: { name?: string; description?: string; type?: EntryType; body?: string }): Promise<{ file: string }>
renameEntry(ref: string, newName: string): Promise<{ file: string }>   // 改名 + 改文件名 + 改索引行
removeEntry(ref: string): Promise<void>                                 // 删文件 + 删索引行
rebuildIndex(): Promise<void>                                           // 从目录重建 MEMORY.md
withLock<T>(op: string, fn: () => Promise<T>): Promise<T>
```

所有写原语内部一律：`withLock` → 快照 → 读 → 改 → 写 → 更新缓存 → 释放。

`description` 缺省时由 store 从正文首句派生（首个句号/换行前，截断到 200 字符）。

### 4.3 谁用什么

| 调用方 | 可用原语 | 注册范围 |
|---|---|---|
| `memory` 工具（主 agent） | `addEntry` / `replaceEntry` / `removeEntry` / `searchEntries` / `listEntries` | 进程级 `pi.registerTool()`，**仅这 5 个 action** |
| extract 子 agent | 同上 5 个 action | **仅其 headless session**（作为 `customTools` 传入 `createAgentSession`） |
| dream 子 agent | 全部 7 个 action（额外 `rename` / `rebuild_index`） | **仅其 headless session**（同上） |
| auto-surfacing 侧查询 | 只读 | 无任何工具 |
| 迁移 | `withLock` + 目录级操作 | 不涉及工具 |

**注册范围是硬约束（D12）**：工具定义由 `createMemoryTool(deps, { actions: [...] })` 按 session 构建。`rename` 与 `rebuild_index` **不得**出现在主 agent 与 extract 的 schema 中；反之 extract 也不需要它们。

dream **不再**拥有 `write` / `edit` / `ls` / `bash`。它的重构能力边界由上述原语定义：合并两条 = `replaceEntry(目标, 合并正文)` + `removeEntry(另一条)`。

---

## 5. 锁与并发

### 5.1 锁文件

`.lock`，JSON 内容：

```json
{ "pid": 12345, "hostname": "h", "startedAt": "2026-10-01T09:12:33.123Z", "op": "dream" }
```

- 获取（**必须原子**）：先把持有者信息写进同目录的唯一临时文件 `${lockPath}.<pid>.<n>.tmp`，再 `link(temp, lockPath)`；`EEXIST` 即未获取，`finally` 清理临时文件。
  **不得**用 `open(lockPath, "wx")` 后紧接着单独写内容 —— 那会让锁路径出现「存在但 0 字节」的中间态，而 `readLockInfo` 读到空文件会返回 null、`isStale(null)` 恒为 true（pid 与 TTL 检查根本不会执行），并发等待者恰好采样到这个窗口就会删掉刚被正确获取的锁并据为己有。
- 失败时读取持有者信息（**必须做形状校验**：合法 JSON 但不是锁记录、如 `123` / `{}`，一律当作无法解释的锁 → 可回收；否则 `isStale` 会因 hostname 非字符串而跳过 pid 检查、又因 `Date.parse(undefined)` 是 NaN 而跳过 TTL 检查，锁永远不会变 stale）：
  - 同 host 且 `pid` 不存活 → stale（只有 `ESRCH` 算死亡；`EPERM` 与意外 errno 一律按存活 —— 「误判为存活」最多等到 TTL 兜底，「误判为死亡」却会删掉活持有者的锁）；
  - 或 `now - startedAt > lock.ttlMs`（默认 10 分钟）→ stale；
  - stale 则删除并重试一次；仍失败则按等待策略处理。
- **续约（心跳）**：持有期间每 `max(1000, ttlMs / 2)` 毫秒以「临时文件 + `rename`」原子刷新 `startedAt`（同样不得直接 `writeFile` 覆盖）。这样上面的 TTL 只对**不再续约**的持有者（崩溃、挂死）生效 —— 否则一个健康但耗时超过 TTL 的长任务（dream 跑满 10 分钟）会被别的写者抢锁，而抢锁者的锁又会被原持有者的 `finally` 删掉，级联出两个写者同时进临界区。
- 释放：`finally` 中删除，但**仅当锁仍是自己持有的才删**（比对持有记录的 pid / hostname），否则留给真正的持有者；在途的续约不得在释放之后再落回。进程被 kill 时靠 stale 检测回收。

### 5.2 等待策略

| 调用方 | 策略 |
|---|---|
| `memory` 工具（主 agent 同步调用） | 轮询等待，总超时 `lock.timeoutMs`（默认 5000ms），超时抛出明确错误：`Memory is locked by <op> (pid N, started ...)` |
| extract 子 agent | **不等待**。检测到锁存在即跳过本轮（后台任务，静默跳过合理） |
| dream | 等待，超时 `lock.dreamTimeoutMs`（默认 30000ms），超时报错 |
| 迁移 | 等待，超时 `lock.dreamTimeoutMs`（默认 30000ms），超时报错 |

### 5.3 锁解决的具体问题

- 两个 session 同时 nudge 出 dream → 第二个会等待或超时失败，不会并发重写。
- dream 与 extract 的写入竞争 → 两者走同一把锁。

---

## 6. 快照与回滚

- 备份位置：`.backups/<ISO ts>/`（文件名中的 `:` 替换为 `-`）。
- 粒度：
  - `addEntry` / `replaceEntry` / `renameEntry` / `removeEntry`：仅备份被修改的 entry 文件与 `MEMORY.md`。
  - `rebuildIndex`：备份 `MEMORY.md`。
  - dream：进入时对整目录做一次快照；该次 dream 内各原语的逐文件快照**跳过**（避免同一批变更产生多份重复备份）。
  - 迁移：整目录快照到 `.backups/migrate-<ts>/`，原 topic 文件额外保留在 `.backups/migrate-<ts>/originals/`。
- 保留策略：按时间排序保留最近 `lock.snapshotKeep`（默认 5）份，其余删除。
- 快照失败视为写入失败（fail-closed）。

---

## 7. 工具 schema 变更（破坏性）

### 7.1 `memory` 工具

```
memory(
  action: "add" | "replace" | "remove" | "search" | "list",
  name?:        string,   // 标题。add 时必填；replace/remove 时作为定位键
  description?: string,   // 一行摘要；缺省由 store 从正文派生
  type?:        "user" | "feedback" | "project" | "reference",
  content?:     string,   // 正文。add/replace 时必填
  query?:       string,   // search
  scope?:       "memory" | "sessions"   // search
)
```

**移除的参数：** `title`、`topic`、`entry`。

- `add`：新建 entry 文件 + 追加索引行。
- `replace`：按 `name` 定位，覆盖正文/摘要/类型；若 `name` 变化则改名并移动文件。
- `remove`：按 `name` 定位，删文件 + 删索引行。
- `list`：列出全部 entry 的 `name` / `description` / `type` / `modified`。
- `search`：`scope=memory` 全文搜索；`scope=sessions` 检索历史 session（行为不变）。

> 这是**主 agent** 的 action 集合（5 个）。dream 额外拥有 `rename` / `rebuild_index`，但仅在 dream 自己的 session 内注册（D12、§12.1），**不出现在上述 schema 中**。

### 7.2 幂等

`add` 遇到 **`name` 精确相同**的 entry 时覆盖该 entry，不追加重复行。仅**文件名**冲突（不同 `name` 派生出同一文件名）时按 §3.2 追加 `-2` 后缀，**不覆盖、不合并**。这消除了旧实现中「重复写入后 `remove` 报 `Multiple matches` 无法删除」的问题。

### 7.3 提示词与指引

- 工具的 `description`、`promptSnippet`、`promptGuidelines` 全部重写：不再提 topic，不再说「只有索引标题会进上下文」。
- 新指引要点：一个记忆一个文件；`description` 必须自包含（它是侧查询的唯一判别依据）；`name` 需唯一且可读。

---

## 8. 索引写入

### 8.1 外科式按行修改

索引写入不再整文件重建。规则：

1. 解析出所有可识别行（`- [name](file.md) — description`）及其行号；
2. 结构性操作：
   - 新增 entry → 在最后一条可识别行之后追加一行；
   - 更新 entry → 只替换对应那一行；
   - 删除 entry → 只删除对应那一行；
3. **所有无法识别的行（`# Memory Index` 标题、用户手写的 `## 分组`、空行、注释）保持原位置与原文不变。**

这消除了旧实现「`serializeIndex()` 整文件重建导致手写内容被抹掉」的问题。解析失败的行数在 `/memory` 状态里报告，不再静默丢弃。

### 8.2 容量（D9）

- 写入后统计索引行数与非空字节数。
- 超过 `memIndexMaxLines`（200）/ `memIndexMaxBytes`（25600）时：**写入仍然成功**，但工具返回可操作错误，要求模型重写索引（合并、删除陈旧 entry、把细节移入正文）。
- 错误文案需包含当前值与限额，并给出明确动作。

### 8.3 注入截断

- 注入时按 `memIndexInjectMaxLines` / `memIndexInjectMaxBytes`（与写入同值：200 / 25600）截断，截断时追加 `[truncated: N lines omitted]` 标记。

---

## 9. 注入（`before_agent_start`）

### 9.1 索引注入：section + 会话内冻结（compaction 例外）

#### (a) 用 section 而非全量替换

不再是 `return { systemPrompt }`，而是就地修改可变对象：

```ts
event.systemPromptOptions.sections["memory_index"] = indexSnapshot;   // 已 sanitize
```

section 名必须匹配 `/^[a-z][a-z0-9_-]*$/`（pi 的约束），渲染为 `<memory_index>…</memory_index>`。

#### (b) 为什么「中途改变索引」很贵：三层机制

**第一层 —— diff 只产出 patch。** `diffSystemPromptSections(previous, current)`（`dist/core/system-prompt.js`）逐 section 比较，只把变化的键放进 patch；**全部相同时返回 `undefined`**，此时 pi 一条消息都不追加。

**第二层 —— patch 是一条追加的 system 消息。** `_preparePromptAndToolLoadout`（`dist/core/agent-session.js`）在 sections 有变化时返回 `{ role: "system", content: "", sections }` 并追加到对话。

**第三层 —— provider 决定这条 patch 是「追加」还是「被折叠回头部」。** `resolveTranscript(context, supportsMidConvoSystemMessages)`（pi-ai）：

```js
function collapseSystemMessages(context){
  const head = getCurrentSystemMessage(context.messages);   // 按顺序重放所有 system 消息的 sections，取最终值，保留原位置
  return { messages: head ? [head, ...context.messages.filter(m => m.role !== "system")] : messages };
}
function resolveTranscript(context, supportsMidConvoSystemMessages){
  return supportsMidConvoSystemMessages ? context : collapseSystemMessages(context);
}
```

`supportsMidConvoSystemMessages` 默认 **false**（`anthropic-messages` 与 `azure-openai-responses` 均为 `model.compat?.supportsMidConvoSystemMessages ?? false`；另一批 provider 在 pi-ai 内部硬编码 `true`）。

**关键位置事实**：`buildSystemPromptSections` 的插入顺序为 `preamble → tools → rules → docs → addendum → project_context → skills → cwd → 自定义 sections`。自定义 section **最后插入**，因此 `memory_index` 是 system prompt 的**最后一段**，其后紧跟全部对话消息。

于是索引值变化时：

| 情形 | 后果 |
|---|---|
| 折叠路径（Anthropic 默认） | 头部尾部被改写 → 缓存从 `memory_index` 处失效，**其后是整个对话历史** |
| 非折叠路径 | patch 作为独立消息追加 → 前缀保留，但每条 patch 永久留在对话里，反复变更会累积 token |
| 全量 `forceSystemPrompt`（旧实现） | 头部 = 每轮渲染的完整 prompt，任何变化都从 **position 0** 失效 |

#### (c) 冻结与唯一的例外

因为 `diffSystemPromptSections` 在内容不变时返回 `undefined`，**只要 section 的值在整个 session 内不变，就一条 patch 都不会产生，折叠后的头部逐字节稳定，缓存完整命中**。这就是冻结的全部价值 —— 不是省一次文件读，而是让 system prompt 绝对不变。

索引值的来源规则：

| 场景 | 来源 | 理由 |
|---|---|---|
| `startup` / `new`（无录制值） | 从磁盘读 | 全新 session |
| `resume` / `fork` | **录制值**（从该 session 的 transcript 重放得到） | 保持父会话/被恢复会话的头部不变 |
| `reload` | **录制值**（同上） | 扩展重载不应改写 system prompt |
| `session_compact` | 从磁盘**重读**并覆盖 | compaction 已重写对话中段，边际缓存损失最小；长会话到中期往往已积累新记忆，刷新收益最大 |

实现要点：读录制值需重放 transcript 的 system 消息。`ctx.sessionManager` 暴露 `getEntries` / `getLeafId` / `buildContextEntries`，包根另导出 `sessionEntryToContextMessages`；据此按 pi 的 patch 语义重放即可得到 `sections["memory_index"]`。重放规则：逐条 system 消息遍历其 `sections`，`value === null` 表示**删除该 section**（`Map.delete`），否则覆盖其值并保留首次插入位置。

**必须避开的陷阱（`null` 语义）**：pi 用 `null` 表示「该 section 不存在」，`diffSystemPromptSections` 在「上一状态有、当前状态没有」时会生成 `patch[name] = null`，重放时 `sections.delete(name)`。因此在 `before_agent_start` 中**必须无条件把 `memory_index` 放进 `event.systemPromptOptions.sections`**（值为冻结值），**不得**因为「本次是 resume/fork，不想动它」而省略这个键 —— 省略等于声明「该 section 不应存在」，后果是索引被从 system prompt 中**静默删除**。「不想改」只能靠「喂回与录制值逐字节相同的值」实现。同理，重放中遇到 `null` 时按「拿不到该键」处理并回退磁盘读，不得将 `null` 当作录制值回填。

**若重放拿不到该键**（例如更早版本的 session），回退为从磁盘读。

语义代价（有意接受）：同一会话内看不到本轮新增的记忆（extract / `memory add` 服务的是未来会话，工具返回值已确认写入）；后果是 compaction 之后视图会刷新一次。

> **与原分析 #8 的差异**：原分析建议「compaction 后从磁盘重注入」。本设计保留 compaction 的重注入，但**拒绝在其余任何时点刷新**（含 resume/fork），并把 D13 的理由从「缓存前缀失效」修正为上面的三层机制 + 位置事实。compaction 相关修复同时包含清空 `injectedTopics`（§9.3、§10）。

### 9.2 侧查询清单缓存

现状 `scanTopics()` 每个用户消息都 `readdir` + 读取全部 topic 文件取 frontmatter（最多 200 次 `readFile`/轮）。

改为进程内缓存：

```ts
Map<filename, { mtimeMs: number; name: string; description: string; type: string }>
```

- 每轮 `readdir` + 对每个文件 `stat`；`mtimeMs` 未变则复用缓存的 frontmatter，不读文件内容。
- 首次（首轮）仍读全部文件，此后每轮只付 `readdir` + `stat` 成本。
- 不引入持久化缓存文件，避免与手工编辑产生漂移。

### 9.3 自动浮现（auto-surfacing）变更项

流程保持：清单 → 侧查询选 ≤ `maxFiles` 个 entry → 注入 `<relevant_memories>`。

- 清单单位由 topic 改为 entry；description 不再被 `slice(0,80)` 二次截断（改为按清单总预算均分）。
- session 内去重集合 `injectedTopics` 改存 entry 文件名。
- 子 agent 中仍不启用（沿用 `<active_agent name="` 检测）。

---

## 10. 生命周期

| 事件 | 行为 |
|---|---|
| `session_start` | 加载配置；解析 memoryDir；若需迁移则执行迁移（§15）；**确定索引来源并冻结**（`startup`/`new` 读磁盘；`resume`/`fork`/`reload` 重放 transcript 取录制值）；注册 `memory` 工具（仅首次，5 个 action）；重建侧查询缓存；nudge 检查 |
| `before_agent_start` | 赋 `sections["memory_index"] = indexSnapshot`（冻结值，**不重读磁盘**）；auto-surfacing（main session 且非 subagent） |
| `agent_end` | 触发 extract（异步，行为见 §11） |
| `session_compact` | **清空 `injectedTopics`**（compaction 会把已注入内容挤出上下文，不清空则该 entry 本会话再也不会浮现）；**并从磁盘重读索引覆盖 `indexSnapshot`**（D14，唯一的会话内刷新点） |
| `session_shutdown` | 等待进行中的写操作收尾（上限 `lock.timeoutMs`），避免留下 stale 锁。`.dream-meta.json` 由 dream 运行器在完成时写入，不在此处处理 |

---

## 11. 提取（extract）保真度

### 11.1 现状问题

`src/extract.ts:26-27` 只取 `messages.find(role === "user")` 与 `messages.findLast(role === "assistant")`，即**本轮第一条 user 消息 + 最后一条 assistant 消息**。中间的纠正、工具调用与工具结果全部丢失。

### 11.2 新设计

传给 extract agent 的是本轮**完整**消息序列的**结构化渲染**，而非两条消息拼接：

```
=== Conversation ===
[1] user: <全文>
[2] assistant: <文本> | tool_call: memory(action="list")
[3] tool_result: <摘要，截断到 N 字符>
[4] user: <纠正/追加指令>
...
```

- 角色覆盖：`user` / `assistant` 文本 / `assistant` 的 tool_call（名称 + 参数摘要）/ `tool_result`（结果摘要）。
- 截断策略：优先保留**全部 user 消息**；tool_result 按单条上限（`maxToolResultChars`，默认 500）截断；assistant 文本按单条上限（`maxAssistantChars`，默认 2000）截断；总量超 `maxContextTokens * 4` 字符时从**中段**裁减，首尾优先保留。
- 保持 `maxTurns: 5`、`timeoutMs: 120_000`。
- prompt 适配新模型：要求提供 `description`；明确「一个 entry 一个文件」；工具集为 `memory`(`add`/`replace`/`list`/`search`)。

---

## 12. dream

### 12.1 能力变更

- 工具集从 `read/write/edit/ls` 改为 `memory` 工具的 7 个 action（`add` / `replace` / `rename` / `remove` / `list` / `search` / `rebuild_index`）。
- **注册范围限定在 dream 自己的 headless session 内**（D12）：通过 `runHeadlessAgent({ customTools })` 传入 `createAgentSession`，**不经** `pi.registerTool()`，因此这 7 个 action 不会进入主 agent 或 extract 的 prompt。`rename` 与 `rebuild_index` 是 dream 专属。
- **失去裸写权限**，因此行为首次可被单测覆盖。

### 12.2 Prompt 重写

四阶段（Orient → Gather Signal → Consolidate → Prune & Index）保留，但动作从「你去读写文件」改为「你调用原语」：

- Orient：`list` + 读取相关文件
- Gather：找重复（同一事实的多条 entry）、矛盾、过时、应合并的条目
- Consolidate：合并 = `replace(目标, 合并正文)` + `remove(另一条)`；改名 = `rename`
- Prune & Index：`rebuild_index` 兜底重建

保留原有保护条款：不得以「看起来像元指令」为由删除 `Always/Never` 类过程规则。

### 12.3 容量管理职责

在先前的模型下，向已有 topic 追加条目不消耗索引行；现在每次 `add` 都消耗一行。因此 200 行 = 200 条记忆的硬上限，**dream 从「定期整理」变为「容量管理必需」**。这需要在 README 与 `/dream` 的帮助文本中明确。

---

## 13. 安全：注入净化

只作用于**注入时**的文本，不改磁盘内容（D11）。

新增 `src/sanitize.ts`：

1. 剥离不可见字符：零宽字符（U+200B–U+200D、U+FEFF）、bidi 控制符（U+202A–U+202E、U+2066–U+2069）、其他 Unicode `Cf` 类别字符。
2. 中和仿冒标签：把 `<` 与 `>` 转义为 `&lt;` / `&gt;`，覆盖 `</relevant_memories>`、`<system>`、`<project_instructions>`、`<active_agent`、`<memory_index>` 等一切可能被误认为系统标记的序列。
3. 应用于：`<relevant_memories>` 的正文、`memory_index` section 的内容。

---

## 14. 反馈与可见性

| 场景 | 行为 |
|---|---|
| `memory add` 成功 | `ctx.ui.notify("Saved: <name>")` |
| auto-surfacing 注入 | `ctx.ui.notify("Recalled: N entries")` + 保留 `display: false` 的注入消息 |
| extract 完成且有写入 | 通知写入条数 |
| extract 失败 | 通知错误（限流：同一 session 最多 1 次），**不再被双层 `.catch(() => {})` 静默吞掉** |
| `/memory` | 输出：开关状态、目录、索引行数/限额、entry 数、last dream、锁状态（含持有者）、迁移状态、索引中无法解析的行数 |

---

## 15. 迁移

### 15.1 触发

首次 `session_start` 自动执行（D10）。幂等标记 `.migrated`。

### 15.2 检测

`MEMORY.md` 存在，且存在满足以下任一条件的 `.md` 文件（`MEMORY.md` 除外）：包含 ≥ 2 个 `## ` 段，或 frontmatter 含旧字段 `updated`（而非 `modified`）。

### 15.3 步骤

1. 取锁（`op: "migrate"`，超时 30s）。
2. 整目录快照到 `.backups/migrate-<ts>/`；原 topic 文件额外复制到 `.backups/migrate-<ts>/originals/`。
3. 对每个需要迁移的文件：
   - `parseEntries()` 得到 N 个条目；
   - N ≥ 1：为每条生成一个 entry 文件。`name` = 条目标题；`description` = 条目标题；`type` = 原文件 frontmatter 的 `type`；`created` / `modified` = 原 `updated`；正文 = 条目内容。
   - N = 0（只有 frontmatter 无正文）：不生成 entry，从索引移除，原文件留在备份中。
   - 文件名按 §3.2 生成；**文件名**冲突按 `-2` 递增。
   - **`name`** 跨文件重复时，第二条及以后追加 ` (2)`、` (3)` 后缀，保证 `name` 在目录内唯一（`remove` / `replace` 依赖它定位）。
4. `rebuildIndex()`。
5. 原 topic 文件从 memory 目录移除以避免重复计入（已保留在备份中）。
6. 写 `.migrated`（内容含时间与迁移条目数），释放锁。
7. 通知用户：`Migrated N memories from M topic files. Backup at <path>`。

### 15.4 失败处理

任一步骤失败：不写 `.migrated`，保留备份，抛出明确错误并通知用户。下次 `session_start` 重试。因为幂等标记未写且快照存在，重跑安全。

### 15.5 回滚

文档化手工回滚：从 `.backups/migrate-<ts>/originals/` 恢复原 topic 文件，删除 `.migrated` 与生成的 entry 文件。README 提供命令。

---

## 16. 配置变更

```jsonc
{
  "enabled": true,
  "memoryDir": "~/.pi/memory",
  "memIndexMaxLines": 200,
  "memIndexMaxBytes": 25600,
  "memIndexInjectMaxLines": 200,      // 由 20 改为 200（D3）
  "memIndexInjectMaxBytes": 25600,    // 由 3072 改为 25600（D3）
  "lock": {
    "timeoutMs": 5000,
    "dreamTimeoutMs": 30000,
    "ttlMs": 600000,
    "snapshotKeep": 5
  },
  "defaults": { "sessionPersistence": { "enabled": false } },   // defaults.model 保留：缺省时回退父会话模型
  "dream": { "nudgeAfterSessions": 5, "nudgeAfterHours": 24, "model": "auto", "thinkLevel": "high" },
  "sessionSearch": { "maxSessions": 10, "maxMatches": 5 },
  "autoSurfacing": {
    "enabled": true, "model": "auto", "thinkLevel": "off",
    "maxFiles": 3, "maxEntryBytes": 3072, "maxInjectionBytes": 10240
  },
  "extractMemories": {
    "enabled": true, "model": "auto", "thinkLevel": "high",
    "maxContextTokens": 2000,
    "maxToolResultChars": 500,
    "maxAssistantChars": 2000
  }
}
```

- `autoSurfacing.maxTopicBytes` → 重命名为 `maxEntryBytes`（语义变化，旧键忽略）。
- 新增 `lock` 段（含 `dreamTimeoutMs`）；新增 `extractMemories.maxToolResultChars` / `maxAssistantChars`。

---

## 17. 数据流

```
session_start
  ├ 加载配置 / 解析 memoryDir
  ├ migrateIfNeeded()  ── 需要则迁移（持锁 + 快照）
  ├ 确定索引来源：startup/new 读磁盘；resume/fork/reload 重放 transcript 取录制值
  │                  → sanitize → indexSnapshot（会话内冻结，D13）
  ├ 重建侧查询缓存（读全目录）
  ├ registerTool(memory, 5 actions)  ── 仅首次
  └ nudge 检查 → 用户确认 → runDream（持锁，原语化；7 actions 仅注册于其 session）

before_agent_start（每个用户回合）
  ├ sections["memory_index"] = indexSnapshot（冻结值，不重读磁盘）
  ├ auto-surfacing：缓存清单（可含本会话新增 entry）→ 侧查询选 ≤3 → sanitize → return { message }
  └ （不再 return systemPrompt）

agent_end（每个 run 结束）
  └ runExtract（异步，不阻塞）
       └ 完整消息序列 → 结构化渲染 → headless agent（持锁写原语）

session_compact
  └ injectedTopics.clear() + 从磁盘重读索引覆盖 indexSnapshot（唯一刷新点）

session_shutdown
  └ 等待进行中的写操作收尾（避免留下 stale 锁）
```

---

## 18. 测试策略

### 18.1 新增单测

| 模块 | 用例 |
|---|---|
| `memory-store` | 每个原语的正常路径；`add` 同名覆盖（幂等）；`remove` 定位失败；并发 `add` 串行化 |
| 文件名生成 | 中文标题；不安全字符替换；空结果回退 hash；100 字节截断；重名 `-2` 递增；确定性（同输入同输出） |
| 锁 | 互斥；stale（PID 不存活 / 超 TTL）；等待超时；释放；kill 后回收 |
| 快照 | 写入前生成；`snapshotKeep` 裁剪；快照失败 → 写入失败 |
| 索引外科式修改 | 保留手写 `## 分组` 标题与注释；只改目标行；行序稳定 |
| 容量 | 超 200 行：写入成功且返回可操作错误 |
| 净化 | 零宽字符、bidi 控制符、≥5 种仿冒标签；磁盘内容不被修改 |
| 注入 | `event.systemPromptOptions.sections["memory_index"]` 被设置；未设置 `forceSystemPrompt`；**同一 session 内多轮之间内容恒等**（磁盘 MEMORY.md 被并发修改后仍恒等） |
| 索引来源 | `startup`/`new`：从磁盘读；`resume`/`fork`/`reload`：重放 transcript 取录制值（**不读磁盘**）；重放得不到该键或遇到 `null` 时回退磁盘；重放遵循 `null` = 删除、否则覆盖 |
| `null` 陷阱 | `before_agent_start` 在多轮中**始终**设置 `sections["memory_index"]`（含 resume/fork/reload）；断言省略该键时 diff 会生成 `{memory_index: null}` 并导致索引被删除 |
| 工具注册范围 | 主 agent 的 `memory` schema 只含 5 个 action；`rename` / `rebuild_index` 不出现在主 agent 与 extract 的工具集中；dream 的工具集含 7 个 |
| 生命周期 | `session_compact` 后 `injectedTopics` 为空；且 `session_compact` 后 `indexSnapshot` **被磁盘值覆盖**；其余事件后 `indexSnapshot` 不变 |
| 提取 | prompt 含全部 user 消息与 tool_result 摘要；中段裁减策略；单条上限生效 |
| 缓存 | 第二轮不读文件内容（mock `readFile` 计数）；`mtimeMs` 变化时重读 |
| 迁移 | 多条目拆分；单条目；零条目；跨文件重名；中文标题；幂等（重跑不重复）；失败不写标记 |

### 18.2 既有测试改造

现有 15 个测试文件 / 206 个用例中，涉及 `topic` 参数、`## entry` 解析、`hook` 生成、`memIndexInjectMax*` 默认值的用例需重写：

`tests/memory-tool.test.ts`、`tests/topic-file.test.ts`、`tests/index-file.test.ts`、`tests/index-wiring.test.ts`、`tests/inject.test.ts`、`tests/inject-snapshot.test.ts`（可能整体删除，因为快照机制被移除）、`tests/config.test.ts`、`tests/extract.test.ts`、`tests/dream.test.ts`、`tests/nudge.test.ts`。

`src/topic-file.ts` 的 `appendContent` / `removeEntrySection` / `hasEntries` / `parseEntries` 在新模型下不再需要（多条目解析仅被迁移逻辑使用）。

### 18.3 手工验证

更新 `tests/manual-test-plan.md`：升级迁移实机验证、`/memory` 输出、Saved/Recalled 通知、锁冲突下的 add 行为、dream 全流程。

---

## 19. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 破坏性 schema + 布局变更 | 主版本号 2.0.0；README 显著提示；迁移自动执行且有备份 |
| 迁移误拆分/误删数据 | 整目录快照 + `originals/` 保留；幂等标记在最后写；失败即中止 |
| 锁 stale 误判导致双写 | stale 需满足「PID 不存活」或「超 TTL」；删除后仅重试一次 |
| 净化过度破坏正文可读性 | 只在注入时净化，磁盘内容不变（D11） |
| 200 行上限比旧模型更快触顶 | §8.2 的可操作错误 + dream 容量管理职责文档化 |
| 会话内索引冻结 → 本会话看不到刚写入的记忆 | 刻意选择（D13，prefix cache 优先）；工具返回值已确认写入；新会话立即生效 |
| `sections` 注入方式依赖 pi 内部行为 | 已核对源码与类型：`systemPromptOptions` 可变、section 名约束、`resolveTranscript` 的折叠分叉均已验证；退路是回 `forceSystemPrompt`（功能不受损，仅缓存变差） |
| 自实现的 section 重放与 pi 语义漂移 | 重放逻辑极小（`null` 删除 / 否则覆盖、保留首次位置）；重放失败或拿不到 `memory_index` 时**回退为从磁盘读**，不会因此丢失索引 |
| 文件身份以字符串比较为准（大小写不敏感 / Unicode 规范化的文件系统上，两个不同的文件名可能指向同一 inode → 可能写穿别人的文件或改名后自删刚写入的文件） | 取名前对磁盘做一次存在性探测（`MemoryStore.#resolveTargetFile`）；删除前比较 inode（`sameFile`），同一 inode 则不删；`unlinkStrict` 使删除失败 fail-closed。但**跨平台语义未在 CI 覆盖**（Linux 上无法构造出该派生路径） |
| `.lock` 的 stale 回收竞态：两个等待者同时判定 stale 时会互相 `rm` | §5.1 的「删除并重试一次」是已批准设计；持有期心跳续约（`renewIntervalMs` = TTL/2，至少 1s）使健康持有者不再被判 stale，续约与释放前均校验所有权（比对 pid；未比 hostname —— NFS 共享 `memoryDir` 且两 host 出现相同 pid 时仍可能删错锁，`memoryDir` 目前是每 host 一份）以切断级联删除；候选的彻底修法是 rename 接管 |
| 迁移的回滚点可能被快照保留策略裁掉 | `createSnapshot` 恒产出 `<ts>-<label>`，**不可能**以 `migrate-` 开头，而 `pruneSnapshots` 永不裁剪 `migrate-` 前缀 —— 因此迁移必须自己建 `.backups/migrate-<ts>/` 作为回滚点 |
| `rebuildIndex` 不返回 `capacityWarning`（与 `addEntry` / `replaceEntry` 不同），尽管它最可能在膨胀目录上运行 | 已知的 API 不一致：调用方（dream / 迁移）在 `rebuildIndex` 之后需自行做容量检查；若要返回值对齐需扩展其签名 |
| `.lock` 不可重入；dream / 迁移需要「全程持锁」时会自锁到 `timeoutMs` 后抛 MemoryLockedError | Plan B 必须先为 `MemoryStore` 补一个公开且可重入的 `withLock(op, fn)`（§4.2 已列为原语、§4.3 指派给迁移），而不是直接用 `fs-lock.withLock` 包住写原语；详见 `MemoryStore` 类注释的「锁契约」 |
| `removeEntry` / `replaceEntry` 的 `unlink` 失败现在会抛错（fail-closed），不再静默当作删除成功 | 调用方必须把「保存失败」当作用户可见的错误处理（工具层不得吞掉 rejection）；失败时索引与文件保持一致，且写前快照可从 `.backups/` 回滚 |
| **CRLF 的 `MEMORY.md` 对索引层不可见** | entry 文件侧的 CRLF 已在 `parseEntryFile` 入口归一化；但 `entry-index` 的 `LINE_RE` 尾组 `(.*)$` 匹配不到以 `\r` 结尾的行，于是整个索引都被计成 `unrecognized`、`removeIndexLine` 空操作（删除会留下死链）、`upsertIndexLine` 追加重复行、`rebuildIndex` 把整块当作「手写头部」保留。用户用 Windows 编辑器手改 `MEMORY.md` 时触发 |
| 续约心跳的在途请求可能在释放之后落回 | 会留下一个没有持有者的 `.lock`，后续同进程写入会超时抛错直到 TTL（≤ 600s）自愈，无数据丢失。概率约 1e-6/长任务。硬化方向：释放前 await 在途续约 |
| `ttlMs ≤ 2000` 时续约间隔的 1s 下限会破坏「已续约即不 stale」不变量 | 生产路径传 `ttlMs: 600000`，无实际影响；仅影响把 TTL 调得极短的测试或用例 |

---

## 20. 落地顺序（供 writing-plans 参考）

1. `memory-store` + 锁 + 快照 + 文件名生成（纯新增，不动现有路径）
2. 索引外科式修改 + 容量语义
3. `memory` 工具 schema 切换到 store
4. 注入改为 section + 删除 `indexSnapshot` + `session_compact`
5. auto-surfacing 缓存 + entry 粒度
6. 净化
7. extract 保真度
8. dream 原语化
9. 通知与 `/memory` 增强
10. 迁移
11. README（含 zh）+ 配置表 + 版本 2.0.0
