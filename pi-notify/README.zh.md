# pi-notify

pi 的桌面通知包：当你并行运行多个 pi 实例时，每个实例在「停下来等你」——弹出阻塞式对话框，或一轮任务跑完——时发出桌面通知，你不必再轮流盯各个终端。

## 功能

- **等待输入**：任何未声明为非阻塞的 `ctx.ui` 弹窗（select / confirm / input / editor / custom，含其它扩展发起的弹窗）都会发送通知——延迟 4 秒投递，弹窗在此之前关闭则不发送——包含弹窗标题、交互类型和实例上下文。不会阻塞 agent 继续执行的 UI 可以在调用前发出 `notify:non-blocking-prompt`，这类弹窗永不通知。urgency 默认 `critical`。
- **任务完成**：agent 完全空闲（`agent_settled`）时发送通知，展示回合耗时和最后一条 assistant 消息的纯文本摘要，urgency 默认 `normal`。
- **实例标识**：标题以 session 名开头（未命名时回退为项目目录名）；正文第二行在有用时保留项目名，并始终带进程 pid。
- **可读摘要**：去除 markdown 标记和多余空白；最多保留 160 个字素簇加 `…`，优先选择附近的句子或单词边界，避免截断单词或 emoji。
- **防打扰**：短于最短时长阈值（默认 10 秒）的回合不发完成通知——你正在窗口里连续交互的短问答保持安静；随手点掉的弹窗同样不通知；被中断（aborted）的回合不通知。
- **Active-agent 会话抑制**：系统提示词含 `<active_agent name="..."/>` 标记的会话不发送等待输入或完成桌面通知，包括早于 `session_start` 的弹窗；每次 `session_start` 重新检测。
- **Custom 回合抑制**：`before_agent_start` 报告 `messageType: "custom"` 的回合不发送完成通知；并入既有用户回合的 steering / follow-up 不改变来源，该用户回合完成时仍正常通知。
- **`/notify` 命令**：运行时切换当前实例的通知开关。
- **失败安全**：通知发送为 fire-and-forget；若启动通知程序失败（例如 `notify-send` 或 `powershell.exe` 不存在），在 pi UI 中警告一次后保持静默，绝不阻塞 agent 循环。

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

要求 pi >= 1.5.0，并具备以下任一种后端：

- **Linux**：系统有可用的 `notify-send`（或自定义命令，见下文）。
- **原生 Windows 10/11**：Windows 自带的 Windows PowerShell 5.1（`powershell.exe`）。pi 可以从 Windows PowerShell 5.1 或 PowerShell 7 终端启动，但通知 helper 始终使用 `powershell.exe` 5.1，不要求也不使用纯 `pwsh` 投递。Windows 后端不覆盖 WSL。

## 通知格式

| 事件 | 标题 | 正文 | urgency（默认） |
|------|------|------|-----------------|
| `ui_prompt_start` | `<name> · Waiting for input` | `<subject>\n<context>` | `critical` |
| `agent_settled`（非 aborted） | `<name> · Finished · <duration>` | `<summary>\n<context>` | `normal` |

- `<name>` 为通过 `/name` 或 `pi.setSessionName()` 设置的 session 名，缺省回退为工作目录的 basename。
- 等待输入时，`<subject>` 为弹窗标题，无标题时为其 kind；`custom` 弹窗按契约不带标题，因此固定用 `Interactive prompt` 而非 kind 名称。`<context>` 包含有独立 session 名时的项目 basename、未在首行重复出现的弹窗 kind，以及 `pid <pid>`。
- 任务完成时，`<summary>` 为最后一条 assistant 消息的清洗后文本；无文本时正文只有 `<context>`。耗时四舍五入到秒，按秒、分钟或小时紧凑展示。
- `\n` 表示实际换行：标题或摘要位于第一行，实例元数据位于第二行。自定义通知命令仍在同一个 body 参数中收到这两行。
- 等待输入通知**延迟 4 秒**投递，唯一用途是避免立即答掉的阻塞弹窗产生打扰。已声明为非阻塞的弹窗无论停留多久都不会排定通知。会话替换与关闭也会丢弃待投递的通知。

示例：

```text
review · Finished · 1m 23s
Updated foo.ts and fixed the notification bug…
proj · pid 4242
```

### 非阻塞弹窗契约

如果扩展的 picker、菜单或浮层不会阻止 agent loop 继续执行，应在每次调用对应 UI 前、同一个同步块内声明：

```ts
pi.events.emit("notify:non-blocking-prompt", {});
await ctx.ui.custom(/* ... */);
```

声明按计数保存：每个 `ui_prompt_start` 最多消费一个，`ui_prompt_end` 不消费声明，`session_shutdown` 清除未消费的声明。已声明的 start 会取消此前待投递的弹窗通知，并在构造 notifier 前返回。shutdown 后，同一 runner 上已排队的 start 会被忽略，直到新的 `session_start`。未声明的弹窗保持默认通知行为，因此未改造扩展的阻塞 UI 不会被静默。

只为真正不阻塞 agent 的 UI 声明，且声明后必须实际调用对应的包装 UI 并产生最外层 `ui_prompt_start`。Pi 会把嵌套或重叠弹窗合并为一个最外层 start，因此可能嵌套或重叠的调用（包括 RPC 客户端允许的并发对话框）不得声明；这些调用保持未声明的默认行为。未配对的声明可能抑制后续弹窗，直到会话关闭。

### 宿主弹窗限制

Pi 只为最外层弹窗发出 `ui_prompt_start` / `ui_prompt_end`。因此，另一个弹窗仍处于活动状态时打开的阻塞弹窗不会产生事件，也无法触发桌面通知。除非宿主提供独立的弹窗身份或嵌套事件，否则扩展无法恢复这种嵌套告警。

## 配置

全部通过环境变量配置：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PI_NOTIFY` | 启用 | 设为 `0` 或 `false` 使实例启动时通知关闭 |
| `PI_NOTIFY_MIN_DURATION_MS` | `10000` | 完成通知的最短回合时长；`0` 表示每个回合都通知。非法值或负值回退默认 |
| `PI_NOTIFY_URGENCY_PROMPT` | `critical` | 等待输入通知的 urgency |
| `PI_NOTIFY_URGENCY_DONE` | `normal` | 完成通知的 urgency |
| `PI_NOTIFY_COMMAND` | 非 Windows 为 `notify-send`；Windows 为 `powershell.exe` | 自定义通知程序；以 `<command> <title> <body>` 调用（不传 urgency） |

回合时长从当前空闲周期间隔内首个 `agent_start` 计到 `agent_settled`，时长 **>=** 阈值才发送。每次 settle 与 session 替换都会重置计时。等待输入通知不受阈值影响：未声明的阻塞弹窗延迟 4 秒投递、提前关闭即取消，已声明的非阻塞弹窗不排定通知。待投递的等待输入通知在 `session_shutdown` 时丢弃（任何会话替换都会先在旧 runner 上发出它），而**不在** `session_start` 丢弃：Pi 在 `session_start` 之前发出的启动期弹窗不能因此丢掉告警。

`/notify` 切换当前实例的开关并在 pi UI 中反馈新状态。开关仅存于内存：`PI_NOTIFY` 决定初始状态，`session_start`（startup / reload / new / resume / fork）时重置。

### 平台投递

- Linux 默认执行 `notify-send -a pi -u <urgency> <title> <body>`。
- 原生 Windows 默认通过 Windows PowerShell 5.1 执行包内 `src/windows-toast.ps1`，仅在子进程范围使用 execution-policy bypass。脚本构造 Toast XML，并通过 XML 文本节点写入内容，不把通知文本插值进标记。
- Windows 复用系统自带的 Windows PowerShell AppUserModelID，因此通知横幅、通知中心和系统通知设置里的来源可能显示为 **Windows PowerShell**。不会安装开始菜单快捷方式或独立的 pi AppUserModelID；需要允许该来源显示通知横幅。
- Windows 上 `critical` 映射为长 Toast 时长（约 25 秒），其它 urgency 使用短时长。这只是近似映射，不保证 Linux 通知服务可能为 `critical` 提供的常驻行为。
- 自定义 `PI_NOTIFY_COMMAND` 会替换平台默认后端，并在所有平台保持原来的两个参数协议。
- 投递是 fire-and-forget：通知不会阻塞 pi，也不会让 pi 驻留。程序完全无法启动时会在本次会话内关闭通知并警告一次；能启动但退出码非 0 时只报告一次（带其 stderr），下一次通知仍会重新尝试。

## 行为说明

- 在所有 pi 模式（tui / rpc / print / json）下行为一致；桌面投递不依赖终端 UI。
- 无标记会话中，早于 `session_start` 的弹窗（例如扩展发起的 project trust 确认）也会通知（惰性初始化）；active-agent 会话保持抑制。pi 内置的 trust prompt 不经过扩展 UI 通道，不覆盖。
- 通知正文会显示在桌面上（是否含锁屏取决于桌面设置），可能包含会话内容。
- 非目标：点击通知聚焦对应终端窗口、窗口聚焦时自动免打扰、独立 Windows 品牌和 WSL 投递。Wayland 下没有可靠的窗口聚焦检测，最短时长阈值用于近似后者。

## UI 能力

| 方法 | 守卫 | 非 TUI |
|------|------|--------|
| `ctx.ui.notify`（开关反馈、通知程序失败警告） | `none` | fire-and-forget，可能被宿主静默丢弃；核心桌面通知不依赖它 |

## License

MIT
