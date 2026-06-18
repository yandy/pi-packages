import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SBX_CONFIG, getSbxConfigPath, imageRefForTag, loadSbxConfig, saveSbxConfig } from "../src/config";

const testDir = resolvePath(tmpdir(), "pi-sandbox-test-" + Date.now());

beforeEach(() => {
	if (existsSync(testDir)) rmSync(testDir, { recursive: true });
	mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
	if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("getSbxConfigPath", () => {
	it("returns path under .pi/agent/sandbox.json", () => {
		const path = getSbxConfigPath(testDir);
		expect(path).toBe(resolvePath(testDir, ".pi", "agent", "sandbox.json"));
	});
});

describe("imageRefForTag", () => {
	it("combines image and tag with optional slash prefix", () => {
		expect(imageRefForTag("pi-sandbox", "latest")).toBe("pi-sandbox:latest");
		expect(imageRefForTag("org/pi-sandbox", "v1.0")).toBe("org/pi-sandbox:v1.0");
	});
});

describe("loadSbxConfig", () => {
	it("returns defaults when no config file exists", () => {
		const cfg = loadSbxConfig(testDir);
		expect(cfg).toEqual(DEFAULT_SBX_CONFIG);
	});

	it("loads values from existing config file", () => {
		const configDir = resolvePath(testDir, ".pi", "agent");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(resolvePath(configDir, "sandbox.json"), JSON.stringify({ image: "my-img", tag: "v2", tier: "large" }));

		const cfg = loadSbxConfig(testDir);
		expect(cfg.image).toBe("my-img");
		expect(cfg.tag).toBe("v2");
		expect(cfg.tier).toBe("large");
		expect(cfg.containerName).toBe(DEFAULT_SBX_CONFIG.containerName);
		expect(cfg.persist).toBe(DEFAULT_SBX_CONFIG.persist);
	});

	it("falls back to defaults on corrupt JSON", () => {
		const configDir = resolvePath(testDir, ".pi", "agent");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(resolvePath(configDir, "sandbox.json"), "not json {{{");

		const cfg = loadSbxConfig(testDir);
		expect(cfg).toEqual(DEFAULT_SBX_CONFIG);
	});
});

describe("saveSbxConfig", () => {
	it("writes config to disk", () => {
		saveSbxConfig(testDir, { image: "x", tag: "y", containerName: "z", tier: "small", persist: true, cacheVolume: "v" });
		const cfg = loadSbxConfig(testDir);
		expect(cfg.image).toBe("x");
		expect(cfg.tag).toBe("y");
		expect(cfg.containerName).toBe("z");
		expect(cfg.tier).toBe("small");
		expect(cfg.persist).toBe(true);
		expect(cfg.cacheVolume).toBe("v");
	});

	it("round-trips: save then load returns same values", () => {
		const input = { ...DEFAULT_SBX_CONFIG, tier: "large" as const, containerName: "my-container" };
		saveSbxConfig(testDir, input);
		const output = loadSbxConfig(testDir);
		expect(output).toEqual(input);
	});
});

describe("loadSbxConfig new fields", () => {
	it("parses dockerfile, buildContext, buildArgs from config", () => {
		const configDir = resolvePath(testDir, ".pi", "agent");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			resolvePath(configDir, "sandbox.json"),
			JSON.stringify({
				image: "my-img",
				tag: "v2",
				dockerfile: "./Dockerfile.custom",
				buildContext: ".",
				buildArgs: { FOO: "bar", BAZ: "1" },
			}),
		);

		const cfg = loadSbxConfig(testDir);
		expect(cfg.dockerfile).toBe("./Dockerfile.custom");
		expect(cfg.buildContext).toBe(".");
		expect(cfg.buildArgs).toEqual({ FOO: "bar", BAZ: "1" });
	});

	it("omits optional fields when not present in config", () => {
		const configDir = resolvePath(testDir, ".pi", "agent");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(resolvePath(configDir, "sandbox.json"), JSON.stringify({ image: "img" }));

		const cfg = loadSbxConfig(testDir);
		expect(cfg.dockerfile).toBeUndefined();
		expect(cfg.buildContext).toBeUndefined();
		expect(cfg.buildArgs).toBeUndefined();
	});
});

describe("loadSbxConfig hostCommands", () => {
	it("reads hostCommands from config file", () => {
		const configDir = resolvePath(testDir, ".pi", "agent");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			resolvePath(configDir, "sandbox.json"),
			JSON.stringify({
				image: "my-img",
				hostCommands: ["git", "docker", "npm"],
			}),
		);

		const cfg = loadSbxConfig(testDir);
		expect(cfg.hostCommands).toEqual(["git", "docker", "npm"]);
	});

	it("returns undefined hostCommands when not in config", () => {
		const cfg = loadSbxConfig(testDir);
		expect(cfg.hostCommands).toBeUndefined();
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

describe("loadSbxConfig preserves unknown fields", () => {
	it("round-trips user-added fields through save/load", () => {
		const configDir = resolvePath(testDir, ".pi", "agent");
		mkdirSync(configDir, { recursive: true });
		const original = { image: "pi-sandbox", custom_user_field: "hello", nested: { foo: 1 } };
		writeFileSync(resolvePath(configDir, "sandbox.json"), JSON.stringify(original));

		const cfg = loadSbxConfig(testDir);
		expect((cfg as any).custom_user_field).toBe("hello");
		expect((cfg as any).nested).toEqual({ foo: 1 });

		saveSbxConfig(testDir, cfg);
		const cfg2 = loadSbxConfig(testDir);
		expect((cfg2 as any).custom_user_field).toBe("hello");
		expect((cfg2 as any).nested).toEqual({ foo: 1 });
	});
});
