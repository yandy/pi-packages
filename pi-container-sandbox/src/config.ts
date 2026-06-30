import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { expandPath } from "./paths";
import type { SizeTier } from "./tiers";

export interface MountConfig {
	source: string;
	target: string;
	mode?: 'ro' | 'rw';
}

export interface ImageConfig {
	name: string;
	tag: string;
}

export interface RuntimeConfig {
	name: string | null;
	tier: SizeTier;
	network: boolean;
	persist: boolean;
	memory: string | null;
	cpus: string | null;
	swap: string | null;
	pidsLimit: number | null;
	cache: string | null;
	mounts: MountConfig[];
	env?: string[];
}

export interface HostConfig {
	commands: string[];
}

export interface SbxConfig {
	image: ImageConfig;
	runtime: RuntimeConfig;
	host: HostConfig;
}

export const DEFAULT_SBX_CONFIG: SbxConfig = {
	image: { name: "pi-container-sandbox", tag: "latest" },
	runtime: {
		name: null, tier: "medium", network: true, persist: false,
		memory: null, cpus: null, swap: null, pidsLimit: null,
		cache: null, mounts: [], env: [],
	},
	host: { commands: [] },
};

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_DOCKER_DIR = resolvePath(__dirname, "..", "docker");

function readJsonFile(path: string): Record<string, unknown> | null {
	try {
		const raw = readFileSync(path, "utf-8");
		return JSON.parse(raw) as Record<string, unknown>;
	} catch { return null; }
}

function mergeGroup<G>(a: G, b: Partial<G>): G {
	const result = { ...a } as G;
	for (const key of Object.keys(b as object)) {
		const k = key as keyof G;
		if (b[k] !== undefined) result[k] = b[k] as G[keyof G];
	}
	return result;
}

function extractGroup(raw: Record<string, unknown>, group: string): Record<string, unknown> {
	const g = raw[group];
	return (g && typeof g === "object" && !Array.isArray(g) ? g : {}) as Record<string, unknown>;
}

export function loadSbxConfig(hostCwd: string): SbxConfig {
	const agentDir = getAgentDir();
	const globalRaw = readJsonFile(resolvePath(agentDir, "sandbox.json")) || {};
	const projectRaw = readJsonFile(getSbxConfigPath(hostCwd)) || {};

	const config: SbxConfig = {
		image: mergeGroup(
			mergeGroup(DEFAULT_SBX_CONFIG.image, extractGroup(globalRaw, "image") as Partial<ImageConfig>),
			extractGroup(projectRaw, "image") as Partial<ImageConfig>,
		),
		runtime: mergeGroup(
			mergeGroup(DEFAULT_SBX_CONFIG.runtime, extractGroup(globalRaw, "runtime") as Partial<RuntimeConfig>),
			extractGroup(projectRaw, "runtime") as Partial<RuntimeConfig>,
		),
		host: mergeGroup(
			mergeGroup(DEFAULT_SBX_CONFIG.host, extractGroup(globalRaw, "host") as Partial<HostConfig>),
			extractGroup(projectRaw, "host") as Partial<HostConfig>,
		),
	};

	// Expand ~ and ${userHome} in mount source and cache paths
	config.runtime.mounts = config.runtime.mounts.map((m) => ({
		...m,
		source: expandPath(m.source),
	}));
	if (config.runtime.cache) {
		config.runtime.cache = expandPath(config.runtime.cache);
	}

	return config;
}

export function getSbxConfigPath(hostCwd: string): string {
	return resolvePath(hostCwd, CONFIG_DIR_NAME, "sandbox.json");
}

export function saveSbxConfig(hostCwd: string, config: SbxConfig): void {
	const configPath = getSbxConfigPath(hostCwd);
	const dir = resolvePath(configPath, "..");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const tmpPath = `${configPath}.tmp`;
	writeFileSync(tmpPath, JSON.stringify(config, null, 2));
	renameSync(tmpPath, configPath);
}

export function imageRef(im: ImageConfig): string {
	return `${im.name}:${im.tag}`;
}

export function discoverDockerfiles(): string[] {
	if (!existsSync(PACKAGE_DOCKER_DIR)) return [];
	return readdirSync(PACKAGE_DOCKER_DIR)
		.filter((f) => f.endsWith(".Dockerfile"))
		.map((f) => basename(f, extname(f)));
}
