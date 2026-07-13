# pi-memory

基于文件系统的持久化记忆层，为 pi 编程代理提供跨会话的项目记忆。事实、偏好、调试历史等知识以纯 Markdown 文件形式存储在 `~/.pi/memory/<项目哈希>/` 下。

对齐 Claude Code 的 auto memory 机制：每 topic 一行的 MEMORY.md 紧凑索引、基于相关性的 topic 文件自动注入、per-turn 记忆自动提取、类型化记忆分类。

## 功能

- **一个 `memory` 工具**，四种操作：`add`（追加条目）、`remove`（按标题删除条目）、`read`（加载主题或条目）、`search`（查询记忆或会话历史）
- **基于主题的文件组织**：每次 `memory add` 向指定名称的 `.md` 文件写入 `## 条目` 区块
- **`MEMORY.md` 索引**：每个 topic 文件一行紧凑指针 `- [名称](文件.md) — 摘要`，同 topic 自动合并
- **记忆类型系统**：四种分类 — `user`（用户）、`feedback`（反馈，默认）、`project`（项目）、`reference`（引用）— 存储在 topic 文件 frontmatter 中
- **Auto-surfacing** ⭐：每次用户发消息时，side-query LLM 自动选出最多 N 个相关 topic 文件并将其内容注入 agent context。无需手动 `memory read`。Session 内去重防止同一 topic 重复注入
- **Extract memories** ⭐：每次 agent 运行结束后，异步子 agent 分析对话内容，自动将 learnings 写入 memory — 偏好、约定、调试心法等
- **快照注入**：每个新会话启动时，MEMORY.md 索引追加到系统提示中
- **`/dream` 命令**：四阶段（Orient → Gather → Consolidate → Prune）无头代理整理，去重、合并、重建全部记忆文件
- **梦醒提醒**：经过 N 个会话或 N 小时后，温和通知建议运行 `/dream`
- **`/memory` 命令**：查看状态、开关记忆、检查索引和主题文件
- **会话搜索**：`memory search scope=sessions` 操作可检索过往对话历史
- **分支安全**：记忆目录以 git 根目录为键，分叉仓库自然共享记忆
- **路径穿越防护**：主题文件路径会验证是否逃逸记忆目录

## 安装

```bash
pi install npm:@yandy0725/pi-memory
```

或在 `~/.pi/agent/settings.json` 中添加：

```json
{
  "packages": ["npm:@yandy0725/pi-memory"]
}
```

## 配置

在代理目录（`~/.pi/agent/memory.json`）或项目的 `.pi/` 目录（需受信任）中创建 `memory.json`：

```json
{
  "enabled": true,
  "memoryDir": "~/.pi/memory",
  "memIndexMaxLines": 200,
  "memIndexMaxBytes": 25600,
  "dream": {
    "nudgeAfterSessions": 5,
    "nudgeAfterHours": 24,
    "model": "auto",
    "thinkLevel": "high"
  },
  "sessionSearch": {
    "maxSessions": 10,
    "maxMatches": 5
  },
  "autoSurfacing": {
    "enabled": true,
    "model": "auto",
    "thinkLevel": "off",
    "maxFiles": 5,
    "maxTopicBytes": 4096,
    "maxInjectionBytes": 20480
  },
  "extractMemories": {
    "enabled": true,
    "model": "auto",
    "thinkLevel": "high",
    "maxContextTokens": 2000
  }
}
```

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `enabled` | `true` | 开关整个记忆系统 |
| `memoryDir` | `~/.pi/memory` | 所有记忆数据的根目录 |
| `memIndexMaxLines` | `200` | `MEMORY.md` 最大行数 |
| `memIndexMaxBytes` | `25600` | `MEMORY.md` 最大字节数 |
| `dream.nudgeAfterSessions` | `5` | 触发提醒需经过的会话数 |
| `dream.nudgeAfterHours` | `24` | 触发提醒需经过的小时数 |
| `dream.model` | `"auto"` | 整理使用的模型（`"auto"` = 当前模型，或 `"provider/id"`） |
| `dream.thinkLevel` | `"high"` | 整理子 agent 的思考深度：`"off"` / `"minimal"` / `"low"` / `"medium"` / `"high"` / `"xhigh"` |
| `sessionSearch.maxSessions` | `10` | 搜索历史时最多扫描的会话数 |
| `sessionSearch.maxMatches` | `5` | 历史搜索最多返回的匹配数 |
| `autoSurfacing.enabled` | `true` | ⭐ 启用 per-turn topic 文件自动注入 |
| `autoSurfacing.model` | `"auto"` | ⭐ side-query 相关性选择模型 |
| `autoSurfacing.thinkLevel` | `"off"` | ⭐ side-query 思考深度（推荐 `"off"`，轻量选择任务） |
| `autoSurfacing.maxFiles` | `5` | ⭐ 每轮最多注入的 topic 文件数 |
| `autoSurfacing.maxTopicBytes` | `4096` | ⭐ 单个注入 topic 文件最大字节数（截断） |
| `autoSurfacing.maxInjectionBytes` | `20480` | ⭐ 每轮注入内容总字节数上限 |
| `extractMemories.enabled` | `true` | ⭐ 启用 per-turn 记忆自动提取 |
| `extractMemories.model` | `"auto"` | ⭐ 提取子 agent 使用的模型 |
| `extractMemories.thinkLevel` | `"high"` | ⭐ 提取的思考深度：`"off"` / `"minimal"` / `"low"` / `"medium"` / `"high"` / `"xhigh"` |
| `extractMemories.maxContextTokens` | `2000` | ⭐ 分析对话的最大 token 数 |

项目级配置（`.pi/memory.json`）仅在项目受信任时加载。

## 工作原理

### MEMORY.md 索引

MEMORY.md 是一个**紧凑指针索引** — 每个 topic 文件一行，而非每个条目一行：

```
- [Debugging](debugging.md) — SSH 使用 2222 端口；MySQL staging 上 30s 超时
- [API Conventions](api.md) — REST handlers 在 src/api/handlers/；使用标准错误格式
```

每次会话只有索引被注入系统提示（前 200 行 / 25KB）。Topic 文件内容**不会**在启动时加载 — 通过 auto-surfacing 按需注入或显式 `memory read`。

### Topic 文件格式

每个 topic 文件使用四字段 YAML frontmatter：

```yaml
---
name: 调试技巧
description: 常见调试模式、SSH 端口、MySQL 超时配置
type: feedback
updated: 2026-07-13
---

## SSH 踩坑
staging 使用 2222 端口，密钥在 ~/.ssh/staging

## MySQL 超时
staging 上连接超时 30s
```

`description` 字段至关重要 — auto-surfacing 的 side-query 根据它判断相关性。描述要具体。

### 记忆类型

| 类型 | 含义 | 示例 |
|------|------|------|
| `user` | 用户角色、偏好、知识背景 | "用户是数据科学家，关注可观测性" |
| `feedback` | 教训/纠正/确认（默认） | "用真实 DB 不用 mock—上次踩过坑" |
| `project` | 项目状态、deadline、incident | "merge freeze 从 3 月 5 日开始" |
| `reference` | 外部系统指针 | "bug tracker = Linear INGEST project" |

### Auto-surfacing

每次用户发消息时（`before_agent_start` hook）：
1. 扫描所有 topic 文件，提取 frontmatter 元数据
2. Side-query LLM 根据用户问题选出最多 `maxFiles` 个相关 topic 文件
3. 已注入过的 topic 跳过（session 内去重）
4. 选中文件内容注入 context — agent 自动看到相关记忆

### Extract memories

每次 agent 运行结束后（`agent_end` hook）：
1. 异步 fork 子 agent，传入本轮对话内容
2. 分析是否有值得持久化的 learnings
3. 如有，直接写入 memory 文件 — 偏好、约定、调试心法等
4. 子 agent 独立运行，结果为未来会话所用

记忆提取有选择性：忽略一次性任务、可从项目推导的代码、已在 CLAUDE.md 中的内容。

## 工具参考

```
memory(action: "add" | "remove" | "search" | "read",
        content?, topic?, title?, type?,
        entry?, query?, scope?)
```

### `add`

向 topic 文件追加 `## 条目` 区块。若该 topic 已在索引中存在，则更新 MEMORY.md 的 hook 摘要。新建 topic 时在索引中新增一行。

- **`content`**（必填）— 要持久化的知识文本
- **`topic`**（必填）— 目标文件名，如 `"debugging.md"`，不存在则自动创建
- **`title`**（必填）— 描述性、自包含的条目标题。只有 MEMORY.md 索引行被注入未来 prompt（topic 文件内容不会），所以标题必须自成一体地传达信息
- **`type`**（可选）— 记忆分类：`"user"`、`"feedback"`（默认）、`"project"`、`"reference"`

### `remove`

按标题删除条目。遍历所有 topic 文件查找匹配的 `##` 区块。更新受影响 topic 的 MEMORY.md hook。当 topic 文件中最后一条被删除后，topic 文件及其索引行均被清理。

- **`entry`**（必填）— 要删除的条目标题

### `read`

加载记忆内容。可以是整个 topic 文件或单个条目区块。

- **`topic`**（可选）— 主题名称，如 `"debugging"` 或 `"debugging.md"`。加载整个 topic 文件
- **`entry`**（可选）— 条目标题。返回对应的 `## 条目标题` 区块

### `search`

查询记忆文件或会话历史。记忆搜索返回匹配条目的完整区块（整个 `##` 区域）。

- **`query`**（必填）— 搜索关键词
- **`scope`**（可选）— `"memory"`（默认，扫描 topic 文件）或 `"sessions"`（扫描会话历史）

## 命令

### `/memory`

显示记忆状态（启用/禁用、目录、索引行数、topic 文件、上次整理时间戳）。

```
/memory        — 显示状态
/memory on     — 启用记忆
/memory off    — 禁用记忆
```

### `/dream`

启动无头代理，四阶段整理全部记忆文件：

1. **Orient** — 列出文件、读取 MEMORY.md、浏览 topic 文件
2. **Gather Signal** — 发现重复、矛盾、过时条目
3. **Consolidate** — 合并重复、解决矛盾、更新日期
4. **Prune & Index** — 重建 frontmatter、生成 hook、重建 MEMORY.md

使用的模型通过 `memory.json` 的 `dream.model` 配置。开始前弹出确认对话框，完成时通知摘要。

## 文件布局

```
~/.pi/memory/
  <12位sha256哈希>/
    MEMORY.md            — 紧凑索引：每个 topic 文件一行
    .dream-meta.json     — 上次整理的时间戳和会话计数
    debugging.md         — topic 文件（frontmatter + ## 条目）
    preferences.md
    ...
```

哈希值由项目的 git 根目录（或绝对路径）派生，每个项目拥有独立记忆命名空间。

## 快照语义

每次 `session_start` 读取 `MEMORY.md` 索引，通过 `before_agent_start` 追加到系统提示中。超限则截断并标记 `[truncated]`。此快照是会话开始时的静态副本。

Topic 文件内容通过 **auto-surfacing**（自动、per-turn、基于相关性）或显式 `memory read` 按需加载。
