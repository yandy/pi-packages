import type { ThinkingLevel } from "@earendil-works/pi-ai";

export type VisionReasoning = "off" | ThinkingLevel;

export interface ReasoningOptions {
	reasoningEffort?: ThinkingLevel;
}

export function reasoningToOptions(level: VisionReasoning | undefined): ReasoningOptions {
	if (!level || level === "off") return {};
	return { reasoningEffort: level };
}
