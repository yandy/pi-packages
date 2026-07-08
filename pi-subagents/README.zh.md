# pi-subagents

[Pi](https://pi.dev) 扩展，提供聚焦的进程内子代理核心——在同一 pi 运行时内运行的自主代理（无需生成子进程），外加类型化 API 和生命周期事件供其他扩展构建。

## 功能

- **进程内原生** — 代理共享同一 pi 运行时：相同的工具名、调用约定和 UI 模式
- **并行后台代理** — 同时启动多个代理，自动排队（可配置并发数，默认 4）
- **实时 Widget UI** — 持久化的编辑器上方组件，带动态旋转指示器、实时工具活动、token 计数和彩色状态图标
- **自定义代理类型** — 在 `.pi/agents/<name>.md` 中通过 YAML frontmatter 定义：系统提示词、模型、思考等级、工具限制
- **运行中转向** — 向运行中的代理注入消息，无需重启即可改变工作方向
- **会话恢复** — 从上次中断处继续，保留完整对话上下文
- **优雅轮次限制** — 代理在硬中止前收到"收尾"警告
- **大小写不敏感** — `"explore"`、`"Explore"`、`"EXPLORE"` 均可
- **模糊模型选择** — 按名称（`"haiku"`、`"sonnet"`）而非完整 ID 指定模型
- **上下文继承** — 可选择将父对话分叉给子代理
- **风格化通知** — 后台结果渲染为主题化通知框
- **事件总线** — 通过 `pi.events` 发出生命周期事件（`subagents:created`、`started`、`completed`、`failed`、`steered`、`compacted`）

## 安装

```bash
pi install npm:@yandy0725/pi-subagents
```

## 快速开始

父代理使用 `subagent` 工具启动子代理：

```text
subagent({
  subagent_type: "Explore",
  prompt: "Find all files that handle authentication",
  description: "Find auth files",
  run_in_background: true,
})
```

前台代理阻塞直到完成。后台代理立即返回 ID，完成后通知。

## 默认代理类型

| 类型 | 工具 | 模型 | 描述 |
|------|------|------|------|
| `general-purpose` | 全部 | 继承父级 | 完整父级系统提示词——相同规则、相同约定 |
| `Explore` | read, bash, grep, find, ls | haiku（回退：继承） | 快速代码库探索（只读） |

## 自定义代理

在 `.pi/agents/<name>.md` 中创建 `.md` 文件定义自定义代理类型：

```markdown
---
description: 安全代码审查
tools: read, grep, find, bash
model: anthropic/claude-opus-4-6
thinking: high
max_turns: 30
---

你是一名安全审计员。审查代码漏洞...
```

代理从 `.pi/agents/<name>.md`（项目级）和 `~/.pi/agent/agents/<name>.md`（全局）发现。项目级覆盖全局。

## 工具

### `subagent`

启动子代理。

| 参数 | 类型 | 必填 | 描述 |
|------|------|------|------|
| `prompt` | string | 是 | 代理要执行的任务 |
| `description` | string | 是 | 3-5 词简短描述（UI 中显示） |
| `subagent_type` | string | 是 | 代理类型（内置或自定义） |
| `model` | string | 否 | 模型覆盖（`provider/modelId` 或模糊名称） |
| `thinking` | string | 否 | off / minimal / low / medium / high / xhigh |
| `max_turns` | number | 否 | 最大代理轮次（默认无限制） |
| `run_in_background` | boolean | 否 | 后台运行不阻塞 |
| `resume` | string | 否 | 恢复之前会话的代理 ID |
| `inherit_context` | boolean | 否 | 将父对话分叉给子代理 |

### `get_subagent_result`

检查后台代理的状态并获取结果。

| 参数 | 类型 | 必填 | 描述 |
|------|------|------|------|
| `agent_id` | string | 是 | 要检查的代理 ID |
| `wait` | boolean | 否 | 等待完成 |
| `verbose` | boolean | 否 | 包含完整对话日志 |

### `steer_subagent`

向运行中的代理发送转向消息。

| 参数 | 类型 | 必填 | 描述 |
|------|------|------|------|
| `agent_id` | string | 是 | 要转向的代理 ID |
| `message` | string | 是 | 注入代理对话的消息 |

## 命令

| 命令 | 描述 |
|------|------|
| `/subagents:settings` | 配置并发数、轮次限制 |
| `/subagents:sessions` | 查看子代理的会话记录 |

## 并发控制

后台代理受可配置并发限制约束（默认 4）。超出限制的代理自动排队。前台代理绕过队列。

## 持久化设置

通过 `/subagents:settings` 设置的参数持久化到 `<cwd>/.pi/subagents.json`（项目级），也可在 `~/.pi/agent/subagents.json` 中设置全局默认值。

## 事件

通过 `pi.events` 发出的生命周期事件，供其他扩展消费：

| 事件 | 触发时机 |
|------|----------|
| `subagents:created` | 后台代理已注册 |
| `subagents:started` | 代理转入运行状态 |
| `subagents:completed` | 代理成功完成 |
| `subagents:failed` | 代理出错/停止/中止 |
| `subagents:steered` | 转向消息已发送 |
| `subagents:compacted` | 代理会话已压缩 |
| `subagents:settings_loaded` | 持久化设置已应用 |
| `subagents:settings_changed` | 设置变更已生效 |

## 权限系统集成

当安装了 `@yandy0725/pi-permission-system` 时，本包自动集成：
- 通过 YAML frontmatter 为各代理类型设置权限策略
- Agent 启动前过滤工具
- `ask` 状态从子代理转发到父级 UI

## 开发

```bash
npm run typecheck        # tsc --noEmit
npm run lint             # biome lint
npm test                 # vitest run
```

## 致谢

本项目是 [@gotgenes/pi-subagents](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-subagents)（作者 [Chris Lasher](https://github.com/gotgenes)）的友好分支，后者源自 [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents)。感谢所有原作者的工作使本包成为可能。

## 许可证

MIT
