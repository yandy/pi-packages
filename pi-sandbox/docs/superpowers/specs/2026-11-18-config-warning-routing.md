# 配置告警的出口：缓冲区 + `session_start` 接线（2026-11-18）

## 问题

`sandbox.json` / `sandbox-writable.json` 在扩展 factory 顶部被读取，那一刻还没有 `ctx`，
告警只能走 `console.warn` → 直接写到终端，随后被 TUI 绘制覆盖。实测症状：用户看到一行
`sandbox: extraWritableDirs entry is not an existing directory: …` 一闪而过，界面同时被弄脏；
`/permission` 里能看到的只有最终配置，看不出「某条目被丢了、为什么」。

「无提示的失败」在本包里是不可接受的（用户明明放了文件却拿不到授权），所以不能简单删掉告警，
必须换落点。

## 结论

`src/config-warnings.ts` 承接所有配置告警（`reportConfigWarning`）：

| 阶段 / 宿主形态 | 落点 |
| --- | --- |
| factory 顶部加载配置（还没有 `ctx`） | 入模块级缓冲，不写终端 |
| `session_start` 且 `hasUI`（tui / rpc） | `ctx.ui.notify(message, "warning")`，落在对话区（`Warning: …` 行） |
| 无 UI 且本进程出现过 UI（pi-subagents 子会话） | 不打印，留在缓冲等下一个有 UI 的会话 |
| 无 UI 且本进程从未出现 UI（`pi -p` / JSON 模式） | `console.warn`（stderr），保持可见 |

要点：

1. **出口在 `session_start` 安装**，装的时候先补发缓冲，之后新告警直发；`session_shutdown`
   摘除出口，后续告警重新入缓冲。
2. **「本进程出现过 UI」挂 `globalThis`**（`Symbol.for("@yandy0725/pi-sandbox:ui-seen")`），
   不是模块变量：宿主的扩展模块缓存以 `(cwd, generation)` 为令牌，子会话 cwd 与父不同时会重新
   import 整个扩展，模块级标志会复位——那样就判断不出「打印会覆盖父会话界面」，子会话的
   `console.warn` 会重新污染 TUI。
3. **出口抛错不炸加载路径**：`ctx.ui.notify` 对陈旧 `ctx` 会抛错，此时告警退回缓冲（不丢、不冒泡）；
   接线整体另有 try/catch，绝不影响 `session_start` 的其余逻辑。
4. 告警文本保持原样（仍以 `sandbox: ` 开头），只是多一层 pi 的 `Warning: ` 前缀。

## 不变的部分

- 判定逻辑、丢弃/保留策略、告警文案完全不变（`resolveExtraWritableDirs` / `loadWritableDirs`
  只把 `console.warn` 换成 `reportConfigWarning`）。warn-don't-guess 的取舍不变。
- 每个进程仍只读一次配置；`/reload` 会重新 import 扩展并重读配置，因此告警会再出现一次
  （此时已有 UI 出口，直接进对话区）。

## 测试

- `tests/config-warnings.test.ts`：缓冲 / 补发 / 摘除 / 出口抛错 / 进程级 UI 标志。
- `tests/config.test.ts`：原来 `vi.spyOn(console, "warn")` 的用例改为「装一个收集出口」，
  语义等价，但顺带钉住「告警不会漏到终端」。
- `tests/index-smoke.test.ts`：四条出口规则各一条用例（有 UI 补发、装好后直发、子会话不打印、
  print 模式落 stderr），以及陈旧 `ctx` 不打断 `session_start`。
