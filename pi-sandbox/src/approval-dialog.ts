/**
 * approval-dialog.ts — 一次提权审批对话（select → Deny 后可选 input）的结算层。
 *
 * 为什么需要这一层：宿主对话框只在拿到 `opts.timeout` 时才会自己超时，只在拿到 `opts.signal`
 * 时才响应中断；两者都缺时，弹窗 promise 只能等一个可能永远不来的应答（RPC 客户端把
 * `extension_ui_request` 静默丢弃即如此）。审批是工具执行前的硬门禁，挂起等于把整轮 turn 挂住，
 * 所以结算权必须留在本包：每次都武装本地 deadline、派生自己的 signal，并让本地裁决与宿主 promise
 * 竞争——宿主完全忽略 opts 也能结算。
 *
 * 直连 `ctx.ui` 与跨会话父通道都委托到这里，两步式的次序与取消语义只有一份实现。
 */

import { APPROVAL_DENY, type DenialReasonPrompt, type EscalationDecision } from "./escalation";

/** 非 TUI 宿主的默认审批 deadline（毫秒）。TUI 有人值守，不设默认上限。 */
export const NON_TUI_APPROVAL_DEADLINE_MS = 300_000;

/** 单次弹窗调用的选项。signal 恒存在（本地裁决与外部中断都要能关掉弹窗）。 */
export interface ApprovalDialogOptions {
	/** 派生 signal：外部中断与本地裁决（deadline / abort）都能关掉宿主弹窗。 */
	signal: AbortSignal;
	/** 宿主侧超时，与本地 deadline 同值；TUI 下为 undefined（不设默认上限）。 */
	timeout?: number;
}

/**
 * 弹窗宿主的原始能力。`mode()` 必须是**弹窗实际显示的那个会话**的模式：
 * 子会话转发审批时用父会话的 mode，子会话自己的 mode 与弹窗是否有人值守无关。
 */
export interface ApprovalDialogPort {
	mode(): string | undefined;
	select(title: string, options: string[], opts: ApprovalDialogOptions): Promise<string | undefined>;
	input?(title: string, placeholder: string | undefined, opts: ApprovalDialogOptions): Promise<string | undefined>;
}

export interface ApprovalDialogRequest {
	title: string;
	options: readonly string[];
	/** Deny 后的可选理由追问（两步式的第二步）；缺失时只返回 Deny。 */
	denialReason?: DenialReasonPrompt;
}

/** 单次弹窗调用的结果。error 是宿主实现抛错/拒绝：审批一律按取消处理。 */
type StepOutcome =
	| { status: "answered"; value: unknown }
	| { status: "cancelled" }
	| { status: "error" };

/** 弹窗所在宿主是否需要本地 deadline。mode 现查抛错（stale ctx）按非 TUI —— 有上限才是 fail-closed 方向。 */
function deadlineFor(port: ApprovalDialogPort): number | undefined {
	try {
		return port.mode() === "tui" ? undefined : NON_TUI_APPROVAL_DEADLINE_MS;
	} catch {
		return NON_TUI_APPROVAL_DEADLINE_MS;
	}
}

/**
 * 发起一次弹窗调用，并让它与本地裁决竞争。
 * 宿主 promise 在调用点就被订阅：迟到的 reject 由这里的 handler 吞掉，不会变成 unhandled rejection；
 * 本地裁决先落地时 `settled` 已经置位，迟到的应答/异常都不再改写结果。
 */
function askStep(
	invoke: (opts: ApprovalDialogOptions) => Promise<unknown>,
	signal: AbortSignal,
	timeout: number | undefined,
): Promise<StepOutcome> {
	if (signal.aborted) return Promise.resolve({ status: "cancelled" });
	return new Promise<StepOutcome>((resolve) => {
		let settled = false;
		const settle = (outcome: StepOutcome): void => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			resolve(outcome);
		};
		const onAbort = (): void => settle({ status: "cancelled" });
		signal.addEventListener("abort", onAbort, { once: true });
		let host: Promise<unknown>;
		try {
			host = invoke({ signal, timeout });
		} catch {
			settle({ status: "error" });
			return;
		}
		host.then(
			(value) => settle({ status: "answered", value }),
			() => settle({ status: "error" }),
		);
	});
}

/**
 * 跑完一次审批对话并给出结算（不抛错：宿主异常、deadline、abort 全部收敛成 `{ choice: undefined }`）。
 *
 * 结算规则：
 * - 调用前已中断：不打开弹窗，直接 cancelled（否则用户会看到一个没人接收结果的幽灵审批）。
 * - 本地 deadline / 外部 abort：**先**记录裁决（置 `cancelled`、结算本地 promise），**再** abort 派生
 *   signal 关闭宿主弹窗。宿主若在 abort 监听里同步 reject，其结果已无处落地，不会把 cancelled
 *   改写成 generic error。
 * - 单次弹窗一份 deadline：宿主拿到的 `timeout` 与本包武装的定时器同值，不会出现“宿主倒计时还在、
 *   本地已取消”的不一致。
 * - 两步式共用同一个中断通道：理由步被本地裁决（deadline / abort）打断时整次审批是 cancelled，
 *   而不是「Deny、无理由」（后者只表示宿主正常取消/异常）。
 */
export async function runApprovalDialog(
	port: ApprovalDialogPort,
	request: ApprovalDialogRequest,
	externalSignal?: AbortSignal,
): Promise<EscalationDecision> {
	if (externalSignal?.aborted === true) return { choice: undefined };

	const timeout = deadlineFor(port);
	const dialogAbort = new AbortController();
	let cancelled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	/** 本地裁决：先落裁决，再关闭宿主弹窗（宿主在 abort 监听里同步 reject 也改写不了结果）。 */
	const cancel = (): void => {
		if (cancelled) return;
		cancelled = true;
		dialogAbort.abort();
	};
	const onExternalAbort = (): void => cancel();
	/** 单个弹窗：自己一份 deadline（宿主拿到的 timeout 与本地完全一致，不会出现“倒计时还在、本地已取消”）。 */
	const step = (invoke: (opts: ApprovalDialogOptions) => Promise<unknown>): Promise<StepOutcome> => {
		if (cancelled) return Promise.resolve({ status: "cancelled" });
		if (timeout !== undefined) {
			timer = setTimeout(cancel, timeout);
			// 审批挂起时不应阻止进程退出（TUI 关闭 / 宿主 shutdown）。
			timer.unref?.();
		}
		return askStep(invoke, dialogAbort.signal, timeout).finally(() => {
			if (timer === undefined) return;
			clearTimeout(timer);
			timer = undefined;
		});
	};

	try {
		externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

		const first = await step((opts) => port.select(request.title, [...request.options], opts));
		// 本地裁决优先于宿主结果：到期/中断后落地的应答（含迟到的 "Allow once"）一律作废。
		if (cancelled || first.status !== "answered") return { choice: undefined };
		const choice = first.value;
		if (choice !== APPROVAL_DENY || request.denialReason === undefined || typeof port.input !== "function") {
			return { choice };
		}

		const denialReason = request.denialReason;
		const input = port.input;
		const second = await step((opts) => input(denialReason.title, denialReason.placeholder, opts));
		if (cancelled || second.status === "cancelled") return { choice: undefined };
		// 宿主正常取消理由、空白理由或普通异常：保持「Deny、无理由」，不是 cancelled。
		if (second.status !== "answered" || typeof second.value !== "string") return { choice: APPROVAL_DENY };
		return { choice: APPROVAL_DENY, reason: second.value };
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		externalSignal?.removeEventListener("abort", onExternalAbort);
	}
}
