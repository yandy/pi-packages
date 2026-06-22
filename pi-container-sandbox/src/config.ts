import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
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

function readJsonFile(path: string): Record<string, unknown> | null {
	try {
		const raw = readFileSync(path, "utf-8");
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return null;
	}
}

export function getSbxConfigPath(hostCwd: string): string {
	return resolvePath(hostCwd, CONFIG_DIR_NAME, "sandbox.json");
}

export function loadSbxConfig(hostCwd: string): SbxConfig {
	const agentDir = getAgentDir();
	const globalConfig = readJsonFile(resolvePath(agentDir, "sandbox.json")) || {};
	const projectConfig =
		readJsonFile(getSbxConfigPath(hostCwd)) || {};
	return {
		...DEFAULT_SBX_CONFIG,
		...globalConfig,
		...projectConfig,
	} as SbxConfig;
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
