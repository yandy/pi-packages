# pi-notify

pi 的桌面通知包：扩展通过共享事件显式请求用户注意力，pi-notify 也会在一轮任务完成时自动通知。并行运行多个 pi 实例时，每条通知都会标识来源会话和进程。

## 功能

- **显式请求**：任何扩展都可以在 `pi.events` 上发出 `notify:request`；没有这个 signal，弹窗和其他 UI 默认不通知。合法请求立即投递。
- **任务完成**：agent 完全空闲（`agent_settled`）时发送通知，展示回合耗时和最后一条 assistant 消息的纯文本摘要，urgency 默认 `normal`。
- **实例标识**：由 pi-notify 统一补充 session 名（未命名时回退为项目目录名）、有用的项目名和进程 pid；producer 不传这些元数据。
- **可读完成摘要**：去除 markdown 标记和多余空白；最多保留 160 个字素簇加 `…`，优先选择附近的句子或单词边界，避免截断单词或 emoji。
- **完成防打扰**：短于最短时长阈值（默认 10 秒）的回合和被中断（aborted）的回合不发完成通知。
- **Active-agent 完成抑制**：系统提示词含 `<active_agent name="..."/>` 标记的会话不发送自动完成通知；每次 `session_start` 重新检测。显式请求不受此抑制。
- **Custom 回合抑制**：`before_agent_start` 报告 `messageType: "custom"` 的回合不发送完成通知；并入既有用户回合的 steering / follow-up 不改变来源，该用户回合完成时仍正常通知。
- **`/notify` 命令**：运行时切换当前实例的所有通知。
- **失败安全**：通知发送为 fire-and-forget；启动通知程序失败时，在能取得上下文的条件下通过 pi UI 警告一次，绝不阻塞 agent 循环。

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

| 来源 | 标题 | 正文 | urgency（默认） |
|------|------|------|-----------------|
| `notify:request` | `<name> · <request.title>` | `<request.body>\n<context>` | `normal` |
| `agent_settled`（符合条件的回合） | `<name> · Finished · <duration>` | `<summary>\n<context>` | `normal` |

- `<name>` 为通过 `/name` 或 `pi.setSessionName()` 设置的 session 名，缺省回退为工作目录的 basename。
- `<context>` 在有独立 session 名时包含项目 basename，并始终以 `pid <pid>` 结尾。
- 显式请求缺省或空 body 时正文只有 context；其它 body 原样保留，文案与格式由 producer 负责。
- 任务完成时，`<summary>` 为最后一条 assistant 消息的清洗后文本；无文本时正文只有 `<context>`。耗时四舍五入到秒，按秒、分钟或小时紧凑展示。
- `\n` 表示实际换行。自定义通知命令在同一个 body 参数中收到组合后的正文。

示例：

```text
review · Finished · 1m 23s
Updated foo.ts and fixed the notification bug…
proj · pid 4242
```

### 显式请求契约

在共享扩展事件总线上发送面向展示的 payload：

```ts
pi.events.emit("notify:request", {
  title: "Approval required",
  body: "A sandbox escalation is waiting for a decision",
  urgency: "critical",
});
```

```ts
interface NotifyRequest {
  /** 简短主题，不含 session/project/pid 元数据 */
  title: string;
  /** 可选详细内容，不含实例元数据 */
  body?: string;
  /** "low" | "normal" | "critical"，缺省为 "normal" */
  urgency?: "low" | "normal" | "critical";
}
```

标题去除首尾空白后必须非空。body 和 urgency 出现时必须符合文档类型；未知字段会被忽略。非法 payload 直接丢弃，不抛错，也不构造 notifier。

请求立即投递且 fire-and-forget。通知禁用或会话 shutdown 后的请求直接丢弃，不缓冲等待以后投递。显式请求不使用完成通知的最短时长、aborted、custom 回合或 active-agent 抑制条件。契约不提供取消、确认、重试或投递状态。

producer 应在一个逻辑交互开始需要用户注意力时发一次，而不是每个内部后续步骤都发。producer 无需导入或依赖本包；未安装消费者时，事件没有桌面副作用。

## 配置

全部通过环境变量配置：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PI_NOTIFY` | 启用 | 设为 `0` 或 `false` 使实例启动时通知关闭 |
| `PI_NOTIFY_MIN_DURATION_MS` | `10000` | 完成通知的最短回合时长；`0` 表示每个回合都通知。非法值或负值回退默认 |
| `PI_NOTIFY_URGENCY_DONE` | `normal` | 完成通知的 urgency |
| `PI_NOTIFY_COMMAND` | 非 Windows 为 `notify-send`；Windows 为 `powershell.exe` | 自定义通知程序；以 `<command> <title> <body>` 调用（不传 urgency） |

回合时长从当前空闲周期间隔内首个 `agent_start` 计到 `agent_settled`，时长 **>=** 阈值才发送完成通知。每次 settle 与 session 替换都会重置计时。显式请求不受此阈值影响。

`/notify` 切换当前实例的开关并在 pi UI 中反馈新状态。开关仅存于内存：`PI_NOTIFY` 决定初始状态，`session_start`（startup / reload / new / resume / fork）时重置。

### 平台投递

- Linux 默认执行 `notify-send -a pi -u <urgency> <title> <body>`。
- 原生 Windows 默认通过 Windows PowerShell 5.1 执行包内 `src/windows-toast.ps1`，仅在子进程范围使用 execution-policy bypass。脚本构造 Toast XML，并通过 XML 文本节点写入内容，不把通知文本插值进标记。
- Windows 复用系统自带的 Windows PowerShell AppUserModelID，因此通知横幅、通知中心和系统通知设置里的来源可能显示为 **Windows PowerShell**。不会安装开始菜单快捷方式或独立的 pi AppUserModelID；需要允许该来源显示通知横幅。
- Windows 上 `critical` 映射为长 Toast 时长（约 25 秒），其它 urgency 使用短时长。这只是近似映射，不保证 Linux 通知服务可能为 `critical` 提供的常驻行为。
- 自定义 `PI_NOTIFY_COMMAND` 会替换平台默认后端，并在所有平台保持原来的两个参数协议。
- 投递是 fire-and-forget：通知不会阻塞 pi，也不会让 pi 驻留。程序完全无法启动时会在本次会话内关闭通知，并在有 UI 上下文时警告一次；能启动但退出码非 0 时只报告一次（带其 stderr），下一次通知仍会重新尝试。

## 行为说明

- 在所有 pi 模式（tui / rpc / print / json）下行为一致；桌面投递不依赖终端 UI。
- 首次 `session_start` 之前的显式请求使用 `process.cwd()` 补充项目元数据。此时若后端启动失败，因尚无扩展上下文，不能通过 `ctx.ui.notify` 报警。
- 通知正文会显示在桌面上（是否含锁屏取决于桌面设置），可能包含会话内容。
- 非目标：点击通知聚焦对应终端窗口、窗口聚焦时自动免打扰、独立 Windows 品牌和 WSL 投递。Wayland 下没有可靠的窗口聚焦检测，最短时长阈值用于近似完成通知的聚焦免打扰。

## UI 能力

| 方法 | 守卫 | 非 TUI |
|------|------|--------|
| `ctx.ui.notify`（开关反馈、通知程序失败警告） | `none` | fire-and-forget，可能被宿主静默丢弃；核心桌面通知不依赖它 |

## License

MIT
