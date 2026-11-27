import { posix, win32 } from "node:path";

export type ToolStoragePlatform = "linux" | "darwin" | "win32";
export type ToolStorageProfileId = "pip" | "uv" | "npm" | "corepack" | "pnpm" | "yarn" | "bun" | "go" | "maven" | "gradle";

export interface ToolStorageContext {
	platform: ToolStoragePlatform;
	env: NodeJS.ProcessEnv;
	home: string;
	workspaceRoot: string;
	uid: number | null;
	/** An XDG runtime root whose ownership and permissions were validated by detection. */
	pnpmRuntimeRoot: string | null;
}

export interface ToolStorageRoot {
	profile: ToolStorageProfileId;
	path: string;
}

export interface ToolStorageProfileDefinition {
	id: ToolStorageProfileId;
	commands: readonly string[];
	wrappers?: readonly string[];
	roots(context: ToolStorageContext): ToolStorageRoot[];
}

function pathApi(platform: ToolStoragePlatform) {
	return platform === "win32" ? win32 : posix;
}

function env(context: ToolStorageContext, name: string): string | undefined {
	let value = context.env[name];
	if (value === undefined && context.platform === "win32") {
		const key = Object.keys(context.env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
		if (key !== undefined) value = context.env[key];
	}
	return value === undefined || value.length === 0 ? undefined : value;
}

/** Tool-specific paths may be relative to the project; XDG paths cannot. */
function overridePath(context: ToolStorageContext, value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const path = pathApi(context.platform);
	return path.isAbsolute(value) ? path.normalize(value) : path.resolve(context.workspaceRoot, value);
}

function overrideEnv(context: ToolStorageContext, name: string): string | undefined {
	return overridePath(context, env(context, name));
}

function xdg(context: ToolStorageContext, name: "XDG_CACHE_HOME" | "XDG_DATA_HOME" | "XDG_STATE_HOME"): string | undefined {
	const value = env(context, name);
	if (value === undefined) return undefined;
	const path = pathApi(context.platform);
	return path.isAbsolute(value) ? path.normalize(value) : undefined;
}

function localAppData(context: ToolStorageContext): string {
	return overrideEnv(context, "LOCALAPPDATA") ?? pathApi(context.platform).join(context.home, "AppData", "Local");
}

function appData(context: ToolStorageContext): string {
	return overrideEnv(context, "APPDATA") ?? pathApi(context.platform).join(context.home, "AppData", "Roaming");
}

function roots(profile: ToolStorageProfileId, paths: readonly (string | undefined)[]): ToolStorageRoot[] {
	return paths.filter((path): path is string => path !== undefined).map((path) => ({ profile, path }));
}

function pipRoots(context: ToolStorageContext): ToolStorageRoot[] {
	const overridden = overrideEnv(context, "PIP_CACHE_DIR");
	let cache: string;
	if (overridden !== undefined) cache = overridden;
	else if (context.platform === "win32") cache = pathApi(context.platform).join(localAppData(context), "pip", "Cache");
	else {
		const base = xdg(context, "XDG_CACHE_HOME");
		cache = base !== undefined
			? posix.join(base, "pip")
			: context.platform === "darwin"
				? posix.join(context.home, "Library", "Caches", "pip")
				: posix.join(context.home, ".cache", "pip");
	}
	return roots("pip", [cache]);
}

function uvRoots(context: ToolStorageContext): ToolStorageRoot[] {
	const path = pathApi(context.platform);
	let cache = overrideEnv(context, "UV_CACHE_DIR");
	if (cache === undefined) {
		if (context.platform === "win32") cache = win32.join(localAppData(context), "uv", "cache");
		else {
			const base = xdg(context, "XDG_CACHE_HOME");
			cache = base === undefined ? posix.join(context.home, ".cache", "uv") : posix.join(base, "uv");
		}
	}
	let python = overrideEnv(context, "UV_PYTHON_INSTALL_DIR");
	if (python === undefined) {
		if (context.platform === "win32") python = win32.join(appData(context), "uv", "data", "python");
		else {
			const base = xdg(context, "XDG_DATA_HOME");
			python = base === undefined ? posix.join(context.home, ".local", "share", "uv", "python") : posix.join(base, "uv", "python");
		}
	}
	return roots("uv", [cache, python]);
}

function npmRoots(context: ToolStorageContext): ToolStorageRoot[] {
	const overridden = overridePath(context, env(context, "npm_config_cache") ?? env(context, "NPM_CONFIG_CACHE"));
	return roots("npm", [overridden ?? pathApi(context.platform).join(...(context.platform === "win32"
		? [localAppData(context), "npm-cache"]
		: [context.home, ".npm"]))]);
}

function corepackRoots(context: ToolStorageContext): ToolStorageRoot[] {
	return roots("corepack", [overrideEnv(context, "COREPACK_HOME") ?? (context.platform === "win32"
		? win32.join(localAppData(context), "node", "corepack")
		: posix.join(context.home, ".cache", "node", "corepack"))]);
}

const PNPM_LOCK_NAMES = [
	"pnpm-store-operation-locks",
	"pnpm-dir-locks",
	"pnpm-verify-deps-install-locks",
	"pnpm-modules-swaps",
	"pnpm-wasm-sqlite",
] as const;

function pnpmRoots(context: ToolStorageContext): ToolStorageRoot[] {
	const path = pathApi(context.platform);
	const pnpmHome = overrideEnv(context, "PNPM_HOME");
	const data = xdg(context, "XDG_DATA_HOME");
	const store = pnpmHome !== undefined
		? path.join(pnpmHome, "store")
		: data !== undefined
			? path.join(data, "pnpm", "store")
			: context.platform === "win32"
				? win32.join(localAppData(context), "pnpm", "store")
				: context.platform === "darwin"
					? posix.join(context.home, "Library", "pnpm", "store")
					: posix.join(context.home, ".local", "share", "pnpm", "store");
	const cacheBase = xdg(context, "XDG_CACHE_HOME");
	const cache = cacheBase !== undefined
		? path.join(cacheBase, "pnpm")
		: context.platform === "win32"
			? win32.join(localAppData(context), "pnpm-cache")
			: context.platform === "darwin"
				? posix.join(context.home, "Library", "Caches", "pnpm")
				: posix.join(context.home, ".cache", "pnpm");
	const stateBase = xdg(context, "XDG_STATE_HOME");
	const state = stateBase !== undefined
		? path.join(stateBase, "pnpm")
		: context.platform === "win32"
			? win32.join(localAppData(context), "pnpm-state")
			: posix.join(context.home, ".local", "state", "pnpm");
	let lockRoot: string | null = null;
	if (context.platform === "win32") lockRoot = localAppData(context);
	else if (context.pnpmRuntimeRoot !== null && context.uid !== null) lockRoot = context.pnpmRuntimeRoot;
	const locks = lockRoot === null
		? []
		: PNPM_LOCK_NAMES.map((name) => path.join(lockRoot, context.platform === "win32" ? name : `${name}-${context.uid}`));
	return roots("pnpm", [store, cache, state, ...locks]);
}

function yarnRoots(context: ToolStorageContext): ToolStorageRoot[] {
	const path = pathApi(context.platform);
	let classic = overrideEnv(context, "YARN_CACHE_FOLDER");
	if (classic === undefined) {
		if (context.platform === "win32") classic = win32.join(localAppData(context), "Yarn", "Cache");
		else if (context.platform === "darwin") classic = posix.join(context.home, "Library", "Caches", "Yarn");
		else {
			const base = xdg(context, "XDG_CACHE_HOME");
			classic = base === undefined ? posix.join(context.home, ".cache", "yarn") : posix.join(base, "yarn");
		}
	}
	const berry = overrideEnv(context, "YARN_GLOBAL_FOLDER") ?? path.join(context.home, ".yarn", "berry");
	return roots("yarn", [classic, berry]);
}

function bunRoots(context: ToolStorageContext): ToolStorageRoot[] {
	return roots("bun", [overrideEnv(context, "BUN_INSTALL_CACHE_DIR") ?? pathApi(context.platform).join(context.home, ".bun", "install", "cache")]);
}

function goRoots(context: ToolStorageContext): ToolStorageRoot[] {
	const path = pathApi(context.platform);
	let mod = overrideEnv(context, "GOMODCACHE");
	if (mod === undefined) {
		const goPath = env(context, "GOPATH")?.split(context.platform === "win32" ? ";" : ":").find((entry) => entry.length > 0);
		const base = overridePath(context, goPath) ?? path.join(context.home, "go");
		mod = path.join(base, "pkg", "mod");
	}
	const goCache = env(context, "GOCACHE");
	let build: string | undefined;
	if (goCache !== undefined && goCache !== "off") {
		// Go rejects relative GOCACHE values rather than resolving them against the project.
		build = path.isAbsolute(goCache) ? path.normalize(goCache) : undefined;
	} else if (goCache === undefined) {
		if (context.platform === "win32") build = win32.join(localAppData(context), "go-build");
		else if (context.platform === "darwin") build = posix.join(context.home, "Library", "Caches", "go-build");
		else {
			const base = xdg(context, "XDG_CACHE_HOME");
			build = base === undefined ? posix.join(context.home, ".cache", "go-build") : posix.join(base, "go-build");
		}
	}
	return roots("go", [mod, build]);
}

function mavenRoots(context: ToolStorageContext): ToolStorageRoot[] {
	const path = pathApi(context.platform);
	const wrapperHome = overrideEnv(context, "MAVEN_USER_HOME") ?? path.join(context.home, ".m2");
	return roots("maven", [path.join(context.home, ".m2", "repository"), path.join(wrapperHome, "wrapper", "dists")]);
}

function gradleRoots(context: ToolStorageContext): ToolStorageRoot[] {
	const path = pathApi(context.platform);
	const base = overrideEnv(context, "GRADLE_USER_HOME") ?? path.join(context.home, ".gradle");
	return roots("gradle", [
		path.join(base, "caches"),
		path.join(base, "daemon"),
		path.join(base, "jdks"),
		path.join(base, "wrapper", "dists"),
	]);
}

export const TOOL_STORAGE_PROFILES: readonly ToolStorageProfileDefinition[] = [
	{ id: "pip", commands: ["pip", "pip3", "python", "python3", "py"], roots: pipRoots },
	{ id: "uv", commands: ["uv"], roots: uvRoots },
	{ id: "npm", commands: ["npm", "npx"], roots: npmRoots },
	{ id: "corepack", commands: ["corepack", "pnpm", "yarn"], roots: corepackRoots },
	{ id: "pnpm", commands: ["pnpm", "pnpx", "corepack"], roots: pnpmRoots },
	{ id: "yarn", commands: ["yarn", "yarnpkg", "corepack"], roots: yarnRoots },
	{ id: "bun", commands: ["bun", "bunx"], roots: bunRoots },
	{ id: "go", commands: ["go"], roots: goRoots },
	{ id: "maven", commands: ["mvn"], wrappers: ["mvnw", "mvnw.cmd"], roots: mavenRoots },
	{ id: "gradle", commands: ["gradle"], wrappers: ["gradlew", "gradlew.bat"], roots: gradleRoots },
];
