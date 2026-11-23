/**
 * escalation-broker.ts — 同进程子代理的提权审批转发（spec 2026-09-30 §4.2）。
 *
 * 事实基础：pi-subagents 的子会话在同一 Node 进程内创建（createAgentSession），但 pi 对每个
 * 会话重新调用扩展 factory——父子是各自独立的 jiti 实例，import 的模块单例不共享，
 * globalThis 是唯一共享点（与 src/permission.ts 的 processPermissionState 同理）。
 *
 * 严格 fail-closed（spec §2 D3）：只有由 `subagents:child:session-created` 建立的 child→parent
 * link 才能路由审批；解析不到就返回 null，由调用方退回既有 "no approval channel is available"
 * 错误——绝不猜"进程内唯一的交互会话"。
 *
 * 并发对话框由宿主管理，本包不排队也不承诺顺序：TUI 让新弹窗获焦，早先的弹窗留在栈里，
 * 栈顶关闭后重新显示并各自结算；RPC 的并发请求各自独立结算。
 */

import { type ApprovalDialogOptions, type ApprovalDialogPort, runApprovalDialog } from "./approval-dialog";
import type { DenialReasonPrompt, EscalationDecision } from "./escalation";

/** 进程全局槽位键：带包名前缀，避免与其他扩展的 globalThis 使用相撞。 */
const BROKER_KEY = Symbol.for("@yandy0725/pi-sandbox:escalation-broker");

/** 沿 link 向上查找祖先的深度上限：异常数据不得导致长链遍历或死循环。 */
const MAX_ANCESTOR_DEPTH = 32;

/**
 * 通道实现的 `hasUI()` 可能抛错（宿主 stale ctx 的 `assertActive()`、或同进程其他扩展注册的
 * 敌对实现）——一律按"无 UI"处理：fail-closed 路径上绝不冒泡异常（spec §6）。
 */
function hasUIOf(channel: ParentApprovalChannel): boolean {
	try {
		return channel.hasUI();
	} catch {
		return false;
	}
}

/**
 * 父会话注册的审批通道。
 * `hasUI` 与 `mode` 是函数而非快照：注册后父会话可能失去 UI 或换宿主（reload / 会话替换），
 * 每次都用现查的值。
 * - `hasUI()`：路由判据（`resolveChannel` 只命中仍有 UI 的祖先）。
 * - `mode()`：审批 deadline 的判据，必须是**弹窗实际显示的那个会话**的 `ctx.mode`。子会话自己的
 *   mode 与弹窗是否有人值守无关（子会话可以是 rpc 而父会话是 tui，反之亦然）。
 * `opts` 直通 pi 的 `ExtensionUIDialogOptions`（`signal` + `timeout`）：`signal` 让父弹窗能被中断关闭，
 * `timeout` 让宿主自己也武装一个与本地同值的倒计时。宿主实现见 TUI 的 `showExtensionSelector` 与
 * RPC 模式的 `createDialogPromise`。并发审批顺序由宿主决定，本包不做承诺。
 * 此处不引 dist 行号——行号引用跨宿主版本即腐（Ruling 3）。
 */
export interface ParentApprovalChannel {
	readonly sessionId: string;
	hasUI(): boolean;
	mode(): string | undefined;
	/** Emits on the parent instance that displays the approval, never the requesting child. */
	announce?(title: string): void;
	select(title: string, options: string[], opts?: ApprovalDialogOptions): Promise<string | undefined>;
	/** 可选：Deny 后的理由输入（两步式的第二步）。缺失/抛错时请求照常返回 Deny（无理由）。
	 *  宿主的 `ctx.ui.input` 本就是必填成员，此处仍声明为可选：通道是**跨会话注册**的抽象，
	 *  注册方可能拿不到 `input`（异常 ctx）；缺失时跳过理由追问是 fail-closed 方向。 */
	input?(title: string, placeholder?: string, opts?: ApprovalDialogOptions): Promise<string | undefined>;
}

export interface EscalationBroker {
	/** 父实例在 session_start（且 ctx.hasUI）时注册。 */
	registerParent(channel: ParentApprovalChannel): void;
	/** 父实例在 session_shutdown 时注销。 */
	unregisterParent(sessionId: string): void;
	/** 由 `subagents:child:session-created` 驱动；parentSessionId 缺失时不建立 link。 */
	linkChild(childSessionId: string, parentSessionId: string | undefined): void;
	/** 由 `subagents:child:disposed` 驱动。 */
	unlinkChild(childSessionId: string): void;
	/** 严格解析：沿 link 向上找第一个「已注册且 hasUI()」的祖先通道；找不到返回 null。 */
	resolveChannel(childSessionId: string): ParentApprovalChannel | null;
	/** 提交一次审批；本地 deadline / signal abort → choice 为 undefined，落进既有"取消"分支。
	 *  从不 reject：父侧 UI 异常、病态 signal 一律按取消结算。 */
	request(
		channel: ParentApprovalChannel,
		title: string,
		options: string[],
		signal?: AbortSignal,
		denialReason?: DenialReasonPrompt,
	): Promise<EscalationDecision>;
}

class InProcessEscalationBroker implements EscalationBroker {
	private readonly parents = new Map<string, ParentApprovalChannel>();
	private readonly links = new Map<string, string>();

	registerParent(channel: ParentApprovalChannel): void {
		if (!channel.sessionId) return;
		this.parents.set(channel.sessionId, channel);
	}

	unregisterParent(sessionId: string): void {
		this.parents.delete(sessionId);
	}

	linkChild(childSessionId: string, parentSessionId: string | undefined): void {
		// 严格模式（D3）：没有父 id 就无从路由，不建立 link，也不做"唯一交互会话"兜底。
		if (!childSessionId || !parentSessionId) return;
		this.links.set(childSessionId, parentSessionId);
	}

	unlinkChild(childSessionId: string): void {
		this.links.delete(childSessionId);
	}

	resolveChannel(childSessionId: string): ParentApprovalChannel | null {
		const visited = new Set<string>();
		let current: string | undefined = childSessionId;
		for (let depth = 0; current !== undefined && depth < MAX_ANCESTOR_DEPTH; depth++) {
			if (visited.has(current)) return null; // link 成环
			visited.add(current);
			const parentSessionId = this.links.get(current);
			if (parentSessionId === undefined) return null; // 链路断：严格 fail-closed
			const channel = this.parents.get(parentSessionId);
			if (channel !== undefined && hasUIOf(channel)) return channel;
			current = parentSessionId; // 中间会话无通道（depth ≥ 2）：继续向上
		}
		return null;
	}

	request(
		channel: ParentApprovalChannel,
		title: string,
		options: string[],
		signal?: AbortSignal,
		denialReason?: DenialReasonPrompt,
	): Promise<EscalationDecision> {
		const port: ApprovalDialogPort = {
			// deadline 判据来自父会话（弹窗所在宿主），不是发起的子会话。
			mode: () => channel.mode(),
			announce: (title) => channel.announce?.(title),
			select: (title, options, opts) => channel.select(title, options, opts),
			// 取值延迟到调用点：通道是跨会话注册的宿主对象，`input` 可能是抛错取值器；抛错由 dialog 层
			// 收成「Deny、无理由」，不该把整次审批降级成取消。
			input: (title, placeholder, opts) => {
				const input = channel.input;
				return typeof input === "function" ? input(title, placeholder, opts) : Promise.resolve(undefined);
			},
		};
		const run = async (): Promise<EscalationDecision> => {
			try {
				return await runApprovalDialog(port, { title, options, denialReason }, signal);
			} catch {
				// 父侧 UI / 病态 signal 一律按"取消"处理（fail-closed），不让异常冒泡打断子代理的工具调用。
				return { choice: undefined };
			}
		};
		return run();
	}
}

/** 进程全局单例：父子会话各自的 jiti 实例共享同一对象。 */
export function getEscalationBroker(): EscalationBroker {
	const store = globalThis as Record<symbol, unknown>;
	const existing = store[BROKER_KEY] as EscalationBroker | undefined;
	if (existing !== undefined) return existing;
	const broker = new InProcessEscalationBroker();
	store[BROKER_KEY] = broker;
	return broker;
}

/** 仅供测试复位全局槽位（生产代码不得调用）。 */
export function resetEscalationBrokerForTests(): void {
	delete (globalThis as Record<symbol, unknown>)[BROKER_KEY];
}
