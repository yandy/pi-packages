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
 */

/** 进程全局槽位键：带包名前缀，避免与其他扩展的 globalThis 使用相撞。 */
const BROKER_KEY = Symbol.for("@yandy0725/pi-sandbox:escalation-broker");

/** 沿 link 向上查找祖先的深度上限：异常数据不得导致长链遍历或死循环。 */
const MAX_ANCESTOR_DEPTH = 32;

/** FIFO 链尾吞掉结算值：只为串行化，不关心结果。 */
function noop(): void {}

/**
 * 父会话注册的审批通道。
 * `hasUI` 是函数而非布尔快照：注册后父会话可能失去 UI（reload / 会话替换），每次解析都现查。
 * `opts.signal` 直通 pi 的 ExtensionUIDialogOptions.signal——子代理被中断时父弹窗被真正关闭，
 * 且已 abort 的请求根本不会弹窗（宿主实现见 TUI 的 showExtensionSelector 与 RPC 模式的 createDialogPromise：二者都在 signal abort 时关闭弹窗并 resolve undefined；此处不引 dist 行号——本机 pi 0.99.1 与本仓 peer floor 0.80.2 的同一函数行号不同，行号引用跨版本即腐）。
 */
export interface ParentApprovalChannel {
	readonly sessionId: string;
	hasUI(): boolean;
	select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
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
	/** 提交一次审批；signal abort → resolve(undefined)，落进既有"取消"分支。 */
	request(
		channel: ParentApprovalChannel,
		title: string,
		options: string[],
		signal?: AbortSignal,
	): Promise<string | undefined>;
}

class InProcessEscalationBroker implements EscalationBroker {
	private readonly parents = new Map<string, ParentApprovalChannel>();
	private readonly links = new Map<string, string>();

	/** FIFO 链尾：每个请求串到它后面，保证父 TUI 一次只弹一个对话框（spec §4.6）。 */
	private tail: Promise<unknown> = Promise.resolve();

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
			if (channel?.hasUI()) return channel;
			current = parentSessionId; // 中间会话无通道（depth ≥ 2）：继续向上
		}
		return null;
	}

	request(
		channel: ParentApprovalChannel,
		title: string,
		options: string[],
		signal?: AbortSignal,
	): Promise<string | undefined> {
		const run = async (): Promise<string | undefined> => {
			// 排队期间已被中断：根本不弹窗，否则用户会看到没人接收结果的幽灵审批（Review Focus #2）。
			if (signal?.aborted === true) return undefined;
			try {
				// 在飞时 abort 由 pi 的对话框自行关闭并 resolve undefined（opts.signal 已透传）。
				return await channel.select(title, options, signal === undefined ? undefined : { signal });
			} catch {
				// 父侧 UI 异常按"取消"处理（fail-closed），不让异常冒泡打断子代理的工具调用。
				return undefined;
			}
		};
		// 前一个请求即使 reject 也要继续出队，否则队列会永久卡死。
		const result = this.tail.then(run, run);
		this.tail = result.then(noop, noop);
		return result;
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
