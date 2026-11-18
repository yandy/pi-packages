/**
 * approval-dialog.ts — 提权审批对话的唯一实现（两步式：select → Deny 后可选 input）。
 *
 * 为什么单独成模块：审批的结算语义（本地 deadline、abort、宿主 promise 竞争）必须只有一份。
 * 直连通道（tools.ts 的 ctx.ui）与跨会话父通道（escalation-broker.ts）都委托到这里，
 * 否则两处 guard 一漂移，就有一处会在宿主静默时永久挂起。
 *
 * 结算契约（顺序即优先级）：
 * 1. 本地已记录取消原因（timeout / abort）→ 取消拥有最终裁决权：宿主随后 resolve 的
 *    "Allow once" 不会被采纳，宿主在 abort listener 里同步 reject 也得到取消，而不是 generic error；
 * 2. 否则以宿主结果为准：resolve 的值原样返回（白名单校验在 approveEscalation，不在协议层）；
 *    reject 按「审批 UI 故障」处理——select 步直接按取消结算（与宿主既有口径一致：宿主的
 *    内部报错绝不冒泡成用户/模型看到的工具错误），理由步退回「Deny、无理由」；
 * 3. 调用前已 abort：根本不打开弹窗。
 *
 * 宿主可能完全忽略 opts（既不听 signal 也不设 timeout），所以本地必须自己计时并在宿主
 * promise 之外 race；所有宿主 promise 都立即订阅，迟到的 resolve/reject 不会成为 unhandled rejection。
 */

import type { DenialReasonPrompt, EscalationDecision } from "./escalation";

/**
 * 非 TUI（RPC / json / print）每次 dialog 的默认 deadline。
 * TUI 不设默认上限：用户有 Esc/Ctrl-C，弹窗可以一直等；给 TUI 加自动取消只会制造惊喜。
 */
export const APPROVAL_DIALOG_DEFAULT_TIMEOUT_MS = 300_000;

/** 传给宿主的 dialog opts：派生 signal 让宿主能关闭弹窗，timeout 让守规矩宿主自己定时。 */
export interface ApprovalDialogOptions {
	signal?: AbortSignal;
	timeout?: number;
}

/** 宿主对话框的最小形状（直连 ctx.ui 与父通道注册的实现都满足它）。 */
export interface ApprovalDialogChannel {
	select(title: string, options: string[], opts?: ApprovalDialogOptions): Promise<string | undefined>;
	/** 可选：Deny 后的理由输入（两步式的第二步）。缺失时跳过追问。 */
	input?(title: string, placeholder?: string, opts?: ApprovalDialogOptions): Promise<string | undefined>;
}

/** 非 TUI 默认 deadline，TUI 无上限；模式未知（老宿主 / 陈旧的 ctx）按非 TUI 兜底——挂死比误取消更糟。 */
export function dialogTimeoutMs(mode: string | undefined): number | undefined {
	return mode === "tui" ? undefined : APPROVAL_DIALOG_DEFAULT_TIMEOUT_MS;
}

/** 一次审批会话的 guard：外部中断与本地 deadline 由它统一转成取消。 */
export interface ApprovalGuardOptions {
	/** 工具调用的 signal（subagent 被中断 / 排队中被取消）。 */
	signal?: AbortSignal;
	/** 每次 dialog 的本地 deadline；undefined = 无限等待（TUI）。 */
	timeoutMs?: number;
}

type CancelKind = "timeout" | "abort";

type StepOutcome =
	| { status: "answered"; value: string | undefined }
	| { status: "cancelled" }
	| { status: "failed"; error: unknown };

/** 一个独立的控制器：派生 signal 与取消原因，绝不与其他审批共享。 */
class ApprovalSession {
	private readonly controller = new AbortController();
	private cancelKind: CancelKind | undefined;
	private readonly external: AbortSignal | undefined;
	private readonly timeoutMs: number | undefined;
	private readonly onExternalAbort = () => this.cancel("abort");

	constructor(guard: ApprovalGuardOptions) {
		this.external = guard.signal;
		this.timeoutMs = guard.timeoutMs;
		if (this.external === undefined) return;
		try {
			// 病态 signal（getter / addEventListener 抛错）按已取消处理：fail-closed，且绝不 reject。
			if (this.external.aborted) {
				this.cancel("abort");
				return;
			}
			this.external.addEventListener("abort", this.onExternalAbort, { once: true });
		} catch {
			this.cancel("abort");
		}
	}

	/** 本地取消：abort 派生 signal（关掉宿主弹窗）并记住原因。首个原因获胜。 */
	private cancel(kind: CancelKind): void {
		if (this.cancelKind !== undefined) return;
		this.cancelKind = kind;
		this.controller.abort();
	}

	async step(run: (opts: ApprovalDialogOptions) => Promise<string | undefined>): Promise<StepOutcome> {
		if (this.cancelKind !== undefined) return { status: "cancelled" };
		return new Promise<StepOutcome>((resolve) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const settle = (outcome: StepOutcome): void => {
				if (settled) return;
				settled = true;
				if (timer !== undefined) clearTimeout(timer);
				this.controller.signal.removeEventListener("abort", onAbort);
				resolve(outcome);
			};
			const onAbort = () => settle({ status: "cancelled" });
			// 先挂本地 abort 监听再呼叫宿主：保证 abort 派发时本地结算先于宿主的同步 resolve/reject
			//（即便宿主的 listener 先跑，下面的 settle 仍会按 cancelKind 裁决为取消）。
			this.controller.signal.addEventListener("abort", onAbort, { once: true });
			if (this.timeoutMs !== undefined) {
				timer = setTimeout(() => this.cancel("timeout"), this.timeoutMs);
				timer.unref?.(); // 不因等待审批而拖住进程退出
			}
			let host: Promise<string | undefined>;
			try {
				host = run({ signal: this.controller.signal, timeout: this.timeoutMs });
			} catch (error) {
				host = Promise.reject(error);
			}
			// 立即订阅：迟到结果只被丢弃，绝不成为 unhandled rejection。
			host.then(
				(value) => settle(this.cancelKind === undefined ? { status: "answered", value } : { status: "cancelled" }),
				(error) => settle(this.cancelKind === undefined ? { status: "failed", error } : { status: "cancelled" }),
			);
		});
	}

	/** 正常应答后清理外部 signal 监听；逐个 step 的 timer 已在各自结算时清掉。 */
	dispose(): void {
		try {
			this.external?.removeEventListener("abort", this.onExternalAbort);
		} catch {
			// 病态 signal：清理失败不影响已经结算的审批。
		}
	}
}

/**
 * 跑完一次完整审批对话。取消（本地 timeout / abort / 调用前已 abort）一律返回
 * `{ choice: undefined }`，落进 approveEscalation 既有的 "cancelled" fail-closed 分支；
 * 理由步只有宿主自身取消/异常才退回「Deny、无理由」。
 */
export async function runApprovalDialog(
	channel: ApprovalDialogChannel,
	title: string,
	options: string[],
	denialReason: DenialReasonPrompt | undefined,
	guard: ApprovalGuardOptions = {},
): Promise<EscalationDecision> {
	const session = new ApprovalSession(guard);
	try {
		const selected = await session.step((opts) => channel.select(title, options, opts));
		if (selected.status === "cancelled" || selected.status === "failed") return { choice: undefined };
		const input = channel.input;
		if (selected.value !== "Deny" || denialReason === undefined || typeof input !== "function") {
			return { choice: selected.value };
		}
		const reason = await session.step((opts) => input(denialReason.title, denialReason.placeholder, opts));
		if (reason.status === "cancelled") return { choice: undefined };
		// 理由步的宿主异常/空值保持既有「Deny、无理由」语义（fail-closed），只有本地取消才是 cancelled。
		if (reason.status === "failed") return { choice: selected.value };
		return { choice: selected.value, reason: reason.value };
	} finally {
		session.dispose();
	}
}
