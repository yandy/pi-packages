import { resolve as resolvePath } from "node:path";
import { Type } from "typebox";
import { createBashTool, createEditTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { createSandboxBashOps, type SpawnFn } from "./bash-ops";
import type { SandboxConfig } from "./config-v2";
import { approveEscalation, sandboxPermissionsDescription, validateEscalationArgs } from "./escalation";
import { assertWriteAllowed } from "./fence";
import type { PermissionState } from "./permission";
import { resolveEffectiveMode, type SandboxMode } from "./policy";
import { selectRunner, type RunnerHooks } from "./runners";

export interface SandboxToolDeps {
	cwd: string;
	workspaceRoot: string;
	getConfig(): SandboxConfig;
	permission: PermissionState;
	hooks?: RunnerHooks;
	spawnFn?: SpawnFn;
	/** 测试注入的预解析 runner；生产缺省走 selectRunner 缓存。 */
	selected?: ReturnType<typeof selectRunner>;
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
	ui: { select(title: string, options: string[]): Promise<string | undefined> };
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
): Promise<SandboxMode> {
	validateEscalationArgs(params.sandbox_permissions, params.justification);
	const effective = resolveEffectiveMode(deps.permission.override, deps.getConfig().mode);
	if (params.sandbox_permissions === undefined) return effective;
	return approveEscalation(
		{
			requestedMode: params.sandbox_permissions,
			justification: params.justification as string,
			effectiveMode: effective,
			subject,
			summary: summary().slice(0, 200),
		},
		{ hasUI: ctx.hasUI, select: (title, options) => ctx.ui.select(title, options) },
	);
}

function extendParams(base: { properties: Record<string, unknown> }) {
	return Type.Object({ ...base.properties, ...ESCALATION_PROPS });
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

/**
 * pi 的 AgentTool 类型声明中 execute 只收 4 参且无 promptGuidelines 字段；
 * 运行时第 5 参 ctx 会透传、字段也可能存在。仅做类型收敛
 *（controller 事实 5：as never 收敛一次，不得放宽运行时校验）。
 */
interface LooseTool {
	promptGuidelines?: string[];
	execute(toolCallId: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown): unknown;
}

function loose(tool: unknown): LooseTool {
	return tool as LooseTool;
}

export function createSandboxTools(deps: SandboxToolDeps) {
	const baseBash = createBashTool(deps.cwd);
	const baseWrite = createWriteTool(deps.cwd);
	const baseEdit = createEditTool(deps.cwd);

	const bash = {
		...baseBash,
		label: `${baseBash.label} (sandboxed)`,
		description: escalationDescription(baseBash.description, "command"),
		promptGuidelines: [...(loose(baseBash).promptGuidelines ?? []), ESCALATION_GUIDELINE],
		parameters: extendParams(baseBash.parameters as { properties: Record<string, unknown> }),
		async execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: ToolCtxLike & Record<string, unknown>) {
			const mode = await resolveCallMode(params as EscalationParams, ctx, deps, "command", () => String(params.command ?? ""));
			const config = deps.getConfig();
			const selected = mode === "danger-full-access"
				? undefined
				: (deps.selected ?? selectRunner(config.probeTimeoutMs, deps.hooks));
			const tool = createBashTool(deps.cwd, {
				operations: createSandboxBashOps({
					mode,
					workspaceRoot: deps.workspaceRoot,
					selected,
					runnerCommand: config.runnerCommand,
					runnerFailureSignatures: config.runnerFailureSignatures,
					probeTimeoutMs: config.probeTimeoutMs,
					hooks: deps.hooks,
					spawnFn: deps.spawnFn,
				}),
			});
			return loose(tool).execute(toolCallId, stripEscalation(params), signal, onUpdate, ctx);
		},
	};

	function fencedFileTool(base: typeof baseWrite | typeof baseEdit) {
		return {
			...base,
			label: `${base.label} (sandboxed)`,
			description: escalationDescription(base.description, "operation"),
			promptGuidelines: [...(loose(base).promptGuidelines ?? []), ESCALATION_GUIDELINE],
			parameters: extendParams(base.parameters as { properties: Record<string, unknown> }),
			async execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: ToolCtxLike & Record<string, unknown>) {
				const mode = await resolveCallMode(params as EscalationParams, ctx, deps, "operation", () => String(params.path ?? ""));
				const abs = resolvePath(deps.cwd, String(params.path ?? ""));
				// fence 拒绝不捕获：直接 throw 上抛，pi 的 agent 循环会转成 error result
				// （err.message 携带双行标记）——与 pi 自带 write 工具失败即 throw 的行为一致
				//（dist/core/tools/write.js 已核实），也与 1.x guardExternalRead 同路径。
				// Ruling 8 前提：abs 只用于 fence 检查；委托 base 时传原始 params，base 内部
				// resolveToCwd(path, cwd) 以同一 cwd 做同样解析——检查与落点同一字符串。
				assertWriteAllowed(abs, { mode, workspaceRoot: deps.workspaceRoot });
				return loose(base).execute(toolCallId, stripEscalation(params), signal, onUpdate, ctx);
			},
		};
	}

	return {
		bash,
		write: fencedFileTool(baseWrite),
		edit: fencedFileTool(baseEdit),
	};
}
