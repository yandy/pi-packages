# pi-memory v2 设计规格

> 基于 `2026-07-02-pi-memory-design.md`（v0.1.0），经 brainstorming 重新确认需求后的完整设计。

## 变更动机

1. **Entry 粒度**：一个 topic 文件可以有多个 entry（`## entryTitle` block），MEMORY.md 允许多行指向同一 topic
2. **简化 API**：移除 `replace` action 和 `old_text` 参数，用更语义化的参数替代
3. **增强读取**：新增 `read` action，按 topic name 加载整个话题或按 entry title 返回单个 entry block
4. **优化搜索**：搜索结果返回完整 entry block 而非 ±2 行上下文
5. **Dream 适配**：entry 粒度去重/合并 + MEMORY.md 索引更新

---

## API 签名

```ts
Type.Object({
  action: StringEnum(["add", "remove", "search", "read"]),

  // add
  content: Type.Optional(Type.String({ description: "Knowledge text to store (add)." })),
  topic: Type.Optional(Type.String({ description: "Target topic filename, e.g. 'debugging.md'. Auto-created if new (add)." })),
  title: Type.Optional(Type.String({ description: "Short title for the MEMORY.md index line (add). Required for add." })),

  // remove
  entry: Type.Optional(Type.String({ description: "Entry title to remove. Exact match on MEMORY.md index line." })),

  // search
  query: Type.Optional(Type.String()),
  scope: Type.Optional(StringEnum(["memory", "sessions"])),

  // read
  topic: Type.Optional(Type.String({ description: "Topic name, e.g. 'debugging' or 'debugging.md'. Loads entire topic file." })),
  entry: Type.Optional(Type.String({ description: "Entry title. Returns the specific ## block content." })),
})
```

### 变更汇总

| 变更 | 说明 |
|------|------|
| actions | `replace` 移除，新增 `read` |
| `description` | 移除（MEMORY.md 索引行不再有描述文本） |
| `old_text` | 移除 |
| `title`（add） | 改为必填（LLM 必须显式提供） |
| `entry`（remove） | 替代 `old_text`，精确匹配 MEMORY.md 索引行 |
| `topic`（read） | 支持 `"debugging"` / `"debugging.md"`，返回整个 topic 文件 |
| `entry`（read） | 按 entry title 返回单个 `## entryTitle` block |

### promptSnippet / promptGuidelines

更新：去掉 replace/old_text 相关指引，添加 read 相关指引。

---

## 文件格式

### MEMORY.md

无 description 的简化索引行，允许多行指向同一 topic：

```markdown
- [SSH Gotcha](debugging.md)
- [MySQL Timeout](debugging.md)
- [Firewall Rules](network.md)
```

### Topic 文件

简化 frontmatter（仅 `updated`），无 `#` 一级标题，frontmatter 后直接 `## entryTitle`。文件名本身即标识：

```markdown
---
updated: 2026-07-03
---

## SSH Gotcha
staging uses port 2222

## MySQL Timeout
connection timeout after 30s on staging
```

---

## `add` 行为

参数：`content`（必填）、`topic`（必填）、`title`（必填）。

流程：

1. 解析 topic 文件路径（`safeTopicPath` 防穿越）
2. 读取已有 topic 文件（如存在）
3. 若文件不存在 → 写 `buildFrontmatter({ updated: today() })` + `\n## title\n\ncontent`
4. 若文件存在 → 追加 `\n\n## title\n\ncontent`，刷 frontmatter `updated`
5. MEMORY.md **追加**新索引行（不 upsert，允许多行同 topic）
6. 容量校验：超限回滚 + 返回错误
7. 走 `withFileMutationQueue(join(memoryDir, "MEMORY.md"), ...)`

---

## `remove` 行为

参数：`entry`（必填，entry title 精确匹配）。

流程：

1. 读 MEMORY.md，按 `entry` 匹配索引行 `- [entry](topicFile)`
2. 必须**恰好 1 条**匹配，否则报错（"no match" / "multiple matches"）
3. 从 MEMORY.md 删除该索引行
4. 读取 topic 文件，找并删除 `## entry\n\n...` block（到下一个 `## ` 或文件尾），含前导空行
5. 若 topic 文件无剩余 `## ` → 删除该 topic 文件
6. 否则 → 刷新 frontmatter `updated` 为 today
7. 走 `withFileMutationQueue(join(memoryDir, "MEMORY.md"), ...)`

### `##` block 移除示例

```markdown
---
updated: 2026-07-03
---

## SSH Gotcha
staging uses port 2222

## MySQL Timeout
connection timeout after 30s
```

移除 `entry="SSH Gotcha"` 后：

```markdown
---
updated: 2026-07-03
---

## MySQL Timeout
connection timeout after 30s
```

---

## `search` 行为（scope=memory）

参数：`query`（必填）、`scope`（memory | sessions）。

`scope=memory` 流程：

1. 遍历所有 topic `.md` 文件，解析为 entry blocks（`## title\n\ncontent`）
2. 每个 entry 内做大小写不敏感子串匹配
3. 命中 → 返回**整个 entry block**（不是 ±2 行）
4. 格式：`### topicFile\n\`\`\`\n## title\ncontent\n\`\`\``

`scope=sessions` 行为不变（`searchSessions` 子串匹配 + 上下文）。

---

## `read` 行为

- **`topic` 传参**：读整个 topic 文件。`topic` 值支持 `"debugging"` 和 `"debugging.md"`（自动补扩展名），`safeTopicPath` 防路径穿越。返回原始 markdown 内容。

- **`entry` 传参**：扫描所有 topic 文件，找到包含 `## entry` 的 block，返回该 block 的完整内容。

---

## Dream 变更

从「按 topic 文件粒度合并」改为「entry 粒度整理 + 索引重建」。

### Dream prompt 核心指令

```
You are a memory consolidation agent. Your job: read all memory files in <dir>,
consolidate entries within each topic (merge duplicates, resolve contradictions,
update outdated info), and rebuild the MEMORY.md index. Rules:
- Each topic file contains entries as `## Entry Title` blocks.
- Deduplicate entries: if two entries in the same topic contain the same info, merge them.
- If entries across different topics overlap, move the content to the more appropriate topic.
- Rebuild MEMORY.md index: list entries you deem valuable (not necessarily every entry). Each line: - [Entry Title](topic.md). Accuracy matters more than completeness.
- When done, output a summary: merged N, removed N, moved N, updated N.
```

### 流程不变

- fork headless agent（`createAgentSession`）
- 工具限制：`read` / `edit` / `write`，`cwd=memoryDir`
- in-memory session（`SessionManager.inMemory`）
- 隔离的 `DefaultResourceLoader`（空 settings/agentDir，不入任何扩展）
- auth 显式传入（`authStorage` / `modelRegistry`）

### 索引重建

dream 结束后，MEMORY.md 索引应准确反映 dream 整理后的结果。不要求 MEMORY.md 覆盖 topic 文件中的所有 `##` entry——dream 可选择性列出有价值的 entry，索引只需对其列出的条目保持准确即可。

---

## `src/topic-file.ts` 变更

| 函数 | 变更 |
|------|------|
| `TopicMeta` | 仅 `updated: string` |
| `buildFrontmatter(meta)` | 仅输出 `updated` |
| `appendContent(existing, entryTitle, content)` | 新文件（existing=null）：`## entryTitle\n\ncontent`；已有文件：追加 `\n\n## entryTitle\n\ncontent`。不负责 frontmatter（由 `doAdd` 处理） |
| `updateFrontmatterDate(raw, date)` | **新增**，更新 frontmatter 中 `updated` 字段 |
| `removeEntrySection(raw, title)` | **新增**，移除 `## title` 对应 block |
| `hasEntries(raw)` | **新增**，是否存在 `## ` 二级标题 |
| `parseEntries(raw)` | **新增**，解析 topic 文件为 `{ title, content }[]`，用于 search |
| `isEmptyAfterRemove` | **移除** |

## `src/index-file.ts` 变更

| 函数 | 变更 |
|------|------|
| `IndexEntry` | `description` 字段移除 |
| `upsertEntry` | **移除** |
| `addEntry(entries, entry)` | **新增**，始终 `[...entries, entry]`（push） |
| `removeEntryByTitle(entries, title)` | **新增**，按 title 匹配移除一条（返回 `IndexEntry[]`） |
| `matchEntryByTitle(entries, title)` | **新增**，按 title 精确匹配，返回 `IndexEntry | null` + 是否唯一 |
| 序列化格式 | 索引行：`- [title](topic)`（无 ` — description`） |

## `src/memory-tool.ts` 变更

| 函数 | 变更 |
|------|------|
| `doAdd` | 重写：always append + 新 topic 格式 + 无 description |
| `doReplace` | **移除** |
| `doRemove` | 重写：按 `entry` 精确匹配索引行 + 删 ## block + 无 entry 时删文件 |
| `doRead` | **新增**：按 `topic` 加载整个 topic 文件 / 按 `entry` 返回单个 block |
| `searchMemory` | 改进：返回完整 entry block（解析 ## 区域），不再仅 ±2 行 |
| `findMatches` | **移除** |
| `AddParams` | `title` 改为必填，`description` 移除 |
| `ReplaceParams` | **移除** |
| `RemoveParams` | 改为 `{ entry: string }` |

---

## 边界情况

### `remove` entry 冲突

不同 topic 文件中可能存在同名 entry title。`remove` 按 `- [entry](topicFile)` 在 MEMORY.md 中匹配索引行：
- 0 条匹配 → 报错 "no match for entry '<entry>'"
- 1 条匹配 → 正常删除
- >=2 条匹配 → 报错 "multiple matches" + 列出匹配的 topic 文件

### `read` 参数互斥

`topic` 和 `entry` 不可同时传——若同时提供，`topic` 优先（加载整个 topic 文件）。

### `read` topic 名处理

`topic` 参数自动处理扩展名：`"debugging"` 和 `"debugging.md"` 均解析为 `debugging.md`。

---

## 不变的部分

- `search` scope=sessions 行为不变
- Dream 流程不变（headless agent fork、隔离、in-memory session）
- 配置机制不变（`pi-memory.json`）
- System prompt 注入（snapshot）不变
- nudge 逻辑不变
- `/memory` 命令不变
- 容量校验不变
- `withFileMutationQueue` 并发安全不变
- topic 路径穿越防护不变

---

## 测试更新

### `topic-file.test.ts`

- 更新 `buildFrontmatter`：仅验证 `updated`，无 `name` / `description` / `type`
- 更新 `appendContent`：新文件不包含 `# ` 一级标题
- 新增 `updateFrontmatterDate` 测试
- 新增 `removeEntrySection` 测试（单 entry / 多 entry / 首 entry / 尾 entry）
- 新增 `hasEntries` 测试
- 新增 `parseEntries` 测试（单 entry / 多 entry / 空文件）
- 移除 `isEmptyAfterRemove` 测试

### `index-file.test.ts`

- 移除 `upsertEntry` 测试
- 新增 `addEntry` 测试（始终 push，不替换）
- 新增 `removeEntryByTitle` 测试
- 新增 `matchEntryByTitle` 测试（unique / no match / multiple）
- 更新序列化/解析测试：索引行无 description

### `memory-tool.test.ts`

- 更新 `doAdd`：
  - 同一 topic 有多行（不 upsert）
  - 新 topic 文件无一级标题、有 frontmatter（仅 updated）
  - 追加已有 topic 刷新 `updated`
  - 无 description
- 移除 `doReplace` 测试
- 重写 `doRemove`：
  - 按 entry 精确删除（索引行 + ## block）
  - 多 entry topic 删除一个后文件仍存在
  - 最后一个 entry 删除后文件被删除
  - entry 不存在时报错
  - 多匹配时报错
- 新增 `doRead`：
  - `topic` 参数加载整个 topic 文件
  - `entry` 参数返回单个 entry block
  - 安全防护（路径穿越拒绝）
- 更新 `searchMemory`：
  - 命中返回完整 entry block（整个 ## 区域）
  - 多 entry topic 中各 entry 独立匹配

### `dream.test.ts`

- 更新 dream prompt 构建测试（entry 粒度指令）
- 其他 dream 测试不变

### 不变

config / paths / inject / nudge / session-search / index-wiring 测试全部不变。
