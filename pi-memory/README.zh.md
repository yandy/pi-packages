# pi-memory

pi coding agent 的文件系统持久记忆层。把项目知识（事实、偏好、调试历史）以纯 Markdown 文件的形式存在 `~/.pi/memory/<git|local>/<project>/` 下，跨会话可用。

对齐 Claude Code 的自动记忆机制：**一条记忆 = 一个文件**、`MEMORY.md` 索引一行一条记忆、按相关性自动浮现、每轮自动提取、记忆分类。

> ## ⚠️ 破坏性变更
>
> **2.3.0：**
>
> - **注入的索引窗口改为「最新的 50 行 / 16 KiB」。** `memIndexInjectMaxLines` 200 → 50、`memIndexInjectMaxBytes` 25600 → 16384。写入口径不变（200 行 / 25600 字节），因此比「最新 50 行」更旧的记忆不再进 system prompt —— 它们仍可由 auto-surfacing 与 `memory` 工具检索。已经显式配置 `memIndexInjectMax*` 的用户不受影响。
>
> **2.2.0：**
>
> - **`extractMemories.enabled` 默认改为 `false`。** 每轮自动提取现在是 opt-in：开启后每轮结束都会跑一次 headless 模型调用。已经显式写了 `"extractMemories": { "enabled": true }` 的配置不受影响。
>
> **2.1.0：**
>
> - **模型必须显式配置。** 没有内置默认值，也没有父会话模型回退：`defaults.model`（或 per-task `model`）必须存在且可解析，否则 `session_start` 会报配置错误并且**什么都不初始化**。详见[模型配置](#模型配置)。
> - **`/memory on` / `/memory off` 已删除。** `enabled` 只是 `memory.json` 里的开关，启动时读一次，改动需要重启会话。
> - **1.x → 2.0 的自动迁移已删除。** legacy topic 文件原样留在磁盘上，但对记忆系统**不可见**（过不了 `parseEntryFile` 的 v2 五字段校验）。详见 [1.x 数据](#1x-数据)。
>
> **2.0.0 已包含：**
>
> - 索引现在**一行一条记忆**（1.x 是一行一个 topic 文件，文件里塞很多 `## entry`）。
> - 每条记忆**独占一个文件**，frontmatter 五个字段：`name`、`description`、`type`、`created`、`modified`（1.x 用的是 `updated`）。
> - 索引改为以 **system prompt section**（`memory_index`）注入，并在整个会话内冻结，而不是拼到 system prompt 字符串末尾。

## 功能

- **一个 `memory` 工具，主 agent 五个 action**：`add`、`replace`、`remove`、`list`、`search`。另外两个 —— `rename` 与 `rebuild_index` —— **只存在于 `/dream` 自己的 headless 会话里**，绝不出现在主 agent 或 extract 的 schema 中。
- **一条记忆 = 一个文件** —— 不再有多条目 `## section` 块；`name` 是定位键，`add` 一个已存在的 `name` 就是幂等覆盖。
- **`MEMORY.md` 索引** —— 一行一条记忆：`- [Name](file.md) — description`。分隔符是 **em dash**（`—`，U+2014），两侧各一个半角空格。
- **`memory_index` section，会话内冻结** ⭐ —— 索引写进 `event.systemPromptOptions.sections["memory_index"]`，其值在**整个会话内不再变化**，只有 compaction 会从磁盘重读。pi 对 sections 做 diff，值没变就一条消息都不追加，于是 system prompt 逐轮逐字节相同，provider 的 prefix cache 一直命中。`resume` / `fork` / `reload` 用 transcript 里的**录制值**重放，而不是读磁盘，因此恢复会话不会改写它的头部。
- **注入净化** —— 所有注入内容（索引行、浮现的 entry 正文与 name）都会剥离不可见/bidi 字符并转义 `<` `>`，因此记忆无法伪造 `</relevant_memories>`、`<system>`、`<project_instructions>`、`<active_agent …>` 或 `<memory_index>`。净化**只发生在注入时**：磁盘上的文件永远不会被改写（保持可读、可手工编辑）。
- **自动浮现（auto-surfacing）** ⭐ —— 每个用户回合由一次轻量侧查询挑出至多 `maxFiles` 条 **entry**（只看 `description`），把正文注入 `<relevant_memories>`。同一会话内按文件名去重；清单来自进程内的 `mtime` 缓存，每回合只付一次 `readdir` + 每文件一次 `stat`。子 agent 中不启用。
- **自动提取（extract memories）** ⭐ —— 每轮结束后一个异步 headless agent 拿到的是**整轮对话的结构化渲染**（user 消息全文、assistant 文本与 tool_call、tool_result 及其错误标记），而不是两条消息。它经同一套 `memory` 原语写入，并且**从不排队等锁**：dream 正在整轮持锁时，本回合直接跳过。该功能**默认关闭**，需要显式设 `extractMemories.enabled: true`。
- **`/dream`** —— headless 整理 agent（Orient → Gather Signal → Consolidate → Prune & Index），合并重复、消解矛盾、改名、重建索引。它**没有裸文件权限**：只有七个 `memory` action，整轮持有逻辑锁，进入时先对整个目录拍一次快照。
- **Dream 提醒** —— 距上次 dream 超过 N 个会话或 N 小时后提示 `/dream`。
- **`/memory`** —— 完整状态（开关、目录、索引容量、entry 数、上次 dream、锁状态含持有者），以及 `unlock`。
- **两级锁** —— 进程内逻辑锁承担**逻辑作用域**（单次原语，或 dream 的整轮）；跨进程 `.lock` **只持毫秒**且**永不自动回收**。没有 TTL、没有心跳、没有接管，所以互斥是硬保证；代价是崩溃遗留的锁必须**人工**清除（`/memory unlock`）。
- **快照** —— 每次写入都在 `.backups/<ts>-<label>/` 留下回滚点，保留最近 `lock.snapshotKeep` 份（`migrate-` 开头的目录是旧版迁移留下的整目录快照，其 `originals/` 子目录里才是 2.0 之前的 topic 原文，永不裁剪）。`/dream` 是例外：它**进入时只对整个目录拍一次**快照，该轮内部的原语会跳过逐文件快照（一轮只留一个回滚点）。
- **会话检索** —— `memory search scope=sessions` 查历史会话。
- **可读、clone 友好的布局** —— git 仓库（http(s)/ssh/git remote，含 scp 写法与 `git+ssh`/`git+https`）存在 `~/.pi/memory/git/<host__owner__repo>/`，其余存在 `~/.pi/memory/local/<absolute-path>/`；同一仓库的 clone 与 worktree 共享记忆（fork 有自己的 remote，因此有独立目录）。

## 安装

```bash
pi install npm:@yandy0725/pi-memory
```

或加入 `~/.pi/agent/settings.json`：

```json
{
  "packages": ["npm:@yandy0725/pi-memory"]
}
```

## 存储布局

```
~/.pi/memory/git/github.com__owner__repo/
  MEMORY.md            — 索引：一行一条记忆（em dash 分隔）
  SSH-port-on-staging.md
  Test-command.md      — 一条记忆一个文件
  .lock                — 跨进程写锁（只持毫秒，永不自动回收）
  .backups/            — 回滚点：<ISO-ts>-<label>/（以及旧版 1.x 迁移留下的 migrate-<ts>/ 整目录快照）
  .dream-meta.json     — 上次 dream 的时间与会话数（提醒逻辑用它）
  sessions/            — headless 会话落盘目录，仅在开启 sessionPersistence 时使用
```

### Entry 文件

```yaml
---
name: SSH port on staging
description: staging SSH listens on 2222, not 22; key at ~/.ssh/staging
type: project
created: 2026-07-13
modified: 2026-10-02T08:14:03.120Z
---

staging 的 SSH 用 2222 端口，密钥在 ~/.ssh/staging。
```

- `name` —— 唯一、可读的标题；`replace` / `remove` / `rename` 的定位键。再次 `add` 同名记忆是**覆盖**，不会产生第二条。
- `description` —— **一行自包含的说明**。侧查询判断相关性时**只看得到它**，所以它必须脱离正文也能读懂。反例：`Debugging tips`；正例：`staging SSH listens on 2222, not 22`。
- `type` —— `user` | `feedback`（默认）| `project` | `reference`。
- `created` —— `YYYY-MM-DD`，只在新建时写入，覆盖时保留。
- `modified` —— ISO 8601，**一律由 store 写入**，调用方传不进来。

文件名由 `name` 派生（不安全字符替换、100 字节上限，只有**文件名**冲突时才追加 `-2` / `-3`）。任何 `name` 都写不到 `MEMORY.md` 上。

### MEMORY.md 索引

```
# Memory Index

- [SSH port on staging](SSH-port-on-staging.md) — staging SSH listens on 2222, not 22
- [Test command](Test-command.md) — run npm test, not npm run test
```

写入是**外科式**的：只改目标行，手写的标题、分组、注释逐字保留，行序稳定。唯一的例外是行尾：CRLF（以及单独的 CR）在解析前被归一为 LF，因此第一次写入 CRLF 文件会把它整体转成 LF。

### 记忆类型

| 类型 | 含义 | 示例 |
|------|------|------|
| `user` | 用户角色、偏好、知识背景 | "用户是聚焦可观测性的数据科学家" |
| `feedback` | 经验、纠正、确认（默认） | "集成测试用真库不要 mock —— 上季度栽过" |
| `project` | 项目状态、时间点、事故 | "移动端 2026-03-05 起封版" |
| `reference` | 外部系统的指针 | "缺陷跟踪 = Linear 的 INGEST 项目" |

### 容量：200 行索引 ≈ 199 条记忆

索引上限是 `memIndexMaxLines`（200）个非空行与 `memIndexMaxBytes`（25600）字节。这 200 行是**索引行，不是记忆条数**：`rebuildIndex` 至少保证一行头部（已有手写头部时原样保留 —— 首个条目之前的末尾空行会被去掉；否则写 `# Memory Index`），手写的标题、分组、注释同样占额度。因此重建后的索引最多约 **199 条记忆**（每个项目目录；若保留手写标题则更少）。超限时写入**不会失败**：写入照样成功，工具把一条可操作的警告回给模型，让它去合并或删除条目（超出上限的部分下次加载时不可见）。

**真正进模型的是另一个更小的窗口**：`memIndexInjectMaxLines` / `memIndexInjectMaxBytes`（默认 50 行 / 16384 字节）。窗口取索引的**最新**一端 —— 即**文件底部**：`memory(action="add")` 追加到末尾、`/dream` 的 `rebuild_index` 按 `modified` 重排。两种例外值得知道：`memory(action="replace")` 是**原地**重写那一行，被改写的老记忆会保持原位（可能就留在窗口外）直到下次 `/dream` 重排；而文件顶部的手写标题/分组/注释是**位置**语义而不是时间语义，索引一旦超过 50 行，先被丢出窗口的正是这块手工整理的内容。因此写满的索引恰好注入**最新的 50 条记忆**（窗口一旦截断，`# Memory Index` 头行与它下面的空行就落在窗口外）；48 条及以下则整份注入。被略过的记忆**没有丢**：auto-surfacing、`memory(action="search")` 与 `/dream` 整理都还能看到它们。`/memory` 用两行区分两套口径：`Index:` 是写入口径（磁盘真相），`Inject:` 是进 system prompt 的窗口。

这也是 `/dream` 不再是「可选的整理」而是**容量管理必需**的原因。两个阀值要分开看：prompt 可见性止于注入窗口，想让每条记忆都进 system prompt，就在**接近 48 条之前**整理；199 只是写入口径的硬上限，过了它索引自身就必须缩小。

## 配置

在 agent 目录（`~/.pi/agent/memory.json`）或项目 `.pi/` 目录（仅在项目被信任时）创建 `memory.json`：

```json
{
  "enabled": true,
  "memoryDir": "~/.pi/memory",
  "memIndexMaxLines": 200,
  "memIndexMaxBytes": 25600,
  "memIndexInjectMaxLines": 50,
  "memIndexInjectMaxBytes": 16384,
  "lock": { "timeoutMs": 5000, "snapshotKeep": 5 },
  "defaults": { "model": "provider/model-id", "sessionPersistence": { "enabled": false } },
  "dream": { "nudgeAfterSessions": 5, "nudgeAfterHours": 24, "thinkLevel": "high" },
  "sessionSearch": { "maxSessions": 10, "maxMatches": 5 },
  "autoSurfacing": {
    "enabled": true,
    "thinkLevel": "off",
    "maxFiles": 3,
    "maxEntryBytes": 3072,
    "maxInjectionBytes": 10240
  },
  "extractMemories": {
    "enabled": false,
    "thinkLevel": "high",
    "maxContextTokens": 2000,
    "maxToolResultChars": 500,
    "maxAssistantChars": 2000
  }
}
```

> 每个 `model` 值都必须能在你的 registry 里解析 —— 没有默认值。缺失或解析不出的模型会让 `session_start` 报配置错误并且什么都不初始化。详见[模型配置](#模型配置)。

| 键 | 默认值 | 说明 |
|-----|---------|------|
| `enabled` | `true` | 整个记忆系统的开关。**启动时读一次**，改动需重启会话 |
| `memoryDir` | `~/.pi/memory` | 所有记忆数据的根目录 |
| `memIndexMaxLines` | `200` | 写入口径：`MEMORY.md` 的最大非空行数（`# Memory Index` 头行与手写标题同样占额度，所以并不等于记忆条数） |
| `memIndexMaxBytes` | `25600` | 写入口径：`MEMORY.md` 的最大字节数 |
| `memIndexInjectMaxLines` | `50` | 注入口径：放进 `memory_index` section 的最大行数。窗口保留**最新**的行、丢弃**最旧**的行 —— 索引是纯时间序，窗口再小也不会藏住你刚写完的那条。**任一键写 `0` = 完全不注入索引**（section 保持空值） |
| `memIndexInjectMaxBytes` | `16384` | 注入口径：section 的最大字节数（优先丢最旧的行，截断标记在**开头**） |
| `lock.timeoutMs` | `5000` | 单次原语等逻辑锁 / 等跨进程 `.lock` 的上限。同时也是 `session_shutdown` 等在途写入的上限 |
| `lock.snapshotKeep` | `5` | `.backups/` 保留的回滚点数量（`migrate-` 前缀的目录永不裁剪 —— 它们是旧版迁移留下的整目录快照，`originals/` 子目录里装着 2.0 之前的 topic 原文） |
| `defaults.model` | —（必需） | 三个子任务的共享模型。**没有默认值**：会执行的任务必须能解析出模型，否则启动失败（见[模型配置](#模型配置)）。per-task 覆盖它 |
| `defaults.sessionPersistence.enabled` | `false` | 共享回退：headless 子会话（extract / dream / 侧查询）默认只在内存里跑 |
| `defaults.sessionPersistence.sessionDir` | `<项目记忆目录>/sessions/` | headless 会话的自定义落盘目录 |
| `dream.nudgeAfterSessions` | `5` | 距上次 dream 多少个会话后开始提醒 |
| `dream.nudgeAfterHours` | `24` | 距上次 dream 多少小时后开始提醒 |
| `dream.model` | — | dream 用的模型（`"provider/id"`）。回退 `defaults.model`；没有 `defaults.model` 时必填（必须可解析，不回退父会话模型） |
| `dream.thinkLevel` | `"high"` | dream 的思考强度：`off` / `minimal` / `low` / `medium` / `high` / `xhigh` |
| `dream.sessionPersistence.*` | 继承 `defaults` | 把 dream 会话落盘（调试/审计用） |
| `sessionSearch.maxSessions` | `10` | `search scope=sessions` 扫描的最大会话数 |
| `sessionSearch.maxMatches` | `5` | 历史检索返回的最大命中数 |
| `autoSurfacing.enabled` | `true` | ⭐ 开启每回合的 entry 自动注入 |
| `autoSurfacing.model` | — | ⭐ 相关性侧查询用的模型。回退 `defaults.model`；没有 `defaults.model` 时必填（必须可解析，不回退父会话模型） |
| `autoSurfacing.thinkLevel` | `"off"` | ⭐ 侧查询的思考强度（`"off"` 最省） |
| `autoSurfacing.maxFiles` | `3` | ⭐ 每回合最多注入几条 entry |
| `autoSurfacing.maxEntryBytes` | `3072` | ⭐ 单条 entry 正文的注入字节上限（超出截断）。取代 1.x 的 `maxTopicBytes`（旧键已失效） |
| `autoSurfacing.maxInjectionBytes` | `10240` | ⭐ 每回合注入内容的总字节上限 |
| `autoSurfacing.sessionPersistence.*` | 继承 `defaults` | 把侧查询会话落盘 |
| `extractMemories.enabled` | `false` | ⭐ 开启每轮自动提取。**默认关闭**（opt-in）：开启后每轮结束都会跑一次 headless 模型调用 |
| `extractMemories.model` | — | ⭐ 提取 agent 用的模型。回退 `defaults.model`；没有 `defaults.model` 时必填（必须可解析，不回退父会话模型） |
| `extractMemories.thinkLevel` | `"high"` | ⭐ 提取的思考强度 |
| `extractMemories.maxContextTokens` | `2000` | ⭐ 渲染后对话的预算（`× 4` 个字符；超出时先裁中段、首尾优先保留，user 消息最后才动） |
| `extractMemories.maxToolResultChars` | `500` | ⭐ 单条 `tool_result` 渲染的字符上限 |
| `extractMemories.maxAssistantChars` | `2000` | ⭐ 单条 assistant 文本渲染的字符上限（user 消息从不截断） |
| `extractMemories.sessionPersistence.*` | 继承 `defaults` | 把 extract 会话落盘 |

headless 会话默认落在 `<项目记忆目录>/sessions/` —— 在项目记忆目录里，不在你的工作副本里。

## 模型配置

会执行的任务必须能解析出模型 —— **既没有随包默认值，也没有父会话模型回退**。`defaults.model` 可以满足全部任务；各任务自己的 `model`（`dream.model` / `extractMemories.model` / `autoSurfacing.model`）优先于它。

| 任务 | 何时必需 |
|------|---------|
| `dream` | 记忆系统开启（`enabled: true`）时**恒**需要 |
| `extractMemories` | `extractMemories.enabled` 为真时 |
| `autoSurfacing` | `autoSurfacing.enabled` 为真时 |

`enabled: false` 时什么都不跑（`/dream` 与提醒也被挡住），因此不需要任何模型。`session_start` 会把每个必需模型拿到注册表里解析；只要有缺失或解析不出的，就**不初始化任何东西**：弹一条 error 通知 `pi-memory config error:` + 每个问题一行 `- <error>`，`/memory` 则报 `Memory: misconfigured` + `Dir: not initialized` + 同样的行。两条错误文案：

- `no model for <task> — set "<task>.model" or "defaults.model" in memory.json`
- `model "<value>" for <task> is not resolvable (unknown id or missing credentials)`

改好 `memory.json` 后重启会话 —— 配置在启动时只读一次。headless / print 会话里配置错误是静默的（不会弹任何通知），所以要在交互式会话里用 `/memory` 确认。

## 工作原理

### 会话生命周期

| 事件 | pi-memory 做什么 |
|---|---|
| `session_start` | 加载配置 → 校验必需模型（失败即什么都不初始化）→ 解析记忆目录 → **确定索引值并冻结**（`startup`/`new` 读磁盘；`resume`/`fork`/`reload` 重放 transcript 取录制值）→ 注册 `memory` 工具（仅首次，5 个 action）→ 重建清单缓存 → dream 提醒检查 |
| `before_agent_start` | 把冻结值写进 `sections["memory_index"]`（**每一轮、无条件**），然后做 auto-surfacing（主会话且非子 agent） |
| `agent_end` | `extractMemories.enabled` 开启时触发异步 extract；写入成功通知 `Extracted N memories.`，失败通知 `Extract failed: …`（每会话一次） |
| `session_compact` | 清空已注入集合，**并从磁盘重读索引** —— 会话内唯一的刷新点 |
| `session_shutdown` | 等在途写入收尾（上限 `lock.timeoutMs`），避免退出时留下 stale 的 `.lock` |

### 为什么索引要冻结

pi 用有序的 sections 构建 system prompt，只对**值发生变化**的 section 追加一条 patch 消息；全部没变时一条都不追加。自定义 section 插在**最后**，所以 `memory_index` 是 system prompt 的最后一段，其后紧跟整段对话。一旦它的值在会话中途变化，折叠后的头部就会被改写，其后的全部内容失去 prefix cache。因此：一个会话一个值，只有 compaction 才刷新（那时对话中段本来就要被重写）。

有意接受的代价：**本会话内写入的记忆不会出现在本会话的索引里**。工具返回值已经确认写入，下一个会话立刻可见。

如果宿主的 pi 还没有 sections API，pi-memory 回退为把索引拼到 system prompt 字符串末尾 —— 功能不变，只是缓存变差。

### 自动浮现

1. 从 store 的 `mtime` 缓存构建清单：`[type] file.md — description`，按 `modified` 降序，最多 200 条、4000 字符（description 预算按条数均分，每条不低于 80 字符）。
2. 侧查询（`maxTurns: 1`、零工具）从清单里返回至多 `maxFiles` 个文件名；不在清单里的一律丢弃。
3. 选中 entry 的**正文**（不含 frontmatter）按 `maxEntryBytes` 截断、净化，作为一条 `display: false` 的 custom 消息注入，外面包 `<relevant_memories>`；总量到 `maxInjectionBytes` 就停。
4. 注入过的文件名在本会话内记住，compaction 时清空。你会看到 `Recalled: N entries` 通知。

### 自动提取

> **默认关闭。** 先在 `memory.json` 里设 `"extractMemories": { "enabled": true }`（配置只在 `session_start` 读一次，改动需重启会话），并确保 `extractMemories.model` 或 `defaults.model` 可解析。

extract 拿到的是结构化渲染，而不是有损的两条消息摘要：

```
=== Conversation ===
[1] user: <全文>
[2] assistant: <文本> | tool_call: memory({"action":"list"})
[3] tool_result: <摘要，按 maxToolResultChars 截断>
[4] user: <纠正>
```

它只有主 agent 的五个 action（永远拿不到 `rename` / `rebuild_index`）、没有文件工具、`maxTurns: 5`、超时 120s。逻辑锁被占用时（dream 正在整轮持有）它**跳过本回合**而不是排队 —— 下一次 `agent_end` 还会来。

### 锁

| 层级 | 作用域 | 行为 |
|---|---|---|
| 进程内逻辑锁（按记忆目录分键） | 单次原语；或 dream 的整轮 | 最多等 `lock.timeoutMs`，超时抛一条写明目录的可读错误。`extract` 用不等待的形态，直接跳过本回合 |
| 跨进程 `.lock` | 毫秒级，只包住物理写入 | 用 `link` 原子获取，**永不自动回收**：没有 TTL、没有心跳、没有接管 |

因此写入中途崩溃可能留下一个 `.lock`，而且**没有任何进程会替你删掉它** —— 这是「互斥是硬保证」的刻意代价。错误文案会写明 pid、op、开始时间与路径；`/memory unlock` 是唯一被认可的清除方式。

## 工具参考

```
memory(action: "add" | "replace" | "remove" | "list" | "search",
       name?, description?, content?, type?, query?, scope?)
```

`description` 是未来会话唯一能拿到的相关性信号 —— `add` 与 `replace` 请务必带上自包含的一行。

### `add`

新建一条记忆，或**覆盖 `name` 完全相同的那一条**（幂等；`created` 保留）。

- `name`（必填）—— 唯一、可读的标题
- `content`（必填）—— 记忆正文，它会成为整个 entry 文件
- `description`（可选）—— 一行自包含说明；缺省取 `content` 的第一句
- `type`（可选）—— `user` / `feedback`（默认）/ `project` / `reference`

### `replace`

重写已有记忆的 `content` / `description` / `type`，按 `name` 定位。改名是 `rename`，dream 专属。

### `remove`

删除 `name` 匹配的记忆 —— 文件、索引行一起删。找不到条目或删不掉文件时**明确报错**，不会假装删成功。

### `list`

每条记忆一行：`- name (type, modified …) — description [file]`。

### `search`

- `query`（必填）
- `scope`（可选）—— `memory`（默认：在所有 entry 的 name / description / 正文里找）或 `sessions`（查历史会话）

### dream 专属 action

`rename`（`name` + `new_name`；文件名与索引行跟着走，并保持索引行的位置）与 `rebuild_index`（从磁盘全量重建，保留手写头部）。它们**只**注册在 `/dream` 的 headless 会话里，主 agent 与 extract 都调不到。

## 命令

### `/memory`

```
/memory          — 查看状态
/memory unlock   — 清除遗留的 .lock（会先要求确认）
```

状态输出：

```
Memory: enabled
Dir: /home/you/.pi/memory/git/github.com__owner__repo
Index: 38/200 lines, 2841/25600 bytes, 1 unrecognized lines
Inject: 39/50 lines, 2841/16384 bytes
Entries: 37
Modules: dream=on(provider/model-a) extractMemories=off autoSurfacing=on(provider/model-b)
Last dream: 2026-10-01T22:10:04.882Z
Lock: free
```

- `Index` 用**写入**口径（`memIndexMax*`），并报告索引里有多少非空行解析不出（`# Memory Index` 头行与手写标题会计入）。CRLF（以及单独的 CR）行尾在解析前就被归一为 LF，下一次写入也一律输出 LF，因此被 Windows 编辑器改过行尾的 `MEMORY.md` **不会**推高这个计数。注入侧同样做归一：CRLF 文件不会把 `\r` 送进 system prompt。
- `Inject` 用**注入**口径（`memIndexInjectMax*`），统计窗口内的行数与字节数 —— 即真正会进 `memory_index` section 的索引文本（截断标记本身不计入）。它与真正注入的值由同一份窗口代码算出来，不可能漂移。注意两行的口径不同：`Index` 数的是**非空**行，`Inject` 数的是窗口内的**全部**行，所以规范索引（LF 行尾、以换行结尾、头部后有且仅有一个空行）下 `Inject` 会比 `Index` 多一行而字节数相同。system prompt 里的值是**会话内冻结**的（见[为什么索引是冻结的](#为什么索引是冻结的)）：`session_start` 之后写入的记忆会立刻出现在 `Index`，但要等 compaction 或下一个会话才出现在 `Inject`。
- `Modules` 报三个模型驱动功能的激活状态：`on(<生效模型>)` / `off`。生效模型 = 该任务自己的 `model`，没有则用 `defaults.model`。`dream` 没有独立开关 —— memory 系统启用它就可用。
- `Lock` 有三种：`free`、`held by <op> (pid N on <hostname>, started <ISO>)`、`unreadable — run /memory unlock`。`/memory unlock` 的确认框会显示同一行持有者信息。
- 以 `enabled: false` 启动的会话在启动时不初始化任何东西：`/memory` 报两行（`Memory: disabled` + `Dir: not initialized — set "enabled": true in memory.json and restart`）；会话中途无法开启；`/memory unlock` 不需要 store 也能用。
- 必需模型缺失或解析不出时不初始化任何东西，`/memory` 报 `Memory: misconfigured` + `Dir: not initialized` + 每行一条 `- <error>`；同样的错误在 session_start 时以 error 通知出现。

### `/dream`

先要求确认，然后对整个目录拍快照，再跑一个 headless agent 走完四个阶段：

1. **Orient** —— `list`，读相关 entry
2. **Gather Signal** —— 找重复（同一事实的多条 entry）、矛盾、过时内容
3. **Consolidate** —— 用 `replace` + `remove` 合并，用 `rename` 改名
4. **Prune & Index** —— 用 `rebuild_index` 兜底重建

它碰不到文件：只有七个 `memory` action。完成时通知摘要，失败时通知 `Dream failed: …`。模型可用 `dream.model` 配置。

## 1.x 数据

1.x → 2.0 的自动迁移已被删除。legacy topic 文件（frontmatter 带 `updated` 而缺 `created`/`modified`，过不了 v2 的五字段 frontmatter 校验）原样留在磁盘上，且**对记忆系统不可见** —— `parseEntryFile` 要求 v2 的五个 frontmatter 字段，所以这类文件不会出现在索引、注入、`list`/`read`/`search` 里，`/dream` 也看不到它们（dream 只有 `memory` 工具）。要人工恢复内容，把每个 `## ` 段拆成带 v2 frontmatter（`name`、`description`、`type`、`created`、`modified`）的独立文件。旧版迁移建过的目录仍然永不被裁剪：`.backups/migrate-*/originals/` 里是 2.0 之前的 topic 原文，`.backups/migrate-*/MEMORY.md` 是当时的索引。

## 文件布局

```
~/.pi/memory/
  git/
    github.com__yandy__pi-packages/    ← https://github.com/yandy/pi-packages.git
      MEMORY.md            — 索引：一行一条记忆
      SSH-port-on-staging.md
      Test-command.md      — 一条记忆一个文件
      .lock  .backups/  .dream-meta.json
  local/
    home__yandy__workspace__scratch/   ← 非 git 目录 /home/yandy/workspace/scratch
```

目录名的推导规则：

- remote 是 http(s)、ssh（含 scp 写法 `[user@]host:owner/repo`，user 可省略）或 `git://`，以及 `git+ssh://` / `git+https://` 别名的 git 仓库 → `git/<host>__<owner>__<repo>`；端口、凭据、结尾的 `/` 与 `.git` 会被剥掉，host 转小写
- remote URL 从原始 git config 读取（`remote.<name>.url`；先 `origin`，再按字母序，第一个可用的胜出），所以 `url.*.insteadOf` 重写不会影响映射
- scheme 形式走 WHATWG URL 规范化（IDN host 转 punycode，百分号编码与 `.`/`..` 折叠生效，凭据/query/fragment 被丢弃），scp 形式保留原样路径 —— 等价但写法不同的 remote 可能映射到不同目录
- 其余情况 —— 非 git 目录、没有 remote 的 git 仓库、`file://` 或本地路径 remote → `local/<absolute-path>`（git 仓库用仓库根；Windows 盘符形式的 remote 如 `C:/repos/foo.git` 在 POSIX 上按 scp 写法处理，与 git 一致）
- `/` 变成 `__`；文件名里不可移植的字符（`<>:"|?*`、控制字符）变成 `_XX` 十六进制转义
- 超过 120 UTF-8 字节的名字在码点边界截断到 100 字节，再加 `__<hash8>` 后缀
- 名字面向 POSIX 文件系统：反斜杠是普通字符，不做 Windows 设备名与结尾句点处理

映射不是单射：下划线原样保留，所以 `/home/a__b` 与 `/home/a/b` 都映射到 `home__a__b`（共享同一个记忆目录）。改动或重命名 remote、新增一个排序更靠前的 remote、移动本地目录，都会改变记忆目录，旧目录会被孤立。

**更老的布局：** 1.x 之前的版本把记忆存在 `~/.pi/memory/<12-char-sha256>/`；这些目录不再被读写。要手工迁移，用 `printf '%s' "$(git rev-parse --show-toplevel)" | sha256sum | cut -c1-12` 算出旧 hash（不在 git 仓库里就用 `$PWD`），把那个目录 `mv` 到新位置（在项目里跑 `/memory` 可以看到新路径），其 topic 文件需要按 [1.x 数据](#1x-数据)手工拆分。

## 通知

| 时机 | 通知 |
|---|---|
| `memory add` 成功（有 UI 的会话） | `Saved: <name>` |
| 自动浮现注入了 entry | `Recalled: <N> entries` |
| extract 写入了记忆 | `Extracted <N> memory.` / `Extracted <N> memories.` |
| extract 失败 | `Extract failed: <message>` —— 每会话最多一次 |
| `/dream` 结束 / 失败 | headless agent 的摘要 / `Dream failed: <message>` |

headless 会话（`hasUI === false`）不发任何通知。
