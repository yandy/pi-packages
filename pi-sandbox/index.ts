import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSandboxConfig } from "./src/config";
import { getDenialLedger } from "./src/denial-ledger";
import { getEscalationBroker } from "./src/escalation-broker";
import { createPermissionCommand, processPermissionState } from "./src/permission";
import { canonicalPath } from "./src/policy";
import { selectRunner } from "./src/runners";
import { createSandboxTools } from "./src/tools";

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

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	// I2 fail-safe：坏配置在此 warn 并回落 DEFAULT（仍是受约束的 workspace-write），
	// 绝不 throw——throw 会让 pi 把整个扩展置 null，三个基础工具随即无沙箱裸跑（fail-open）。
	getSandboxConfig(cwd);

	// C1：/permission 覆盖用进程级模块单例（spec §9）——pi 对每个会话（含 subagent 子会话）
	// 重新调用本 factory，activate 闭包不跨会话共享；模块单例才能覆盖父/子全部会话。
	const tools = createSandboxTools({ cwd, permission: processPermissionState });
	pi.registerTool(tools.bash as never);
	pi.registerTool(tools.write as never);
	pi.registerTool(tools.edit as never);

	pi.registerCommand("permission", createPermissionCommand({
		state: processPermissionState,
		// C2：pi 从不 chdir，会话 cwd 只经命令 ctx.cwd 可达；空串回落 activate 时 cwd。
		describeStatus: (statusCwd) => {
			const effectiveCwd = statusCwd || cwd;
			const cfg = getSandboxConfig(effectiveCwd);
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
			return [
				`sandbox mode: ${effective} (${source})`,
				`runner: ${runnerText}`,
				`workspace: ${canonicalPath(effectiveCwd)}`,
			].join("\n");
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
			// 两步式的第二步：Deny 后的可选理由。旧宿主/异常 ctx 可能没有 input——缺失时 broker 跳过追问。
			input: typeof ctx.ui.input === "function" ? (title, placeholder, opts) => ctx.ui.input(title, placeholder, opts) : undefined,
		});
	});
	pi.on("session_shutdown", () => {
		unsubscribeCreated();
		unsubscribeDisposed();
		if (registeredSessionId === null) return;
		broker.unregisterParent(registeredSessionId);
		getDenialLedger().forget(registeredSessionId); // 会话销毁：清掉未消费的拒绝记录（防 Map 泄漏）
		registeredSessionId = null;
	});
}
