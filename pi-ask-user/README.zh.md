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
- 运行时浮层切换：当提示窗口打开时，按下配置的叠加层切换键（默认 `alt+o`，可每次调用配置或通过环境变量设置）临时隐藏/显示弹窗，以便阅读之前的 Agent 输出
- Pi-TUI 对齐的按键绑定和编辑器行为
- 工具调用和结果的自定义 TUI 渲染
- 通过 `promptSnippet` 和 `promptGuidelines` 集成系统提示词
- 叠加层和回退输入模式下均支持可选的超时自动关闭
- 所有结果均包含结构化 `details` 用于会话状态重建
- 交互式 UI 不可用时的优雅回退
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
| `allowComment` | `boolean?` | `false` | 在自定义 UI 中提供可切换的额外上下文选项（`ctrl+g` 或切换行），并在回退对话框中收集可选注释 |
| `displayMode` | `"overlay" \| "inline"?` | 环境变量或 `"overlay"` | 控制自定义 UI 渲染：`overlay` 显示居中模态框（当前行为），`inline` 不显示叠加框架渲染 |
| `overlayToggleKey` | `string?` | 环境变量或 `"alt+o"` | 隐藏/显示叠加弹窗的快捷键（仅 overlay 模式）。Pi-TUI 键位格式，例如 `"alt+o"`、`"ctrl+shift+h"`。传入 `"off"` 禁用。 |
| `commentToggleKey` | `string?` | 环境变量或 `"ctrl+g"` | 当 `allowComment: true` 时切换可选注释/额外上下文行的快捷键。传入 `"off"` 禁用。 |
| `timeout` | `number?` | — | N 毫秒后自动关闭，超时返回 `null` |

## 通过环境变量设置个人偏好

在你的 shell 配置（`~/.zshrc`、`~/.bash_profile` 等）中设置以下变量来全局配置默认值：

```bash
export PI_ASK_USER_DISPLAY_MODE=inline
export PI_ASK_USER_OVERLAY_TOGGLE_KEY=alt+h
export PI_ASK_USER_COMMENT_TOGGLE_KEY=alt+c
```

### 显示模式

生效优先级：

1. 每次调用时的 `displayMode` 参数（如提供）
2. `PI_ASK_USER_DISPLAY_MODE`（如设置为 `"overlay"` 或 `"inline"`）
3. 回退默认值：`"overlay"`

无法识别的值会被静默忽略并回退到 `"overlay"`。

### 快捷键

`overlayToggleKey` 和 `commentToggleKey` 的生效优先级：

1. 每次调用时的参数（如提供）
2. 对应的环境变量（`PI_ASK_USER_OVERLAY_TOGGLE_KEY` / `PI_ASK_USER_COMMENT_TOGGLE_KEY`）
3. 内置默认值：`alt+o` 和 `ctrl+g`

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

如果你始终不希望看到叠加层，请每次调用时设置 `displayMode: "inline"`，或全局设置 `PI_ASK_USER_DISPLAY_MODE=inline`。

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
}
```

## 致谢

本项目基于 [pi-ask-user](https://github.com/edlsh/pi-ask-user)（作者 [Enzo Lucchesi](https://github.com/edlsh)）。感谢原作者的出色工作。

## 许可证

MIT
