import { access as fsAccess, constants, mkdir as fsMkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { Type, type TSchema } from "typebox";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createWriteToolDefinition,
	type EditOperations,
	type ExtensionContext,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { createSandboxBashOps, type SpawnFn } from "./bash-ops";
import { getSandboxConfig, type SandboxConfig } from "./config";
import { approveEscalation, type EscalationUI, sandboxPermissionsDescription, validateEscalationArgs } from "./escalation";
import { getEscalationBroker } from "./escalation-broker";
import { assertWriteAllowed, type FencePolicy } from "./fence";
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

/** 提权参数对（三个工具共用）。 */
export const ESCALATION_PROPS = {
	sandbox_permissions: Type.Optional(Type.Union([Type.Literal("workspace-write"), Type.Literal("danger-full-access")])),
	justification: Type.Optional(Type.String()),
};

interface EscalationParams {
	sandbox_permissions?: string;
	justification?: string;
}

interface ToolCtxLike {
	hasUI: boolean;
	cwd?: string;
	ui: { select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined> };
	/** 子会话身份来源。可选：既有测试的窄 ctx 与异常宿主都可能没有它，
	 *  缺失时按"无法路由"fail-closed，绝不得抛 TypeError（Review Focus #1）。 */
	sessionManager?: { getSessionId(): string };
}

/** 防御性读取子会话 id：缺失、非字符串或抛错都归为"无法路由"（fail-closed）。 */
function readChildSessionId(ctx: ToolCtxLike): string | null {
	try {
		const sessionId = ctx.sessionManager?.getSessionId();
		return typeof sessionId === "string" && sessionId.trim().length > 0 ? sessionId.trim() : null;
	} catch {
		return null;
	}
}

/**
 * 审批通道解析（spec 2026-09-30 §4.3）：本会话有 UI 就直连；否则向 broker 要父通道。
 * 解析不到时返回 hasUI:false 的哑通道，让 approveEscalation 抛出既有 fail-closed 文案
 * ——不新增错误分支、不改变校验顺序，escalation.ts 因此零改动。
 * signal 两条路径都透传（D6）：中断既能关掉在飞的弹窗，也能让排队中的请求根本不弹。
 */
function approvalChannelFor(ctx: ToolCtxLike, signal: AbortSignal | undefined): EscalationUI {
	const opts = signal === undefined ? undefined : { signal };
	if (ctx.hasUI) {
		return { hasUI: true, select: (title, options) => ctx.ui.select(title, options, opts) };
	}
	const childSessionId = readChildSessionId(ctx);
	const channel = childSessionId === null ? null : getEscalationBroker().resolveChannel(childSessionId);
	if (channel === null) {
		return { hasUI: false, select: async () => undefined };
	}
	return {
		hasUI: true,
		select: (title, options) => getEscalationBroker().request(channel, title, options, signal),
	};
}

/**
 * 解析一次调用的生效模式（spec §4/§7）：
 * malformed 校验 → effective（/permission 覆盖 > config）→ 可选的已批准提权。
 */
export async function resolveCallMode(
	params: EscalationParams,
	ctx: ToolCtxLike,
	deps: SandboxToolDeps,
	subject: "command" | "operation",
	summary: () => string,
	signal?: AbortSignal,
): Promise<SandboxMode> {
	validateEscalationArgs(params.sandbox_permissions, params.justification);
	const config = configForCall(deps, ctx.cwd ?? deps.cwd);
	const effective = resolveEffectiveMode(deps.permission.override, config.mode);
	if (params.sandbox_permissions === undefined) return effective;
	return approveEscalation(
		{
			requestedMode: params.sandbox_permissions,
			justification: params.justification as string,
			effectiveMode: effective,
			subject,
			summary: summary().slice(0, 200),
		},
		approvalChannelFor(ctx, signal),
	);
}

/** Ruling 15：对象 spread 保留 base schema 的自有 options（如 editSchema 的 additionalProperties:false）。 */
function extendParams(base: TSchema): TSchema {
	const b = base as unknown as { properties: Record<string, unknown> };
	return { ...base, properties: { ...b.properties, ...ESCALATION_PROPS } } as TSchema;
}

function escalationDescription(base: string, subject: "command" | "operation"): string {
	return [
		base,
		"",
		"Sandbox: file effects are confined by the current permission mode (read-only | workspace-write | danger-full-access).",
		`Writes outside the permitted roots are denied. To retry, pass sandbox_permissions — ${sandboxPermissionsDescription(subject)}`,
		"Pass justification: a one-sentence reason shown verbatim in the user's approval prompt.",
	].join("\n");
}

const ESCALATION_GUIDELINE =
	"When a sandbox denial marker appears, you may retry the exact same call once with sandbox_permissions (the narrowest wider mode that suffices) plus justification; the user is asked to approve. If denied or unavailable, stop and explain instead of working around it.";

function stripEscalation(params: Record<string, unknown>) {
	const { sandbox_permissions: _sp, justification: _just, ...rest } = params;
	return rest;
}

/** fence 移到 ops 层（Ruling 14）：pi execute 用 resolveToCwd 解析后把 absolutePath 传给 ops，
 *  围栏检查的就是将被写入的同一字符串——与落盘构造性一致，杜绝 ~/、@/、file:// 解析分歧绕过。
 *  readFile/access 是读操作，不设围栏（所有模式读全放行）。 */
function createFencedWriteOps(policy: FencePolicy): WriteOperations {
	return {
		writeFile: async (path, content) => {
			assertWriteAllowed(path, policy);
			await fsWriteFile(path, content, "utf-8");
		},
		mkdir: async (dir) => {
			assertWriteAllowed(dir, policy);
			await fsMkdir(dir, { recursive: true });
		},
	};
}

function createFencedEditOps(policy: FencePolicy): EditOperations {
	return {
		readFile: (path) => fsReadFile(path),
		access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
		writeFile: async (path, content) => {
			assertWriteAllowed(path, policy);
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
		description: escalationDescription(baseBash.description, "command"),
		promptGuidelines: [...(baseBash.promptGuidelines ?? []), ESCALATION_GUIDELINE],
		parameters: extendParams(baseBash.parameters),
		async execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: ExtensionContext) {
			const sessionCwd = (ctx as { cwd?: string }).cwd ?? deps.cwd;
			const workspaceRoot = workspaceRootFor(sessionCwd);
			const config = configForCall(deps, sessionCwd);
			const mode = await resolveCallMode(params as EscalationParams, ctx, deps, "command", () => String(params.command ?? ""), signal);
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
				}),
			});
			return tool.execute(toolCallId, stripEscalation(params) as never, signal, onUpdate as never, ctx);
		},
	};

	const write = {
		...baseWrite,
		label: `${baseWrite.label} (sandboxed)`,
		description: escalationDescription(baseWrite.description, "operation"),
		promptGuidelines: [...(baseWrite.promptGuidelines ?? []), ESCALATION_GUIDELINE],
		parameters: extendParams(baseWrite.parameters),
		async execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: ExtensionContext) {
			const sessionCwd = (ctx as { cwd?: string }).cwd ?? deps.cwd;
			const workspaceRoot = workspaceRootFor(sessionCwd);
			const mode = await resolveCallMode(params as EscalationParams, ctx, deps, "operation", () => String(params.path ?? ""), signal);
			// fence 拒绝不捕获：FenceDenialError 从 ops 抛出、经 pi execute 原样上抛
			//（withFileMutationQueue 不吞错）——pi 的 agent 循环会转成 error result。
			const tool = createWriteToolDefinition(sessionCwd, { operations: createFencedWriteOps({ mode, workspaceRoot, _tmpRoots: deps._tmpRoots }) });
			return tool.execute(toolCallId, stripEscalation(params) as never, signal, onUpdate as never, ctx);
		},
	};

	const edit = {
		...baseEdit,
		label: `${baseEdit.label} (sandboxed)`,
		description: escalationDescription(baseEdit.description, "operation"),
		promptGuidelines: [...(baseEdit.promptGuidelines ?? []), ESCALATION_GUIDELINE],
		parameters: extendParams(baseEdit.parameters),
		async execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: ExtensionContext) {
			const sessionCwd = (ctx as { cwd?: string }).cwd ?? deps.cwd;
			const workspaceRoot = workspaceRootFor(sessionCwd);
			const mode = await resolveCallMode(params as EscalationParams, ctx, deps, "operation", () => String(params.path ?? ""), signal);
			const tool = createEditToolDefinition(sessionCwd, { operations: createFencedEditOps({ mode, workspaceRoot, _tmpRoots: deps._tmpRoots }) });
			return tool.execute(toolCallId, stripEscalation(params) as never, signal, onUpdate as never, ctx);
		},
	};

	return { bash, write, edit };
}
