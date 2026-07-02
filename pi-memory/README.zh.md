# pi-memory

基于文件系统的持久化记忆层，为 pi 编程代理提供跨会话的项目记忆。事实、偏好、调试历史等知识以纯 Markdown 文件形式存储在 `~/.pi/memory/<项目哈希>/` 下。

## 功能

- **一个 `memory` 工具**，四种操作：`add`（存储知识）、`replace`（编辑现有内容）、`remove`（删除）、`search`（查询记忆或会话历史）
- **基于主题的文件组织**：每次 `memory add` 都会向项目记忆目录下指定名称的 `.md` 文件写入内容
- **`MEMORY.md` 索引**：自动生成的目录，带有行数/字节容量限制
- **快照注入**：每个新会话启动时，记忆索引会追加到系统提示中，让代理始终感知过往工作
- **`/dream` 命令**：启动无头代理，对记忆文件进行去重、合并和整理
- **梦醒提醒**：经过 N 个会话或 N 小时后，温和通知建议运行 `/dream`
- **`/memory` 命令**：查看状态、开关记忆、检查索引和主题文件
- **会话搜索**：`memory search scope=sessions` 操作可检索过往对话历史
- **分支安全**：记忆目录以 git 根目录（或绝对路径）为键，分叉仓库自然共享记忆
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

在代理目录（`~/.pi/agent/pi-memory.json`）或项目的 `.pi/` 目录（需受信任）中创建 `pi-memory.json`：

```json
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
  }
}
```

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `enabled` | `true` | 开关整个记忆系统 |
| `memoryDir` | `~/.pi/memory` | 所有记忆数据的根目录 |
| `memIndexMaxLines` | `200` | `MEMORY.md` 的最大行数，超限报容量错误 |
| `memIndexMaxBytes` | `25600` | `MEMORY.md` 的最大字节数，超限报容量错误 |
| `dream.nudgeAfterSessions` | `5` | 距离上次整理经过的会话数，达到后展示提醒 |
| `dream.nudgeAfterHours` | `24` | 距离上次整理经过的小时数，达到后展示提醒 |
| `dream.model` | `"auto"` | 整理使用的模型（`"auto"` 使用当前模型，或 `"provider/id"` 指定模型） |
| `sessionSearch.maxSessions` | `10` | 搜索历史会话时最多扫描的会话数 |
| `sessionSearch.maxMatches` | `5` | 历史搜索最多返回的匹配数 |

项目级配置（`.pi/pi-memory.json`）仅在项目受信任时加载。

## 工具参考

```
memory(action: "add" | "replace" | "remove" | "search",
        content?, topic?, title?, description?,
        old_text?, query?, scope?)
```

### `add`

将内容存储到主题文件并更新 MEMORY.md 索引。

- **`content`**（必填）— 要持久化的知识文本
- **`topic`**（必填）— 目标文件名，如 `"debugging.md"`，不存在则自动创建
- **`title`**（可选）— 索引行的短标题（默认取 topic 的文件名部分）
- **`description`**（可选）— 一行描述（默认取内容前 ~80 字符）

### `replace`

定位 `old_text` 子串并替换为 `content`。

- **`old_text`**（必填）— 要查找的子串
- **`content`**（必填）— 替换文本
- **`topic`**（可选）— 限定搜索范围到指定文件；当文本在多个位置出现时必须提供

### `remove`

定位 `old_text` 并删除。当主题文件的全部内容被删除后，文件及其索引条目会被自动清理。

- **`old_text`**（必填）— 要删除的子串
- **`topic`**（可选）— 限定搜索范围到指定文件

### `search`

查询记忆文件或会话历史。

- **`query`**（必填）— 搜索关键词
- **`scope`**（可选）— `"memory"`（默认，扫描主题文件）或 `"sessions"`（扫描会话历史）

## 命令

### `/memory`

显示记忆状态（启用/禁用、目录、索引行数、主题文件、上次整理时间戳）。

```
/memory        — 显示状态
/memory on     — 启用记忆
/memory off    — 禁用记忆
```

### `/dream`

启动无头代理，读取所有记忆文件，去重、合并矛盾、更新过时信息、重组 `MEMORY.md`。使用的模型可通过 `pi-memory.json` 的 `dream.model` 配置（`"auto"` 使用当前会话模型；`"provider/id"` 指定特定模型）。

开始整理前会弹出确认对话框。完成时在通知中显示结果摘要。

整理元数据（时间戳、整理时会话计数）持久化在记忆目录下的 `.dream-meta.json` 中。

## 文件布局

```
~/.pi/memory/
  <12位sha256哈希>/
    MEMORY.md            — 索引：每个主题文件一行
    .dream-meta.json     — 上次整理的时间戳和会话计数
    debugging.md         — 用户创建的主题文件
    preferences.md
    ...
```

哈希值由项目的 git 根目录（或绝对路径）派生，确保每个项目拥有独立的记忆命名空间。

## 快照语义

每次 `session_start` 时读取 `MEMORY.md` 索引，通过 `before_agent_start` 追加到系统提示中。如果索引超过 `memIndexMaxLines` 或 `memIndexMaxBytes`，将被截断并添加 `[truncated]` 标记——代理仍能获取到最相关的部分。此快照是会话开始时的静态副本；会话中通过 `memory` 工具所做的变更不会影响当次会话的快照，而是在下次会话中生效。
