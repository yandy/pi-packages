/**
 * model-tiers.ts — Capability/cost tiers for the subagent tool's `model_tier` param.
 *
 * A tier is an indirection: the calling agent asks for a class of model
 * (`fast` | `standard` | `advanced`) and the user decides which real model each
 * class maps to in `subagents.json` (`modelTiers`). See README for the intended
 * semantics of each tier.
 */

export const MODEL_TIERS = ["fast", "standard", "advanced"] as const;

export type ModelTier = (typeof MODEL_TIERS)[number];

/** Partial tier → model mapping as configured in `subagents.json`. */
export type ModelTierMap = Partial<Record<ModelTier, string>>;

/**
 * Case-insensitively map a raw value to a canonical tier.
 * Returns undefined for unknown names and non-strings.
 */
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

/** Failed resolution: unknown tier name or no mapping configured for a known tier. */
export interface ModelTierResolutionError {
	model?: undefined;
	error: string;
}

export type ModelTierResolution = ModelTierResolutionResult | ModelTierResolutionError;

/** Where users configure the tier map — repeated in error messages. */
const SETTINGS_HINT = "Configure it in .pi/subagents.json or ~/.pi/agent/subagents.json";

/**
 * Resolve a `model_tier` param value to the model reference configured for it.
 * An unknown tier or an unconfigured mapping is an explicit error — a tier
 * request is never silently downgraded to another model.
 */
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
