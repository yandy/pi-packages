# pi-memory v3 — Claude Code Memory 对齐设计

> 基于 `2026-07-03-pi-memory-v2-design.md`，将 pi-memory 对齐 Claude Code 的 auto memory 机制。

## 目标差异

以下是 pi-memory v2 与 Claude Code memory 的核心差异及本次对齐方案：

| 差异 | pi-memory v2 | Claude Code | v3 方案 |
|------|-------------|-------------|---------|
| MEMORY.md 格式 | 每条目一行，同 topic 可多行 | 每 topic 一行 + hook 描述 | 每 topic 一行，`- [Name](file.md) — hook` |
| Topic 文件注入 | ❌ 不会自动注入 | ✅ Sonnet per-turn 选 ≤5 个注入 | ✅ per-turn side-query 选 ≤N 个注入 context |
| Per-turn 记忆提取 | ❌ 无 | ✅ extractMemories fork 子 agent | ✅ 异步 fork 子 agent 提取 learnings |
| Memory 类型 | ❌ 无类型 | ✅ user/feedback/project/reference | ✅ 四种 type，frontmatter 新增 name/description/type |
| Dream 合并 | 笼统 prompt | 四阶段 Orient→Gather→Consolidate→Prune | 四阶段 task prompt |
| Memory 工具 | 完整暴露 | 完整暴露 | 保留，行为适配新格式 |

---

## 整体架构

使用 pi 原生 hook 事件实现所有功能，不引入新的 hook 类型：

```
                        会话开始
                           │
                    session_start
                    初始化 memoryDir
                    加载 MEMORY.md 快照
                    注册 memory tool
                    注册 auto-surfacing
                    已注入 topic 记录
                           │
                    ┌──────▼──────┐
    用户发消息 ──►  │before_agent_start│
                    │                  │
                    │ 1. 注入 MEMORY.md│  已有：快照 → systemPrompt
                    │    索引到系统提示  │
                    │ 2. auto-surfacing │  ⭐ 新增
                    │    side-query LLM │
                    │    选 ≤N 个 topic │
                    │    【去重：跳过已  │
                    │     注入的 topic】 │
                    │    注入为 message │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │  主 agent    │
                    │  turn_start  │
                    │  turn_end    │  (多轮 tool calling)
                    │  ...         │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
     agent 结束 ──► │  agent_end   │  ⭐ 新增
                    │ extractMemories│
                    │ fork 子 agent │
                    │ 分析本轮对话   │
                    │ 写入 memory    │
                    └─────────────┘
```

---

## 配置

配置文件从 `pi-memory.json` 改名为 **`memory.json`**。

```jsonc
{
  "enabled": true,
  "memoryDir": "~/.pi/memory",
  "memIndexMaxLines": 200,
  "memIndexMaxBytes": 25600,
  "dream": {
    "nudgeAfterSessions": 5,
    "nudgeAfterHours": 24,
    "model": "auto"
  },
  "sessionSearch": {
    "maxSessions": 10,
    "maxMatches": 5
  },
  // ⭐ 新增
  "autoSurfacing": {
    "enabled": true,
    "model": "auto",           // "auto" = 与主 agent 同模型，或指定 "provider/modelId"
    "maxFiles": 5,
    "maxTopicBytes": 4096,
    "maxInjectionBytes": 20480
  },
  // ⭐ 新增
  "extractMemories": {
    "enabled": true,
    "model": "auto",
    "maxContextTokens": 2000
  }
}
```

---

## MEMORY.md 格式变更

**v2（每条目一行）**：
```
- [SSH Gotcha](debugging.md)
- [MySQL Timeout](debugging.md)
- [Firewall Rules](network.md)
```

**v3（每 topic 一行 + hook）**：
```
- [Debugging](debugging.md) — SSH uses port 2222; MySQL 30s timeout on staging
- [Firewall Rules](network.md) — production uses port 443 for HTTPS
```

### 规则

- 同一 topic 文件**只占一行**
- 格式：`- [Name](file.md) — one-line hook`
- `Name`：取自 topic 文件 frontmatter 的 `name` 字段
- `hook`：由 dream 合并或 `add` 时 LLM 生成，控制在 ~150 字符内
- 200 行 / 25KB 截断规则不变

### `memory add` 行为变化

- **不再在 MEMORY.md 新增行**（该 topic 已有行）
- 只往 topic 文件追加 `## entryTitle` 块
- 更新 MEMORY.md 中该 topic 行的 hook（用 LLM 合并所有条目的内容生成新 hook 摘要）
- 首次创建 topic 时：新建 topic 文件 + 在 MEMORY.md 新增一行

### `memory remove` 行为变化

- 删除 `##` 条目
- 更新 MEMORY.md 中该 topic 的 hook 行
- 若 topic 文件清空 → 删除 MEMORY.md 中该行 + 删除 topic 文件

---

## Topic 文件 Frontmatter & 类型系统

**v2 frontmatter**：
```yaml
---
updated: 2026-07-03
---
```

**v3 frontmatter**（对齐 Claude Code）：
```yaml
---
name: Debugging Tips
description: Common debugging patterns, SSH ports, MySQL timeout configs
type: feedback
updated: 2026-07-03
---
```

### 四种 type

| Type | 含义 | 示例 |
|------|------|------|
| `user` | 用户角色、偏好、知识背景 | "用户是数据科学家，关注可观测性" |
| `feedback` | 教训/纠正/确认（默认） | "用真实 DB 不用 mock—上次踩过坑" |
| `project` | 项目状态、deadline、incident | "merge freeze 从 3 月 5 日开始" |
| `reference` | 外部系统指针 | "bug tracker = Linear INGEST project" |

### description 字段

`description` 是 auto-surfacing side-query 判断相关性的关键字段。LLM 根据 description 判断该 topic 文件是否与当前用户查询相关。description 必须具体、有区分度。

### 默认值

- `type`：add 时默认 `feedback`
- `name`：add 时默认取 topic 文件名（去 .md）
- `description`：add 时由 LLM 根据 content 自动生成

---

## Auto-Surfacing（Topic 文件自动注入）

### 触发时机与实现

在 `before_agent_start` hook 中同步执行（每次用户提交消息时触发）。
可通过 `autoSurfacing.enabled` 关闭。

实现方式：在 `before_agent_start` 返回值中通过 `{ message: {...} }` 注入 topic 文件内容。
这使主 agent 在开始处理前就能看到相关记忆，且注入的 message 会被存储到 session 中。

注意：`before_agent_start` 已有的 MEMORY.md 索引注入保持独立，
auto-surfacing 注入的 topic 文件内容是附加的额外上下文。

**Session 内去重**：维护一个 `injectedTopics` Set（在 `session_start` 时初始化），
记录当前 session 中已通过 auto-surfacing 注入过的 topic 文件名。
每次 auto-surfacing 选出的文件会先过滤掉已在 `injectedTopics` 中的文件，
然后将新注入的文件名加入 Set。这样同一 session 内每个 topic 最多注入一次，
避免重复注入浪费 context。

### 流程

```
1. 扫描 memory 目录，收集所有非 MEMORY.md 的 .md 文件
   - 每文件提取：filename, mtime, frontmatter (name, description, type)
   - 最多扫描 200 个文件，按 mtime 降序
   - 控制上下文：每文件一行摘要 [type] filename — description（~80 字符/行）
   - 总计 ≤ ~16KB

2. side-query（使用 autoSurfacing.model）
   - 输入：文件清单 + 当前用户消息
   - 输出：{ "selected_files": ["debugging.md", "api.md", "..."] }
   - 最多 maxFiles 个
   - ⭐ 过滤掉已在当前 session 注入过的 topic（injectedTopics Set）

3. 读取选中的 topic 文件
   - 每文件截断到 maxTopicBytes（默认 4KB）
   - 总注入内容 ≤ maxInjectionBytes（默认 20KB）

4. 注入到主 agent 的 context
   - 作为 user message 的附加部分（非 system prompt）
   - 格式：

     <relevant_memories>
     ## Debugging Tips (type: feedback)
     SSH uses port 2222. MySQL connection timeout after 30s.
     ...

     ## API Conventions (type: project)
     REST handlers in src/api/handlers/. Use standard error format.
     ...
     </relevant_memories>
```

### 上下文控制

| 边界 | 限制 | 配置项 |
|------|------|--------|
| 文件清单 | ~16KB | 内置（每文件 80 字符 × 200 文件） |
| 单个 topic 文件 | 4KB | `autoSurfacing.maxTopicBytes` |
| 本轮总注入 | 20KB | `autoSurfacing.maxInjectionBytes` |
| 选中文件数 | 5 | `autoSurfacing.maxFiles` |

### 模型可配置

- `autoSurfacing.model = "auto"`：使用当前会话的主 agent 模型
- `autoSurfacing.model = "provider/modelId"`：指定特定模型
- side-query 推荐用 cheap model（如 `deepseek/deepseek-v4-flash`）

---

## extractMemories（Per-turn 记忆自动提取）

### 触发时机与实现

在 `agent_end` hook 中异步 fork 子 agent（agent 运行结束时触发）。
可通过 `extractMemories.enabled` 关闭。

`agent_end` 的 `event.messages` 包含本轮所有消息（user + assistant + tool results），
子 agent 分析这些内容并提取 learnings。

### 流程

```
1. 收集本轮对话内容
   - 用户消息 + agent 回复
   - 截断到 maxContextTokens（默认 2000 tokens）

2. fork 子 agent（使用 extractMemories.model）
   - 子 agent cwd = memoryDir，通过 prompt 指导直接操作 memory 文件
   - 子 agent 知道 topic 文件格式（frontmatter + ## entries）和 MEMORY.md 格式

3. 子 agent 独立运行
   - 不阻塞主 agent
   - 不将结果注入主 agent context
   - 写入的 memory 是为未来会话用的

4. 子 agent 的 system prompt（核心指令）：

   You are a memory extraction agent. Analyze the conversation snippet
   below and decide if there are any learnings worth persisting across
   sessions. If yes, use the memory tool to add them.

   Worth remembering:
   - User preferences, coding style choices, tooling preferences
   - Project conventions, architecture decisions, naming patterns
   - Debugging insights, workarounds, gotchas discovered
   - "Always do X" / "Never do Y" rules
   - References to external systems or documentation

   NOT worth remembering:
   - One-time task instructions or ephemeral details
   - Code snippets or file paths derivable from the project
   - Information already captured in CLAUDE.md or AGENTS.md
   - Git history or recent changes

   When writing memories:
   - Use descriptive, self-contained entry titles (only index lines are injected)
   - Choose the appropriate type: user/feedback/project/reference
   - Be concise but complete
   - If you're unsure, err on the side of not writing

### 上下文控制

- 只传最近一轮的用户消息 + agent 回复
- 截断到 `maxContextTokens` tokens
- 不传完整对话历史

### 模型可配置

- `extractMemories.model = "auto"`：使用当前会话的主 agent 模型
- `extractMemories.model = "provider/modelId"`：指定特定模型
- 推荐用 cheap model

---

## Dream 增强（四阶段合并）

对齐 Claude Code autoDream 的四阶段：Orient → Gather Signal → Consolidate → Prune & Index。

### Dream task prompt（核心指令）

```
You are a memory consolidation agent. Your job is to read all memory files
and consolidate them into a clean, deduplicated memory store.

Phase 1 — Orient:
- List all files in the memory directory
- Read MEMORY.md to understand current index
- Skim each topic file to understand its contents

Phase 2 — Gather Signal:
- Find duplicate entries within and across topic files
- Identify contradictory information
- Spot outdated or obsolete entries
- Note temporal references that should be absolute dates

Phase 3 — Consolidate:
- Merge duplicates into single entries
- Resolve contradictions — pick the most accurate version
- Convert relative dates (today, last week) to absolute dates
- Update outdated information
- Move entries to more appropriate topic files when needed
- Delete entries that are no longer relevant

Phase 4 — Prune & Index:
- For each topic file, update frontmatter:
  name: meaningful name for the topic
  description: specific summary that helps LLM match queries (be specific!)
  type: user/feedback/project/reference
  updated: today's date
- Generate a compact hook (~150 chars) for each topic
- Rebuild MEMORY.md with one line per topic file:
  - [Name](file.md) — hook
- Remove topic files that have no remaining entries

CRITICAL for hooks and descriptions:
- Only the MEMORY.md index is injected into future coding sessions.
  Topic file content is NOT seen by the coding agent unless explicitly
  read or auto-surfaced. The hook and description must be specific
  enough that the LLM can correctly decide relevance.
- Bad: "Debugging tips"
- Good: "SSH port 2222 on staging; MySQL 30s timeout; Redis auth fix"
```

---

## Memory 工具更新

| action | 变化 |
|--------|------|
| `add` | `type` 可选（默认 `feedback`）；不新增 MEMORY.md 行（已有 topic 行时仅更新 hook）；首次创建 topic 时新增 MEMORY.md 行；每次 add 后 LLM 合并 topic 所有条目生成新 hook |
| `remove` | 删除条目后更新 MEMORY.md 对应行的 hook；topic 文件清空时删除 MEMORY.md 中该行 |
| `read` | 不变 |
| `search` | 不变 |

### add 的 hook 更新逻辑

add 操作后，异步调用一次轻量 LLM（使用 autoSurfacing.model，推荐 cheap model）
合并该 topic 文件所有条目的内容，生成：
- 新的 hook（~150 字符），更新 MEMORY.md 对应行
- 新的 description（~200 字符），更新 topic 文件 frontmatter

**异步执行**：hook 更新在 `add` 返回后异步进行，不阻塞 add 响应。
若 hook 更新失败，不影响 add 操作本身——hook 可能暂时过时，
下次 add 或 dream 会修正。

**优化**：若 topic 仅有一个条目且 hook 已存在，跳过 LLM 调用，
直接用 entry title 作为 hook。

---

## 文件变更清单

| 文件 | 变更 |
|------|------|
| `src/config.ts` | 配置文件名改为 `memory.json`；`MemoryConfig` 新增 `autoSurfacing` 和 `extractMemories` |
| `src/topic-file.ts` | `TopicMeta` 新增 `name`/`description`/`type`；`buildFrontmatter` 签名变更；新增 hook 生成辅助函数 |
| `src/index-file.ts` | MEMORY.md 每 topic 一行格式；`IndexEntry` 改为一 topic 一条；新增 hook 更新函数；`addEntry` 改为 upsert-by-topic |
| `src/memory-tool.ts` | `add` 逻辑变更（不新增 index 行 + 更新 hook）；`type` 定义为可选；hook 生成逻辑 |
| `src/inject.ts` | 新增 `autoSurfacing()` 函数：扫描 → side-query → 读取 → 注入 |
| `src/dream.ts` | 四阶段 task prompt |
| `src/extract.ts` | ⭐ **新文件**：extractMemories 子 agent fork 逻辑。在 `agent_end` hook 中触发，从 `event.messages` 提取对话内容，fork 子 agent 进行记忆提取 |
| `index.ts` | 注册 auto-surfacing（`before_agent_start`）和 extractMemories（`agent_end`）hook；维护 `injectedTopics` Set 做 session 内去重；更新工具 promptGuidelines；更新配置加载（配置文件名 `memory.json`） |
| `tests/*` | 更新所有相关测试用例 |

---

## 不变的部分

- 项目 hash 路径（`~/.pi/memory/<hash>/`）
- Branch-safe（git root keyed）
- System prompt 注入（`before_agent_start` + MEMORY.md snapshot）
- Nudge 逻辑
- `/memory` 命令
- `/dream` 命令（task prompt 更新但流程不变）
- Session search（`scope=sessions`）
- 容量校验
- `withFileMutationQueue` 并发安全
- Topic 路径穿越防护
- 与 `@yandy0725/pi-subagents` 的依赖关系
