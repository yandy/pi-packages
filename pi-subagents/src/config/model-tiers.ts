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

/** LLM-facing intent of each tier — mirrors the README table. */
export const MODEL_TIER_INTENTS: Record<ModelTier, string> = {
	fast: "cheapest, fastest, least capable",
	standard: "balanced default",
	advanced: "most capable, most expensive",
};
