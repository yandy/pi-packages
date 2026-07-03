# pi-memory entry 粒度重构

> 基于 `2026-07-02-pi-memory-design.md`（v0.1.0），对 `add`/`remove` 行为做 entry 粒度重构。本文档仅描述变更部分，未提及的行为沿用原设计。

## 变更动机

当前 `add` 按 topic 文件做 upsert（同一 topic 只有一个索引行），`remove` 按子串匹配删除任意文本。新需求：

1. **一个 topic 文件可以有多个 entry**——每行为一个知识条目，对应 topic 文件中的一个 `##` 区域。
2. **remove 按 entry 精确删除**——通过 entry title 匹配，删除索引行 + topic 文件中对应的 `##` block。

---

## 变更清单

| 组件 | 变更 |
|------|------|
| `replace` action | **移除**（原设计中的 action 之一） |
| `old_text` 参数 | **移除** |
| `add` 行为 | MEMORY.md 始终 append（不再 upsert）；新 topic 文件写 frontmatter + `## entryTitle`；已有 topic 追加 `## entryTitle` + 刷新 `updated` |
| `remove` 行为 | 按 `title` 精确匹配 MEMORY.md 索引行；删索引行 + 删 topic 文件中对应 `## title` block；无剩余 `##` → 删文件 |
| frontmatter | 简化为仅 `name` + `updated`（移除 `description`、`type`） |
| topic 文件结构 | 无 `#` 一级标题，frontmatter 后直接 `## entryTitle` |

---

## API 签名

```ts
Type.Object({
  action: StringEnum(["add", "remove", "search"]),
  // add
  content: Type.Optional(Type.String({ description: "Knowledge text to store (add)." })),
  topic: Type.Optional(Type.String({ description: "Target topic filename, e.g. 'debugging.md'. Auto-created if new (add)." })),
  title: Type.Optional(Type.String({ description: "Short title for the MEMORY.md index line (add/remove). Required for both add and remove." })),
  description: Type.Optional(Type.String({ description: "One-line description for the MEMORY.md index line (add). Defaults to first line of content truncated ~80 chars." })),
  // search
  query: Type.Optional(Type.String()),
  scope: Type.Optional(StringEnum(["memory", "sessions"])),
})
```

移除：`old_text`。

---

## 文件结构（变更后）

### MEMORY.md

允许多行 link 同一 topic 文件：

```markdown
- [SSH Gotcha](debugging.md) — staging uses port 2222
- [MySQL Timeout](debugging.md) — connection timeout after 30s on staging
- [Firewall Rules](network.md) — prod port 443
```

### topic 文件

无一级标题，简化 frontmatter 后直接 `## entryTitle`：

```markdown
---
name: debugging
updated: 2026-07-03
---

## SSH Gotcha
staging uses port 2222

## MySQL Timeout
connection timeout after 30s on staging
```

---

## `add` 行为（变更）

参数：`content`（必填）、`topic`（必填）、`title`（必填）、`description`（可选，默认 content 首行截断 ~80 字符）。

流程：

1. 解析 topic 文件路径（`safeTopicPath` 防穿越）。
2. 读取已有 topic 文件（如存在）。
3. 若文件不存在 → 写 `buildFrontmatter({ name: topicTitle, updated: today() })` + `\n## title\n\ncontent`。
4. 若文件存在 → 追加 `\n\n## title\n\ncontent`，同时更新 frontmatter 中的 `updated` 为 today。
5. **在 MEMORY.md 追加**一条新索引行（不再 upsert 同 topic 的已有行）。
6. 容量校验（同原设计，超限回滚）。
7. 走 `withFileMutationQueue(join(memoryDir, "MEMORY.md"), ...)`。

`title` 的默认行为（原为"默认 topic 词干"）→ **改为必填**（因为 remove 依赖精确匹配，LLM 应显式提供有意义的 title）。

---

## `remove` 行为（重设计）

参数：`title`（必填，entry title 精确匹配）。

流程：

1. 读取 MEMORY.md，按 `[title](topicFile)` 匹配索引行。
2. 必须**恰好 1 条**匹配 → 否则报错（"no match" / "multiple matches"）。
3. 提取匹配行的 `topicFile`（即 topic 文件名）。
4. 从 MEMORY.md 中删除该索引行。
5. 读取 topic 文件，找到并删除 `## title\n\n...` block（到下一个 `## ` 或文件尾）。
6. 若 topic 文件中已无 `## ` 二级标题 → 删除该 topic 文件。
7. 否则 → 更新 frontmatter 的 `updated` 为 today，写回 topic 文件。
8. 走 `withFileMutationQueue(join(memoryDir, "MEMORY.md"), ...)`。

### `##` block 移除逻辑

移除从 `## title` 行开始到下一个 `## ` 行（或文件尾）为止的全部内容，包括前导空行。例如：

```markdown
---
name: debugging
updated: 2026-07-03
---

## SSH Gotcha
staging uses port 2222

## MySQL Timeout
connection timeout after 30s
```

移除 `title="SSH Gotcha"` 后：

```markdown
---
name: debugging
updated: 2026-07-03
---

## MySQL Timeout
connection timeout after 30s
```

---

## `src/topic-file.ts` 变更

| 函数 | 变更 |
|------|------|
| `TopicMeta` | 仅 `name: string` + `updated: string` |
| `buildFrontmatter(meta)` | 仅输出 `name` + `updated` |
| `appendContent(existing, entryTitle, content)` | 新文件（existing=null）：`## entryTitle\n\ncontent`；已有文件：追加 `\n\n## entryTitle\n\ncontent`。不负责 frontmatter（由调用方 `doAdd` 处理） |
| `updateFrontmatterDate(raw, date)` | **新增**，更新 frontmatter 中 `updated` 字段 |
| `removeEntrySection(raw, title)` | **新增**，移除 `## title` 对应 block |
| `hasEntries(raw)` | **新增**，返回是否还有 `## ` 二级标题 |
| `isEmptyAfterRemove` | **移除** |

## `src/index-file.ts` 变更

| 函数 | 变更 |
|------|------|
| `upsertEntry` | **移除** |
| `addEntry(entries, entry)` | **新增**，始终 `[...entries, entry]`（push，不替换） |
| `removeEntryByTitle(entries, title)` | **新增**，按 title 匹配并移除一条（返回 `IndexEntry[]` 和新长度） |
| `matchEntryByTitle(entries, title)` | **新增**，按 title 精确匹配返回 `IndexEntry \| null` + 是否唯一 |

## `src/memory-tool.ts` 变更

| 函数 | 变更 |
|------|------|
| `doAdd` | 重写：always append + 新 topic 文件格式 + 无 frontmatter `description`/`type` |
| `doReplace` | **移除** |
| `doRemove` | 重写：按 title 匹配索引行 + 删 ## block + 无 entry 时删文件 |
| `findMatches` | **移除**（remove 不再用子串搜索） |
| `AddParams` | `title` 改为必填 |
| `ReplaceParams` | **移除** |
| `RemoveParams` | `title: string`（替代 `old_text`），移除 `topic` |

---

## 边界情况

### frontmatter `name`（topic title）生成

取 topic 文件名去掉 `.md` 扩展名作为 topic title，例如 `debugging.md` → `debugging`，`go-setup.md` → `go-setup`。不做 slug 化或大小写转换——保留用户/LLM 原始命名。

### `remove` title 冲突

不同 topic 文件中可能存在同名的 entry title。`remove` 按 `[title](topicFile)` 在 MEMORY.md 中匹配索引行：
- 0 条匹配 → 报错 "no match"
- 1 条匹配 → 正常删除
- >=2 条匹配 → 报错 "multiple matches" + 列出匹配的 topic 文件，要求 LLM 先删一个再用不同 title 重试

（不额外引入 `topic` 参数来消歧义——保持 remove 签名最简。）

---

## 不变的部分

- `search` action（scope=memory / sessions）完全不变
- `dream` 行为不变（仍按 topic 文件粒度合并）
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

- 更新 `buildFrontmatter` 测试：仅验证 `name` + `updated`，无 `description`/`type`
- 更新 `appendContent` 测试：新文件不包含 `# ` 一级标题
- 新增 `updateFrontmatterDate` 测试
- 新增 `removeEntrySection` 测试（单 entry / 多 entry / 首 entry / 尾 entry）
- 新增 `hasEntries` 测试
- 移除 `isEmptyAfterRemove` 测试

### `index-file.test.ts`

- 移除 `upsertEntry` 测试
- 新增 `addEntry` 测试（验证始终 push，不替换）
- 新增 `removeEntryByTitle` 测试
- 新增 `matchEntryByTitle` 测试（unique match / no match / multiple）

### `memory-tool.test.ts`

- 更新 `doAdd` 测试：
  - 验证 MEMORY.md 中同一 topic 有多行（不再 upsert）
  - 验证新 topic 文件无一级标题、有 frontmatter（仅 name+updated）
  - 验证追加已有 topic 时刷新 `updated`
- 移除 `doReplace` 测试
- 重写 `doRemove` 测试：
  - 按 title 删除 entry（索引行 + ## block）
  - 多 entry topic 删除一个后文件仍存在
  - 最后一个 entry 删除后文件被删除
  - title 不存在时报错
  - 多匹配时报错
