import type { SandboxMode } from "./policy";

/**
 * 严格更宽表：key 为当次调用的 effective mode，value 为可提权到的目标。
 * 在执行期对着每次调用的 effective mode 检查（schema 枚举是注册表全局的，
 * effective mode 才是逐调用真相——deepseek escalation.ts 语义）。
 */
export const WIDER_MODES: Record<string, readonly SandboxMode[]> = {
	"read-only": ["workspace-write", "danger-full-access"],
	"workspace-write": ["danger-full-access"],
};

/** 封闭的提权目标词汇（read-only 是底线，不可作为目标）。 */
export const ESCALATION_TARGETS = ["workspace-write", "danger-full-access"] as const;

export const ESCALATION_OPTIONS = ["Allow once", "Deny"] as const;

/**
 * 畸形提权参数的错误文案（按需付费：只在模型发了畸形参数时进上下文）。三要素缺一不可——
 * ① 是否执行（nothing ran：模型当时据此误判为"沙箱拒绝"，进而滥用最大档）② 原因 ③ 可自我修复的配方。
 */
const MALFORMED_ESCALATION = "invalid escalation: this call was rejected before execution (nothing ran).";
const ESCALATION_FIX =
	'Fix: to run without escalation, omit BOTH fields (never null / "null" / ""); to escalate, send sandbox_permissions ("workspace-write" | "danger-full-access") with a one-sentence justification.';

export function validateEscalationArgs(sandboxPermissions: string | undefined, justification: string | undefined): void {
	if (sandboxPermissions !== undefined && justification === undefined) {
		throw new Error(`${MALFORMED_ESCALATION} Cause: sandbox_permissions was sent without justification. ${ESCALATION_FIX}`);
	}
	if (justification !== undefined && sandboxPermissions === undefined) {
		throw new Error(`${MALFORMED_ESCALATION} Cause: justification was sent without sandbox_permissions. ${ESCALATION_FIX}`);
	}
	if (justification !== undefined && justification.trim().length === 0) {
		throw new Error(`${MALFORMED_ESCALATION} Cause: justification was empty. ${ESCALATION_FIX}`);
	}
}

/** 模型可见的拒绝标记（fs 围栏与 bash denial 分类共用，逐字勿改）。 */
export function sandboxDenialMarker(mode: SandboxMode): string {
	return `[sandbox: file access denied under ${mode} mode]`;
}

/**
 * 随拒绝下发的同轮提示（按需付费）：先给"不用提权的出路"（可写根），再给提权配方——
 * nudge 放在决策点，不依赖模型回忆工具描述（常态提示预算见 tools.ts 的提示预算说明）。
 */
export function escalationHintMarker(subject: "command" | "operation"): string {
	return `[sandbox: escalation available — writable here: the workspace + /tmp; retry this exact ${subject} once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]`;
}

/**
 * 批准后随结果下发的提示：一次性提权到下一次调用即失效。缺了这一句，模型会把"批准过"
 * 当成"档位已放宽"，于是对后续每条命令（哪怕是只读的 ls）都带上同一个提权参数。
 */
export function escalationAppliedMarker(mode: SandboxMode): string {
	return `[sandbox: this call ran with a one-shot escalation to "${mode}"; the approval covered this call only — later calls are confined again]`;
}

/**
 * 审批通道的最小结构形状（不依赖 pi 类型，便于测试注入）。
 * 注意：pi 的 noOpUIContext.select 静默返回 undefined——调用前必须显式查 hasUI，
 * 否则"无通道"会被误判为"用户取消"（spec §9）。
 */
export interface EscalationUI {
	hasUI: boolean;
	select(title: string, options: string[]): Promise<string | undefined>;
}

export interface EscalationRequest {
	requestedMode: string;
	justification: string;
	effectiveMode: SandboxMode;
	subject: "command" | "operation";
	/** 弹窗里展示的命令/路径摘要（截断到 ~200 字符由调用方负责）。 */
	summary: string;
}

/**
 * 执行前解析一次提权请求（顺序即优先级，全部 fail-closed）：
 * 同模式免审批 → 严格更宽校验 → hasUI 显式检查 → select 审批。
 * 返回值只对发起它的那一次调用生效（一次性，不持久）。
 */
export async function approveEscalation(request: EscalationRequest, ui: EscalationUI): Promise<SandboxMode> {
	const { requestedMode, justification, effectiveMode, subject, summary } = request;
	if (requestedMode === effectiveMode) return effectiveMode;
	if (!(WIDER_MODES[effectiveMode] ?? []).includes(requestedMode as SandboxMode)) {
		throw new Error(
			`sandbox escalation to "${requestedMode}" is not strictly wider than this call's current "${effectiveMode}" mode — nothing was executed. Run the call as-is, or escalate to "danger-full-access".`,
		);
	}
	if (!ui.hasUI) {
		throw new Error(
			`sandbox escalation to "${requestedMode}" requires approval, but no approval channel is available — nothing was executed. This happens in headless and cross-process subagents: do the work inside the writable roots, or ask the user to run /permission ${requestedMode} in their main session and retry.`,
		);
	}
	const choice = await ui.select(
		[
			`Sandbox escalation: allow this ${subject} under "${requestedMode}"?`,
			"",
			`Reason: ${justification}`,
			`${subject === "command" ? "Command" : "Path"}: ${summary}`,
		].join("\n"),
		[...ESCALATION_OPTIONS],
	);
	if (choice === undefined) {
		throw new Error(`approval for escalating to "${requestedMode}" was cancelled — nothing was executed`);
	}
	if (choice === "Deny") {
		throw new Error(
			`the user rejected escalating this ${subject} to "${requestedMode}"; it stays denied, so stop and explain instead of working around it — do not retry with a different mode or a rewritten command`,
		);
	}
	return requestedMode as SandboxMode;
}
