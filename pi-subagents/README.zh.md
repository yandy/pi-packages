# pi-subagents

[Pi](https://pi.dev) 扩展，提供聚焦的进程内子代理核心——在同一 pi 运行时内运行的自主代理（无需生成子进程），外加类型化 API 和生命周期事件供其他扩展构建。

## 功能

- **进程内原生** — 代理共享同一 pi 运行时：相同的工具名、调用约定和 UI 模式
- **并行后台代理** — 同时启动多个代理，自动排队（可配置并发数，默认 4）
- **实时 Widget UI** — 持久化的编辑器上方组件，带动态旋转指示器、实时工具活动、token 计数、美元花销和彩色状态图标
- **父会话记账** — 子代理模型用量计入父会话 footer、`/session` 和 `/usage` 总花销，覆盖后台与恢复运行的代理
- **自定义代理类型** — 在 `.pi/agents/<name>.md` 中通过 YAML frontmatter 定义：系统提示词、模型、思考等级、工具限制
- **运行中转向** — 向运行中的代理注入消息，无需重启即可改变工作方向
- **会话恢复** — 从上次中断处继续，保留完整对话上下文
- **优雅轮次限制** — 代理在硬中止前收到"收尾"警告
- **大小写不敏感** — `"explore"`、`"Explore"`、`"EXPLORE"` 均可
- **模糊模型选择** — 按名称（`"haiku"`、`"sonnet"`）而非完整 ID 指定模型
- **模型分层** — 在配置里把 `fast` / `standard` / `advanced` 档位映射到真实模型，代理按提示选择对应模型
- **上下文继承** — 可选择把父对话摘要以文本形式前置到子代理的提示词
- **风格化通知** — 后台结果渲染为主题化通知框
- **事件总线** — 通过 `pi.events` 发出父级与子级生命周期事件（见[事件](#事件)）

## 安装

```bash
pi install npm:@yandy0725/pi-subagents
```

需要 pi >= 1.5.0。

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
| `general-purpose` | 继承父会话工具集（剔除 subagent 相关工具） | 继承父级 | harness 按子代理自身工具集渲染的提示词——沿用相同约定，外加子代理桥接段 |
| `Explore` | read, bash, grep, find, ls | 继承父级模型（可按调用覆盖） | 快速代码库探索（只读） |

## 自定义代理

在 `.pi/agents/<name>.md` 中创建 `.md` 文件定义自定义代理类型：

```markdown
---
description: 安全代码审查
tools: read, grep, find, bash
model: anthropic/claude-opus-4-6
thinking: high
max_turns: 30
timeout: 300
---

你是一名安全审计员。审查代码漏洞...
```

代理从项目级 `<cwd>/.pi/agents/<name>.md` 和全局级 `$PI_CODING_AGENT_DIR/agents/<name>.md`（默认 `~/.pi/agent/agents/`）发现。项目级覆盖全局；文件名即代理类型名。

### frontmatter 字段

| 字段 | 取值 | 默认 | 含义 |
|------|------|------|------|
| `description` | string | 文件名 | 一句话描述，出现在 `subagent` 工具的可用类型列表里 |
| `display_name` | string | 类型名 | widget、通知与结果里显示的短名字 |
| `tools` | CSV / `+name` / `-name` / `none` | 继承父会话 | 工具集，见下方 |
| `model` | string | 继承父级 | `provider/modelId` 或模糊名称；写死时优先于每次调用的 `model` |
| `thinking` | string | 继承父级 | off / minimal / low / medium / high / xhigh |
| `max_turns` | integer | 无限制 | 该类型的轮次上限，优先于每次调用的 `max_turns` |
| `timeout` | integer | 无限制 | 墙钟秒数上限（`0` = 无限制），优先于每次调用的 `timeout` |
| `prompt_mode` | `append` / `replace` | `append` | 正文与基础提示词的关系，见下节 |
| `inherit_context` | boolean | 不指定 | 每次调用没有 `inherit_context` 时的默认值 |
| `run_in_background` | boolean | 不指定 | 每次调用没有 `run_in_background` 时的默认值 |
| `enabled` | boolean | `true` | `false` 时该类型仍在注册表里，但不可启动、也不出现在类型列表中 |

`inherit_context` / `run_in_background` 只是该类型的**默认值**，显式传参永远优先——所以它们不影响能力，只影响默认策略。

`max_turns` 与 `timeout`（墙钟秒数，`0` = 无限制）会锁定该代理类型的上限：frontmatter 中的值优先于每次调用传入的参数。

### `tools` 白名单

`tools` 决定这个代理类型的工具集，共四种写法：

| frontmatter | 子代理拿到 |
|-------------|------------|
| 不写该字段 | 父会话**当前活动**工具集，剔除本包的派发工具（`subagent`、`get_subagent_result`、`steer_subagent`） |
| `tools: none`，或 `tools:`（空值） | **零个工具**：模型只能产出文本，任何工具调用都不会被接受 |
| `tools: read, grep` | 恰好这些工具，按精确名字 |
| `tools: -edit, -write, +powershell` | 继承集按顺序增删（`-name` 移除，`+name` 添加），再剔除派发工具 |

不存在“把内置工具全给”这种回退：不写字段就是继承父会话此刻绑定的工具集，所以父会话用 `/tools` 或 `--tools` 隐藏的工具，子代理也拿不到。

列表条目必须是精确的工具名——`*` 一律报错。普通名字与 `+name` / `-name` 混写同样报错。这两种错误都会点出是哪个代理类型，且在任何会话创建之前抛出。

这条规则和新的默认值对按上一版写的代理类型都是破坏性变更：不写 `tools` 以前表示一份固定的内置工具名单，不是继承；`*` 条目以前会原样转交给宿主，静默生效。如果某个代理依赖过去那种“不写就是固定名单”的行为，请自己写出工具集，或用 `-name` 收窄继承来的集合。

无论哪种形式，本包的派发工具都会被剔除，因此子代理永远不能再起子代理。空列表不会被当成“未配置”，不会回落到任何东西。

```markdown
---
tools: -edit, -write, -bash     # 只读调研：继承一切，去掉会写文件/起 shell 的工具
---
```

继承让子代理与父会话保持一致，代价是这些工具会进到它的提示词里；写一份列表（或 `none`）则把能力钉死在这个代理类型上。

### 提示词模式

`prompt_mode` 决定代理正文与“调用它的代理的系统提示词”之间的关系：

| 取值 | 组装出的系统提示词 | 适用场景 |
|------|--------------------|----------|
| `append`（默认） | harness 按子代理自身工具集渲染的基础提示词（以 `SYSTEM.md` 为基底、把 `APPEND_SYSTEM.md` 保留在我们的追加段之前，并加载 `AGENTS.md`）+ `桥接 + <active_agent> + 环境` + 用 `<agent_instructions>` 包裹的正文 | 代理应沿用调用方的约定，只在其上增加一层角色 |
| `replace` | `<active_agent>` + 环境 + 你的正文，别无他物——完全不沿用调用方的渲染产物（空正文时回落到一段极简的中性提示词），但 harness 仍会追加 skills 索引、日期与子代理自身的工作目录 | 代理需要一套自洽的规范：只读审计、评估、非编程角色 |

`replace` 是刻意的“干净房间”：凡是为调用方渲染的东西都进不来——调用方的提示词、工具清单与工具指引，项目上下文文件（`AGENTS.md`），`SYSTEM.md` / `APPEND_SYSTEM.md`，因为那些描述的是另一套工具集和角色。它也没有属于自己的工具清单：提示词里既没有工具清单也没有工具指引，而工具本身仍由 harness 直接交给模型。正因如此，提示词模式不会增删能力：能做什么只由 `tools` 白名单决定。代理需要的一切——语言、工具偏好这类内部规则，以及工具使用约定——都必须在自己的正文里重申。

`append` 是这条线的另一侧：两种模式都不继承调用方的工具清单。`append` 拿到的是 harness 按代理**自身**工具集渲染的基础提示词（自己的工具与指引），随后再追加桥接段与你的正文。

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
| `timeout` | number | 否 | 墙钟硬性时限（秒）；到点即终止代理并返回已产出的部分输出（默认无限制） |
| `run_in_background` | boolean | 否 | 后台运行不阻塞 |
| `resume` | string | 否 | 恢复之前会话的代理 ID（限制见下文「会话恢复」） |
| `inherit_context` | boolean | 否 | 把父对话摘要以文本形式前置到该次提示词（不是分叉父分支） |

### `get_subagent_result`

检查后台代理的状态并获取结果。

| 参数 | 类型 | 必填 | 描述 |
|------|------|------|------|
| `agent_id` | string | 是 | 要检查的代理 ID |
| `wait` | boolean | 否 | 等待完成；只对**正在运行**的代理生效，排队中的代理会立即返回 |
| `verbose` | boolean | 否 | 包含完整对话日志 |

### `steer_subagent`

向运行中的代理发送转向消息。

| 参数 | 类型 | 必填 | 描述 |
|------|------|------|------|
| `agent_id` | string | 是 | 要转向的代理 ID |
| `message` | string | 是 | 注入代理对话的消息 |

## 模型分层

除了直接写模型 ID，还可以在 `subagents.json` 中把能力档位映射到真实模型。映射表会列在
`subagent` 工具的 `model` 参数描述里，同时有一条 prompt guideline 提醒代理在任务需要
特定成本/能力档位时选用对应配置模型——不存在 `model_tier` 工具参数。

| 档位 | 定位 |
|------|------|
| `fast` | 最便宜、最快，能力最弱（flash / mini / haiku 级） |
| `standard` | 均衡的默认档（sonnet 级） |
| `advanced` | 能力最强、最贵（opus 级） |

映射写在 `subagents.json`：全局 `$PI_CODING_AGENT_DIR/subagents.json`（默认 `~/.pi/agent/subagents.json`），项目 `<cwd>/.pi/subagents.json`。
两层**按档位合并**，项目只改一档时无需重复其余档位：

```json
{
  "modelTiers": {
    "fast": "deepseek-flash",
    "standard": "deepseek-flash",
    "advanced": "qwen3.8-max"
  }
}
```

代理会把映射值复制到 `model`，因此与普通 `model` 值走同一套解析：`provider/modelId` 与
模糊名称（如 `"haiku"`）都可以。未配置的档位不会出现在参数描述与提示里——不会有其他
模型被静默顶替。若代理类型的 frontmatter 固定了 `model`，该模型始终优先。

## 命令

| 命令 | 描述 |
|------|------|
| `/subagents:settings` | 配置并发数、轮次限制、超时 |
| `/subagents:sessions` | 查看子代理的会话记录 |

会话查看器以只读方式复用 Pi 自身的逐条消息组件渲染会话记录，并实时跟随运行中的代理。
工具结果按 Pi 的折叠形态显示（摘要与预览），因此 `read` 调用只显示其调用行。
查看器没有展开键，部分工具调用行里提示的"to expand"键在此不适用。

查看器跟随实时尾部：未滚动时最新行始终贴在底部。向上键（`↑`/`k`、`PgUp`/`shift+up`、`Home`）会
**无条件**暂停跟随 —— 流式输出可能在按键与渲染之间新增行，用那个已经过期的值去判断"我是不是在底部"
会把刚刚离开的视口又拽回底部。向下键落到底部（`↓`/`j`、`PgDn`/`shift+down`）即恢复跟随，`end`
直接跳到底部并强制恢复；`q`/`Esc` 关闭。暂停状态**没有可视指示**（footer 始终显示 `<n> lines · <pct>%`
与键位提示）。

## 并发控制

后台代理受可配置并发限制约束（默认 4）。超出限制的代理自动排队。前台代理绕过队列。

## 持久化设置

通过 `/subagents:settings` 设置的参数持久化到 `<cwd>/.pi/subagents.json`（项目级），也可在全局 `$PI_CODING_AGENT_DIR/subagents.json`（默认 `~/.pi/agent/subagents.json`）中设置全局默认值。同一批文件也保存 [`modelTiers`](#模型分层) 映射；保存其他设置时会保留它。

| 设置 | 含义 |
|------|------|
| `maxConcurrent` | 允许同时运行的后台代理数 |
| `defaultMaxTurns` | 默认最大代理轮次（`0` = 无限制） |
| `defaultTimeoutSeconds` | 默认墙钟硬性超时秒数（`0` = 无限制；设置文件里必须是 `0`–`86400` 的整数，超范围的值会被丢弃） |
| `graceTurns` | 收到"收尾"转向后仍允许的轮次 |

`defaultMaxTurns` / `defaultTimeoutSeconds` 位于优先级链最末端：代理 frontmatter 优先于每次调用参数，每次调用参数又优先于这两个默认值。

`86400` 这个上限只约束**设置文件**（`sanitize` 丢弃非整数或超出 `0`–`86400` 的值）；每次调用的 `timeout` 参数只要求 ≥ 1，frontmatter 只要求非负整数，两者不设上限，会原样生效。

## 事件

通过 `pi.events` 发出两级事件，供其他扩展消费。

代理级事件（每个代理的状态变化）：

| 事件 | 触发时机 | 作用域 |
|------|----------|--------|
| `subagents:created` | 代理已注册 | **仅后台**（在排队准入之前） |
| `subagents:started` | 代理转入运行状态（含从队列转出） | 后台与前台 |
| `subagents:completed` | 代理成功结束 | **仅后台** |
| `subagents:failed` | 代理出错/停止/中止（含中止排队中的代理） | **仅后台** |
| `subagents:steered` | 转向消息已发送 | 运行中的代理（前后台均可） |
| `subagents:compacted` | 代理会话已压缩 | 后台与前台 |
| `subagents:settings_loaded` | 持久化设置已应用 | 扩展加载时一次 |
| `subagents:settings_changed` | 设置变更已生效 | 每次设置写入 |

前台代理的结束不会发 `completed` / `failed`：前台调用的结果直接由 `subagent` 工具返回，
需要结束事件的场景请用后台代理。

子会话级事件（子会话本身的创建与拆除，与“运行”不是一回事）：

| 事件 | 触发时机 |
|------|----------|
| `subagents:child:spawning` | 一次子运行开始、会话还未创建时 |
| `subagents:child:session-created` | 子会话已创建、扩展绑定之前（载荷含 `sessionId`，订阅者必须同步登记） |
| `subagents:child:completed` | 子提示词已结束（正常、被转向收尾或硬中止） |
| `subagents:child:disposed` | 子会话记录被拆除（退出清理、会话切换、扩展关闭、绑定失败）；**不是**每次运行结束时都发 |

## 会话恢复

`resume` 只能续跑**仍在内存中存活**的会话：记录被清理后（见下节）会返回 not found，会话尚未建立的代理会返回 no active session。
续跑实际上只是向同一个会话重发提示词，因此这些参数在这次调用里**都不生效**：`model`、
`thinking`、`max_turns`、`timeout`、`inherit_context`（会话已按首次启动时的配置创建）。
续跑也没有轮次与墙钟保护，只受父会话中断信号约束。

## 会话记录与清理

子代理的 transcript 写在父会话目录内：`<父会话所在目录>/<父会话文件名去掉 .jsonl>/tasks/`。
父会话未持久化时（headless / API 模式）退到 `$TMPDIR/pi-subagents-<uid>/<编码后的 cwd>/tasks/`。

代理结束 10 分钟后被清理：释放会话（触发 `subagents:child:disposed`）。只有已落盘的会话会留下一条可导航记录，
供 `/subagents:sessions` 重新读取。

## 子代理的执行约束

- 子代理不能再起子代理：绑定时从活动工具集剔除 `subagent` / `get_subagent_result` / `steer_subagent`（扩展注册的工具也不例外）。
- 子代理固定运行在父会话的 cwd；`subagent` 工具没有 `cwd` 参数。

## 跨扩展 API

其他扩展可以绕过工具直接调用子代理核心（包已导出入口）：

```ts
const { getSubagentsService } = await import("@yandy0725/pi-subagents");
const svc = getSubagentsService();
const id = svc?.spawn("Explore", "Check for stale TODOs", { description: "Find stale TODOs", foreground: true });
```

| 方法 | 说明 |
|------|------|
| `spawn(type, prompt, options?)` | 启动代理并立即返回 ID（不在无会话时调用，会抛错） |
| `getRecord(id)` | 当前状态的序列化快照（无活动会话对象） |
| `listAgents()` | 所有受管代理，最近的在前 |
| `abort(id)` | 中止运行中或排队中的代理 |
| `steer(id, message)` | 向运行中的代理投递转向消息 |
| `waitForAll()` | 等待所有运行中/排队中的代理结束 |
| `hasRunning()` | 是否有代理仍在运行或排队 |

`SpawnOptions`：`description`、`model`、`maxTurns`、`timeoutSeconds`（`0`/省略 = 无限制，在 API 边界归一化）、
`thinkingLevel`、`inheritContext`、`foreground`、`bypassQueue`。两个队列相关选项语义不同：
`bypassQueue` 只跳过并发限流；`foreground` 同时表示“非后台”（不发 `created` / `completed` / `failed` 事件，也不推完成通知），
但 `spawn` 仍然立即返回 ID，结果通过 `getRecord` 获取。

## 开发

```bash
npm run typecheck        # tsc --noEmit
npm run lint             # biome lint
npm test                 # vitest run
```

## 致谢

本项目是 [@gotgenes/pi-subagents](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-subagents)（作者 [Chris Lasher](https://github.com/gotgenes)）的友好分支，后者源自 [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents)。感谢所有原作者的工作使本包成为可能。

## UI 能力

两个斜杠命令和「运行中 agent」widget 都直接调用宿主的 UI 原语。widget 注册的是**组件工厂**，只有 TUI 接受这种形式；命令用的是对话框，RPC 会转发，但客户端可能不应答或直接丢弃：

| 方法 | 守卫 | 非 TUI（RPC / headless） |
|---|---|---|
| `setWidget(factory)`（运行中 / 已完成 agent 的 widget） | 无 | RPC 静默丢弃组件工厂，widget 不会出现；print / json 根本没有 UI |
| `setStatus`（agent 汇总行） | 无 | fire-and-forget，可能被丢弃 |
| `select` / `input` / `notify`（`/subagents:settings`） | 无 | 会转发；没有传 `timeout`，客户端不响应时命令一直挂着。print / json 下对话皆为空实现，菜单直接退出 |
| `select`（`/subagents:sessions`） | 无 | 会转发；没有超时 |
| `custom`（会话记录浮层） | 无 | RPC 直接返回 `undefined`：选中一个会话后什么都不显示；print / json 同理 |

## 许可证

MIT
