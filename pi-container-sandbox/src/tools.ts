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
import type { SandboxConfig } from "./config";
import { approveEscalation, sandboxPermissionsDescription, validateEscalationArgs } from "./escalation";
import { assertWriteAllowed, type FencePolicy } from "./fence";
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
			const mode = await resolveCallMode(params as EscalationParams, ctx, deps, "command", () => String(params.command ?? ""));
			const config = deps.getConfig();
			const selected = mode === "danger-full-access"
				? undefined
				: (deps.selected ?? selectRunner(config.probeTimeoutMs, deps.hooks));
			const tool = createBashToolDefinition(deps.cwd, {
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
			const mode = await resolveCallMode(params as EscalationParams, ctx, deps, "operation", () => String(params.path ?? ""));
			// fence 拒绝不捕获：FenceDenialError 从 ops 抛出、经 pi execute 原样上抛
			//（withFileMutationQueue 不吞错）——pi 的 agent 循环会转成 error result。
			const tool = createWriteToolDefinition(deps.cwd, { operations: createFencedWriteOps({ mode, workspaceRoot: deps.workspaceRoot }) });
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
			const mode = await resolveCallMode(params as EscalationParams, ctx, deps, "operation", () => String(params.path ?? ""));
			const tool = createEditToolDefinition(deps.cwd, { operations: createFencedEditOps({ mode, workspaceRoot: deps.workspaceRoot }) });
			return tool.execute(toolCallId, stripEscalation(params) as never, signal, onUpdate as never, ctx);
		},
	};

	return { bash, write, edit };
}
