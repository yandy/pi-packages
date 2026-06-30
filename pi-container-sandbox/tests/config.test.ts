import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => "/home/user/.test-cfg/agent",
	CONFIG_DIR_NAME: ".test-cfg",
}));

import { DEFAULT_SBX_CONFIG, getSbxConfigPath, imageRef, loadSbxConfig, saveSbxConfig } from "../src/config";

const TEST_CONFIG_DIR = ".test-cfg";
const testDir = resolvePath(tmpdir(), `pi-sandbox-test-${Date.now()}`);

beforeEach(() => {
	if (existsSync(testDir)) rmSync(testDir, { recursive: true });
	mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
	if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("getSbxConfigPath", () => {
	it("returns path under CONFIG_DIR_NAME/sandbox.json", () => {
		const path = getSbxConfigPath(testDir);
		expect(path).toBe(resolvePath(testDir, TEST_CONFIG_DIR, "sandbox.json"));
	});
});

describe("imageRef", () => {
	it("combines image name and tag", () => {
		expect(imageRef({ name: "pi-sandbox", tag: "latest" })).toBe("pi-sandbox:latest");
		expect(imageRef({ name: "org/pi-sandbox", tag: "v1.0" })).toBe("org/pi-sandbox:v1.0");
	});
});

describe("loadSbxConfig", () => {
	it("returns defaults when no config file exists", () => {
		const cfg = loadSbxConfig(testDir);
		expect(cfg).toEqual(DEFAULT_SBX_CONFIG);
	});

	it("loads values from project config with per-group merge", () => {
		const configDir = resolvePath(testDir, TEST_CONFIG_DIR);
		mkdirSync(configDir, { recursive: true });
		writeFileSync(resolvePath(configDir, "sandbox.json"), JSON.stringify({
			image: { name: "my-img", tag: "v2" },
			runtime: { tier: "large", network: false },
			host: { commands: ["git"] },
		}));

		const cfg = loadSbxConfig(testDir);
		expect(cfg.image.name).toBe("my-img");
		expect(cfg.image.tag).toBe("v2");
		expect(cfg.runtime.tier).toBe("large");
		expect(cfg.runtime.network).toBe(false);
		expect(cfg.runtime.name).toBe(DEFAULT_SBX_CONFIG.runtime.name);
		expect(cfg.runtime.persist).toBe(DEFAULT_SBX_CONFIG.runtime.persist);
		expect(cfg.host.commands).toEqual(["git"]);
	});

	it("falls back to defaults on corrupt JSON", () => {
		const configDir = resolvePath(testDir, TEST_CONFIG_DIR);
		mkdirSync(configDir, { recursive: true });
		writeFileSync(resolvePath(configDir, "sandbox.json"), "not json {{{");
		const cfg = loadSbxConfig(testDir);
		expect(cfg).toEqual(DEFAULT_SBX_CONFIG);
	});

	it("partial group overrides do not reset other group fields", () => {
		const configDir = resolvePath(testDir, TEST_CONFIG_DIR);
		mkdirSync(configDir, { recursive: true });
		writeFileSync(resolvePath(configDir, "sandbox.json"), JSON.stringify({
			runtime: { tier: "small" },
		}));
		const cfg = loadSbxConfig(testDir);
		expect(cfg.runtime.tier).toBe("small");
		expect(cfg.runtime.network).toBe(DEFAULT_SBX_CONFIG.runtime.network);
		expect(cfg.runtime.persist).toBe(DEFAULT_SBX_CONFIG.runtime.persist);
		expect(cfg.image).toEqual(DEFAULT_SBX_CONFIG.image);
	});
});

describe("saveSbxConfig", () => {
	it("writes config to disk", () => {
		const cfg = {
			...DEFAULT_SBX_CONFIG,
			image: { name: "x", tag: "y" },
			runtime: { ...DEFAULT_SBX_CONFIG.runtime, name: "z", tier: "small" as const, persist: true, cache: "v" },
		};
		saveSbxConfig(testDir, cfg);
		const loaded = loadSbxConfig(testDir);
		expect(loaded.image).toEqual({ name: "x", tag: "y" });
		expect(loaded.runtime.name).toBe("z");
		expect(loaded.runtime.tier).toBe("small");
		expect(loaded.runtime.persist).toBe(true);
		expect(loaded.runtime.cache).toBe(resolvePath(testDir, "v"));
	});

	it("round-trips: save then load returns same values", () => {
		const input = {
			...DEFAULT_SBX_CONFIG,
			runtime: { ...DEFAULT_SBX_CONFIG.runtime, tier: "large" as const, name: "my-container" },
		};
		saveSbxConfig(testDir, input);
		const output = loadSbxConfig(testDir);
		expect(output).toEqual(input);
	});
});

describe("new runtime fields", () => {
	it("parses memory, cpus, swap, pidsLimit, mounts from runtime group", () => {
		const configDir = resolvePath(testDir, TEST_CONFIG_DIR);
		mkdirSync(configDir, { recursive: true });
		writeFileSync(resolvePath(configDir, "sandbox.json"), JSON.stringify({
			runtime: { memory: "8g", cpus: "4", swap: "0", pidsLimit: 1024, mounts: [{ source: "/host/projects", target: "/projects" }] },
		}));
		const cfg = loadSbxConfig(testDir);
		expect(cfg.runtime.memory).toBe("8g");
		expect(cfg.runtime.cpus).toBe("4");
		expect(cfg.runtime.swap).toBe("0");
		expect(cfg.runtime.pidsLimit).toBe(1024);
		expect(cfg.runtime.mounts).toEqual([{ source: "/host/projects", target: "/projects" }]);
	});

	it("new fields default to null/empty when not configured", () => {
		const cfg = loadSbxConfig(testDir);
		expect(cfg.runtime.memory).toBeNull();
		expect(cfg.runtime.cpus).toBeNull();
		expect(cfg.runtime.swap).toBeNull();
		expect(cfg.runtime.pidsLimit).toBeNull();
		expect(cfg.runtime.mounts).toEqual([]);
	});

	it("expands ~ and resolves relative paths in mount source and cache fields", () => {
		const configDir = resolvePath(testDir, TEST_CONFIG_DIR);
		mkdirSync(configDir, { recursive: true });
		writeFileSync(resolvePath(configDir, "sandbox.json"), JSON.stringify({
			runtime: {
				mounts: [
					{ source: "~/projects", target: "/projects" },
					{ source: "./relative-dir", target: "/rel" },
					{ source: "../parent-dir", target: "/par" },
					{ source: "/foo", target: "~/keep" },
				],
				cache: "~/sandbox-cache",
			},
		}));
		const cfg = loadSbxConfig(testDir);

		const home = homedir();
		expect(cfg.runtime.mounts).toEqual([
			{ source: home + "/projects", target: "/projects" },
			{ source: resolvePath(testDir, "./relative-dir"), target: "/rel" },
			{ source: resolvePath(testDir, "../parent-dir"), target: "/par" },
			{ source: "/foo", target: "~/keep" },
		]);
		expect(cfg.runtime.cache).toBe(home + "/sandbox-cache");

		// Verify target containing ~ is NOT expanded
		expect(cfg.runtime.mounts[3].source).toBe("/foo");
		expect(cfg.runtime.mounts[3].target).toBe("~/keep");
	});

	it("${userHome} is no longer special — treated as relative path", () => {
		const configDir = resolvePath(testDir, TEST_CONFIG_DIR);
		mkdirSync(configDir, { recursive: true });
		writeFileSync(resolvePath(configDir, "sandbox.json"), JSON.stringify({
			runtime: {
				mounts: [{ source: "${userHome}/tools", target: "/tools" }],
				cache: "${userHome}/cache",
			},
		}));
		const cfg = loadSbxConfig(testDir);
		expect(cfg.runtime.mounts[0].source).toBe(resolvePath(testDir, "${userHome}/tools"));
		expect(cfg.runtime.cache).toBe(resolvePath(testDir, "${userHome}/cache"));
	});

	it("parses env array from runtime group", () => {
		const configDir = resolvePath(testDir, TEST_CONFIG_DIR);
		mkdirSync(configDir, { recursive: true });
		writeFileSync(resolvePath(configDir, "sandbox.json"), JSON.stringify({
			runtime: { env: ["NODE_ENV=production", "DEBUG=app:*"] },
		}));
		const cfg = loadSbxConfig(testDir);
		expect(cfg.runtime.env).toEqual(["NODE_ENV=production", "DEBUG=app:*"]);
	});

	it("env defaults to empty array when not configured", () => {
		const cfg = loadSbxConfig(testDir);
		expect(cfg.runtime.env).toEqual([]);
	});
});

describe("host group", () => {
	it("parses commands from host group", () => {
		const configDir = resolvePath(testDir, TEST_CONFIG_DIR);
		mkdirSync(configDir, { recursive: true });
		writeFileSync(resolvePath(configDir, "sandbox.json"), JSON.stringify({
			host: { commands: ["git", "docker", "npm"] },
		}));
		const cfg = loadSbxConfig(testDir);
		expect(cfg.host.commands).toEqual(["git", "docker", "npm"]);
	});

	it("host commands default to empty array", () => {
		const cfg = loadSbxConfig(testDir);
		expect(cfg.host.commands).toEqual([]);
	});
});

import { discoverDockerfiles } from "../src/config";

describe("discoverDockerfiles", () => {
	it("discovers Dockerfile names from docker/ directory", () => {
		const files = discoverDockerfiles();
		expect(files).toContain("cn");
		expect(files).toContain("gh");
	});
});
