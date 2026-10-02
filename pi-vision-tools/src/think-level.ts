import type { ThinkingLevel } from "@earendil-works/pi-ai";

export type VisionThinkLevel = "off" | ThinkingLevel;

export interface ThinkLevelOptions {
	reasoningEffort?: ThinkingLevel;
}

export function thinkLevelToOptions(level: VisionThinkLevel | undefined): ThinkLevelOptions {
	if (!level || level === "off") return {};
	return { reasoningEffort: level };
}

/**
 * Resolve the effective think level: explicit param wins, else config default, else "off".
 */
export function effectiveThinkLevel(
	param: VisionThinkLevel | undefined,
	configDefault: VisionThinkLevel | undefined,
): VisionThinkLevel {
	return param ?? configDefault ?? "off";
}
