import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, DEFAULT_CONFIG, loadConfig, parseConfig, saveConfig, type VisionConfig } from "../src/config.js";

describe("parseConfig", () => {
	it("returns DEFAULT_CONFIG for null/undefined/empty object", () => {
		expect(parseConfig(null)).toEqual(DEFAULT_CONFIG);
		expect(parseConfig(undefined)).toEqual(DEFAULT_CONFIG);
		expect(parseConfig({})).toEqual(DEFAULT_CONFIG);
	});

	it("accepts a fully valid config", () => {
		const raw = { model: "openai/gpt-4o", defaultThinkLevel: "high" };
		expect(parseConfig(raw)).toEqual(raw);
	});

	it("ignores a legacy provider key", () => {
		expect(parseConfig({ provider: "openai", model: "gpt-4o" })).toEqual({ model: "gpt-4o" });
	});

	it("rejects a non-string model", () => {
		expect(() => parseConfig({ model: false })).toThrow(/model/);
	});

	it("rejects an invalid defaultThinkLevel", () => {
		expect(() => parseConfig({ defaultThinkLevel: "ultra" })).toThrow(/defaultThinkLevel/);
	});

	it("strips both legacy keys without losing the model", () => {
		expect(parseConfig({ model: "haiku", enabled: "off", defaultReasoning: "high" })).toEqual({ model: "haiku" });
	});

	it("strips unknown keys", () => {
		expect(parseConfig({ model: "x", extra: 1 })).toEqual({ model: "x" });
	});
});

describe("configPath", () => {
	it("joins agentDir with vision-tools.json", () => {
		expect(configPath("/home/u/.pi/agent")).toBe("/home/u/.pi/agent/vision-tools.json");
	});
});

describe("loadConfig / saveConfig (filesystem)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "vision-cfg-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("returns DEFAULT_CONFIG when the file does not exist", async () => {
		expect(await loadConfig(dir)).toEqual(DEFAULT_CONFIG);
	});

	it("returns DEFAULT_CONFIG when the file is corrupt JSON", async () => {
		await writeFile(configPath(dir), "{ not json");
		expect(await loadConfig(dir)).toEqual(DEFAULT_CONFIG);
	});

	it("falls back to DEFAULT_CONFIG when a hand-written think level is invalid", async () => {
		await writeFile(configPath(dir), JSON.stringify({ model: "haiku", defaultThinkLevel: "ultra" }));
		expect(await loadConfig(dir)).toEqual(DEFAULT_CONFIG);
	});

	it("round-trips a config through save then load", async () => {
		const cfg: VisionConfig = { model: "openai/gpt-4o", defaultThinkLevel: "low" };
		await saveConfig(dir, cfg);
		expect(await loadConfig(dir)).toEqual(cfg);
	});

	it("write is not pretty / is valid JSON", async () => {
		await saveConfig(dir, { model: "m" });
		const raw = await readFile(configPath(dir), "utf8");
		expect(JSON.parse(raw)).toEqual({ model: "m" });
	});

	it("saveConfig creates the agent dir if missing", async () => {
		const nested = join(dir, "deep", "agent");
		await saveConfig(nested, DEFAULT_CONFIG);
		expect(await loadConfig(nested)).toEqual(DEFAULT_CONFIG);
	});
});
