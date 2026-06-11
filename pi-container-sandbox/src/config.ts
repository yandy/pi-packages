import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { SizeTier } from "./tiers";

export interface SbxConfig {
	image: string;
	tag: string;
	containerName: string | null;
	tier: SizeTier;
	persist: boolean;
	cacheVolume: string | null;
	dockerfile?: string;
	buildContext?: string;
	buildArgs?: Record<string, string>;
}

export const DEFAULT_SBX_CONFIG: SbxConfig = {
	image: "pi-container-sandbox",
	tag: "latest",
	containerName: null,
	tier: "medium",
	persist: false,
	cacheVolume: null,
};

export function getSbxConfigPath(hostCwd: string): string {
	return resolvePath(hostCwd, ".pi", "agent", "sandbox.json");
}

export function loadSbxConfig(hostCwd: string): SbxConfig {
	const configPath = getSbxConfigPath(hostCwd);
	if (!existsSync(configPath)) {
		return { ...DEFAULT_SBX_CONFIG };
	}
	try {
		const raw = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw);
		return {
			image: parsed.image ?? DEFAULT_SBX_CONFIG.image,
			tag: parsed.tag ?? DEFAULT_SBX_CONFIG.tag,
			containerName: parsed.containerName ?? DEFAULT_SBX_CONFIG.containerName,
			tier: parsed.tier ?? DEFAULT_SBX_CONFIG.tier,
			persist: parsed.persist ?? DEFAULT_SBX_CONFIG.persist,
			cacheVolume: parsed.cacheVolume ?? DEFAULT_SBX_CONFIG.cacheVolume,
			dockerfile: parsed.dockerfile,
			buildContext: parsed.buildContext,
			buildArgs: parsed.buildArgs,
		};
	} catch {
		return { ...DEFAULT_SBX_CONFIG };
	}
}

export function saveSbxConfig(hostCwd: string, config: SbxConfig): void {
	const configPath = getSbxConfigPath(hostCwd);
	const dir = resolvePath(configPath, "..");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const tmpPath = configPath + ".tmp";
	writeFileSync(tmpPath, JSON.stringify(config, null, 2));
	renameSync(tmpPath, configPath);
}

export function imageRefForTag(image: string, tag: string): string {
	return `${image}:${tag}`;
}
