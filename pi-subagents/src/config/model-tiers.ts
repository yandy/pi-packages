/**
 * model-tiers.ts — Capability/cost tier vocabulary for subagent model selection.
 *
 * A tier is a user-facing class of model (`fast` | `standard` | `advanced`).
 * Users map each tier to a real model in `subagents.json` (`modelTiers`); the
 * mapping is surfaced to the agent in the `subagent` tool's `model` parameter
 * description (a fact about that parameter's allowed values), plus one prompt
 * guideline telling it to pick the matching tier when a task warrants it.
 * There is no `model_tier` tool parameter. See README for tier semantics.
 */

export const MODEL_TIERS = ["fast", "standard", "advanced"] as const;

export type ModelTier = (typeof MODEL_TIERS)[number];

/** Partial tier → model mapping as configured in `subagents.json`. */
export type ModelTierMap = Partial<Record<ModelTier, string>>;

/** Case-insensitively map a complete input value to a canonical tier. */
export function normalizeModelTier(value: unknown): ModelTier | undefined {
	if (typeof value !== "string") return undefined;
	const lower = value.trim().toLowerCase();
	return (MODEL_TIERS as readonly string[]).includes(lower) ? (lower as ModelTier) : undefined;
}

/** Successful resolution — `model` is the configured model reference, not a Model instance. */
export interface ModelTierResolutionResult {
	model: string;
	error?: undefined;
}

/** Failed resolution: unknown tier name or no usable mapping configured for a known tier. */
export interface ModelTierResolutionError {
	model?: undefined;
	error: string;
}

export type ModelTierResolution = ModelTierResolutionResult | ModelTierResolutionError;

const SETTINGS_HINT = "Configure it in .pi/subagents.json or ~/.pi/agent/subagents.json";

/** Resolve a tier name to its configured real-model reference without resolving that reference. */
export function resolveModelTier(input: unknown, tiers: ModelTierMap | undefined): ModelTierResolution {
	const tier = normalizeModelTier(input);
	if (!tier) {
		return {
			error: `Unknown model tier: "${String(input)}". Valid tiers: ${MODEL_TIERS.join(", ")}.`,
		};
	}

	const configured = tiers?.[tier];
	const model = typeof configured === "string" ? configured.trim() : "";
	if (!model) {
		return {
			error: `Model tier "${tier}" is not configured. ${SETTINGS_HINT}, e.g. {"modelTiers": {"${tier}": "provider/modelId"}}.`,
		};
	}

	return { model };
}

/** LLM-facing intent of each tier — mirrors the README table. */
export const MODEL_TIER_INTENTS: Record<ModelTier, string> = {
	fast: "cheapest, fastest, least capable",
	standard: "balanced default",
	advanced: "most capable, most expensive",
};
