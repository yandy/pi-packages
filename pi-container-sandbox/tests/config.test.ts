import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { getSbxConfigPath, loadSbxConfig, saveSbxConfig, imageRefForTag, DEFAULT_SBX_CONFIG } from "../src/config";

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
  it("combines image and tag", () => {
    expect(imageRefForTag("pi-sandbox", "latest")).toBe("pi-sandbox:latest");
  });

  it("handles images with slashes", () => {
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
