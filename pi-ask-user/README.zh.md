# pi-ask-user

一个 Pi 扩展包，添加交互式 `ask_user` 工具，用于在 Agent 运行期间收集用户决策。

## 功能

- 可搜索的单选选项列表，支持标题和描述文本换行
- 宽终端下的响应式分栏详情预览，窄终端下回退为单列布局
- 多选选项列表
- 可选的自由文本输入
- 选择后可切换添加额外上下文（可选注释）
- 上下文展示支持
- 可配置的显示模式：`overlay`（模态，默认）或 `inline`（直接内联渲染）
- 运行时浮层切换：当提示窗口打开时，按下配置的叠加层切换键（默认 `alt+o`，可通过环境变量或 `ask-user.json` 配置）临时隐藏/显示弹窗，以便阅读之前的 Agent 输出
- Pi-TUI 对齐的按键绑定和编辑器行为
- 工具调用和结果的自定义 TUI 渲染
- 通过 `promptSnippet` 和 `promptGuidelines` 集成系统提示词
- 叠加层和回退输入模式下均支持可选的超时自动关闭；非 TUI（RPC）模式的对话框另有 5 分钟默认上限，宿主不响应也不会挂死整轮。本地超时或工具中断始终拥有最终裁决权：结果为 `cancelled: true` 并带 `details.cancelReason`，即使宿主随后才 resolve / reject
- 所有结果均包含结构化 `details` 用于会话状态重建
- 交互式 UI 不可用时的优雅回退：RPC/headless 会话仍通过对话协议保持结构化单选与多选
- 内置 `ask-user` 技能，用于高风险或模糊任务中的强制决策门控

## 内置技能: `ask-user`

本包在 `skills/ask-user/SKILL.md` 中内置一个技能，引导/强制 Agent 在以下场景使用 `ask_user`：

- 架构权衡影响较大时
- 需求模糊或冲突时
- 假设会实质性地改变实现时

该技能遵循"决策握手"流程：

1. 收集证据并总结上下文
2. 通过 `ask_user` 提出一个聚焦的问题
3. 等待用户明确选择
4. 确认决策，然后继续

参见：`skills/ask-user/references/ask-user-skill-extension-spec.md`。

## 安装

```bash
pi install npm:@yandy0725/pi-ask-user
```

需要 pi >= 1.5.0。

## 工具名称

注册的工具名称为：

- `ask_user`

## 参数

| 参数 | 类型 | 默认值 | 描述 |
|-----------|------|---------|-------------|
| `question` | `string` | *必填* | 向用户提出的问题 |
| `context` | `string?` | — | 问题前展示的相关上下文摘要 |
| `options` | `(string \| {title, description?})[]?` | `[]` | 多选选项 |
| `allowMultiple` | `boolean?` | `false` | 启用多选模式 |
| `allowFreeform` | `boolean?` | `true` | 添加"自定义输入"自由文本选项 |
| `allowComment` | `boolean?` | `true` | 在自定义 UI 中提供可切换的额外上下文选项（`ctrl+g` 或切换行），并在回退对话框中收集可选注释 |
| `timeout` | `number?` | —（非 TUI 模式的对话框为 300000 ms） | N 毫秒后自动关闭，超时返回 `null`。显式传入的值始终优先于非 TUI 默认值 |

外观类选项（`displayMode`、`overlayToggleKey`、`commentToggleKey`）**不是**模型可见参数：它们是用户偏好，由环境变量与 `ask-user.json` 解析（见[显示模式](#显示模式)与[快捷键](#快捷键)）。内部 `AskParams` 类型仍接受它们（供 SDK/直接调用），但 LLM 的工具调用无法设置。

## 通过环境变量设置个人偏好

在你的 shell 配置（`~/.zshrc`、`~/.bash_profile` 等）中设置以下变量来全局配置默认值：

```bash
export PI_ASK_USER_DISPLAY_MODE=inline
export PI_ASK_USER_OVERLAY_TOGGLE_KEY=alt+h
export PI_ASK_USER_COMMENT_TOGGLE_KEY=alt+c
```

### 显示模式

生效优先级：

1. `PI_ASK_USER_DISPLAY_MODE`（如设置为 `"overlay"` 或 `"inline"`）
2. 项目配置文件 `.pi/ask-user.json`（如存在）中的 `displayMode`
3. 用户配置文件 `~/.pi/agent/ask-user.json`（如存在）中的 `displayMode`
4. 回退默认值：`"overlay"`

（SDK/直接调用传入的 `displayMode` 仍会覆盖以上所有层级，但该字段已不在模型可见的 tool schema 里。）

无法识别的值会被静默忽略并回退到 `"overlay"`。

## 通过配置文件设置个人偏好

除了环境变量，也可以通过 JSON 配置文件设置：

**文件位置：**
- 用户级（全局）：`~/.pi/agent/ask-user.json`
- 项目级：`.pi/ask-user.json`

项目级文件中的字段会覆盖用户级文件中同名字段。配置优先级：环境变量 > 项目配置 > 用户配置 > 默认值。

**示例 `~/.pi/agent/ask-user.json`：**

```json
{
  "displayMode": "inline",
  "overlayToggleKey": "alt+h",
  "commentToggleKey": "alt+c"
}
```

所有字段可选。文件不存在或 JSON 格式错误时静默忽略，等效于未配置。

### 快捷键

`overlayToggleKey` 和 `commentToggleKey` 的生效优先级：

1. 对应的环境变量（`PI_ASK_USER_OVERLAY_TOGGLE_KEY` / `PI_ASK_USER_COMMENT_TOGGLE_KEY`）
2. 项目配置文件 `.pi/ask-user.json`（如存在）
3. 用户配置文件 `~/.pi/agent/ask-user.json`（如存在）
5. 内置默认值：`alt+o` 和 `ctrl+g`

传入 `"off"`、`"none"` 或 `"disabled"`（任意级别）可以完全禁用快捷键。无效的键位格式会被静默丢弃，使用下一个来源。键位格式遵循 Pi-TUI 的 [`KeyId`](https://github.com/earendil-works/pi-mono/blob/main/packages/tui/src/keys.ts) 格式：`[mod+]...key`，修饰键为 `ctrl`、`shift`、`alt`、`super`，可任意顺序用 `+` 连接（如 `ctrl+g`、`alt+shift+x`、`escape`、`tab`）。

## 操作控制

`ask_user` 提示窗口打开时：

| 按键 | 操作 |
|-----|--------|
| `alt+o`（可通过 `overlayToggleKey` 配置） | 隐藏/显示叠加弹窗，以便阅读 Agent 之前的输出。仅在 `overlay` 模式下可用。首次隐藏时会提示恢复弹窗的按键。 |
| `ctrl+g`（可通过 `commentToggleKey` 配置） | 切换可选注释/额外上下文行（当 `allowComment: true` 时）。 |
| `enter` | 确认聚焦的选项、提交自由文本回复、或提交/跳过可选注释。 |
| `esc` | 清除搜索过滤、退出自由文本/注释模式、或取消提示。 |
| `↑` / `↓`、`ctrl+k` / `ctrl+j` | 导航选项。`ctrl+k` / `ctrl+j`（vim 风格）可在可搜索提示中打字时不干扰过滤输入。 |
| `pgup` / `pgdn` | 当问题/背景内容超出弹窗高度时滚动该区域。弹窗总高度不会超过终端的 85%，选项和帮助行始终可见；被隐藏的内容会用 `↑ n lines above` / `↓ n lines below` 指示行标注。仅在选项选择模式下可用（自由文本/注释模式下这两个按键归编辑器所有）。 |

如果你始终不希望看到叠加层，请全局设置 `PI_ASK_USER_DISPLAY_MODE=inline`，或在 `ask-user.json` 中设置 `"displayMode": "inline"`。

## RPC / headless 回退

当富 TUI 不可用时（`ctx.ui.custom()` 返回 `undefined`，例如 `pi --rpc`），工具改由对话协议（`select` / `input`）收集同样的答案：

- **单选**——一次 `select` 对话列出选项标题；`allowFreeform` 开启时追加一行自由文本入口。
- **多选**——多轮 `select`。每轮把选项列成带编号的复选行（`1. [✓] Red`、`2. [ ] Blue`）；选中某行即勾选，再选一次即取消勾选。至少勾选一项后出现 `✓ Done selecting` 结束行，`allowFreeform` 开启时出现自由文本行。对话标题里带完整选项列表（含描述）与当前已选。
- **注释**——`allowComment` 开启时，选择之后再走一次 `input`；直接提交空内容即跳过。
- **取消**——只有对话被取消（或超时）才产生 `cancelled: true`。

用户不需要手打选项标题，因此不存在“解析失败被当成取消”。只有本轮实际 offered 的行会被接受：自由文本行仅在 `allowFreeform` 开启时成立，`✓ Done selecting` 仅在已勾选时成立。返回的值不在 offered 列表里（未提供的哨兵、上一轮的旧行或任意未知字符串）时，工具返回 `isError: true` 且 `cancelled: false`，在 `details.rawInput` 回显原始答案，并在错误文本里列出可选项。

走这条路径得到的结果带 `details.fallback: "dialogs"`。

## 结果详情

所有工具结果均包含结构化的 `details` 对象，用于渲染和会话状态重建：

```typescript
type AskResponse =
  | { kind: "selection"; selections: string[]; comment?: string }
  | { kind: "freeform"; text: string };

interface AskToolDetails {
  question: string;
  context?: string;
  options: QuestionOption[];
  response: AskResponse | null;
  cancelled: boolean;
  /** 由 RPC/headless 对话协议收集答案时出现。 */
  fallback?: "dialogs";
  /** 失败描述；失败的提问保持 `cancelled: false`。 */
  error?: string;
  /** 对话返回的、与任何可选项都不匹配的原始答案。 */
  rawInput?: string;
  /** 工具自行结算时给出；用户（或宿主）主动取消时缺省。 */
  cancelReason?: "timeout" | "abort";
}
```

## RPC / headless 宿主

RPC 模式（`pi --mode rpc`）下 `ctx.ui.custom()` 返回 `undefined`，`ask_user` 回退到扩展 UI 对话框协议
（`select()` / `input()`）。

**硬要求：RPC 客户端必须实现 `select`、`confirm`、`input`、`editor` 四个对话框方法。** 每个方法发出一个
`extension_ui_request`，并等待带相同 `id` 的 `extension_ui_response`。宿主只有在请求带 `timeout` / `signal`
时才注册定时器与 abort 监听，因此静默丢弃这些请求的客户端会挂死任何向用户提问的工具调用。
线格式见宿主的 `docs/rpc-extension-ui.md`。

`ask_user` 对静默客户端有自保：

- 每次对话框调用都同时带 `timeout` 与 `AbortSignal`，守规矩的宿主可显示倒计时，并在 turn 被中断时关闭弹窗。
- 非 TUI 模式下，调用方未传 `timeout` 时适用 **300000 ms（5 分钟）** 默认上限；显式 `timeout` 始终优先。
  TUI 模式不设默认上限——真实用户在场，可随时按 `esc`。
- 工具还会用本地 deadline 与工具 abort signal 与宿主 promise 赛跑，宿主完全忽略这两个选项时也能结算。
  超时会 abort 传给宿主的 signal，让守规矩的宿主撤掉弹窗。
- 已记录的本地超时/中断拥有最终裁决权：宿主在 abort listener 里同步 resolve/reject，或在本地取消之后才
  结算，都不能把结果改成答案或宿主错误；迟到的 rejection 会被消费，不会变成 unhandled rejection。
  没有本地取消原因时，每条 dialog 路径（包括无选项的自由提问 `input()`）上宿主异常都返回结构化的
  `isError` 结果。
- 结算结果为 `cancelled: true` 加 `details.cancelReason`：到期为 `"timeout"`，被中断为 `"abort"`，
  用户（或宿主）主动取消时缺省。富内联/叠加层 UI 同样上报这两个原因：显式 `timeout` 与工具中断会结算
  提示并清理 timer 与 abort listener，任何结局（作答、取消、超时、中断、组件构造抛错）都会清理，
  迟到回调不会再结算一次。

## 致谢

本项目基于 [pi-ask-user](https://github.com/edlsh/pi-ask-user)（作者 [Enzo Lucchesi](https://github.com/edlsh)）。感谢原作者的出色工作。

## UI 能力

`ask_user` 依赖宿主的 UI 原语，各方法在不同运行模式下的支持并不一致：

| 方法 | 守卫 | 非 TUI（RPC / headless） |
|---|---|---|
| `custom`（富交互的内联 / 浮层提问组件） | `hasUI` | RPC 直接返回 `undefined`，工具退回下面的 `select` / `input` 对话协议。显式 `timeout` 或工具中断会把提示结算为 `cancelled: true` 加 `details.cancelReason: "timeout"` / `"abort"`（超时渲染为 `Timed out`），并在每条退出路径上清理 timer 与 abort listener |
| `onTerminalInput`（浮层切换键） | `mode === "tui"`（只在组件路径里注册） | 不注册 |
| `select` / `input`（对话降级、无选项的自由提问） | `hasUI` | 以 `extension_ui_request` 转发，客户端应当应答。每次调用都带 `timeout` + `signal`，工具另用本地 deadline（非 TUI 默认 300000 ms）与工具 abort signal 赛跑，客户端不响应时结算为 `cancelled: true` 加 `details.cancelReason: "timeout"`，不会挂死整轮；本地取消同样优先于之后才到达的宿主 resolve / reject |
| `notify`（`ask_user hidden — press …` 提示） | `mode === "tui"` | 不会触发 |
| `hasUI === false`（print / json） | `hasUI` | 返回 `Ask requires interactive mode …` 错误结果，让模型改用纯文本提问 |

## 许可证

MIT
