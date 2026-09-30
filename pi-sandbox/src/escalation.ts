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

export function validateEscalationArgs(sandboxPermissions: string | undefined, justification: string | undefined): void {
	if (sandboxPermissions !== undefined && justification === undefined) {
		throw new Error("invalid escalation: sandbox_permissions requires a justification");
	}
	if (justification !== undefined && sandboxPermissions === undefined) {
		throw new Error("invalid escalation: justification is only valid together with sandbox_permissions");
	}
	if (justification !== undefined && justification.trim().length === 0) {
		throw new Error("invalid justification: expected a non-empty sentence");
	}
}

/** 模型可见的拒绝标记（fs 围栏与 bash denial 分类共用，逐字勿改）。 */
export function sandboxDenialMarker(mode: SandboxMode): string {
	return `[sandbox: file access denied under ${mode} mode]`;
}

/** 随拒绝下发的同轮提权提示——nudge 放在决策点，不依赖模型回忆工具描述。 */
export function escalationHintMarker(subject: "command" | "operation"): string {
	return `[sandbox: escalation available — retry this exact ${subject} once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]`;
}

/** sandbox_permissions 参数的 schema 描述（模型可见的提权规则常驻声明）。 */
export function sandboxPermissionsDescription(subject: "command" | "operation"): string {
	return `The narrowest wider sandbox mode for a one-shot retry of the exact ${subject} the sandbox just denied; the retry asks the user for approval.`;
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
		throw new Error(`sandbox escalation to "${requestedMode}" is not strictly wider than this call's current "${effectiveMode}" mode`);
	}
	if (!ui.hasUI) {
		throw new Error(`sandbox escalation to "${requestedMode}" requires approval, but no approval channel is available`);
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
		throw new Error(`approval for escalating to "${requestedMode}" was cancelled`);
	}
	if (choice === "Deny") {
		throw new Error(`the user rejected escalating this ${subject} to "${requestedMode}"; it stays denied, so stop and explain instead of working around it`);
	}
	return requestedMode as SandboxMode;
}
