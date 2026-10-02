import { access as fsAccess, constants, mkdir as fsMkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { Type, type TSchema } from "typebox";
import {
	type AgentToolResult,
	createBashToolDefinition,
	createEditToolDefinition,
	createWriteToolDefinition,
	type EditOperations,
	type ExtensionContext,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { createSandboxBashOps, type SpawnFn } from "./bash-ops";
import { getSandboxConfig, type SandboxConfig } from "./config";
import { getDenialLedger } from "./denial-ledger";
import {
	approveEscalation,
	type DenialReasonPrompt,
	escalationAppliedMarker,
	escalationIgnoredMarker,
	type EscalationDecision,
	type EscalationUI,
	isStrictlyWider,
	normalizeEscalationValue,
	validateEscalationArgs,
} from "./escalation";
import { getEscalationBroker } from "./escalation-broker";
import { assertWriteAllowed, FenceDenialError, type FencePolicy } from "./fence";
import type { PermissionState } from "./permission";
import { canonicalPath, resolveEffectiveMode, type SandboxMode } from "./policy";
import { selectRunner, type RunnerHooks } from "./runners";

export interface SandboxToolDeps {
	cwd: string;
	/** 测试注入用；生产缺省逐调用 getSandboxConfig(ctx.cwd)（C2）。 */
	getConfig?(): SandboxConfig;
	permission: PermissionState;
	hooks?: RunnerHooks;
	spawnFn?: SpawnFn;
	/** 测试注入的预解析 runner；生产缺省走 selectRunner 缓存。 */
	selected?: ReturnType<typeof selectRunner>;
	/** 测试注入（testing.md「参数注入」）：替换缺省的 "/tmp" + os.tmpdir() tmp 根；生产不传。 */
	_tmpRoots?: readonly string[];
}

const workspaceRootCache = new Map<string, string>();

/** C2（spec §9）：pi 从不 chdir，会话 cwd 只经 execute 的 ctx.cwd 可达——
 *  围栏根逐调用从它派生（模块级缓存，进程内共享），不再冻结在 activate 时的 process.cwd()。 */
function workspaceRootFor(rawCwd: string): string {
	let root = workspaceRootCache.get(rawCwd);
	if (root === undefined) {
		root = canonicalPath(rawCwd);
		workspaceRootCache.set(rawCwd, root);
	}
	return root;
}

/** 逐调用配置（C2）：测试注入优先，否则按会话 cwd 惰性加载（getSandboxConfig 自带缓存）。 */
function configForCall(deps: SandboxToolDeps, sessionCwd: string): SandboxConfig {
	return deps.getConfig?.() ?? getSandboxConfig(sessionCwd);
}

/**
 * 提权参数对（三个工具共用）。
 * 枚举显式接受占位符（字符串 "null" / JSON null）：LLM 常把"不填"表达成 "null"，
 * 严格枚举会把它挡在宿主 schema 校验层——扩展的 normalizeEscalationValue 根本没机会运行。
 * 放行后由归一化统一视为"未提供"；真正的档位拼写错误仍被宿主拦（枚举的防护不丢）。
 * spec：`docs/superpowers/specs/2026-10-02-denial-first-escalation-design.md` §4.3。
 */
export const ESCALATION_PROPS = {
	sandbox_permissions: Type.Optional(
		Type.Union([
			Type.Literal("workspace-write"),
			Type.Literal("danger-full-access"),
			// 占位符容错（1.3.1）：值本身不合法，但它是"不填"的常见表达——
			// 拦在宿主层只会浪费一次工具往返（模型看到 Validation failed 再自纠）。
			Type.Literal("null"),
			Type.Null(),
		]),
	),
	justification: Type.Optional(Type.String()),
};

interface EscalationParams {
	sandbox_permissions?: string;
	justification?: string;
}

interface ToolCtxLike {
	hasUI: boolean;
	cwd?: string;
	ui: {
		select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
		/** 可选：Deny 后的理由输入（两步式第二步）。缺失时仅跳过一次理由追问。 */
		input?(title: string, placeholder?: string, opts?: { signal?: AbortSignal }): Promise<string | undefined>;
	};
	/** 子会话身份来源。可选：既有测试的窄 ctx 与异常宿主都可能没有它，
	 *  缺失时按"无法路由"fail-closed，绝不得抛 TypeError（Review Focus #1）。 */
	sessionManager?: { getSessionId(): string };
}

/** 防御性读取会话 id：缺失、非字符串或抛错都归为"无法路由"（fail-closed）。父/子两侧共用。 */
function readSessionId(ctx: ToolCtxLike): string | null {
	try {
		const sessionId = ctx.sessionManager?.getSessionId();
		return typeof sessionId === "string" && sessionId.trim().length > 0 ? sessionId.trim() : null;
	} catch {
		return null;
	}
}

/**
 * 审批通道解析（spec 2026-09-30 §4.3）：
 * - 本会话有 UI：优先用它自己注册的通道，经 broker 的同一条 FIFO 车道弹窗（Ruling 17）——宿主的
 *   对话框只有一个槽位且不排队，第二次调用会让前一个弹窗收不到按键、其 promise 变成孤儿。
 *   解析不到自己的通道（宿主未发 session_start、拿不到会话 id）才回落直连，回落行为与改动前逐字一致。
 * - 本会话无 UI（子会话）：沿 link 严格解析父通道（D3），解析不到就返回哑通道。
 * 哑通道让 approveEscalation 抛出既有 fail-closed 文案——不新增错误分支、不改变校验顺序。
 * 两条通道的 ask 都是两步式（select → Deny 时 input 收理由）：直连串行 await，broker 在同一个
 * FIFO 任务内完成，理由输入不会被排队中的下一个审批弹窗顶掉。signal 两条路径都透传（D6）：
 * 中断既能关掉在飞的弹窗，也能让排队中的请求根本不弹。
 */
function approvalChannelFor(ctx: ToolCtxLike, signal: AbortSignal | undefined): EscalationUI {
	const opts = signal === undefined ? undefined : { signal };
	const broker = getEscalationBroker();
	const sessionId = readSessionId(ctx);
	// 直连通道的两步式：select →（Deny 时）input，在同一条异步链上串行 await，天然原子。
	const directAsk = async (title: string, options: string[], denialReason?: DenialReasonPrompt): Promise<EscalationDecision> => {
		const choice = await ctx.ui.select(title, options, opts);
		if (choice !== "Deny" || denialReason === undefined || typeof ctx.ui.input !== "function") return { choice };
		try {
			const reason = await ctx.ui.input(denialReason.title, denialReason.placeholder, opts);
			return { choice, reason };
		} catch {
			return { choice }; // 理由输入异常不影响拒绝语义（fail-closed）
		}
	};
	if (ctx.hasUI) {
		const own = sessionId === null ? null : broker.resolveOwnChannel(sessionId);
		if (own === null) {
			return { hasUI: true, ask: directAsk };
		}
		return { hasUI: true, ask: (title, options, denialReason) => broker.request(own, title, options, signal, denialReason) };
	}
	const channel = sessionId === null ? null : broker.resolveChannel(sessionId);
	if (channel === null) {
		return { hasUI: false, ask: async () => ({ choice: undefined }) };
	}
	return { hasUI: true, ask: (title, options, denialReason) => broker.request(channel, title, options, signal, denialReason) };
}

/**
 * 解析一次调用的生效模式（spec §4/§7）：
 * malformed 校验 → effective（/permission 覆盖 > config）→ 可选的已批准提权。
 * escalated 为真仅当本次真的经审批提了权（请求档位 == effective 时免审批，不是提权）。
 */
export interface ResolvedCall {
	mode: SandboxMode;
	escalated: boolean;
	/** denial-first 门禁忽略了本次提权参数：按 effective 档位执行，不是提权。 */
	ignoredEscalation: boolean;
}

export async function resolveCall(
	params: EscalationParams,
	ctx: ToolCtxLike,
	deps: SandboxToolDeps,
	subject: "command" | "operation",
	summary: () => string,
	signal?: AbortSignal,
): Promise<ResolvedCall> {
	// 占位符归一化先于校验：null / "null" / 空白是"没填"而不是畸形提权（normalizeEscalationValue）。
	// 直接报 MALFORMED 会让模型误判为沙箱拒绝，转而升级成真正的最大档提权。
	const requested = normalizeEscalationValue(params.sandbox_permissions);
	const justification = normalizeEscalationValue(params.justification);
	validateEscalationArgs(requested, justification);
	const config = configForCall(deps, ctx.cwd ?? deps.cwd);
	const effective = resolveEffectiveMode(deps.permission.override, config.mode);
	if (requested === undefined) return { mode: effective, escalated: false, ignoredEscalation: false };
	// denial-first 硬门禁（spec 2026-10-02 §4.3）：严格更宽的请求必须有本会话、同工具类的未消费拒绝记录，
	// 否则忽略提权参数、按当前档位执行。同档请求与非法请求不进门禁：前者免审批（approveEscalation 首行），
	// 后者由 approveEscalation 报既有"not strictly wider"错误（不能把非法请求静默降成普通执行）。
	if (isStrictlyWider(effective, requested)) {
		const sessionId = readSessionId(ctx);
		const denied = sessionId !== null && getDenialLedger().consume(sessionId, subject === "command" ? "command" : "operation");
		if (!denied) return { mode: effective, escalated: false, ignoredEscalation: true };
	}
	const mode = await approveEscalation(
		{
			requestedMode: requested,
			justification: justification as string,
			effectiveMode: effective,
			subject,
			summary: summary().slice(0, 200),
		},
		approvalChannelFor(ctx, signal),
	);
	return { mode, escalated: mode !== effective, ignoredEscalation: false };
}

/** 兼容包装：既有调用方与判例按裸 mode 断言（一次性提权语义不变，Review Focus #5）。 */
export async function resolveCallMode(
	params: EscalationParams,
	ctx: ToolCtxLike,
	deps: SandboxToolDeps,
	subject: "command" | "operation",
	summary: () => string,
	signal?: AbortSignal,
): Promise<SandboxMode> {
	return (await resolveCall(params, ctx, deps, subject, summary, signal)).mode;
}

/** Ruling 15：对象 spread 保留 base schema 的自有 options（如 editSchema 的 additionalProperties:false）。 */
function extendParams(base: TSchema): TSchema {
	const b = base as unknown as { properties: Record<string, unknown> };
	return { ...base, properties: { ...b.properties, ...ESCALATION_PROPS } } as TSchema;
}

/**
 * 提示预算（β′，每请求成本受控）：
 * - `tool.description` 与参数 schema 是**按工具**进请求的 → 同一句话写进 bash/write/edit 就付 3 份；
 * - `promptGuidelines` 进 system prompt 的 rules，pi 按字符串去重（`buildRules` 的 seen 集）→ 只付 1 份。
 * 所以：跨工具规则只留一句（ESCALATION_GUIDELINE + 这一句 SANDBOX_NOTE），协议细节一律放按需面
 * （denial hint / 校验错误 / 批准后标记）。
 */
const SANDBOX_NOTE =
	"Sandbox: confined to the current mode; workspace-write already allows the workspace and /tmp. Pass escalation fields only when retrying a denial (never null); others are ignored.";

function escalationDescription(base: string): string {
	return [base, "", SANDBOX_NOTE].join("\n");
}

/** 批准后追加一行按需反馈（其余字段原样保留）。 */
function withEscalationNote<T>(result: AgentToolResult<T>, mode: SandboxMode): AgentToolResult<T> {
	return { ...result, content: [...result.content, { type: "text", text: escalationAppliedMarker(mode) }] };
}

/** denial-first 门禁忽略提权时追加的按需反馈（其余字段原样保留）。
 *  已知边界：只随成功结果下发——bash 非零退出会 throw（pi 的错误路径不经过 execute 的返回值），
 *  那种场景下模型仍能按随错误下发的 escalation hint 正确重试（真实拒绝已记账，重试会弹窗）。 */
function withIgnoredEscalationNote<T>(result: AgentToolResult<T>, mode: SandboxMode): AgentToolResult<T> {
	return { ...result, content: [...result.content, { type: "text", text: escalationIgnoredMarker(mode) }] };
}

const ESCALATION_GUIDELINE =
	"When a sandbox denial marker appears, you may retry the exact same call once with sandbox_permissions (the narrowest wider mode that suffices) plus justification; the user is asked to approve and may attach a reason when denying. Never send escalation fields before a denial — such requests are ignored and the call runs confined. If denied or unavailable, stop and explain instead of working around it.";

function stripEscalation(params: Record<string, unknown>) {
	const { sandbox_permissions: _sp, justification: _just, ...rest } = params;
	return rest;
}

/** fence 移到 ops 层（Ruling 14）：pi execute 用 resolveToCwd 解析后把 absolutePath 传给 ops，
 *  围栏检查的就是将被写入的同一字符串——与落盘构造性一致，杜绝 ~/、@/、file:// 解析分歧绕过。
 *  readFile/access 是读操作，不设围栏（所有模式读全放行）。 */
function createFencedWriteOps(policy: FencePolicy, onDenial?: () => void): WriteOperations {
	const guard = (path: string): void => {
		try {
			assertWriteAllowed(path, policy);
		} catch (error) {
			if (error instanceof FenceDenialError) onDenial?.();
			throw error;
		}
	};
	return {
		writeFile: async (path, content) => {
			guard(path);
			await fsWriteFile(path, content, "utf-8");
		},
		mkdir: async (dir) => {
			guard(dir);
			await fsMkdir(dir, { recursive: true });
		},
	};
}

function createFencedEditOps(policy: FencePolicy, onDenial?: () => void): EditOperations {
	const guard = (path: string): void => {
		try {
			assertWriteAllowed(path, policy);
		} catch (error) {
			if (error instanceof FenceDenialError) onDenial?.();
			throw error;
		}
	};
	return {
		readFile: (path) => fsReadFile(path),
		access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
		writeFile: async (path, content) => {
			guard(path);
			await fsWriteFile(path, content, "utf-8");
		},
	};
}

export function createSandboxTools(deps: SandboxToolDeps) {
	// Ruling 15：以 definition 工厂为 base——自带 promptSnippet/promptGuidelines，
	// execute 第 5 参 ctx 类型正确（ExtensionContext），spread 后注册不丢系统提示元数据。
	const baseBash = createBashToolDefinition(deps.cwd);
	const baseWrite = createWriteToolDefinition(deps.cwd);
	const baseEdit = createEditToolDefinition(deps.cwd);

	const bash = {
		...baseBash,
		label: `${baseBash.label} (sandboxed)`,
		description: escalationDescription(baseBash.description),
		promptGuidelines: [...(baseBash.promptGuidelines ?? []), ESCALATION_GUIDELINE],
		parameters: extendParams(baseBash.parameters),
		async execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: ExtensionContext) {
			const sessionCwd = (ctx as { cwd?: string }).cwd ?? deps.cwd;
			const workspaceRoot = workspaceRootFor(sessionCwd);
			const config = configForCall(deps, sessionCwd);
			const sessionId = readSessionId(ctx);
			const { mode, escalated, ignoredEscalation } = await resolveCall(params as EscalationParams, ctx, deps, "command", () => String(params.command ?? ""), signal);
			// M3：配置了自定义 runnerCommand 时跳过链探测（confine 直接用 runnerCommand）。
			const selected = mode === "danger-full-access" || (config.runnerCommand?.length ?? 0) > 0
				? undefined
				: (deps.selected ?? selectRunner(config.probeTimeoutMs, deps.hooks));
			const tool = createBashToolDefinition(sessionCwd, {
				operations: createSandboxBashOps({
					mode,
					workspaceRoot,
					selected,
					runnerCommand: config.runnerCommand,
					runnerFailureSignatures: config.runnerFailureSignatures,
					probeTimeoutMs: config.probeTimeoutMs,
					hooks: deps.hooks,
					spawnFn: deps.spawnFn,
					// 真实沙箱拒绝时记账：denial-first 门禁据此放行同一会话的下一笔同类提权。
					onDenial: sessionId === null ? undefined : () => getDenialLedger().record(sessionId, "command"),
				}),
			});
			const result = await tool.execute(toolCallId, stripEscalation(params) as never, signal, onUpdate as never, ctx);
			if (ignoredEscalation) return withIgnoredEscalationNote(result, mode);
			return escalated ? withEscalationNote(result, mode) : result;
		},
	};

	const write = {
		...baseWrite,
		label: `${baseWrite.label} (sandboxed)`,
		description: escalationDescription(baseWrite.description),
		promptGuidelines: [...(baseWrite.promptGuidelines ?? []), ESCALATION_GUIDELINE],
		parameters: extendParams(baseWrite.parameters),
		async execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: ExtensionContext) {
			const sessionCwd = (ctx as { cwd?: string }).cwd ?? deps.cwd;
			const workspaceRoot = workspaceRootFor(sessionCwd);
			const sessionId = readSessionId(ctx);
			const { mode, escalated, ignoredEscalation } = await resolveCall(params as EscalationParams, ctx, deps, "operation", () => String(params.path ?? ""), signal);
			// fence 拒绝不捕获：FenceDenialError 从 ops 抛出、经 pi execute 原样上抛
			//（withFileMutationQueue 不吞错）——pi 的 agent 循环会转成 error result。
			const tool = createWriteToolDefinition(sessionCwd, {
				operations: createFencedWriteOps(
					{ mode, workspaceRoot, _tmpRoots: deps._tmpRoots },
					sessionId === null ? undefined : () => getDenialLedger().record(sessionId, "operation"),
				),
			});
			const result = await tool.execute(toolCallId, stripEscalation(params) as never, signal, onUpdate as never, ctx);
			if (ignoredEscalation) return withIgnoredEscalationNote(result, mode);
			return escalated ? withEscalationNote(result, mode) : result;
		},
	};

	const edit = {
		...baseEdit,
		label: `${baseEdit.label} (sandboxed)`,
		description: escalationDescription(baseEdit.description),
		promptGuidelines: [...(baseEdit.promptGuidelines ?? []), ESCALATION_GUIDELINE],
		parameters: extendParams(baseEdit.parameters),
		async execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: ExtensionContext) {
			const sessionCwd = (ctx as { cwd?: string }).cwd ?? deps.cwd;
			const workspaceRoot = workspaceRootFor(sessionCwd);
			const sessionId = readSessionId(ctx);
			const { mode, escalated, ignoredEscalation } = await resolveCall(params as EscalationParams, ctx, deps, "operation", () => String(params.path ?? ""), signal);
			const tool = createEditToolDefinition(sessionCwd, {
				operations: createFencedEditOps(
					{ mode, workspaceRoot, _tmpRoots: deps._tmpRoots },
					sessionId === null ? undefined : () => getDenialLedger().record(sessionId, "operation"),
				),
			});
			const result = await tool.execute(toolCallId, stripEscalation(params) as never, signal, onUpdate as never, ctx);
			if (ignoredEscalation) return withIgnoredEscalationNote(result, mode);
			return escalated ? withEscalationNote(result, mode) : result;
		},
	};

	return { bash, write, edit };
}
