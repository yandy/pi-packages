import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
	TOOL_STORAGE_PROFILES,
	type ToolStorageContext,
	type ToolStoragePlatform,
	type ToolStorageProfileId,
} from "../src/tool-storage/catalog";

const HOMES = {
	linux: "/home/alice",
	darwin: "/Users/alice",
	win32: "C:\\Users\\Alice",
} as const;

const WORKSPACES = {
	linux: "/work/project",
	darwin: "/work/project",
	win32: "D:\\work\\project",
} as const;

function pathApi(platform: ToolStoragePlatform) {
	return platform === "win32" ? win32 : posix;
}

function at(platform: ToolStoragePlatform, ...segments: string[]): string {
	return pathApi(platform).join(HOMES[platform], ...segments);
}

function context(platform: ToolStoragePlatform, env: NodeJS.ProcessEnv = {}, overrides: Partial<ToolStorageContext> = {}): ToolStorageContext {
	return {
		platform,
		env,
		home: HOMES[platform],
		workspaceRoot: WORKSPACES[platform],
		uid: 1000,
		pnpmRuntimeRoot: null,
		...overrides,
	};
}

function paths(id: ToolStorageProfileId, platform: ToolStoragePlatform, env: NodeJS.ProcessEnv = {}, overrides: Partial<ToolStorageContext> = {}): string[] {
	const profile = TOOL_STORAGE_PROFILES.find((candidate) => candidate.id === id);
	if (profile === undefined) throw new Error(`missing profile ${id}`);
	return profile.roots(context(platform, env, overrides)).map((root) => root.path);
}

const DEFAULTS: Array<{
	id: ToolStorageProfileId;
	platform: ToolStoragePlatform;
	expected: string[];
}> = [
	{ id: "pip", platform: "linux", expected: [at("linux", ".cache", "pip")] },
	{ id: "pip", platform: "darwin", expected: [at("darwin", "Library", "Caches", "pip")] },
	{ id: "pip", platform: "win32", expected: [at("win32", "AppData", "Local", "pip", "Cache")] },
	{ id: "uv", platform: "linux", expected: [at("linux", ".cache", "uv"), at("linux", ".local", "share", "uv", "python")] },
	{ id: "uv", platform: "darwin", expected: [at("darwin", ".cache", "uv"), at("darwin", ".local", "share", "uv", "python")] },
	{ id: "uv", platform: "win32", expected: [at("win32", "AppData", "Local", "uv", "cache"), at("win32", "AppData", "Roaming", "uv", "data", "python")] },
	{ id: "npm", platform: "linux", expected: [at("linux", ".npm")] },
	{ id: "npm", platform: "darwin", expected: [at("darwin", ".npm")] },
	{ id: "npm", platform: "win32", expected: [at("win32", "AppData", "Local", "npm-cache")] },
	{ id: "corepack", platform: "linux", expected: [at("linux", ".cache", "node", "corepack")] },
	{ id: "corepack", platform: "darwin", expected: [at("darwin", ".cache", "node", "corepack")] },
	{ id: "corepack", platform: "win32", expected: [at("win32", "AppData", "Local", "node", "corepack")] },
	{ id: "pnpm", platform: "linux", expected: [at("linux", ".local", "share", "pnpm", "store"), at("linux", ".cache", "pnpm"), at("linux", ".local", "state", "pnpm")] },
	{ id: "pnpm", platform: "darwin", expected: [at("darwin", "Library", "pnpm", "store"), at("darwin", "Library", "Caches", "pnpm"), at("darwin", ".local", "state", "pnpm")] },
	{ id: "yarn", platform: "linux", expected: [at("linux", ".cache", "yarn"), at("linux", ".yarn", "berry")] },
	{ id: "yarn", platform: "darwin", expected: [at("darwin", "Library", "Caches", "Yarn"), at("darwin", ".yarn", "berry")] },
	{ id: "yarn", platform: "win32", expected: [at("win32", "AppData", "Local", "Yarn", "Cache"), at("win32", ".yarn", "berry")] },
	{ id: "bun", platform: "linux", expected: [at("linux", ".bun", "install", "cache")] },
	{ id: "bun", platform: "darwin", expected: [at("darwin", ".bun", "install", "cache")] },
	{ id: "bun", platform: "win32", expected: [at("win32", ".bun", "install", "cache")] },
	{ id: "go", platform: "linux", expected: [at("linux", "go", "pkg", "mod"), at("linux", ".cache", "go-build")] },
	{ id: "go", platform: "darwin", expected: [at("darwin", "go", "pkg", "mod"), at("darwin", "Library", "Caches", "go-build")] },
	{ id: "go", platform: "win32", expected: [at("win32", "go", "pkg", "mod"), at("win32", "AppData", "Local", "go-build")] },
	{ id: "maven", platform: "linux", expected: [at("linux", ".m2", "repository"), at("linux", ".m2", "wrapper", "dists")] },
	{ id: "maven", platform: "darwin", expected: [at("darwin", ".m2", "repository"), at("darwin", ".m2", "wrapper", "dists")] },
	{ id: "maven", platform: "win32", expected: [at("win32", ".m2", "repository"), at("win32", ".m2", "wrapper", "dists")] },
	{ id: "gradle", platform: "linux", expected: [at("linux", ".gradle", "caches"), at("linux", ".gradle", "daemon"), at("linux", ".gradle", "jdks"), at("linux", ".gradle", "wrapper", "dists")] },
	{ id: "gradle", platform: "darwin", expected: [at("darwin", ".gradle", "caches"), at("darwin", ".gradle", "daemon"), at("darwin", ".gradle", "jdks"), at("darwin", ".gradle", "wrapper", "dists")] },
	{ id: "gradle", platform: "win32", expected: [at("win32", ".gradle", "caches"), at("win32", ".gradle", "daemon"), at("win32", ".gradle", "jdks"), at("win32", ".gradle", "wrapper", "dists")] },
];

describe("tool storage catalog defaults", () => {
	it.each(DEFAULTS)("resolves $id on $platform", ({ id, platform, expected }) => {
		expect(paths(id, platform)).toEqual(expected);
	});

	it("keeps pnpm's Windows locks in five named LocalAppData children", () => {
		expect(paths("pnpm", "win32")).toEqual([
			at("win32", "AppData", "Local", "pnpm", "store"),
			at("win32", "AppData", "Local", "pnpm-cache"),
			at("win32", "AppData", "Local", "pnpm-state"),
			at("win32", "AppData", "Local", "pnpm-store-operation-locks"),
			at("win32", "AppData", "Local", "pnpm-dir-locks"),
			at("win32", "AppData", "Local", "pnpm-verify-deps-install-locks"),
			at("win32", "AppData", "Local", "pnpm-modules-swaps"),
			at("win32", "AppData", "Local", "pnpm-wasm-sqlite"),
		]);
	});
});

describe("tool storage path overrides", () => {
	it("honors uv's exact cache and managed-Python overrides", () => {
		const cache = at("linux", "custom-cache");
		const python = at("linux", "custom-python");
		expect(paths("uv", "linux", { UV_CACHE_DIR: cache, UV_PYTHON_INSTALL_DIR: python })).toEqual([cache, python]);
	});

	it("applies XDG base directories before uv and pip defaults", () => {
		const cache = at("darwin", "xdg-cache");
		const data = at("darwin", "xdg-data");
		expect(paths("uv", "darwin", { XDG_CACHE_HOME: cache, XDG_DATA_HOME: data })).toEqual([
			posix.join(cache, "uv"),
			posix.join(data, "uv", "python"),
		]);
		expect(paths("pip", "darwin", { XDG_CACHE_HOME: cache })).toEqual([posix.join(cache, "pip")]);
	});

	it("uses PNPM_HOME for the store before XDG_DATA_HOME and resolves cache/state independently", () => {
		const home = at("linux", "pnpm-home");
		const data = at("linux", "xdg-data");
		const cache = at("linux", "xdg-cache");
		const state = at("linux", "xdg-state");
		expect(paths("pnpm", "linux", { PNPM_HOME: home, XDG_DATA_HOME: data, XDG_CACHE_HOME: cache, XDG_STATE_HOME: state })).toEqual([
			posix.join(home, "store"),
			posix.join(cache, "pnpm"),
			posix.join(state, "pnpm"),
		]);
		expect(paths("pnpm", "linux", { XDG_DATA_HOME: data })[0]).toBe(posix.join(data, "pnpm", "store"));
	});

	it.each(["npm_config_cache", "NPM_CONFIG_CACHE"])("honors npm's %s", (name) => {
		const cache = at("win32", "custom-npm");
		expect(paths("npm", "win32", { [name]: cache })).toEqual([cache]);
	});

	it("honors Corepack, Yarn, Bun, and Gradle storage overrides", () => {
		const custom = at("linux", "custom");
		expect(paths("corepack", "linux", { COREPACK_HOME: custom })).toEqual([custom]);
		expect(paths("yarn", "linux", { YARN_CACHE_FOLDER: `${custom}-classic`, YARN_GLOBAL_FOLDER: `${custom}-berry` })).toEqual([`${custom}-classic`, `${custom}-berry`]);
		expect(paths("bun", "linux", { BUN_INSTALL_CACHE_DIR: custom })).toEqual([custom]);
		expect(paths("gradle", "linux", { GRADLE_USER_HOME: custom })).toEqual([
			posix.join(custom, "caches"),
			posix.join(custom, "daemon"),
			posix.join(custom, "jdks"),
			posix.join(custom, "wrapper", "dists"),
		]);
	});

	it("resolves a relative tool-specific override against the workspace", () => {
		expect(paths("bun", "linux", { BUN_INSTALL_CACHE_DIR: "relative-cache" })).toEqual([posix.join(WORKSPACES.linux, "relative-cache")]);
	});

	it("ignores a relative XDG path", () => {
		expect(paths("pip", "linux", { XDG_CACHE_HOME: "relative-cache" })).toEqual([at("linux", ".cache", "pip")]);
	});
});

describe("Go, Maven, and pnpm lock boundaries", () => {
	it("uses GOMODCACHE/GOCACHE exactly and the first GOPATH entry by default", () => {
		const first = at("linux", "go-one");
		const second = at("linux", "go-two");
		const mod = at("linux", "custom-mod");
		const build = at("linux", "custom-build");
		expect(paths("go", "linux", { GOPATH: `${first}:${second}` })[0]).toBe(posix.join(first, "pkg", "mod"));
		expect(paths("go", "linux", { GOMODCACHE: mod, GOCACHE: build })).toEqual([mod, build]);
	});

	it.each(["off", "relative-cache"])("does not turn GOCACHE=%s into a writable root", (value) => {
		expect(paths("go", "linux", { GOCACHE: value })).toEqual([at("linux", "go", "pkg", "mod")]);
	});

	it("uses MAVEN_USER_HOME only for wrapper distributions", () => {
		const custom = at("win32", "maven-home");
		expect(paths("maven", "win32", { MAVEN_USER_HOME: custom })).toEqual([
			at("win32", ".m2", "repository"),
			win32.join(custom, "wrapper", "dists"),
		]);
	});

	it("adds only UID-qualified pnpm lock children below a qualified POSIX runtime root", () => {
		const runtime = "/run/user/1000";
		expect(paths("pnpm", "linux", {}, { pnpmRuntimeRoot: runtime })).toEqual([
			at("linux", ".local", "share", "pnpm", "store"),
			at("linux", ".cache", "pnpm"),
			at("linux", ".local", "state", "pnpm"),
			posix.join(runtime, "pnpm-store-operation-locks-1000"),
			posix.join(runtime, "pnpm-dir-locks-1000"),
			posix.join(runtime, "pnpm-verify-deps-install-locks-1000"),
			posix.join(runtime, "pnpm-modules-swaps-1000"),
			posix.join(runtime, "pnpm-wasm-sqlite-1000"),
		]);
		expect(paths("pnpm", "linux", {}, { pnpmRuntimeRoot: runtime, uid: null })).toHaveLength(3);
	});
});
