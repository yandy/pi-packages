/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-base-to-string, @typescript-eslint/restrict-template-expressions -- Pi SDK types are not fully exported; see upstream Pi SDK for type improvements */
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { AgentTypeRegistry } from "../config/agent-types";
import { MODEL_TIERS, MODEL_TIER_INTENTS, type ModelTierMap } from "../config/model-tiers";
import type { ParentSnapshot } from "../lifecycle/parent-snapshot";
import type { AgentSpawnConfig } from "../lifecycle/subagent-manager";
import { spawnBackground } from "../tools/background-spawner";
import { runForeground } from "../tools/foreground-runner";
import { buildDetails, buildTypeListText, textResult } from "../tools/helpers";
import { renderAgentResult } from "../tools/result-renderer";
import { type ModelInfo, resolveSpawnConfig } from "../tools/spawn-config";
import type { ParentSessionInfo, Subagent } from "../types";
import { type AgentDetails, getDisplayName } from "../ui/display";

// ---- Deps interfaces ----

/** Narrow manager interface — only the methods the Agent tool calls. */
export interface AgentToolManager {
	spawn: (snapshot: ParentSnapshot, type: string, prompt: string, opts: AgentSpawnConfig) => string;
	spawnAndWait: (
		snapshot: ParentSnapshot,
		type: string,
		prompt: string,
		opts: Omit<AgentSpawnConfig, "isBackground">,
	) => Promise<Subagent>;
	resume: (id: string, prompt: string, signal: AbortSignal) => Promise<Subagent | undefined>;
	getRecord: (id: string) => Subagent | undefined;
}

/** Narrow runtime interface — the Agent tool's slice of SubagentRuntime. */
export interface AgentToolRuntime {
	buildSnapshot(inheritContext: boolean): ParentSnapshot;
	getModelInfo(): ModelInfo;
	getSessionInfo(): { parentSessionFile: string; parentSessionId: string };
}

/** Narrow settings accessor — only the fields the Agent tool reads. */
export type AgentToolSettings = {
	readonly defaultMaxTurns: number | undefined;
	readonly defaultTimeoutSeconds: number | undefined;
	readonly maxConcurrent: number;
	readonly modelTiers?: ModelTierMap;
};

/** LLM-facing guidance to map a capability tier to the model to pass via the `model` parameter, or undefined when none configured. */
function buildTierGuideline(tiers: ModelTierMap | undefined): string | undefined {
	const configured = MODEL_TIERS.filter((tier) => tiers?.[tier]).map(
		(tier) => `${tier} → ${tiers?.[tier]} (${MODEL_TIER_INTENTS[tier]})`,
	);
	if (configured.length === 0) return undefined;
	return `User-configured subagent model tiers — when a task needs one of these capability levels, pass the mapped model via the model parameter: ${configured.join(", ")}.`;
}

/**
 * 行为纪律（进 system prompt 的 Guidelines，不进 description）。
 *
 * 之前这些写在 `description` 里，同时与参数描述重复（`run_in_background` / `resume` / `model` /
 * `thinking` / `timeout` / `inherit_context` 各说两遍，共 516 字符），而 description 是每工具
 * 各一份、不参与去重。现在只留“何时用 / 怎么配合”这一类，参数细节全交给参数描述。
 */
const PROMPT_GUIDELINES: readonly string[] = [
	"Use subagent for work that needs its own context or a different model; finish inline work yourself.",
	"For parallel work set run_in_background: true on each agent — sibling foreground calls run concurrently anyway, but they block the current turn and bypass the concurrency limit.",
	"Give each subagent a self-contained prompt; it cannot see the parent conversation unless inherit_context is true.",
	"Subagent results come back as text — summarize them for the user.",
	"Use steer_subagent to redirect a running background agent, and get_subagent_result with wait: true to block for one result.",
];

// ---- Class ----

export class AgentTool {
	private readonly typeListText: string;
	private readonly availableTypesText: string;

	constructor(
		private readonly manager: AgentToolManager,
		private readonly runtime: AgentToolRuntime,
		private readonly settings: AgentToolSettings,
		private readonly registry: AgentTypeRegistry,
		private readonly agentDir: string,
	) {
		this.typeListText = buildTypeListText(registry, agentDir);
		this.availableTypesText = registry.getAvailableTypes().join(", ");
	}

	async execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: ((update: AgentToolResult<any>) => void) | undefined,
		_ctx: any,
	) {
		// Reload custom agents so new .pi/agents/*.md files are picked up without restart
		this.registry.reload();

		// ---- Config resolution (pure) ----
		const config = resolveSpawnConfig(params, this.registry, this.runtime.getModelInfo(), this.settings);
		if ("error" in config) return textResult(config.error);

		// ---- Boundary extraction (after config so inheritContext is resolved) ----
		const snapshot = this.runtime.buildSnapshot(config.execution.inheritContext);
		const { parentSessionFile, parentSessionId } = this.runtime.getSessionInfo();
		const parentSession: ParentSessionInfo = { parentSessionFile, parentSessionId, toolCallId };

		// ---- Resume existing agent ----
		if (params.resume) {
			const existing = this.manager.getRecord(params.resume as string);
			if (!existing) {
				return textResult(`Agent not found: "${params.resume}". It may have been cleaned up.`);
			}
			if (!existing.isSessionReady()) {
				return textResult(`Agent "${params.resume}" has no active session to resume.`);
			}
			const record = await this.manager.resume(
				params.resume as string,
				params.prompt as string,
				signal ?? new AbortController().signal,
			);
			if (!record) {
				return textResult(`Failed to resume agent "${params.resume}".`);
			}
			return textResult(
				record.result?.trim() ?? record.error?.trim() ?? "No output.",
				buildDetails(config.presentation.detailBase, record),
			);
		}

		// ---- Background execution ----
		if (config.execution.runInBackground) {
			return spawnBackground(this.manager, { config, snapshot, parentSession, settings: this.settings });
		}

		// ---- Foreground execution — stream progress via onUpdate ----
		return runForeground(this.manager, { config, snapshot, parentSession }, signal, onUpdate);
	}

	toToolDefinition() {
		const typeListText = this.typeListText;
		const availableTypesText = this.availableTypesText;
		const tierGuideline = buildTierGuideline(this.settings.modelTiers);
		const registry = this.registry;

		return defineTool({
			name: "subagent" as const,
			label: "Subagent",
			promptSnippet: "Launch a specialized agent for complex, multi-step tasks",
			promptGuidelines: tierGuideline ? [...PROMPT_GUIDELINES, tierGuideline] : [...PROMPT_GUIDELINES],
			description: `Launch a subagent that works autonomously on a task.

Available agent types:
${typeListText}`,
			parameters: Type.Object({
				prompt: Type.String({
					description: "The task for the agent to perform.",
				}),
				description: Type.String({
					description: "A short (3-5 word) description of the task (shown in UI).",
				}),
				subagent_type: Type.String({
					description: `The type of specialized agent to use. Available types: ${availableTypesText}.`,
				}),
				model: Type.Optional(
					Type.String({
						description:
							'Optional model override. Accepts "provider/modelId" or fuzzy name (e.g. "haiku", "sonnet"). Omit to use the agent type\'s default.',
					}),
				),
				thinking: Type.Optional(
					StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, {
						description: "Thinking level override. Default: inherit the agent type's setting.",
					}),
				),
				max_turns: Type.Optional(
					Type.Number({
						description: "Maximum number of agentic turns before stopping. Omit for unlimited (default).",
						minimum: 1,
					}),
				),
				timeout: Type.Optional(
					Type.Number({
						description:
							"Hard wall-clock limit in seconds. When exceeded, the agent is terminated immediately and only partial output is returned. Use as a safety net for tasks that could run away (long builds, hanging commands); omit for unlimited.",
						minimum: 1,
					}),
				),
				run_in_background: Type.Optional(
					Type.Boolean({
						description:
							"Set to true to run in background. Returns agent ID immediately. You will be notified when it completes.",
					}),
				),
				resume: Type.Optional(
					Type.String({
						description: "Optional agent ID to resume from. Continues from previous context.",
					}),
				),
				inherit_context: Type.Optional(
					Type.Boolean({
						description: "If true, fork parent conversation into the agent. Default: false (fresh context).",
					}),
				),
			}),

			// ---- Custom rendering: inline subagent results ----

			renderCall(args: Record<string, unknown>, theme: any) {
				const displayName = args.subagent_type ? getDisplayName(args.subagent_type as string, registry) : "Subagent";
				const desc = (args.description as string | undefined) ?? "";
				return new Text(
					`▸ ${theme.fg("toolTitle", theme.bold(displayName))}${desc ? `  ${theme.fg("muted", desc)}` : ""}`,
					0,
					0,
				);
			},

			renderResult(result: any, { expanded, isPartial }: any, theme: any) {
				const details = result.details as AgentDetails | undefined;
				if (!details) {
					const text = result.content[0]?.type === "text" ? result.content[0].text : "";
					return new Text(text, 0, 0);
				}
				const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
				return new Text(renderAgentResult(details, resultText, expanded, isPartial, theme), 0, 0);
			},

			execute: (
				toolCallId: string,
				params: Record<string, unknown>,
				signal: AbortSignal | undefined,
				onUpdate: ((update: AgentToolResult<any>) => void) | undefined,
				ctx: any,
			) => this.execute(toolCallId, params, signal, onUpdate, ctx),
		});
	}
}
