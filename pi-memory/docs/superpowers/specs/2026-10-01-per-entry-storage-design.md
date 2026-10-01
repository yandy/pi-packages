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
| D13 | 注入的索引文本在**整个 session 内冻结** | system prompt 是 provider prefix cache 的最前段；会话中途改变它会让**整段对话**的缓存前缀失效。会话内的记忆写入服务的是未来会话，当前会话不需要看到 |

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

- 获取：`fs.open(path, "wx")`（`O_CREAT|O_EXCL`）。
- 失败时读取持有者信息：
  - 同 host 且 `pid` 不存活 → stale；
  - 或 `now - startedAt > lock.ttlMs`（默认 10 分钟）→ stale；
  - stale 则删除并重试一次；仍失败则按等待策略处理。
- 释放：`finally` 中删除。进程被 kill 时靠 stale 检测回收。

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

### 9.1 索引注入改为 system prompt section，且会话内冻结

两个独立要求，必须同时满足。

**(a) 用 section 而非全量替换。** 不再是 `return { systemPrompt }`，而是就地修改可变对象：

```ts
event.systemPromptOptions.sections["memory_index"] = indexSnapshot;   // 已 sanitize
```

- section 名必须匹配 `/^[a-z][a-z0-9_-]*$/`（pi 的约束），渲染为 `<memory_index>…</memory_index>`。
- 理由：`return { systemPrompt }` 走 pi 的 `forceSystemPrompt` 分支，使整个 prompt 变成「无 sections 的不透明字符串」，pi 无法按段 diff（`dist/core/system-prompt.js`、`dist/core/extensions/runner.js`）。

**(b) 会话内内容冻结（D13）。** `indexSnapshot` 在 `session_start` 读取一次并保留到 session 结束；`before_agent_start` 每轮只是重新赋同一个字符串，**不再从磁盘重读**。

- 理由：system prompt 位于 provider prefix cache 的最前段。会话中途改变它 —— 无论是 extract 写了新记忆、还是 dream 重建了索引 —— 都会让**整段对话的缓存前缀失效**，代价远高于「索引晚一轮更新」。
- 语义上也可接受：会话中的记忆写入（extract、`memory add`）服务的是**未来**会话；当前会话不需要看到自己刚写的记忆，工具返回值已经确认了写入。
- 因此在**整个 session 生命周期内（含 compaction 之后）**该 section 保持不变。compaction **不刷新**索引 —— 这是刻意选择，不是遗漏。
- pi 的 `diffSystemPromptSections` 会对比上一轮内容；冻结下内容恒等 → 每轮不产生 patch，成本为 0。
- `session_start` 会在 `startup` / `reload` / `new` / `resume` / `fork` 时触发，因此新会话总会拿到最新索引。

> **与原分析 #8 的差异**：原分析建议「compaction 后从磁盘重注入索引」。本设计改为**会话内永久冻结**，理由是 prefix cache 优先级更高。代价是同一会话内看不到本轮新增的记忆；收益是整段对话的缓存前缀在会话期间稳定。compaction 相关修复收窄为清空 `injectedTopics`（§9.3、§10）。

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
| `session_start` | 加载配置；解析 memoryDir；若需迁移则执行迁移（§15）；**读取并冻结索引快照**（sanitize 后）；注册 `memory` 工具（仅首次，5 个 action）；重建侧查询缓存；nudge 检查 |
| `before_agent_start` | 赋 `sections["memory_index"] = indexSnapshot`（冻结值，**不重读磁盘**）；auto-surfacing（main session 且非 subagent） |
| `agent_end` | 触发 extract（异步，行为见 §11） |
| `session_compact` | **清空 `injectedTopics`**（compaction 会把已注入内容挤出上下文，不清空则该 entry 本会话再也不会浮现）。索引 section **刻意不刷新**（D13） |
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
  ├ 读 MEMORY.md 一次 → sanitize → indexSnapshot（会话内冻结，D13）
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
  └ injectedTopics.clear()（索引 section 刻意不刷新）

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
| 工具注册范围 | 主 agent 的 `memory` schema 只含 5 个 action；`rename` / `rebuild_index` 不出现在主 agent 与 extract 的工具集中；dream 的工具集含 7 个 |
| 生命周期 | `session_compact` 后 `injectedTopics` 为空；且 `session_compact` 后 `indexSnapshot` 不变 |
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
| `sections` 注入方式依赖 pi 内部行为 | 已有源码与类型验证；退路是回 `forceSystemPrompt`（功能不受损，仅失去按段 diff） |

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
