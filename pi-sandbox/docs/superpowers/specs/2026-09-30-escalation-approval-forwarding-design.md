# pi-sandbox：子代理提权审批转发（in-process broker）设计

日期：2026-09-30
状态：待用户审阅
前置设计：`2026-09-29-process-sandbox-design.md`（§7 提权审批、§9 与 pi-subagents 的相容性）
相关变更：`c62f0944`（PR #141，删除已 deprecated 的 `pi-permission-system`）

## 1. 背景与问题

现状（前置设计 §7 第 4 步、§9）：pi-subagents 用 `bindExtensions({})` 创建子会话，不传 uiContext → 子会话 `ctx.hasUI === false`、`ctx.ui.select` 是 noOp → **子代理的提权审批一律 fail-closed 抛错**，唯一解救杠杆是用户在父会话执行 `/permission` 放宽**进程级**档位，再让父 LLM `steer_subagent` 使子代理原地重试。

代价：

- 后台子代理撞到写围栏就停摆，必须经"子 LLM 说明 → 父 LLM 转述 → 用户放宽 → steer 重试"四跳才能恢复
- `/permission` 是全进程、跨会话、持久的档位切换，为了放行子代理的**一次**写入而放宽整个进程的权限，粒度过粗
- 用户明明就在终端前，却无法被问到"这一次要不要放行"

目标：把子代理的**单次**提权审批送到有 UI 的父会话弹窗，用户点一次 `Allow once`，子代理原地按更宽模式执行那一次调用；不改变进程档位，不改变一次性语义。

非目标：跨进程子代理支持、`/permission` 语义变更、`approveEscalation` 校验顺序与文案变更、`read` 工具（无围栏，所有模式读全放行）。

## 2. 已确认决策（用户逐条拍板，不得擅自变更）

| 编号 | 决策 |
|---|---|
| **D1** | 只覆盖**同进程**子代理（本仓 pi-subagents）。不实现跨进程文件邮箱；跨进程场景保持现状 fail-closed |
| **D2** | 挂起的审批**只跟随子会话 `AbortSignal`** 终止（用户 ESC / 子代理被中断即取消），**不设固定超时** |
| **D3** | **严格路由**：必须存在由 `subagents:child:session-created` 建立的 child→parent link，且沿 link 找到的祖先已注册通道且 `hasUI()` 为真；否则沿用现有 fail-closed 文案抛错。不做"进程内恰好只有一个交互会话就发给它"的启发式兜底 |
| **D4** | 转发弹窗的文案**完全沿用**现有 escalation 标题与选项，**不加**任何子代理来源标识（不显示子 sessionId / agentName / cwd） |
| **D5** | `/permission` 状态块**不加**转发通道诊断行（因此 broker 接口不含 `describe()`） |

## 3. 方案选择：为什么是内存 broker 而不是文件邮箱

被删除的 `pi-permission-system` 用的是**文件邮箱 + 双向 250ms 轮询**：子代理原子写 `requests/<id>.json`，父会话定时扫收件箱、弹窗、写回 `responses/<id>.json`，子代理轮询回执（10 分钟超时）。两方案对比：

| 维度 | 内存 broker（选定） | 文件邮箱（否决） |
|---|---|---|
| 覆盖范围 | 同进程子代理 | 同进程 + 跨进程（且要求对方设 `PI_SUBAGENT_PARENT_SESSION`） |
| 参照实现体量 | 新增 ~110 行，纯内存 | 7 个文件 **1272 行**（`io.ts` 302 / `permission-forwarder.ts` 466 / `permission-forwarding.ts` 170 / `subagent-registry.ts` 101 / `subagent-context.ts` 93 / `forwarding-manager.ts` 71 / `subagent-lifecycle-events.ts` 69） |
| 审批延迟 | 立即（一次函数调用） | 平均 125ms、最坏 250ms，父侧再叠一轮轮询 |
| 持久状态 | 无（进程退出即消失） | 磁盘残留 `requests/`、`responses/`、`*.tmp`，需清理逻辑 |
| 竞态风险 | 单进程 Map + Promise 链 | 实证：`permission-forwarder.ts:227-231` 注释记录 issue #398 的 ENOENT 写循环（cleanup 与 write 抢目录） |
| 与包基调一致性 | 一致（已有 `processPermissionState` 模块级进程单例） | 引入本包第一份磁盘可变状态与目录约定 |
| 伪造批准攻击面 | 需同进程代码执行 | 任何能写 `~/.pi/agent/...` 的本地进程都能写 "approved" 回执 |

（表中体量与 #398 引用取自被删除的包，可用 `git show c62f0944^:pi-permission-system/src/forwarded-permissions/permission-forwarder.ts` 等命令复核。）

否决文件邮箱的三条决定性理由：

1. **兼容价值已归零**：该协议的对端（`pi-permission-system`）已于 `c62f0944` 从本仓删除、npm 上 deprecated，提交说明的理由正是"能力已由 pi-sandbox 覆盖"。搬过来只是复制成本，没有互通对象。
2. **env 兼容层对主力场景是死代码**：跨进程路径依赖子代理扩展设置 `PI_SUBAGENT_PARENT_SESSION` 等 env，而本仓 pi-subagents **不设置任何** `PI_SUBAGENT_*` 变量（全包只有 `PI_SUBAGENTS_DEBUG`，见 `pi-subagents/src/debug.ts:9`）——它是同进程的（`createAgentSession`）。
3. **审批语义要求低延迟 + 一次性**：轮询、超时定时器、原子写、目录清理全是为跨进程付出的代价，在同进程场景收益为零。

## 4. 架构

### 4.1 事实基础（均已核实，标注出处）

| 事实 | 出处 |
|---|---|
| pi-subagents 子会话在**同一 Node 进程**内：`createAgentSession` 库调用创建，`await session.prompt()` 驱动，`session.subscribe()` 观察 | `pi-subagents/src/index.ts:96`；`src/lifecycle/subagent-session.ts:110,134,88`；`subagent-manager.ts:216` |
| 父/子**不共享模块实例**（pi 对每个会话重新调用扩展 factory），但共享 `globalThis` | `pi-sandbox/src/permission.ts:16-18`（本包已依赖此事实做 `/permission` 进程级覆盖） |
| 子会话 `hasUI === false` 的原因是 `bindExtensions({})` 未传 uiContext，与进程边界无关 | `pi-subagents/src/lifecycle/create-subagent-session.ts:228` |
| 生命周期事件契约：`subagents:child:session-created { sessionId, parentSessionId }` 在 `bindExtensions()` **之前同步** emit；`subagents:child:disposed { sessionId }` 在 run 的 `finally` 必发 | `pi-subagents/src/lifecycle/child-lifecycle.ts`；emit 点 `create-subagent-session.ts:224`；契约由其 `tests/lifecycle/child-lifecycle.test.ts` 钉住 |
| 取消链路：父 TUI 按 ESC → `InterruptHandler.abortAll()` → 子 `session.abort()` → 子会话工具 `execute` 的 `signal` 触发 | `pi-subagents/src/handlers/interrupt.ts`；`subagent-session.ts:225-232`；`pi-sandbox/src/tools.ts:158,189,206`（三个工具的 execute 第 3 参已是 `signal`） |
| `ui.select` 的第三参 `ExtensionUIDialogOptions { signal?: AbortSignal; timeout?: number }`：传入后（a）**弹窗前**发现 `signal.aborted` → 直接 resolve `undefined`、不显示；（b）**弹窗开着时** abort → `hideExtensionSelector()` 关闭弹窗 + resolve `undefined` | pi `dist/core/extensions/types.d.ts:40-44,74`；实现 `dist/modes/interactive/interactive-mode.js:2034-2059`；RPC 模式同理 `dist/modes/rpc/rpc-mode.js:48` |
| 弹窗显示时抢走焦点（`setFocus(extensionSelector)`），而 `tui.select.cancel` 默认绑 `escape` / `ctrl+c` → **用户在弹窗上按 ESC 已经能取消它**（不依赖 signal） | `interactive-mode.js:2055-2057`；pi `docs/keybindings.md:96`（`app.interrupt` 也是 `escape`，:123，但焦点在弹窗时归 `tui.select.cancel`） |
| pi 扩展 API：`pi.on("session_start" \| "session_shutdown", (event, ctx) => ...)`、`ctx.hasUI`、`ctx.ui.select(title, options)`、`ctx.sessionManager.getSessionId()`、`pi.events.on/emit` | pi `dist/core/extensions/types.d.ts:1134,1141,1148,219,74,223,1356`；`dist/core/session-manager.d.ts:246`；`dist/core/event-bus.d.ts` |

### 4.2 新增 `src/escalation-broker.ts`（~110 行，纯内存，零 fs、零定时器）

```ts
/** 进程全局槽位：父子是各自独立的 jiti 实例，globalThis 是唯一共享点。 */
const BROKER_KEY = Symbol.for("@yandy0725/pi-sandbox:escalation-broker");

/**
 * 父会话注册的审批通道。
 * `hasUI` 是函数而非布尔快照：注册后父会话可能失去 UI（session 切换/reload），
 * 每次解析都必须现查。
 */
export interface ParentApprovalChannel {
	readonly sessionId: string;
	hasUI(): boolean;
	/** `opts.signal` 直通 pi 的 `ExtensionUIDialogOptions.signal`：子代理被中断时
	 *  父弹窗被**真正关闭**，而不是留在屏幕上让用户的选择被丢弃。 */
	select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
}

export interface EscalationBroker {
	/** 父实例在 `session_start`（且 `ctx.hasUI`）时注册；`session_shutdown` 注销。 */
	registerParent(channel: ParentApprovalChannel): void;
	unregisterParent(sessionId: string): void;

	/** 由父实例订阅 `subagents:child:session-created` / `:disposed` 驱动。 */
	linkChild(childSessionId: string, parentSessionId: string | undefined): void;
	unlinkChild(childSessionId: string): void;

	/**
	 * 严格解析（D3）：从 `childSessionId` 沿 link 向上，返回第一个
	 * 「已注册通道且 `hasUI()` 为真」的祖先通道；找不到返回 `null`。
	 * 带 visited 集合防环（异常 link 数据不得导致死循环）。
	 */
	resolveChannel(childSessionId: string): ParentApprovalChannel | null;

	/**
	 * FIFO 串行提交一次审批：同一时刻最多一个 `select` 在飞，其余排队。
	 * `signal` 透传给 `channel.select` 的 `opts.signal`；abort 时 **resolve(undefined)**
	 * （不 reject）——让调用方落进 `approveEscalation` 现有的"取消"分支，
	 * escalation.ts 得以免改（§4.4）。
	 */
	request(
		channel: ParentApprovalChannel,
		title: string,
		options: string[],
		signal?: AbortSignal,
	): Promise<string | undefined>;
}

/** 进程全局单例（与 `processPermissionState` 同一模式）。 */
export function getEscalationBroker(): EscalationBroker;

/** 仅供测试复位全局槽位（生产代码不得调用）。 */
export function resetEscalationBrokerForTests(): void;
```

内部状态：`parents: Map<sessionId, ParentApprovalChannel>`、`links: Map<childSessionId, parentSessionId>`、`queue: Promise<unknown>`（FIFO 链尾）。无 fs、无定时器、无网络。

按 D5，接口**不含** `describe()`。

### 4.3 `src/tools.ts`：只改通道解析

`ToolCtxLike`（现 `:58-62`）新增只读依赖：

```ts
interface ToolCtxLike {
	hasUI: boolean;
	cwd?: string;
	ui: { select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined> };
	sessionManager: { getSessionId(): string };
}
```

（`{ signal?: AbortSignal }` 是 pi `ExtensionUIDialogOptions` 的子集，全部属性可选，因此真实的 `ctx.ui.select` 结构上可直接赋给这个窄类型，无需 cast。）

新增模块私有函数，替换 `resolveCallMode` 里现在直接读 `ctx.hasUI` / `ctx.ui.select` 的那一处（现 `:90`）。返回类型 `EscalationUI` 已由 `src/escalation.ts:50` 导出，`src/tools.ts:13` 的现有 import 追加 `type EscalationUI` 即可：

```ts
/**
 * 审批通道解析：本会话有 UI 就直连；否则向 broker 要父通道（D1/D3）。
 * 解析不到时返回 `hasUI: false` 的哑通道，让 approveEscalation 抛出既有
 * fail-closed 文案——不新增错误分支，不改变校验顺序。
 * signal 两条路径都透传，使中断能关闭在飞的弹窗（D2）。
 */
function approvalChannelFor(ctx: ToolCtxLike, signal: AbortSignal | undefined): EscalationUI {
	const opts = signal ? { signal } : undefined;
	if (ctx.hasUI) {
		return { hasUI: true, select: (title, options) => ctx.ui.select(title, options, opts) };
	}
	const broker = getEscalationBroker();
	const channel = broker.resolveChannel(ctx.sessionManager.getSessionId());
	if (!channel) {
		return { hasUI: false, select: async () => undefined };
	}
	return { hasUI: true, select: (title, options) => broker.request(channel, title, options, signal) };
}
```

`resolveCallMode` 增加第 6 参 `signal?: AbortSignal`，三个工具的 `execute` 把已有的 `signal`（`tools.ts:158/189/206`）透传到调用点（`:162/192/209`）；`approveEscalation` 的第 2 参由 `{ hasUI: ctx.hasUI, select: ... }`（`:90`）换成 `approvalChannelFor(ctx, signal)`。

**为什么两条路径都透传 signal（用户已确认）**：

- **转发路径（必须）**：子代理可能在用户没碰弹窗的情况下就死了——请求还在 FIFO 里排队时子代理已被中断（父 ESC → `abortAll()` → 子 `session.abort()`）、子代理撞 max-turns 硬 abort、后台任务被丢弃。透传 signal 后：已 abort 的请求**根本不会弹窗**（`interactive-mode.js:2036-2039`），在飞的弹窗会被自动关闭——避免弹出一个没人接收结果的窗（用户点了 `Allow once` 也白点）。
- **direct 路径（一致性）**：注意弹窗抢焦点后 ESC 已经能取消它（§4.1），所以这里唯一的可观察差异是：当父 run 被**非 ESC 途径**中断（`ctx.abort()`、session 切换/reload）时，弹窗自动关闭并落进现有 `was cancelled` 分支，而不是留在屏幕上。收益小、风险也小，且与转发路径共用同一段代码（不必在 `approvalChannelFor` 里分叉）。
- 两条路径都只在 `signal` 存在时才传第三参，headless（无 signal）行为逐字不变。

按 D4，**标题与选项文案一字不改**（`escalation.ts:78-86` 现有拼接：`Sandbox escalation: allow this <subject> under "<mode>"?` + 空行 + `Reason:` + `Command:`/`Path:`；选项 `Allow once` / `Deny`）。

### 4.4 `src/escalation.ts`：零改动

论证：`approveEscalation` 的 6 步顺序（配对校验 → 同模式免审批 → 严格更宽 → `hasUI` 显式检查 → `select` → 结果分派）全部复用。三条返回路径的映射关系不变：

| broker/父侧结果 | 落进的现有分支 | 现有文案 |
|---|---|---|
| `"Allow once"` | 返回 `requestedMode` | —— |
| `"Deny"` | `choice === "Deny"` | `the user rejected escalating this <subject> to <mode>; it stays denied, so stop and explain instead of working around it` |
| `undefined`（父侧取消 **或** signal abort，D2） | `choice === undefined`（`escalation.ts:87-89`） | `approval for escalating to "<mode>" was cancelled` |
| 无通道（哑通道 `hasUI: false`） | `!ui.hasUI` | `sandbox escalation to "<mode>" requires approval, but no approval channel is available` |

这正是"`request` 在 abort 时 resolve(undefined) 而非 reject"的原因：取消语义复用，无需在 escalation.ts 里新增 abort 分支。

### 4.5 `index.ts`：接线

```ts
const broker = getEscalationBroker();

// 父侧通道注册：只有具备对话框能力的会话才是审批终点（TUI 与 RPC 模式 hasUI 均为 true）。
pi.on("session_start", (_event, ctx) => {
	if (!ctx.hasUI) return;
	const sessionId = ctx.sessionManager.getSessionId();
	broker.registerParent({
		sessionId,
		hasUI: () => ctx.hasUI,
		select: (title, options, opts) => ctx.ui.select(title, options, opts),
	});
});
pi.on("session_shutdown", (_event, ctx) => {
	broker.unregisterParent(ctx.sessionManager.getSessionId());
});

// 通道名在本包内独立声明，不 import pi-subagents（避免运行时依赖；
// 契约由 pi-subagents 的 tests/lifecycle/child-lifecycle.test.ts 钉住）。
pi.events.on("subagents:child:session-created", (data) => {
	const event = data as { sessionId: string; parentSessionId?: string };
	broker.linkChild(event.sessionId, event.parentSessionId);
});
pi.events.on("subagents:child:disposed", (data) => {
	const event = data as { sessionId: string };
	broker.unlinkChild(event.sessionId);
});
```

时序保证：事件由**父实例**的 `pi.events.emit` 发出，且在子会话 `bindExtensions()` 之前**同步** emit（`create-subagent-session.ts:219-228`），因此 link 必然早于子会话的第一次工具调用；`disposed` 在 run 的 `finally` 必发，link 不会泄漏。

### 4.6 FIFO 与并发

多个子代理（或同一子代理的多个工具调用）并发提权时，`request` 串到模块级 promise 链尾，父 TUI **一次只弹一个**对话框；前一个 settle（选择/取消/abort）后才弹下一个。

abort 的两种时机：

- **排队中 abort**：出队时检测到 `signal.aborted` → 立即 resolve(undefined)，**不调用** `channel.select`，不占用弹窗
- **在飞时 abort**：`opts.signal` 已交给 pi 的对话框 → 弹窗被关闭、`select` resolve `undefined` → 同样落进取消分支

两种时机都不 reject，因此 `escalation.ts` 无需感知 abort。

## 5. 时序

**depth-1（后台子代理）**

1. 父 `session_start` → `registerParent`
2. 父调 subagent 工具 → pi-subagents emit `session-created` → 父实例 `linkChild(child, parent)` → 子 `bindExtensions()`（子实例独立 jiti，但共享 globalThis broker）
3. 子 `bash` 被沙箱拒 → 子模型带 `sandbox_permissions` + `justification` 原样重试
4. `resolveCallMode` → `approvalChannelFor`：`ctx.hasUI === false` → `resolveChannel(child)` → 父通道
5. `broker.request` 入 FIFO → 父 TUI 弹 `select`（文案同父会话自己提权）
6. 用户选 `Allow once` → resolve → `approveEscalation` 返回目标 mode → **仅该次调用**以更宽模式执行
7. 子 run 结束 → `disposed` → `unlinkChild`

**depth-2（子代理再派子代理）**：`resolveChannel` 从孙会话沿 `links` 向上——孙→子（子未注册通道，跳过）→父（已注册且 `hasUI()`）→ 命中父通道。

## 6. 失败模式矩阵（全部 fail-closed，绝不静默放宽）

| 情况 | 行为 |
|---|---|
| 子会话 `hasUI === true`（未来 pi-subagents 给子会话接入 uiContext） | 走原 direct 路径，不经 broker，行为自动恢复 |
| 无 link（非 pi-subagents 子代理 / 事件缺失 / 版本漂移） | `resolveChannel → null` → 哑通道 → 抛 `no approval channel is available` |
| 有 link 但父未注册（父 headless、父已 `session_shutdown`） | 同上 |
| 有 link、父已注册但 `hasUI()` 现为 false | 继续向上找祖先；找不到 → 同上 |
| depth ≥ 2 | 沿 link 向上找第一个「已注册且 hasUI」的祖先 |
| link 数据成环 | visited 集合截断 → `null` → 同上 |
| 用户 ESC（父中断 → 子 signal abort，D2） | `request` resolve(undefined) → 抛 `was cancelled` |
| 用户选 `Deny` | 抛 `the user rejected escalating...`，模型被要求 stop and explain |
| 多子代理并发提权 | FIFO 串行，一次一个弹窗 |
| 提权目标 == effective mode | 免审批直接执行（`escalation.ts:71`），不触达 broker |
| 用户已用 `/permission` 放宽 | effective mode 变宽，提权通常不再需要；覆盖仍是最终兜底杠杆 |
| broker 被同进程其他扩展篡改 | 见 §7 |

## 7. 安全与信任边界

- broker 挂在 `globalThis[Symbol.for("@yandy0725/pi-sandbox:escalation-broker")]`，**同进程任意扩展**都能读写，理论上可注册假通道伪造批准。这在本包威胁模型之外：能在同进程执行代码的扩展本就能直接绕过沙箱（沙箱约束的是被 spawn 的子进程与 fs 写入，不是扩展自身）。
- 因此：broker **不**通过 service 发布、**不**从 `index.ts` 导出为公共 API，只作为包内实现细节。
- 所有解析失败路径一律抛错，沿用既有 fail-closed 文案；不新增"默认允许"分支。
- 提权批准仍是**一次性**的：只影响发起它的那一次调用，不写入 `processPermissionState`、不落盘、不影响后续调用。
- 沙箱本体（runner 链、写围栏）不因本设计改变：转发只决定"这一次用哪个 mode"，mode 的强制仍由 bwrap / landlock / sandbox-exec 与 fence 负责。

## 8. 已知取舍

**D4（弹窗不加来源标识）的后果**：父用户看到的弹窗与父会话自己提权时**完全一致**，无法从标题分辨请求来自哪个子代理；并发场景下只能靠 `Reason:`（模型写的 justification）与 `Command:`/`Path:` 摘要判断。缓解：FIFO 串行保证一次只有一个待审批项；用户可 `Deny`，由父 LLM 转述后再决定。若将来需要加标识，改动面只有 `approvalChannelFor` 返回的 `select` 里 title 的组装（一处），接口与时序均不变。

**D1（不做跨进程）的后果**：使用进程型子代理扩展（如 nicobailon/pi-subagents、HazAT/pi-interactive-subagents）时，子代理提权仍 fail-closed，解救路径与今天一致（`/permission` + `steer_subagent`）。

**D2（无固定超时）的后果**：若父用户长期不理会弹窗，该子代理的这次工具调用会一直挂着，直到用户 ESC（弹窗抢焦点，ESC = `tui.select.cancel`，直接取消）、子代理被中断（signal 关弹窗）、或父会话关闭。可接受的依据：这与父会话自己提权时用户不理会弹窗的行为完全一致，且中断链路已存在（§4.1）。pi 的 `ExtensionUIDialogOptions.timeout`（types.d.ts:43-44）能做自动消失倒计时，但按 D2 **不使用**。

**依赖 pi-subagents 的事件契约（非稳定 API）**：`subagents:child:session-created` / `:disposed` 的通道名与载荷形状是约定而非编译期契约（两包刻意不相互依赖）。上游改名或改形状的后果是**退回今天的 fail-closed 行为**（link 缺失 → 抛错），不会造成误放行——失败方向安全。契约当前由 `pi-subagents/tests/lifecycle/child-lifecycle.test.ts` 钉住。

## 9. 未来扩展点

- **跨进程转发**：若将来需要，新增一个 mailbox 实现即可——`resolveChannel` 的第二来源（env `PI_SUBAGENT_PARENT_SESSION`）+ `request` 的第二实现（文件邮箱 + 轮询）。`EscalationUI` seam（`{ hasUI, select }`）与 `escalation.ts` 均不必改。
- **子会话接入 uiContext**：pi-subagents 若将来给子会话传 uiContext，direct 路径自动恢复（现有设计已保证，无需改本包代码）。

## 10. 文档改动清单

| 文件 | 改动 |
|---|---|
| 本文件 | 新增 |
| `pi-sandbox/docs/superpowers/specs/2026-09-29-process-sandbox-design.md` §7 第 4 步 | 原文 "`ctx.hasUI === false` → 抛错 ... no approval channel is available" 补充：先经 broker 解析父通道，解析不到才抛该错 |
| 同上 §9 | "子 agent 的 escalation 一律 fail-closed" 已不成立，改写为转发语义 + 保留 fail-closed 条件；"拒绝上报与解救路径"补一句转发失败时才走该路径 |
| `pi-sandbox/README.zh.md:43` | "无 UI 通道（headless、后台 subagent）时提权一律拒绝（fail-closed）" → 改为"后台 subagent 的提权会转发到父会话弹窗（同进程 pi-subagents）；无父通道（headless、跨进程子代理）时仍一律拒绝（fail-closed）" |
| `pi-sandbox/README.md:43` | 同上的英文版 |
| `/permission` 状态块 | **不改**（D5） |

## 11. 测试计划

遵循 `docs/guides/testing.md`：纯内存、无 fs/网络依赖；每个测试用 `resetEscalationBrokerForTests()` 复位全局槽位。

| 用例 | 断言 | 文件 |
|---|---|---|
| 注册后按 sessionId 解析 | `resolveChannel(child)` 返回该父通道 | `tests/escalation-broker.test.ts`（新增） |
| link 缺失 | `resolveChannel` 返回 `null`（D3 严格） | 同上 |
| 父已注销 | 返回 `null` | 同上 |
| 父注册但 `hasUI()` 为 false | 返回 `null` | 同上 |
| depth-2 祖先链 | 跳过无通道的中间会话，命中顶层父通道 | 同上 |
| link 成环 | 不死循环，返回 `null` | 同上 |
| FIFO 顺序 | 两个并发 `request` 按入队顺序调 `select`，前者 settle 前后者不弹 | 同上 |
| 排队中 abort | `signal` 先 abort 再出队 → resolve `undefined` 且 `select` **从未被调用** | 同上 |
| 在飞时 abort | `channel.select` 收到的 `opts.signal` 与传入的 `signal` 是同一对象；signal 触发后 `request` resolve `undefined` | 同上 |
| 通道解析（有 link） | `hasUI: false` 的 ctx + broker 有父通道 → 走父 `select`，返回 mode | `tests/tools.test.ts`（扩） |
| 通道解析（无 link） | 同上但无 link → 抛 `no approval channel is available` | 同上 |
| direct 路径不回归 | `hasUI: true` 的 ctx → 仍调 `ctx.ui.select`，不触达 broker | 同上 |
| direct 路径透传 signal | `hasUI: true` + 传入 signal → `ctx.ui.select` 收到 `{ signal }`；无 signal 时第三参为 `undefined`（行为逐字不变） | 同上 |
| 现有 escalation 语义不回归 | 严格更宽校验、配对校验、Deny/取消文案全部不变 | `tests/escalation.test.ts`（现有用例必须继续通过，零改动） |
| 接线冒烟 | 加载 `index.ts` 不抛错；`session_start`/`session_shutdown`/两个事件通道均被订阅 | `tests/index-smoke.test.ts`（扩） |

## 12. 交付范围

- 分支 `feat/sandbox-escalation-forwarding`，用 `.worktrees/` 隔离（已 gitignore）
- 交付物：`src/escalation-broker.ts` 新增、`src/tools.ts` 与 `index.ts` 改动、测试、§10 的文档改动
- **不含** npm 发版（若发版按 `docs/guides/release.md`，minor：`1.0.2` → `1.1.0`）与 PR 创建，二者由用户另行决定
