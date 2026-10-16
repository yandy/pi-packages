import type { AgentConfig, ThinkingLevel } from "../types";

interface AgentInvocationParams {
	model?: string;
	model_tier?: string;
	thinking?: string;
	max_turns?: number;
	run_in_background?: boolean;
	inherit_context?: boolean;
}

export function resolveAgentInvocationConfig(
	agentConfig: AgentConfig | undefined,
	params: AgentInvocationParams,
	/**
	 * Model reference already resolved from `params.model_tier` by the caller
	 * (spawn-config resolves the tier so it can surface config errors). Precedence
	 * matches `params.model`: agent config wins, then params, then the tier.
	 */
	tierModel?: string,
): {
	modelInput?: string;
	modelFromParams: boolean;
	thinking?: ThinkingLevel;
	maxTurns?: number;
	inheritContext: boolean;
	runInBackground: boolean;
} {
	return {
		modelInput: agentConfig?.model ?? params.model ?? tierModel,
		modelFromParams: agentConfig?.model == null && (params.model ?? tierModel) != null,
		thinking: (agentConfig?.thinking ?? params.thinking) as ThinkingLevel | undefined,
		maxTurns: agentConfig?.maxTurns ?? params.max_turns,
		inheritContext: agentConfig?.inheritContext ?? params.inherit_context ?? false,
		runInBackground: agentConfig?.runInBackground ?? params.run_in_background ?? false,
	};
}
