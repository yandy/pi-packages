import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-ai";

type VisionEnabledState = "auto" | "on" | "off";

export interface VisionConfig {
	provider?: string;
	model?: string;
	enabled: VisionEnabledState;
	defaultReasoning?: ThinkingLevel | "off";
}

export const DEFAULT_CONFIG: VisionConfig = { enabled: "auto" };

const ENABLED_STATES = ["auto", "on", "off"] as const;
const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export function configPath(agentDir: string): string {
	return join(agentDir, "vision-tools.json");
}

export function parseConfig(raw: unknown): VisionConfig {
	if (raw == null || typeof raw !== "object") return { ...DEFAULT_CONFIG };
	const obj = raw as Record<string, unknown>;

	const cfg: VisionConfig = { enabled: "auto" };

	if (obj.provider !== undefined) {
		if (typeof obj.provider !== "string" || obj.provider.length === 0) {
			throw new Error("vision-tools config: provider must be a non-empty string");
		}
		cfg.provider = obj.provider;
	}

	if (obj.model !== undefined) {
		if (typeof obj.model !== "string" || obj.model.length === 0) {
			throw new Error("vision-tools config: model must be a non-empty string");
		}
		cfg.model = obj.model;
	}

	if (obj.enabled !== undefined) {
		if (typeof obj.enabled !== "string" || !ENABLED_STATES.includes(obj.enabled as VisionEnabledState)) {
			throw new Error(`vision-tools config: enabled must be one of ${ENABLED_STATES.join(", ")}`);
		}
		cfg.enabled = obj.enabled as VisionEnabledState;
	}

	if (obj.defaultReasoning !== undefined) {
		if (
			typeof obj.defaultReasoning !== "string" ||
			!REASONING_LEVELS.includes(obj.defaultReasoning as (typeof REASONING_LEVELS)[number])
		) {
			throw new Error(`vision-tools config: defaultReasoning must be one of ${REASONING_LEVELS.join(", ")}`);
		}
		cfg.defaultReasoning = obj.defaultReasoning as ThinkingLevel | "off";
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
