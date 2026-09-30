import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { expandPath } from "./paths";
import { container } from "./container-cli";

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
	engine: "docker" | "podman" | "auto";
	name: string | null;
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
		engine: "auto",
		name: null, network: true, persist: false,
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

	// Extract groups so array fields can be concatenated (mergeGroup replaces arrays)
	const globalRuntime = extractGroup(globalRaw, "runtime") as Partial<RuntimeConfig>;
	const projectRuntime = extractGroup(projectRaw, "runtime") as Partial<RuntimeConfig>;
	const globalHost = extractGroup(globalRaw, "host") as Partial<HostConfig>;
	const projectHost = extractGroup(projectRaw, "host") as Partial<HostConfig>;

	const config: SbxConfig = {
		image: mergeGroup(
			mergeGroup(DEFAULT_SBX_CONFIG.image, extractGroup(globalRaw, "image") as Partial<ImageConfig>),
			extractGroup(projectRaw, "image") as Partial<ImageConfig>,
		),
		runtime: mergeGroup(
			mergeGroup(DEFAULT_SBX_CONFIG.runtime, globalRuntime),
			projectRuntime,
		),
		host: mergeGroup(
			mergeGroup(DEFAULT_SBX_CONFIG.host, globalHost),
			projectHost,
		),
	};

	// Concatenate array fields so global + project entries are all preserved.
	// mergeGroup replaces entire arrays; without this, project arrays overwrite global ones.
	config.runtime.mounts = [
		...(DEFAULT_SBX_CONFIG.runtime.mounts),
		...(globalRuntime.mounts ?? []),
		...(projectRuntime.mounts ?? []),
	];
	config.runtime.env = [
		...(DEFAULT_SBX_CONFIG.runtime.env ?? []),
		...(globalRuntime.env ?? []),
		...(projectRuntime.env ?? []),
	];
	config.host.commands = [
		...(DEFAULT_SBX_CONFIG.host.commands),
		...(globalHost.commands ?? []),
		...(projectHost.commands ?? []),
	];

	// Sanitize engine field: anything other than docker/podman/auto defaults to auto
	if (!["docker", "podman", "auto"].includes(config.runtime.engine)) {
		config.runtime.engine = "auto";
	}

	// Expand ~ and resolve relative paths in mount source and cache
	config.runtime.mounts = config.runtime.mounts.map((m) => ({
		...m,
		source: expandPath(m.source, hostCwd),
	}));
	if (config.runtime.cache) {
		config.runtime.cache = expandPath(config.runtime.cache, hostCwd);
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

/** 检测可用的容器引擎，优先 podman。抛错如果一个都没有。 */
function detectEngine(): "docker" | "podman" {
	try { container("podman", ["info"]); return "podman"; } catch {}
	try { container("docker", ["info"]); return "docker"; } catch {}
	throw new Error("No container runtime available. Install podman or docker.");
}

/** 根据配置解析最终使用的引擎 */
export function resolveEngine(engine: "docker" | "podman" | "auto"): "docker" | "podman" {
	if (engine === "auto") return detectEngine();
	// 显式指定：验证可用性
	try {
		container(engine, ["info"]);
		return engine;
	} catch (err) {
		throw new Error(`Container runtime "${engine}" is not available: ${err instanceof Error ? err.message : String(err)}`);
	}
}

export function discoverDockerfiles(): string[] {
	if (!existsSync(PACKAGE_DOCKER_DIR)) return [];
	return readdirSync(PACKAGE_DOCKER_DIR)
		.filter((f) => f.endsWith(".Dockerfile"))
		.map((f) => basename(f, extname(f)));
}
