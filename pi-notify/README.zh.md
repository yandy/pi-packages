# pi-notify

pi 的桌面通知包：当你并行运行多个 pi 实例时，每个实例在「停下来等你」——弹出阻塞式对话框，或一轮任务跑完——时发出桌面通知，你不必再轮流盯各个终端。

## 功能

- **等待输入**：任何阻塞式 `ctx.ui` 弹窗（select / confirm / input / editor / custom，含其它扩展发起的弹窗）立即发送通知，正文为弹窗标题，urgency 默认 `critical`（常驻，需手动关闭）。
- **任务完成**：agent 完全空闲（`agent_settled`）时发送通知，urgency 默认 `normal`，正文为最后一条 assistant 消息的纯文本摘要（压缩空白，截断为 160 字符 + `…`）。
- **实例标识**：每条通知标题都带 session 名（缺省回退为项目目录名）和进程 pid，例如 `myproj (pid 4242)`。
- **防打扰**：短于最短时长阈值（默认 10 秒）的回合不发完成通知——你正在窗口里连续交互的短问答保持安静；被中断（aborted）的回合不通知。
- **`/notify` 命令**：运行时切换当前实例的通知开关。
- **失败安全**：通知发送为 fire-and-forget；若启动通知程序失败（例如 `notify-send` 不存在），在 pi UI 中警告一次后保持静默，绝不阻塞 agent 循环。

## 安装

```bash
pi install npm:@yandy0725/pi-notify
```

或添加到 `~/.pi/agent/settings.json`：

```json
{
  "packages": ["npm:@yandy0725/pi-notify"]
}
```

要求 pi >= 1.5.0，且系统有可用的 `notify-send`（或自定义命令，见下文）。

## 通知格式

| 事件 | 标题 | 正文 | urgency（默认） |
|------|------|------|-----------------|
| `ui_prompt_start` | `Waiting for input — <name> (pid <pid>)` | 弹窗标题，无标题时为其 kind | `critical` |
| `agent_settled`（非 aborted） | `Task finished — <name> (pid <pid>)` | 最后一条 assistant 消息摘要；无则空 | `normal` |

`<name>` 为通过 `/name` 或 `pi.setSessionName()` 设置的 session 名，缺省回退为工作目录的 basename。

## 配置

全部通过环境变量配置：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PI_NOTIFY` | 启用 | 设为 `0` 或 `false` 使实例启动时通知关闭 |
| `PI_NOTIFY_MIN_DURATION_MS` | `10000` | 完成通知的最短回合时长；`0` 表示每个回合都通知。非法值或负值回退默认 |
| `PI_NOTIFY_URGENCY_PROMPT` | `critical` | 等待输入通知的 urgency |
| `PI_NOTIFY_URGENCY_DONE` | `normal` | 完成通知的 urgency |
| `PI_NOTIFY_COMMAND` | `notify-send` | 自定义通知程序；以 `<command> <title> <body>` 调用（不传 urgency） |

回合时长从当前空闲周期间隔内首个 `agent_start` 计到 `agent_settled`，时长 **>=** 阈值才发送。每次 settle 与 session 替换都会重置计时；等待输入通知不受阈值影响。

`/notify` 切换当前实例的开关并在 pi UI 中反馈新状态。开关仅存于内存：`PI_NOTIFY` 决定初始状态，`session_start`（startup / reload / new / resume / fork）时重置。

## 行为说明

- 在所有 pi 模式（tui / rpc / print / json）下行为一致；桌面投递不依赖终端 UI。
- 早于 `session_start` 的弹窗（例如扩展发起的 project trust 确认）也会通知（惰性初始化）。pi 内置的 trust prompt 不经过扩展 UI 通道，不覆盖。
- 通知正文会显示在桌面上（是否含锁屏取决于桌面设置），可能包含会话内容。
- 非目标：点击通知聚焦对应终端窗口、窗口聚焦时自动免打扰——Wayland 下均无可靠实现。最短时长阈值用于近似后者。

## UI 能力

| 方法 | 守卫 | 非 TUI |
|------|------|--------|
| `ctx.ui.notify`（开关反馈、发送失败警告） | `none` | fire-and-forget，可能被宿主静默丢弃；核心桌面通知不依赖它 |

## License

MIT
