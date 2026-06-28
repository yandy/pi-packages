/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- Pi SDK types are not fully exported; see upstream Pi SDK for type improvements */
/**
 * spawn-config.ts — Pure config resolution for the Agent tool.
 *
 * Extracts all config resolution logic from execute: type resolution,
 * invocation config merge, model resolution, max-turns normalization,
 * tag building, and detail-base construction.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { AgentTypeRegistry } from "../config/agent-types";
import { resolveAgentInvocationConfig } from "../config/invocation-config";
import { normalizeMaxTurns } from "../lifecycle/turn-limits";
import { resolveInvocationModel } from "../session/model-resolver";
import type { AgentInvocation, SubagentType, ThinkingLevel } from "../types";
import { type AgentDetails, buildInvocationTags, getDisplayName, getPromptModeLabel } from "../ui/display";

/** Derive a short display model name from a model object (or undefined). */
export function resolveModelName(model: { id?: string; name?: string } | undefined): string | undefined {
	if (!model) return undefined;
	const raw = model.name ?? model.id;
	if (!raw) return undefined;
	return raw.replace(/^Claude\s+/i, "").toLowerCase();
}

/** Model info extracted from the parent session context. */
export interface ModelInfo {
	parentModel: { id: string; name?: string } | undefined;
	modelRegistry: unknown;
}

/** Identity: who is being spawned. */
export interface SpawnIdentity {
	subagentType: string;
	rawType: SubagentType;
	fellBack: boolean;
	displayName: string;
}

/** Execution: how the agent will run. */
export interface SpawnExecution {
	prompt: string;
	description: string;
	model: Model<any> | undefined;
	effectiveMaxTurns: number | undefined;
	thinking: ThinkingLevel | undefined;
	inheritContext: boolean;
	runInBackground: boolean;
	agentInvocation: AgentInvocation;
}

/** Presentation: display/UI values derived from identity and execution. */
export interface SpawnPresentation {
	modelName: string | undefined;
	agentTags: string[];
	detailBase: Pick<AgentDetails, "displayName" | "description" | "subagentType" | "modelName" | "tags">;
}

/** Fully resolved config for spawning an agent — composed of domain-aligned sub-interfaces. */
export interface ResolvedSpawnConfig {
	identity: SpawnIdentity;
	execution: SpawnExecution;
	presentation: SpawnPresentation;
}

/** Error result when model resolution fails. */
export interface SpawnConfigError {
	error: string;
}

/**
 * Resolve all config for an Agent tool invocation.
 *
 * Pure function — no SDK types, no side effects.
 * Returns either a fully resolved config or an error.
 */
export function resolveSpawnConfig(
	params: Record<string, unknown>,
	registry: AgentTypeRegistry,
	modelInfo: ModelInfo,
	settings: { readonly defaultMaxTurns: number | undefined },
): ResolvedSpawnConfig | SpawnConfigError {
	const rawType = params.subagent_type as SubagentType;
	const resolved = registry.resolveType(rawType);

	// A known-but-disabled type is an explicit error, not a silent unknown-type fallback.
	if (resolved !== undefined && !registry.isValidType(resolved)) {
		return { error: `Agent type "${resolved}" is disabled` };
	}

	const subagentType = resolved ?? "general-purpose";
	const fellBack = resolved === undefined;

	const displayName = getDisplayName(subagentType, registry);

	// Merge agent config defaults with tool-call params
	const customConfig = registry.resolveAgentConfig(subagentType);
	const resolvedConfig = resolveAgentInvocationConfig(customConfig, params);

	// Resolve model
	const resolution = resolveInvocationModel(
		modelInfo.parentModel,
		resolvedConfig.modelInput,
		resolvedConfig.modelFromParams,
		modelInfo.modelRegistry as any,
	);
	if (resolution.error) return { error: resolution.error };
	const model = resolution.model;

	const thinking = resolvedConfig.thinking;
	const inheritContext = resolvedConfig.inheritContext;
	const runInBackground = resolvedConfig.runInBackground;

	// Compute display model name — always shown, even when same as parent.
	const modelName = resolveModelName(model ?? modelInfo.parentModel);

	const effectiveMaxTurns = normalizeMaxTurns(resolvedConfig.maxTurns ?? settings.defaultMaxTurns);

	const agentInvocation: AgentInvocation = {
		modelName,
		thinking,
		maxTurns: normalizeMaxTurns(resolvedConfig.maxTurns),
		inheritContext,
		runInBackground,
	};

	const modeLabel = getPromptModeLabel(subagentType, registry);
	const { tags: invocationTags } = buildInvocationTags(agentInvocation);
	const agentTags = modeLabel ? [modeLabel, ...invocationTags] : invocationTags;

	const detailBase = {
		displayName,
		description: params.description as string,
		subagentType,
		modelName,
		tags: agentTags.length > 0 ? agentTags : undefined,
	};

	return {
		identity: { subagentType, rawType, fellBack, displayName },
		execution: {
			prompt: params.prompt as string,
			description: params.description as string,
			model,
			effectiveMaxTurns,
			thinking,
			inheritContext,
			runInBackground,
			agentInvocation,
		},
		presentation: { modelName, agentTags, detailBase },
	};
}
