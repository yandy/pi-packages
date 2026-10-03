import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSandboxConfig } from "./src/config";
import { getDenialLedger } from "./src/denial-ledger";
import { getEscalationBroker } from "./src/escalation-broker";
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
 * 活动工具探测（Ruling 8 的前置）：`getActiveTools` 是 pi 较新的 API，老宿主上可能不存在；
 * 取值器又可能因 ctx 失效 / reload 抛错。`typeof` 探测 + try/catch 把任何失败都归为
 * “无法判断”（undefined）——本文件的约定是扩展 factory 永不 throw（I2），提示宁可不出。
 */
function readActiveTools(pi: ExtensionAPI): string[] | undefined {
	try {
		if (typeof pi.getActiveTools !== "function") return undefined;
		const active = pi.getActiveTools();
		return Array.isArray(active) ? active : undefined;
	} catch {
		return undefined;
	}
}

/** Ruling 8 的提示文案：必须点名修法与失败方向（未启用前 bash 命令被拒）。
 *  T15 修订：补上宿主前提 `requires pi >= 1.0.0`（措辞与 `src/confine.ts` 的
 *  `UnsupportedWindowsShellError` 一致）——低于 1.0.0 的宿主没有 `powershell` 工具，
 *  只让用户去 settings.json 打开一个不存在的工具是不可执行的。 */
const POWERSHELL_HINT_MESSAGE = [
	"pi-sandbox: on Windows the confined shell is PowerShell only. Enable it in ~/.pi/agent/settings.json (requires pi >= 1.0.0):",
	'  { "defaultTools": ["-bash", "+powershell"] }',
	"Until then, bash commands are refused (fail-closed).",
].join("\n");

/**
 * 每进程一次的提示标志：pi 对每个会话（含子会话）重调 factory，不加标志会每次 activate /
 * session_start 重复刷屏。模块级变量在同一 pi 进程的所有会话间共享。
 */
let powershellHintShown = false;

/**
 * Ruling 8：win32 上 pwsh 未激活时提示一次（有 UI 走 `ctx.ui.notify`，无 UI 写 stderr）。
 * 判决条件必须能明确判断：宿主有 `getActiveTools`，且 `bash` 在活动列表而 `powershell` 不在。
 * 任何取值失败（陈旧 ctx / 老宿主 / 取值器抛错）都静默——提示是锦上添花，绝不能阻断激活。
 */
function maybeWarnMissingPowerShellTool(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (process.platform !== "win32" || powershellHintShown) return;
	const active = readActiveTools(pi);
	if (active === undefined || active.includes("powershell") || !active.includes("bash")) return;
	powershellHintShown = true;
	let notified = false;
	if (readHasUI(ctx)) {
		try {
			const notify = ctx.ui?.notify;
			if (typeof notify === "function") {
				notify(POWERSHELL_HINT_MESSAGE, "warning");
				notified = true;
			}
		} catch {
			notified = false; // ctx 已失效（reload / 会话替换）：继续走 stderr
		}
	}
	if (!notified) console.warn(`sandbox: ${POWERSHELL_HINT_MESSAGE.replaceAll("\n", "\n  ")}`);
}

/**
 * Ruling 8 的 `/permission` 状态行：win32 上受限 shell 只有 PowerShell。
 * 能判断出 pwsh 不在活动工具里就注明尚未激活——`/permission` 是用户排查“bash 为何被拒”的第一站。
 * 无法判断（老宿主没有 `getActiveTools`——此类宿主上 pwsh 工具根本不存在——或取值失败）时注明
 * `activation unknown`：不断言激活状态，避免裸 `shell: powershell only` 被读成“已启用”（T15 修订）。
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
	getSandboxConfig(cwd);

	// C1：/permission 覆盖用进程级模块单例（spec §9）——pi 对每个会话（含 subagent 子会话）
	// 重新调用本 factory，activate 闭包不跨会话共享；模块单例才能覆盖父/子全部会话。
	const tools = createSandboxTools({ cwd, permission: processPermissionState });
	pi.registerTool(tools.bash as never);
	pi.registerTool(tools.write as never);
	pi.registerTool(tools.edit as never);
	// Ruling 9：技能按平台**追加**贡献（pi 侧是 mergePaths 合并语义）。只返回本包的技能路径，
	// 或空数组 = 什么也不加（非 win32 上零目录条目）；绝不返回“完整集合”而抹掉其他来源。
	pi.on("resources_discover", () => ({ skillPaths: aclSkillPaths() }));
	// 老宿主（含本仓 devDependency 0.80.2）没有 createPowerShellToolDefinition → tools.powershell
	// 为 undefined：跳过注册即可，不报错（此时宿主本来也没有 powershell 工具可覆盖）。
	if (tools.powershell !== undefined) pi.registerTool(tools.powershell as never);

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
			const lines = [
				`sandbox mode: ${effective} (${source})`,
				`runner: ${runnerText}`,
				`workspace: ${canonicalPath(effectiveCwd)}`,
			];
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
		// Ruling 8 的提示不依赖 UI 或会话身份（无 UI 时落 stderr），所以必须在下面的 hasUI
		// 守卫**之前**——守卫之后的路径是审批通道注册，与提示无关。
		maybeWarnMissingPowerShellTool(pi, ctx);
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
