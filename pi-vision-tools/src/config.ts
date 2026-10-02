import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-ai";

export interface VisionConfig {
	/** "provider/modelId" or a fuzzy model name (e.g. "haiku", "qwen vl"). */
	model?: string;
	defaultThinkLevel?: ThinkingLevel | "off";
}

export const DEFAULT_CONFIG: VisionConfig = {};

export const THINK_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export function configPath(agentDir: string): string {
	return join(agentDir, "vision-tools.json");
}

export function parseConfig(raw: unknown): VisionConfig {
	if (raw == null || typeof raw !== "object") return { ...DEFAULT_CONFIG };
	const obj = raw as Record<string, unknown>;

	const cfg: VisionConfig = {};

	if (obj.model !== undefined) {
		if (typeof obj.model !== "string" || obj.model.length === 0) {
			throw new Error("vision-tools config: model must be a non-empty string");
		}
		cfg.model = obj.model;
	}

	if (obj.defaultThinkLevel !== undefined) {
		if (
			typeof obj.defaultThinkLevel !== "string" ||
			!THINK_LEVELS.includes(obj.defaultThinkLevel as (typeof THINK_LEVELS)[number])
		) {
			throw new Error(`vision-tools config: defaultThinkLevel must be one of ${THINK_LEVELS.join(", ")}`);
		}
		cfg.defaultThinkLevel = obj.defaultThinkLevel as ThinkingLevel | "off";
	}

	return cfg;
}

export async function loadConfig(agentDir: string): Promise<VisionConfig> {
	try {
		const text = await readFile(configPath(agentDir), "utf8");
		return parseConfig(JSON.parse(text));
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

export async function saveConfig(agentDir: string, config: VisionConfig): Promise<void> {
	await mkdir(agentDir, { recursive: true });
	const text = JSON.stringify(config);
	const target = configPath(agentDir);
	const tmp = `${target}.tmp`;
	await writeFile(tmp, text, "utf8");
	await rename(tmp, target);
}
