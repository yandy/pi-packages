import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSandboxConfig } from "./src/config";
import { markProcessHasUI, processHasUI, setConfigWarningSink, takeConfigWarnings } from "./src/config-warnings";
import { getDenialLedger } from "./src/denial-ledger";
import { getEscalationBroker } from "./src/escalation-broker";
import { announceApproval } from "./src/notification";
import { createPermissionCommand, processPermissionState } from "./src/permission";
import { canonicalPath } from "./src/policy";
import { selectRunner } from "./src/runners";
import { createSandboxTools } from "./src/tools";
import { aclSkillPaths } from "./src/win32/skill-paths";

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

/**
 * 活动工具探测：取值失败（陈旧 ctx / reload / 取值器抛错）时返回 undefined，表示“无法判断”。
 * 外层 try/catch 保证扩展 factory 永不 throw（I2）；非数组返回值同样归为无法判断。
 */
function readActiveTools(pi: ExtensionAPI): string[] | undefined {
	try {
		const active = pi.getActiveTools();
		return Array.isArray(active) ? active : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 配置告警的出站接线（见 src/config-warnings.ts）：配置在 factory 顶部读取，那时没有 ctx，
 * 告警只能先入缓冲。这里按宿主能力选择落点——有 UI 交给 `ctx.ui.notify(…, "warning")`
 * （进对话区，而不是被 TUI 覆盖的裸终端）；本进程从未出现过 UI（`pi -p` / JSON）才退回
 * stderr；其余无 UI 会话（父会话为 TUI 的子会话）不打印，留在缓冲等下一个有 UI 的会话。
 */
function relayConfigWarnings(ctx: {
	hasUI: boolean;
	mode?: string;
	ui?: { notify?: (message: string, type?: "info" | "warning" | "error") => void };
}): void {
	if (readHasUI(ctx)) {
		let notify: ((message: string, type: "warning") => void) | undefined;
		try {
			const uiNotify = ctx.ui?.notify;
			if (typeof uiNotify === "function") notify = (message, type) => uiNotify(message, type);
		} catch {
			notify = undefined; // 陈旧 ctx：本轮没有可信的 UI 出口，告警留在缓冲里
		}
		if (notify !== undefined) {
			markProcessHasUI();
			setConfigWarningSink((message) => notify?.(message, "warning"));
			return;
		}
	}
	setConfigWarningSink(null);
	if (processHasUI()) return; // 子会话（父会话是 TUI）：打印会覆盖父会话界面
	let mode: unknown;
	try {
		mode = ctx.mode;
	} catch {
		mode = undefined;
	}
	if (mode !== "print" && mode !== "json") return; // 判断不出宿主形态时不写终端
	for (const message of takeConfigWarnings()) console.warn(message);
}

/**
 * Ruling 8 的 `/permission` 状态行：win32 上受限 shell 只有 PowerShell（本包覆盖注册的 `powershell`
 * 作为扩展工具自动激活；本包的 bash 以 `exposure: "hidden"` 注册，永不进活动列表）。
 * 能判断出 pwsh 不在活动工具里就注明尚未激活——`/permission` 是用户排查“bash 为何被拒”的第一站。
 * 取值失败（陈旧 ctx / 取值器抛错）时注明 `activation unknown`：不断言激活状态，避免裸
 * `shell: powershell only` 被读成“已启用”（T15 修订）。
 */
function win32ShellStatusLine(pi: ExtensionAPI): string | null {
	if (process.platform !== "win32") return null;
	const active = readActiveTools(pi);
	if (active === undefined) return "shell: powershell only (activation unknown)";
	return active.includes("powershell") ? "shell: powershell only" : "shell: powershell only (not activated)";
}

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	// I2 fail-safe：坏配置在此 warn 并回落 DEFAULT（仍是受约束的 workspace-write），
	// 绝不 throw——throw 会让 pi 把整个扩展置 null，三个基础工具随即无沙箱裸跑（fail-open）。
	getSandboxConfig();

	// C1：/permission 覆盖用进程级模块单例（spec §9）——pi 对每个会话（含 subagent 子会话）
	// 重新调用本 factory，activate 闭包不跨会话共享；模块单例才能覆盖父/子全部会话。
	const emitEvent = (channel: string, data: unknown): void => pi.events.emit(channel, data);
	const tools = createSandboxTools({ cwd, permission: processPermissionState, emitEvent });
	// win32 上 bash 是“注册但模型不可达”的覆盖（tools.ts 按平台加 exposure: "hidden"）：既不进模型
	// 工具列表、也不可被命名激活，又保证 bash 这个名字命中的是本包的拒绝壳，而不是 pi 内置的未受限 bash。
	pi.registerTool(tools.bash as never);
	pi.registerTool(tools.write as never);
	pi.registerTool(tools.edit as never);
	// Ruling 9：技能按平台**追加**贡献（pi 侧是 mergePaths 合并语义）。只返回本包的技能路径，
	// 或空数组 = 什么也不加（非 win32 上零目录条目）；绝不返回“完整集合”而抹掉其他来源。
	pi.on("resources_discover", () => ({ skillPaths: aclSkillPaths() }));
	// 非 win32 平台不装配 pwsh 覆盖 → tools.powershell 为 undefined：跳过注册。
	if (tools.powershell !== undefined) pi.registerTool(tools.powershell as never);

	pi.registerCommand("permission", createPermissionCommand({
		state: processPermissionState,
		// C2：pi 从不 chdir，会话 cwd 只经命令 ctx.cwd 可达；空串回落 activate 时 cwd。
		describeStatus: (statusCwd) => {
			const effectiveCwd = statusCwd || cwd;
			const cfg = getSandboxConfig();
			const effective = processPermissionState.override ?? cfg.mode;
			const source = processPermissionState.override !== null ? "/permission override" : "config default";
			let runnerText: string;
			// Ruling 19：danger-full-access 首判——自定义 runner 已配置但模式为全放行时，
			// runner 行必须显示 bypassed（runner 不参与该模式的执行）。
			if (effective === "danger-full-access") {
				runnerText = "bypassed (danger-full-access)";
			} else if (cfg.runnerCommand !== null && cfg.runnerCommand.length > 0) {
				runnerText = `custom command (${cfg.runnerCommand.join(" ")})`;
			} else {
				const selected = selectRunner(cfg.probeTimeoutMs);
				runnerText = selected.runner === "unavailable"
					? "unavailable (fail-closed: confined commands will be refused)"
					: `${selected.runner} (${selected.enforcement} enforcement)`;
			}
			const lines = [
				`sandbox mode: ${effective} (${source})`,
				`runner: ${runnerText}`,
				`workspace: ${canonicalPath(effectiveCwd)}`,
			];
			if (cfg.extraWritableDirs.length > 0) {
				const suffix = effective === "workspace-write" ? "" : ` (inactive: ${effective})`;
				lines.push(`extra writable: ${cfg.extraWritableDirs.join(", ")}${suffix}`);
			}
			const shellLine = win32ShellStatusLine(pi);
			if (shellLine !== null) lines.push(shellLine);
			return lines.join("\n");
		},
	}));

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
		getDenialLedger().forget(event.sessionId); // 子会话销毁：清掉未消费的拒绝记录（防 Map 泄漏）
	});
	pi.on("session_start", (_event, ctx) => {
		try {
			relayConfigWarnings(ctx);
		} catch {
			// 告警接线绝不能影响会话启动（I2）：拿不到 ctx 就留在缓冲里等下一轮
		}
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
			// hasUI / mode 现查而非快照：注册后父会话可能因 reload / 会话替换失去 UI 或换宿主，或使 ctx 失效
			hasUI: () => readHasUI(ctx),
			// 审批 deadline 的判据：弹窗显示在本会话，所以用本会话的 ctx.mode（mode 缺失时按非 TUI 处理）
			mode: () => ctx.mode,
			announce: (title) => announceApproval(emitEvent, title),
			select: (title, options, opts) => ctx.ui.select(title, options, opts),
			// 两步式的第二步：Deny 后的可选理由。异常 ctx 可能缺 input——缺失/抛错时 broker 跳过理由追问
			// （拒绝照常结算）。
			input: (title, placeholder, opts) => ctx.ui.input(title, placeholder, opts),
		});
	});
	pi.on("session_shutdown", () => {
		setConfigWarningSink(null); // 会话结束/ctx 即将失效：后续告警重新入缓冲
		unsubscribeCreated();
		unsubscribeDisposed();
		if (registeredSessionId === null) return;
		broker.unregisterParent(registeredSessionId);
		getDenialLedger().forget(registeredSessionId); // 会话销毁：清掉未消费的拒绝记录（防 Map 泄漏）
		registeredSessionId = null;
	});
}
