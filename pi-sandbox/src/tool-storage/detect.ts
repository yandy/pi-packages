import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { canonicalPath } from "../policy";
import {
	TOOL_STORAGE_PROFILES,
	type ToolStorageContext,
	type ToolStoragePlatform,
	type ToolStorageProfileId,
	type ToolStorageRoot,
} from "./catalog";

export interface ToolStoragePlan {
	platform: ToolStoragePlatform;
	home: string;
	agentDir: string;
	workspaceRoot: string;
	/** Shared bases that must never themselves become automatic writable roots. */
	sharedRoots: readonly string[];
	profiles: readonly ToolStorageProfileId[];
	roots: readonly ToolStorageRoot[];
}

export interface ToolStorageDetectDeps {
	platform?: ToolStoragePlatform;
	env?: NodeJS.ProcessEnv;
	home?: string;
	agentDir?: string;
	uid?: number | null;
	isExecutable?: (path: string) => boolean;
	isFile?: (path: string) => boolean;
}

function pathApi(platform: ToolStoragePlatform) {
	return platform === "win32" ? win32 : posix;
}

function envValue(env: NodeJS.ProcessEnv, platform: ToolStoragePlatform, name: string): string | undefined {
	let value = env[name];
	if (value === undefined && platform === "win32") {
		const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
		if (key !== undefined) value = env[key];
	}
	return value === undefined || value.length === 0 ? undefined : value;
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function isExecutableFile(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function commandExists(
	command: string,
	platform: ToolStoragePlatform,
	workspaceRoot: string,
	env: NodeJS.ProcessEnv,
	isExecutable: (path: string) => boolean,
): boolean {
	const path = pathApi(platform);
	const separator = platform === "win32" ? ";" : ":";
	const pathValue = envValue(env, platform, "PATH") ?? "";
	const extensions = platform === "win32"
		? (envValue(env, platform, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((entry) => entry.length > 0)
		: [];
	for (const entry of pathValue.split(separator)) {
		const directory = path.resolve(workspaceRoot, entry.length === 0 ? "." : entry);
		const candidates = platform === "win32" ? [command, ...extensions.map((extension) => `${command}${extension}`)] : [command];
		for (const candidate of candidates) {
			if (isExecutable(path.join(directory, candidate))) return true;
		}
	}
	return false;
}

/**
 * Match pnpm's XDG_RUNTIME_DIR admission checks. The runtime root itself is
 * never created or granted; only its named pnpm lock children enter the plan.
 */
export function usablePnpmRuntimeRoot(
	env: NodeJS.ProcessEnv,
	platform: ToolStoragePlatform,
	uid: number | null,
): string | null {
	if (platform === "win32" || uid === null) return null;
	const value = envValue(env, platform, "XDG_RUNTIME_DIR");
	if (value === undefined || !posix.isAbsolute(value)) return null;
	try {
		const stat = statSync(value);
		return stat.isDirectory()
			&& stat.uid === uid
			&& (stat.mode & 0o300) === 0o300
			&& (stat.mode & 0o022) === 0
			? posix.normalize(value)
			: null;
	} catch {
		return null;
	}
}

function absoluteEnvRoot(env: NodeJS.ProcessEnv, platform: ToolStoragePlatform, name: string): string | undefined {
	const value = envValue(env, platform, name);
	if (value === undefined) return undefined;
	const path = pathApi(platform);
	return path.isAbsolute(value) ? path.normalize(value) : undefined;
}

function dedupeStrings(paths: readonly string[], platform: ToolStoragePlatform): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const path of paths) {
		const normalized = pathApi(platform).normalize(path);
		const key = platform === "win32" ? normalized.toLowerCase() : normalized;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(normalized);
	}
	return result;
}

export function detectToolStorage(workspaceRoot: string, deps: ToolStorageDetectDeps = {}): ToolStoragePlan {
	const platform = (deps.platform ?? process.platform) as ToolStoragePlatform;
	const env = deps.env ?? process.env;
	const home = deps.home ?? homedir();
	const agentDir = deps.agentDir ?? getAgentDir();
	const canonicalWorkspace = canonicalPath(workspaceRoot);
	const uid = Object.hasOwn(deps, "uid") ? (deps.uid ?? null) : (process.getuid?.() ?? null);
	const executable = deps.isExecutable ?? (platform === "win32" ? isFile : isExecutableFile);
	const file = deps.isFile ?? isFile;
	const selected = TOOL_STORAGE_PROFILES.filter((profile) =>
		profile.commands.some((command) => commandExists(command, platform, canonicalWorkspace, env, executable))
		|| (profile.wrappers ?? []).some((wrapper) => file(pathApi(platform).join(canonicalWorkspace, wrapper))),
	);
	const pnpmRuntimeRoot = selected.some((profile) => profile.id === "pnpm")
		? usablePnpmRuntimeRoot(env, platform, uid)
		: null;
	const context: ToolStorageContext = {
		platform,
		env,
		home,
		workspaceRoot: canonicalWorkspace,
		uid,
		pnpmRuntimeRoot,
	};
	const roots = selected.flatMap((profile) => profile.roots(context));
	const seenRoots = new Set<string>();
	const uniqueRoots = roots.filter((root) => {
		const key = platform === "win32" ? root.path.toLowerCase() : root.path;
		if (seenRoots.has(key)) return false;
		seenRoots.add(key);
		return true;
	});
	const sharedRoots = [
		home,
		...["XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"]
			.map((name) => absoluteEnvRoot(env, platform, name))
			.filter((path): path is string => path !== undefined),
		...(platform === "win32"
			? [
				absoluteEnvRoot(env, platform, "LOCALAPPDATA") ?? win32.join(home, "AppData", "Local"),
				absoluteEnvRoot(env, platform, "APPDATA") ?? win32.join(home, "AppData", "Roaming"),
			]
			: []),
	];
	return {
		platform,
		home,
		agentDir,
		workspaceRoot: canonicalWorkspace,
		sharedRoots: dedupeStrings(sharedRoots, platform),
		profiles: selected.map((profile) => profile.id),
		roots: uniqueRoots,
	};
}

let planCache = new Map<string, ToolStoragePlan>();

export function getToolStoragePlan(workspaceRoot: string): ToolStoragePlan {
	const canonicalWorkspace = canonicalPath(workspaceRoot);
	let plan = planCache.get(canonicalWorkspace);
	if (plan === undefined) {
		plan = detectToolStorage(canonicalWorkspace);
		planCache.set(canonicalWorkspace, plan);
	}
	return plan;
}

export function resetToolStoragePlanCache(): void {
	planCache = new Map();
}
