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

/** 请求档位是否严格更宽（denial-first 门禁与 approveEscalation 共用同一张表）。 */
export function isStrictlyWider(effective: SandboxMode, requested: string): boolean {
	return (WIDER_MODES[effective] ?? []).includes(requested as SandboxMode);
}

/** 封闭的提权目标词汇（read-only 是底线，不可作为目标）。 */
export const ESCALATION_TARGETS = ["workspace-write", "danger-full-access"] as const;

export const ESCALATION_OPTIONS = ["Allow once", "Deny"] as const;

/**
 * 畸形提权参数的错误文案（按需付费：只在模型发了畸形参数时进上下文）。三要素缺一不可——
 * ① 是否执行（nothing ran：模型当时据此误判为"沙箱拒绝"，进而滥用最大档）② 原因 ③ 可自我修复的配方。
 */
const MALFORMED_ESCALATION = "invalid escalation: this call was rejected before execution (nothing ran).";
const ESCALATION_FIX =
	'Fix: to run without escalation, omit BOTH fields or send JSON null for BOTH; to escalate, send sandbox_permissions ("workspace-write" | "danger-full-access") with a one-sentence justification.';

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

/**
 * 提权参数的占位符归一化：`null` / `"null"`（trim、大小写无关）/ 空串 / 纯空白都不是提权请求，而是“没填”。
 * 归一化成 undefined 后走无提权路径：报 MALFORMED 会让模型误判为“沙箱拒绝了我”，转而升级成真正的最大档提权。
 *
 * 可达性按字段不同（实测：**pi 0.80.2 与 1.0.0 都跑 `validateToolArguments`**，校验对象是 declared schema
 * ——0.80.2 无 strict wire schema 转换、无 `normalizeOptionalNulls`，1.0.0 两者都有；
 * 工具侧的 `prepareArguments`（`stripEscalationPlaceholders`）在校验前先剥掉占位符字符串）：
 * - `justification` 的字符串臂是 `Type.String()`（字段本身为 `string | null`）：字符串占位符（`"null"` / `""`）是合法值，
 *   未走钩子的调用路径下会真的到达 execute，
 *   所以这几个分支是 load-bearing 的（否则一笔普通调用会被误判成 MALFORMED，真提权还会带着
 *   `Reason: null` 进审批弹窗）；
 * - `sandbox_permissions` 是两个字面量枚举：字符串占位符若不剥就在 pi 的参数校验期被硬拒（execute 不会跑）。
 *   钩子上线前这是一次硬错误 + 错误回放（模型把自己的 `"null"` 当样本，噪声自我强化）；
 *   钩子上线后占位符在校验前出局，实际能到达 execute 的只剩“省略”、schema 显式声明的 JSON `null`
 *   与两个合法档位——非字符串分支同样是 load-bearing 的（1.0.0 下 JSON `null` 原样送达，0.80.2 下被
 *   `Value.Convert` 转成 `""`，两者都靠本函数归一化；数字/布尔被强转成字符串、对象/数组在校验期被拒）。
 * 只识别占位符；真正的畸形（如只给 justification）仍交 validateEscalationArgs 报错。
 */
export function normalizeEscalationValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed === "" || trimmed.toLowerCase() === "null") return undefined;
	return trimmed;
}

/** 提权字段名（与 `src/tools.ts` 的 `ESCALATION_PROPS` 键一致；一致性由 tests/tools.test.ts 钉住）。 */
export const PLACEHOLDER_KEYS = ["sandbox_permissions", "justification"] as const;

/**
 * pi 的 `prepareArguments` 钩子体（接线见 `src/tools.ts` 的 `withPlaceholderStripping`）：
 * 在 pi 的参数校验（`validateToolArguments`，pi 0.80.2 与 1.0.0 都有）之前，把模型写错的占位符字符串
 * （`"null"` / `""` / 纯空白，判定复用 `normalizeEscalationValue`）从提权字段上剥掉。
 *
 * 为什么需要：strict 提供商（如 deepseek-flash，`compat.supportsStrictMode`）下 pi 会把所有 property
 * 塞进 `required`，模型在协议上无法省略这两个字段；而 schema 文本里 `null` 只以带引号的 `{"type":"null"}`
 * 出现（JSON Schema 的类型名是字符串），模型于是常写字符串 `"null"`。它在 `sandbox_permissions` 的
 * 两字面量枚举上于校验期被硬拒（execute 不跑，**0.80.2 与 1.0.0 实测同**），错误消息又把原参数 JSON 回放进上下文，
 * 成为下一轮最强的模仿样本——在校验前剥掉，既让普通调用照常执行，也掐断这条自我强化循环。
 *
 * 本钩子依赖两个宿主契约（删掉它即回退到错误回放循环）：
 * ① `prepareToolCallArguments` 在 `validateToolArguments` **之前**执行（0.80.2 与 1.0.0 均如此）；
 * ② 校验按 **declared schema** 做，而不是下发给模型的 strict wire schema——若未来宿主改为按 strict wire
 * schema 校验，本钩子的“删键”反而会让普通调用失败（strict 下 required 全含），需同步改设计。
 *
 * 只剥占位符字符串：
 * - JSON `null` 与“省略”原样通过（`Type.Null()` 声明的合法取值仍由 `resolveCall` 归一化，本钩子不改这条路）；
 * - 真提权（合法档位 + 非空理由）不能误剥；
 * - 非法值（非法档位、数字、对象等）原样保留，交给 pi 校验 / `validateEscalationArgs` 报错——
 *   钩子在“归零噪声”，不是在校验期替模型纠错。
 * 非对象输入原样返回；无占位符时返回同一引用（pi 的 `prepareToolCallArguments` 据此跳过替换，零扰动）；
 * 不改动入参对象（会话记录与 UI 保留模型的原始输出）。
 * 泛型断言 `as T` 安全：本例只可能删掉 declared schema 中 optional 的两个键，其余键值原样。
 */
export function stripEscalationPlaceholders<T>(args: T): T {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
	const record = args as Record<string, unknown>;
	let stripped: Record<string, unknown> | undefined;
	for (const key of PLACEHOLDER_KEYS) {
		if (!(key in record)) continue;
		const value = record[key];
		if (typeof value !== "string" || normalizeEscalationValue(value) !== undefined) continue;
		stripped ??= { ...record };
		delete stripped[key];
	}
	return (stripped ?? args) as T;
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
 * denial-first 门禁的忽略标记：提权参数没被受理（本会话没有前置拒绝记录），调用按当前档位执行。
 * 给模型原位反馈——否则它会把"参数没生效"误读成沙箱静默放行，继续对后续调用无脑带参数。
 */
export function escalationIgnoredMarker(mode: SandboxMode): string {
	return `[sandbox: escalation fields were ignored — no sandbox denial was recorded for this session, so this call ran under "${mode}" mode. Send escalation fields only when retrying a call that just returned a denial marker.]`;
}

/** Deny 后的可选理由追问（两步式的第二步：select → input）。 */
export interface DenialReasonPrompt {
	title: string;
	placeholder: string;
}

/** 一次审批对话的结算：choice 为 undefined 表示取消/无通道；reason 为 Deny 时的可选理由。 */
export interface EscalationDecision {
	choice: string | undefined;
	reason?: string;
}

/**
 * 审批通道的最小结构形状（不依赖 pi 类型，便于测试注入）。ask 是一次完整审批对话：
 * 直连通道 select →（Deny 时）input；broker 通道把两步放进同一个 FIFO 任务（宿主只有
 * 一个对话框槽位，select 与 input 之间不得插入其他弹窗）。
 * 注意：pi 的 noOpUIContext.select 静默返回 undefined——调用前必须显式查 hasUI，
 * 否则“无通道”会被误判为“用户取消”（spec §9）。
 */
export interface EscalationUI {
	hasUI: boolean;
	ask(title: string, options: string[], denialReason?: DenialReasonPrompt): Promise<EscalationDecision>;
}

export interface EscalationRequest {
	requestedMode: string;
	justification: string;
	effectiveMode: SandboxMode;
	subject: "command" | "operation";
	/** 弹窗里展示的命令/路径摘要（截断到 ~200 字符由调用方负责）。 */
	summary: string;
}

/** Deny 后的可选理由输入（两步式的第二步）。 */
export const DENIAL_REASON_PROMPT: DenialReasonPrompt = {
	title: "Why deny? (optional — the model will see it)",
	placeholder: "e.g. never touch files outside the workspace",
};

/**
 * 理由归一化：折叠空白、trim、截断到 500 字符。空/占位符 → undefined（拒绝文案逐字回退原样）。
 * 理由随工具错误进上下文，不能让一次输入撑爆提示预算。
 */
export function sanitizeDenialReason(raw: string | undefined): string | undefined {
	if (typeof raw !== "string") return undefined;
	const collapsed = raw.replace(/\s+/g, " ").trim();
	if (collapsed.length === 0) return undefined;
	return collapsed.length > 500 ? `${collapsed.slice(0, 500)}…` : collapsed;
}

function denialReasonSuffix(raw: string | undefined): string {
	const reason = sanitizeDenialReason(raw);
	return reason === undefined ? "" : `. The user's reason: ${reason}`;
}

/**
 * 执行前解析一次提权请求（顺序即优先级，全部 fail-closed）：
 * 同模式免审批 → 严格更宽校验 → hasUI 显式检查 → ask 审批（Deny 时追问可选理由）。
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
	const decision = await ui.ask(
		[
			`Sandbox escalation: allow this ${subject} under "${requestedMode}"?`,
			"",
			`Reason: ${justification}`,
			`${subject === "command" ? "Command" : "Path"}: ${summary}`,
		].join("\n"),
		[...ESCALATION_OPTIONS],
		DENIAL_REASON_PROMPT,
	);
	if (decision.choice === undefined) {
		throw new Error(`approval for escalating to "${requestedMode}" was cancelled — nothing was executed`);
	}
	if (decision.choice === "Deny") {
		throw new Error(
			`the user rejected escalating this ${subject} to "${requestedMode}"; it stays denied, so stop and explain instead of working around it — do not retry with a different mode or a rewritten command${denialReasonSuffix(decision.reason)}`,
		);
	}
	return requestedMode as SandboxMode;
}
