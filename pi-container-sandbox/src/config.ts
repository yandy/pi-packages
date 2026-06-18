import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
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
	hostCommands?: string[];
}

export const DEFAULT_SBX_CONFIG: SbxConfig = {
	image: "pi-container-sandbox",
	tag: "latest",
	containerName: null,
	tier: "medium",
	persist: false,
	cacheVolume: null,
};

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_DOCKER_DIR = resolvePath(__dirname, "..", "docker");

export function getSbxConfigPath(hostCwd: string): string {
	return resolvePath(hostCwd, ".pi", "agent", "sandbox.json");
}

export function loadSbxConfig(hostCwd: string): SbxConfig {
	const configPath = getSbxConfigPath(hostCwd);
	if (!existsSync(configPath)) {
		return { ...DEFAULT_SBX_CONFIG };
	}
	try {
		const raw = JSON.parse(readFileSync(configPath, "utf-8"));
		return {
			...DEFAULT_SBX_CONFIG,
			...raw,
		} as SbxConfig;
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

export function discoverDockerfiles(): string[] {
	if (!existsSync(PACKAGE_DOCKER_DIR)) return [];
	return readdirSync(PACKAGE_DOCKER_DIR)
		.filter((f) => f.endsWith(".Dockerfile"))
		.map((f) => basename(f, extname(f)));
}
