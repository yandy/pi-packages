# pi-notify 设计

新建 Extension package `pi-notify`（npm 名 `@yandy0725/pi-notify`）：多个 pi TUI 实例并行工作时，在实例「停下来等人」或「一轮任务跑完」时发送桌面通知，使用户不必轮流盯屏。

## 1. 意图与目标

- 实例弹出阻塞式 UI（确认、选择、输入、编辑器等）时发「等待输入」通知。
- 一轮任务彻底空闲（`agent_settled`）时发「已完成」通知，带结果摘要。
- 通知能区分实例：带 session 名（未命名用 cwd 目录名）+ pid。
- 防打扰：正在窗口里连续交互的短回合不发完成通知；实例可手动整体开关。

## 2. 非目标 / 反目标

- 不做点击通知聚焦终端窗口（KDE/Wayland 下无可靠窗口激活手段，且 notify-send action 回调需常驻守护进程）。
- 不做「窗口聚焦时自动免打扰」（Wayland 下无可靠活跃窗口查询，用最短回合时长阈值近似）。
- 不做声音、移动推送、按工具类型过滤等扩展能力。
- 反目标：通知轰炸（每个短回合都弹）、发送失败阻塞 agent loop。

## 3. 宿主依据与约束

- `ui_prompt_start` / `ui_prompt_end`：ExtensionRunner 包装 `ctx.ui.select/confirm/input/editor/custom`，所有经扩展 runner 的阻塞弹窗（含其它扩展发起的）都会触发；事件带 `kind`、`title`，嵌套弹窗合并为一个外层 span。宿主内置的 trust prompt 不经过此通道，不覆盖。
- `agent_settled` 是最终空闲信号（`agent_end` 后仍可能自动重试/续跑，不能用）；`event.aborted` 表示被用户中断。
- 发送走 `notify-send` 子进程（目标环境 KDE/Wayland 已具备）；spawn 必须 fire-and-forget，失败不得阻塞或打断会话。
- 通知正文会出现在桌面（含锁屏，取决于桌面配置），摘要可能含会话内容，属预期行为，README 说明。
- 本包不调用终端组件类 UI，全模式（tui/rpc/print/json）行为一致，不按 mode 分支；`/notify` 命令反馈用 `ctx.ui.notify`，属 best-effort 允许静默丢弃。README 按规范写 `## UI surface` / `## UI 能力` 节。

## 4. 方案取舍

| 方案 | 内容 | 结论 |
|------|------|------|
| A 最小版 | 仅两个事件 + 环境变量开关 | 短交互回合也弹通知，打扰明显，否决 |
| B 核心 + 防打扰 | A + 最短回合时长阈值 + `/notify` 开关 + urgency 可配 | **采用** |
| 点击通知聚焦窗口 | notify-send action + 常驻守护 + 窗口激活 | Wayland 下脆弱复杂，否决 |

## 5. 已确认决策

### 触发与文案

- **等待输入**：`ui_prompt_start` → 立即通知。标题含实例标识，正文为弹窗 `title`（缺省用 `kind`）。urgency 默认 `critical`（KDE 下常驻，需手动关闭）。
- **已完成**：`agent_settled` 且 `aborted !== true` → 通知。正文为会话最后一条 assistant 消息的纯文本摘要（去 markdown 标记、压缩空白、截断约 160 字符；无则省略正文）。urgency 默认 `normal`。
- **实例标识**：`pi.getSessionName()` 优先，缺省 `basename(ctx.cwd)`；格式 `<name> (pid <pid>)`。
- 通知文案用英文，与包代码/文档一致。

### 防打扰

- 完成通知最短回合时长：从当前空闲周期间隔内首个 `agent_start` 计时到 `agent_settled`，不足 `PI_NOTIFY_MIN_DURATION_MS`（默认 `10000`，`0` 表示总是通知）则跳过。等待输入通知不受阈值影响。
- `/notify` 命令切换当前实例通知开关（默认开），状态仅存内存；`session_start`（含 reload/new/resume/fork）重置为默认开。

### 配置（环境变量）

| 变量 | 默认 | 说明 |
|------|------|------|
| `PI_NOTIFY` | 启用 | 设为 `0`/`false` 整体禁用 |
| `PI_NOTIFY_MIN_DURATION_MS` | `10000` | 完成通知最短回合时长 |
| `PI_NOTIFY_URGENCY_PROMPT` | `critical` | 等待输入通知 urgency |
| `PI_NOTIFY_URGENCY_DONE` | `normal` | 完成通知 urgency |
| `PI_NOTIFY_COMMAND` | `notify-send` | 自定义通知程序；以 `<title> <body>` 两个 argv 调用，便于非 Linux 平台与测试替身 |

### 发送与降级

- `spawn(command, args, { stdio: "ignore" })` + `unref()`，注册 `error` 处理防 ENOENT 崩溃。
- 发送失败：该 session 内标记降级、后续不再 spawn；用 `ctx.ui.notify` best-effort 提示一次（允许被静默丢弃），不重试、不阻塞。
- 默认 `notify-send` 调用带 `-a pi`（app name）与 `-u <urgency>`。

## 6. 工程事项（按 pi-package-spec 检查清单）

- 目录 `pi-notify/`：`index.ts` 入口 + `src/`（事件/计时/发送/文案拆分）+ `tests/`；`package.json`、`tsconfig.json`、`vitest.config.ts`、`.gitignore`、双语 README。
- 注册：根 `package.json` workspaces、根 `vitest.config.ts` projects、`.github/workflows/publish.yml` case、`.github/workflows/test.yml` paths-filter。
- 依赖：`@earendil-works/pi-coding-agent` peer `>=1.5.0`；标准 4 项 devDependencies；许可 prepack/postpack 钩子。
- 无注册工具，故无 prompt 三通道内容，不需 `prompt-meta.test.ts`。
- 测试遵循 `docs/guides/testing.md`：通知发送用 fake 命令/注入 spawn 替身，不真实弹桌面通知；环境变量隔离。
- 在 `.worktrees/` worktree 中实现。

## 7. 留给实现者的细节

- 摘要提取的具体清洗规则与 assistant 消息获取方式（sessionManager entries）。
- `ui_prompt_end` 是否需要维护状态：初版仅监听 start，不配对跟踪。
- 通知图标等 notify-send 附加参数。
