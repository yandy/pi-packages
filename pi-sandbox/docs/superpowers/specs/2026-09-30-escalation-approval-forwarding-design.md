# pi-sandbox：子代理提权审批转发（in-process broker）设计

日期：2026-09-30
状态：已与用户逐节确认（含追加决策 D6），已落地。实施计划是本仓 gitignore 的 scratch 文件（`pi-sandbox/docs/superpowers/plans/2026-09-30-escalation-approval-forwarding.md`），不入库；落地记录见 git history
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
| **D6** | direct 与转发**两条路径都透传 `signal`**。转发路径必须透传（子代理已死时父弹窗要能自动关闭、排队中的请求不再弹出）；direct 路径的唯一可观察差异是——父 run 被**非 ESC 途径**中断（`ctx.abort()`、session 切换/reload）时弹窗自动关闭并记为 `was cancelled`（ESC 取消弹窗本来就能工作：弹窗抢焦点后 `escape` = `tui.select.cancel`）。第三参恒传，无 `signal` 时其值为 `undefined`（与省略在运行时不可区分：宿主签名为 `opts?`，dist 内无 `arguments.length` 判断），headless 行为逐字不变 |

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
| 取消链路：父 TUI 按 ESC → `InterruptHandler.abortAll()` → 子 `session.abort()` → 子会话工具 `execute` 的 `signal` 触发 | `pi-subagents/src/handlers/interrupt.ts`；`subagent-session.ts:225-232`；`pi-sandbox/src/tools.ts` 三个工具的 `execute`（当前 `:201`/`:232`/`:249`，第 3 参已是 `signal`） |
| `ui.select` 的第三参 `ExtensionUIDialogOptions { signal?: AbortSignal; timeout?: number }`：传入后（a）**弹窗前**发现 `signal.aborted` → 直接 resolve `undefined`、不显示；（b）**弹窗开着时** abort → `hideExtensionSelector()` 关闭弹窗 + resolve `undefined` | pi `dist/core/extensions/types.d.ts` 的 `ExtensionUIDialogOptions` 与 `ExtensionUIContext.select`；实现 `dist/modes/interactive/interactive-mode.js` 的 `showExtensionSelector`；RPC 模式同理 `dist/modes/rpc/rpc-mode.js` 的 `createDialogPromise`（不引 dist 行号：本机 pi 与 peer floor 0.80.2 的同一符号行号不同，Ruling 3） |
| 弹窗显示时抢走焦点（`setFocus(extensionSelector)`），而 `tui.select.cancel` 默认绑 `escape` / `ctrl+c` → **用户在弹窗上按 ESC 已经能取消它**（不依赖 signal） | `interactive-mode.js` 的 `showExtensionSelector` 内的 `setFocus(extensionSelector)`；pi `docs/keybindings.md:96`（`app.interrupt` 也是 `escape`，:123，但焦点在弹窗时归 `tui.select.cancel`） |
| pi 扩展 API：`pi.on("session_start" \| "session_shutdown", (event, ctx) => ...)`、`ctx.hasUI`、`ctx.ui.select(title, options)`、`ctx.sessionManager.getSessionId()`、`pi.events.on/emit` | pi `dist/core/extensions/types.d.ts` 的 `ExtensionHandler` / `ExtensionAPI.on("session_start" \| "session_shutdown")` / `ExtensionContext.hasUI` / `ExtensionUIContext.select` / `ExtensionContext.sessionManager` / `ExtensionAPI.events`；`dist/core/session-manager.d.ts` 的 `ReadonlySessionManager.getSessionId`；`dist/core/event-bus.d.ts` |

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
	 * 本会话自己注册的通道：父会话用它把自己的提权也排进同一条 FIFO 车道（Ruling 17）——
	 * 宿主的 select 只有一个对话框槽位且不排队，第二次调用会让前一个弹窗收不到按键、promise 变孤儿。
	 */
	resolveOwnChannel(sessionId: string): ParentApprovalChannel | null;

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

`resolveOwnChannel` 由 Ruling 17 引入（见 §4.3）。

内部状态：`parents: Map<sessionId, ParentApprovalChannel>`、`links: Map<childSessionId, parentSessionId>`、`queue: Promise<unknown>`（FIFO 链尾）。无 fs、无定时器、无网络。

按 D5，接口**不含** `describe()`。

### 4.3 `src/tools.ts`：只改通道解析

`ToolCtxLike`（`src/tools.ts` 内的模块私有接口声明）新增只读依赖：

```ts
interface ToolCtxLike {
	hasUI: boolean;
	cwd?: string;
	ui: { select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined> };
	/** 可选：现有 `tests/tools.test.ts` 的窄 ctx（`toolCtx(false)`）就不带它，异常宿主也可能缺；
	 *  缺失时经 `readSessionId()` 归为"无法路由" → fail-closed，绝不得抛 TypeError。 */
	sessionManager?: { getSessionId(): string };
}
```

（`{ signal?: AbortSignal }` 是 pi `ExtensionUIDialogOptions` 的子集，全部属性可选，因此真实的 `ctx.ui.select` 结构上可直接赋给这个窄类型，无需 cast。）

新增模块私有函数，替换 `resolveCallMode` 里构造 `approveEscalation` 第 2 参的那一处（原本直接读 `ctx.hasUI` / `ctx.ui.select`）。返回类型 `EscalationUI` 已由 `src/escalation.ts` 导出，`src/tools.ts` 的现有 import 追加 `type EscalationUI` 即可：

```ts
/** 防御性读取会话 id：缺失、非字符串或抛错都归为"无法路由"（fail-closed）。父/子两侧共用。 */
function readSessionId(ctx: ToolCtxLike): string | null {
	try {
		const sessionId = ctx.sessionManager?.getSessionId();
		return typeof sessionId === "string" && sessionId.trim().length > 0 ? sessionId.trim() : null;
	} catch {
		return null;
	}
}

/**
 * 审批通道解析（spec 2026-09-30 §4.3）：
 * - 本会话有 UI：优先用它自己注册的通道，经 broker 的同一条 FIFO 车道弹窗（Ruling 17）——宿主的
 *   select 只有一个对话框槽位且不排队，第二次调用会让前一个弹窗收不到按键、其 promise 变成孤儿。
 *   解析不到自己的通道（宿主未发 session_start、拿不到会话 id）才回落直连，回落行为与改动前逐字一致。
 * - 本会话无 UI（子会话）：沿 link 严格解析父通道（D3），解析不到就返回哑通道。
 * 哑通道让 approveEscalation 抛出既有 fail-closed 文案——不新增错误分支、不改变校验顺序，
 * escalation.ts 因此零改动。signal 两条路径都透传（D6）：中断既能关掉在飞的弹窗，
 * 也能让排队中的请求根本不弹。
 */
function approvalChannelFor(ctx: ToolCtxLike, signal: AbortSignal | undefined): EscalationUI {
	const opts = signal === undefined ? undefined : { signal };
	const broker = getEscalationBroker();
	const sessionId = readSessionId(ctx);
	if (ctx.hasUI) {
		const own = sessionId === null ? null : broker.resolveOwnChannel(sessionId);
		if (own === null) {
			return { hasUI: true, select: (title, options) => ctx.ui.select(title, options, opts) };
		}
		return { hasUI: true, select: (title, options) => broker.request(own, title, options, signal) };
	}
	const channel = sessionId === null ? null : broker.resolveChannel(sessionId);
	if (channel === null) {
		return { hasUI: false, select: async () => undefined };
	}
	return { hasUI: true, select: (title, options) => broker.request(channel, title, options, signal) };
}
```

`resolveCallMode` 增加第 6 参 `signal?: AbortSignal`，三个工具的 `execute` 把已有的 `signal`（各自 `execute` 的第 3 参）透传到其 `resolveCallMode` 调用点；`approveEscalation` 的第 2 参由 `{ hasUI: ctx.hasUI, select: ... }` 换成 `approvalChannelFor(ctx, signal)`。

**为什么两条路径都透传 signal（用户已确认）**：

- **转发路径（必须）**：子代理可能在用户没碰弹窗的情况下就死了——请求还在 FIFO 里排队时子代理已被中断（父 ESC → `abortAll()` → 子 `session.abort()`）、子代理撞 max-turns 硬 abort、后台任务被丢弃。透传 signal 后：已 abort 的请求**根本不会弹窗**（宿主 `showExtensionSelector` 在弹窗前先检查 `signal.aborted`），在飞的弹窗会被自动关闭——避免弹出一个没人接收结果的窗（用户点了 `Allow once` 也白点）。
- **direct 路径（一致性）**：注意弹窗抢焦点后 ESC 已经能取消它（§4.1），所以这里唯一的可观察差异是：当父 run 被**非 ESC 途径**中断（`ctx.abort()`、session 切换/reload）时，弹窗自动关闭并落进现有 `was cancelled` 分支，而不是留在屏幕上。收益小、风险也小，且与转发路径共用同一段代码（不必在 `approvalChannelFor` 里分叉）。
- 两条路径都恒传第三参 `opts`（无 `signal` 时其值为 `undefined`，与省略在运行时不可区分：宿主签名为 `opts?`，dist 内无 `arguments.length` 判断），headless 行为逐字不变。

**direct 路径也排进 FIFO 车道（Ruling 17，整分支审查后追加）**：宿主的 `showExtensionSelector` 只有一个对话框槽位且不排队——第二次调用会清掉容器并覆盖该字段，第一个弹窗从此收不到按键，其 promise 只能靠自己的 `signal` abort 才结算。可达路径不需要任何异常：父会话自己的一次提权弹窗正开着，此时后台子代理提权 → broker 出队 → 第二次调用父 `ctx.ui.select` → 父自己那次审批被孤儿化并静默变成 `was cancelled`。因此 `ctx.hasUI` 分支先用 `resolveOwnChannel(本会话 id)` 找自己注册的通道，命中就走 `broker.request`（与转发请求共用同一条车道，"一次只弹一个"成为包内不变量）；解析不到（宿主未发 `session_start`、拿不到会话 id）才回落直连，回落行为与改动前逐字一致。这不触碰 D1–D6：不新增终止来源、不改文案、不加诊断行、不动严格路由。

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
/**
 * pi-subagents 的子会话生命周期通道名（约定，非编译期契约；spec §4.1、§8）。
 * 本包不 import pi-subagents——两包互不依赖，通道名在此独立声明；上游漂移的后果是
 * link 缺失 → 子会话退回 fail-closed，失败方向安全。
 */
const SUBAGENT_CHILD_SESSION_CREATED = "subagents:child:session-created";
const SUBAGENT_CHILD_DISPOSED = "subagents:child:disposed";

/**
 * ctx 的每个成员都是取值器且先 assertActive()：会话替换 / reload 之后读取会抛
 * "This extension ctx is stale…"。任何读取失败都按"无 UI"处理——严格 fail-closed，
 * 绝不让宿主的内部报错冒泡成子代理工具调用的错误文本（spec §6）。
 */
function readHasUI(ctx: { hasUI: boolean }): boolean {
	try {
		return ctx.hasUI;
	} catch {
		return false;
	}
}

// 提权审批转发（spec 2026-09-30 §4.5）：子会话 hasUI=false，其提权请求经 broker 路由到父会话弹窗。
// broker 挂 globalThis——父子是各自独立的 jiti 实例，模块单例不共享。
const broker = getEscalationBroker();
// 捕获本次 activate 注册的会话 id：session_shutdown 的 ctx 可能已 stale（pi 会对失效 ctx 抛错），
// 用捕获值注销更稳；factory 每会话重调，所以这个变量天然是会话级的。
let registeredSessionId: string | null = null;
// 宿主每次 /reload 都复用同一 event bus 并重新调用本 factory：不退订就会无上限累积监听器
// （超过 Node 默认 maxListeners 后打印 MaxListenersExceededWarning 污染用户终端）。
const unsubscribeCreated = pi.events.on(SUBAGENT_CHILD_SESSION_CREATED, (data) => {
	const event = data as { sessionId?: unknown; parentSessionId?: unknown };
	if (typeof event.sessionId !== "string") return; // 契约漂移 → 不 link → 子会话保持 fail-closed
	broker.linkChild(event.sessionId, typeof event.parentSessionId === "string" ? event.parentSessionId : undefined);
});
const unsubscribeDisposed = pi.events.on(SUBAGENT_CHILD_DISPOSED, (data) => {
	const event = data as { sessionId?: unknown };
	if (typeof event.sessionId !== "string") return;
	broker.unlinkChild(event.sessionId);
});
pi.on("session_start", (_event, ctx) => {
	if (!readHasUI(ctx)) return; // headless / 子会话 / ctx 已失效：都不是审批终点
	let sessionId: string;
	try {
		sessionId = ctx.sessionManager.getSessionId();
	} catch {
		return; // 拿不到会话身份就不注册（严格 fail-closed，不猜）
	}
	if (registeredSessionId !== null && registeredSessionId !== sessionId) {
		// 同一 activate 内二次 session_start 且换了会话：先摘掉旧通道，避免残留在注册表里
		broker.unregisterParent(registeredSessionId);
	}
	registeredSessionId = sessionId;
	broker.registerParent({
		sessionId,
		// hasUI 现查而非快照：注册后父会话可能因 reload / 会话替换失去 UI，或使 ctx 失效
		hasUI: () => readHasUI(ctx),
		select: (title, options, opts) => ctx.ui.select(title, options, opts),
	});
});
pi.on("session_shutdown", () => {
	unsubscribeCreated();
	unsubscribeDisposed();
	if (registeredSessionId === null) return;
	broker.unregisterParent(registeredSessionId);
	registeredSessionId = null;
});
```

时序保证：事件由**父实例**的 `pi.events.emit` 发出，且在子会话 `bindExtensions()` 之前**同步** emit（`create-subagent-session.ts:219-228`），因此 link 必然早于子会话的第一次工具调用；`disposed` 在 run 的 `finally` 必发，link 不会泄漏。

退订：两个 `pi.events.on` 的 disposer 存入 activate 闭包，并在 `session_shutdown` 里调用——宿主每次 `/reload` 复用同一 event bus 且重新调用扩展 factory，不退订会无上限累积监听器（超过 Node 默认 `maxListeners` 后打印 `MaxListenersExceededWarning` 污染用户终端）。

### 4.6 FIFO 与并发

多个子代理（或同一子代理的多个工具调用）、以及父会话自己的提权并发时，`request` 串到模块级 promise 链尾，父 TUI **一次只弹一个**对话框；前一个 settle（选择/取消/abort）后才弹下一个。车道是 broker 级单行道，父会话自己的提权也排在其中（Ruling 17）；释放车道的三条出口不变（用户选择、ESC 取消弹窗、子会话 signal abort）。

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
| 子会话 `hasUI === true`（未来 pi-subagents 给子会话接入 uiContext） | 不再需要转发：走 direct 分支——该会话自己注册了通道就经 FIFO 车道，未注册则回落直连（Ruling 17），行为自动恢复 |
| 无 link（非 pi-subagents 子代理 / 事件缺失 / 版本漂移） | `resolveChannel → null` → 哑通道 → 抛 `no approval channel is available` |
| ctx 上没有 `sessionManager`（窄测试 ctx / 异常宿主） | `readSessionId → null` → 同上（不得抛 TypeError） |
| 有 link 但父未注册（父 headless、父已 `session_shutdown`） | 同上 |
| 有 link、父已注册但 `hasUI()` 现为 false | 继续向上找祖先；找不到 → 同上 |
| 父 ctx 已失效（会话替换 / reload 后宿主 `assertActive()` 抛错） | `index.ts` 的 `readHasUI()` 捕获 → 视为无 UI → 继续向上找祖先；找不到 → 同上（绝不让宿主内部报错冒泡成子代理的工具调用错误） |
| depth ≥ 2 | 沿 link 向上找第一个「已注册且 hasUI」的祖先 |
| link 数据成环 | visited 集合截断 → `null` → 同上 |
| 用户 ESC（父中断 → 子 signal abort，D2） | `request` resolve(undefined) → 抛 `was cancelled` |
| 用户选 `Deny` | 抛 `the user rejected escalating...`，模型被要求 stop and explain |
| 多子代理并发提权 | FIFO 串行，一次一个弹窗 |
| 提权目标 == effective mode | 免审批直接执行（`escalation.ts:71`），不触达 broker |
| 用户已用 `/permission` 放宽 | effective mode 变宽，提权通常不再需要；覆盖仍是最终兜底杠杆 |
| broker 被同进程其他扩展篡改 | 见 §7 |
| 父会话自己的提权与子代理转发的提权并发 | 排进同一条 FIFO 车道，一次只弹一个（Ruling 17）；不会互相顶掉弹窗 |
| 通道实现的 `hasUI()` 抛错（宿主 stale ctx / 同进程其他扩展注册的敌对通道） | `hasUIOf()` 捕获 → 视为无 UI → 继续向上或返回 `null` → fail-closed |

## 7. 安全与信任边界

- broker 挂在 `globalThis[Symbol.for("@yandy0725/pi-sandbox:escalation-broker")]`，**同进程任意扩展**都能读写，理论上可注册假通道伪造批准。这在本包威胁模型之外：能在同进程执行代码的扩展本就能直接绕过沙箱（沙箱约束的是被 spawn 的子进程与 fs 写入，不是扩展自身）。
- 因此：broker **不**通过 service 发布、**不**从 `index.ts` 导出为公共 API，只作为包内实现细节。
- 所有解析失败路径一律抛错，沿用既有 fail-closed 文案；不新增"默认允许"分支。
- 提权批准仍是**一次性**的：只影响发起它的那一次调用，不写入 `processPermissionState`、不落盘、不影响后续调用。
- 沙箱本体（runner 链、写围栏）不因本设计改变：转发只决定"这一次用哪个 mode"，mode 的强制仍由 bwrap / landlock / sandbox-exec 与 fence 负责。

## 8. 已知取舍

**D4（弹窗不加来源标识）的后果**：父用户看到的弹窗与父会话自己提权时**完全一致**，无法从标题分辨请求来自哪个子代理；并发场景下只能靠 `Reason:`（模型写的 justification）与 `Command:`/`Path:` 摘要判断。缓解：FIFO 串行保证一次只有一个待审批项；用户可 `Deny`，由父 LLM 转述后再决定。若将来需要加标识，改动面只有 `approvalChannelFor` 返回的 `select` 里 title 的组装（一处），接口与时序均不变。

**D1（不做跨进程）的后果**：使用进程型子代理扩展（如 nicobailon/pi-subagents、HazAT/pi-interactive-subagents）时，子代理提权仍 fail-closed，解救路径与今天一致（`/permission` + `steer_subagent`）。

**D2（无固定超时）的后果**：若父用户长期不理会弹窗，该子代理的这次工具调用会一直挂着，直到用户 ESC（弹窗抢焦点，ESC = `tui.select.cancel`，直接取消）、子代理被中断（signal 关弹窗）、或父会话关闭。可接受的依据：这与父会话自己提权时用户不理会弹窗的行为完全一致，且中断链路已存在（§4.1）。pi 的 `ExtensionUIDialogOptions.timeout` 能做自动消失倒计时，但按 D2 **不使用**。

**依赖 pi-subagents 的事件契约（非稳定 API）**：`subagents:child:session-created` / `:disposed` 的通道名与载荷形状是约定而非编译期契约（两包刻意不相互依赖）。上游改名或改形状的后果是**退回今天的 fail-closed 行为**（link 缺失 → 抛错），不会造成误放行——失败方向安全。契约当前由 `pi-subagents/tests/lifecycle/child-lifecycle.test.ts` 钉住。

**`/permission` 覆盖在异 cwd 子会话下可能失效（既有缺陷，非本设计引入）**：`processPermissionState` 是模块级单例，而宿主的扩展模块缓存以 cwd + generation 为令牌（pi `dist/core/extensions/loader.js` 的 `useExtensionCacheCwd` / `loadExtensionModule`：令牌变化即用 `createJiti({ moduleCache: false })` 重新导入 → 新模块实例）。pi-subagents 的子会话 cwd 为 `params.cwd ?? snapshot.cwd`（`create-subagent-session.ts:148`），可与父不同；此时父会话设的 `/permission` 覆盖对子会话不可见，"放宽进程档位解救"在该配置下不成立。broker 挂 `globalThis` 正是为了不受此影响。修法（把 `processPermissionState` 同样挂 `globalThis`）超出本设计范围，应作为独立后续分支处理（Ruling 19）。

## 9. 未来扩展点

- **跨进程转发**：若将来需要，新增一个 mailbox 实现即可——`resolveChannel` 的第二来源（env `PI_SUBAGENT_PARENT_SESSION`）+ `request` 的第二实现（文件邮箱 + 轮询）。`EscalationUI` seam（`{ hasUI, select }`）与 `escalation.ts` 均不必改。
- **子会话接入 uiContext**：pi-subagents 若将来给子会话传 uiContext，子会话即走 direct 分支（自己注册了通道就经 FIFO 车道，未注册则直连），无需改本包代码。

## 10. 文档改动清单

| 文件 | 改动 |
|---|---|
| 本文件 | 新增；落地后同步：状态行、§2 追加 D6、§4.3/§4.5 代码块改为落地代码的逐字副本、§4.5 追加"退订"段、§6 矩阵追加"父 ctx 已失效"一行、本清单 |
| `2026-09-29-process-sandbox-design.md` §7 小节标题 | "（执行前，全部 fail-closed）" → "（执行前；无可解析通道时全部 fail-closed）"——第 4 步已改为转发语义，"全部"的无条件措辞不再成立 |
| 同上 §7 第 4 步 | 原文 "`ctx.hasUI === false` → 抛错 ... no approval channel is available" 补充：先经 broker 严格解析父通道，解析到则转发到父会话弹窗（文案与选项完全一致、不加来源标识），解析不到才抛该错 |
| 同上 §9（三处） | (1) "子 agent 的 escalation 一律 fail-closed" 改写为转发语义 + 保留 fail-closed 条件；(2) "拒绝上报与解救路径（无专用通道，走普通结果流）" → "（转发通道不可用时，走普通结果流）"；(3) 尾句删除对已删包 `pi-permission-system` 的引用，改为记录 `subagents:child:session-created` 的同步 emit 时序 |
| `README.zh.md` / `README.md` 的提权审批一节 | "无 UI 通道（headless、后台 subagent）时提权一律拒绝" → "后台 subagent 的提权会转发到父会话弹窗（同进程 pi-subagents，且父会话需有 UI）；无父通道时（headless、跨进程子代理）仍一律拒绝（fail-closed），此时用 `/permission` 放宽进程档位解救"（双语语义对等） |
| `/permission` 状态块 | **不改**（D5） |
| 本文件 §4.2/§4.3/§4.6/§6 | Ruling 17 落地后同步：新增 resolveOwnChannel、direct 路径改为经 FIFO 车道、并发与 hasUI() 抛错两行矩阵 |
| 双语 README 的 /permission 一节 | 追加"异 cwd 子会话下覆盖可能不及"的已知限制（Ruling 19）|

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
| resolveOwnChannel 五种情形（命中/未注册/hasUI 假/hasUI 抛错/不走 link） | 见 tests/escalation-broker.test.ts | 同上 |
| execute 层 signal 接线（bash/write/edit 各一条） | 已 abort 的 signal → 不弹窗且抛 cancelled | tests/tools.test.ts |
| 包内组合级：事件→link→子 execute→父 select→落盘→disposed 回到 fail-closed | 钉住单元判例之间的接缝（Ruling 18） | tests/forwarding-integration.test.ts（新增）|

## 12. 交付范围

- 分支 `feat/sandbox-escalation-forwarding`，用 `.worktrees/` 隔离（已 gitignore）
- 交付物：`src/escalation-broker.ts` 新增、`src/tools.ts` 与 `index.ts` 改动、测试、§10 的文档改动
- **不含** npm 发版（若发版按 `docs/guides/release.md`，minor：`1.0.2` → `1.1.0`）与 PR 创建，二者由用户另行决定
