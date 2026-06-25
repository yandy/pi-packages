import type { ThinkingLevel } from "@earendil-works/pi-ai";

export type VisionReasoning = "off" | ThinkingLevel;

export interface ReasoningOptions {
	reasoningEffort?: ThinkingLevel;
}

export function reasoningToOptions(level: VisionReasoning | undefined): ReasoningOptions {
	if (!level || level === "off") return {};
	return { reasoningEffort: level };
}

/**
 * Resolve the effective reasoning level: explicit param wins, else config default, else "off".
 */
export function effectiveReasoning(
	param: VisionReasoning | undefined,
	configDefault: VisionReasoning | undefined,
): VisionReasoning {
	return param ?? configDefault ?? "off";
}
