import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DEFAULT_CONFIG, loadConfig } from "../src/config";

describe("DEFAULT_CONFIG", () => {
	it("has expected defaults", () => {
		expect(DEFAULT_CONFIG.enabled).toBe(true);
		expect(DEFAULT_CONFIG.memIndexMaxLines).toBe(200);
		expect(DEFAULT_CONFIG.memIndexMaxBytes).toBe(25600);
		expect(DEFAULT_CONFIG.dream.model).toBeUndefined();
		expect(DEFAULT_CONFIG.sessionSearch.maxSessions).toBe(10);
	});
});

describe("loadConfig", () => {
	let globalDir: string;
	let projectDir: string;
	beforeEach(async () => {
		globalDir = await mkdtemp(join(tmpdir(), "mem-global-"));
		projectDir = await mkdtemp(join(tmpdir(), "mem-proj-"));
	});
	afterEach(async () => {
		await rm(globalDir, { recursive: true, force: true });
		await rm(projectDir, { recursive: true, force: true });
	});

	it("returns defaults when no config files exist", async () => {
		const cfg = await loadConfig({ cwd: projectDir, isProjectTrusted: () => true, _globalDir: globalDir, _configDirName: ".pi" });
		expect(cfg.enabled).toBe(true);
		expect(cfg.memIndexMaxLines).toBe(200);
	});
	it("merges global config over defaults", async () => {
		await writeFile(join(globalDir, "memory.json"), JSON.stringify({ memIndexMaxLines: 100 }));
		const cfg = await loadConfig({ cwd: projectDir, isProjectTrusted: () => true, _globalDir: globalDir, _configDirName: ".pi" });
		expect(cfg.memIndexMaxLines).toBe(100);
		expect(cfg.memIndexMaxBytes).toBe(25600); // unchanged default
	});
	it("nested deep-merge preserves sibling fields when one nested field is overridden", async () => {
		await writeFile(join(globalDir, "memory.json"), JSON.stringify({ dream: { model: "deepseek/deepseek-v4-flash" } }));
		const cfg = await loadConfig({ cwd: projectDir, isProjectTrusted: () => true, _globalDir: globalDir, _configDirName: ".pi" });
		expect(cfg.dream.model).toBe("deepseek/deepseek-v4-flash");
		expect(cfg.dream.nudgeAfterSessions).toBe(5);
		expect(cfg.dream.nudgeAfterHours).toBe(24);
	});
	it("project overrides global", async () => {
		await writeFile(join(globalDir, "memory.json"), JSON.stringify({ memIndexMaxLines: 100 }));
		await mkdir(join(projectDir, ".pi"), { recursive: true });
		await writeFile(join(projectDir, ".pi", "memory.json"), JSON.stringify({ memIndexMaxLines: 50 }));
		const cfg = await loadConfig({ cwd: projectDir, isProjectTrusted: () => true, _globalDir: globalDir, _configDirName: ".pi" });
		expect(cfg.memIndexMaxLines).toBe(50);
	});
	it("ignores project config when not trusted", async () => {
		await mkdir(join(projectDir, ".pi"), { recursive: true });
		await writeFile(join(projectDir, ".pi", "memory.json"), JSON.stringify({ memIndexMaxLines: 50 }));
		const cfg = await loadConfig({ cwd: projectDir, isProjectTrusted: () => false, _globalDir: globalDir, _configDirName: ".pi" });
		expect(cfg.memIndexMaxLines).toBe(200); // default, project ignored
	});
	it("expands ~ in memoryDir", async () => {
		await writeFile(join(globalDir, "memory.json"), JSON.stringify({ memoryDir: "~/mymem" }));
		const cfg = await loadConfig({ cwd: projectDir, isProjectTrusted: () => true, _globalDir: globalDir, _configDirName: ".pi" });
		expect(cfg.memoryDir).not.toContain("~");
	});
	it("handles malformed JSON gracefully", async () => {
		await writeFile(join(globalDir, "memory.json"), "this is not json");
		const cfg = await loadConfig({ cwd: projectDir, isProjectTrusted: () => true, _globalDir: globalDir, _configDirName: ".pi" });
		expect(cfg.enabled).toBe(true);
		expect(cfg.memIndexMaxLines).toBe(200);
	});
	it("expands bare ~ to homedir", async () => {
		await writeFile(join(globalDir, "memory.json"), JSON.stringify({ memoryDir: "~" }));
		const cfg = await loadConfig({ cwd: projectDir, isProjectTrusted: () => true, _globalDir: globalDir, _configDirName: ".pi" });
		expect(cfg.memoryDir).toBe(homedir());
	});

	it("has autoSurfacing defaults", async () => {
		const cfg = await loadConfig({ cwd: "/tmp", isProjectTrusted: () => false, _globalDir: globalDir, _configDirName: ".pi" });
		expect(cfg.autoSurfacing).toEqual({
			enabled: true,
			thinkLevel: "off",
			maxFiles: 5,
			maxTopicBytes: 4096,
			maxInjectionBytes: 20480,
		});
	});

	it("has extractMemories defaults", async () => {
		const cfg = await loadConfig({ cwd: "/tmp", isProjectTrusted: () => false, _globalDir: globalDir, _configDirName: ".pi" });
		expect(cfg.extractMemories).toEqual({
			enabled: true,
			thinkLevel: "high",
			maxContextTokens: 2000,
		});
	});

	it("loads config from memory.json not pi-memory.json", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cfg-"));
		const cfgContent = JSON.stringify({
			autoSurfacing: { enabled: false },
			extractMemories: { maxContextTokens: 1000 },
		});
		await writeFile(join(dir, "memory.json"), cfgContent);
		const cfg1 = await loadConfig({ cwd: "/tmp", isProjectTrusted: () => true, _globalDir: dir, _configDirName: ".pi" });
		expect(cfg1.autoSurfacing.enabled).toBe(false);
		expect(cfg1.extractMemories.maxContextTokens).toBe(1000);
		expect(cfg1.autoSurfacing.model).toBeUndefined();
	});

	it("deep-merges autoSurfacing sub-config", async () => {
		const gdir = await mkdtemp(join(tmpdir(), "gcfg-"));
		const pdir = await mkdtemp(join(tmpdir(), "pcfg-"));
		const gcfg = { autoSurfacing: { enabled: false, maxFiles: 3 } };
		await writeFile(join(gdir, "memory.json"), JSON.stringify(gcfg));
		const cfg = await loadConfig({ cwd: pdir, isProjectTrusted: () => true, _globalDir: gdir, _configDirName: ".pi" });
		expect(cfg.autoSurfacing.enabled).toBe(false);
		expect(cfg.autoSurfacing.maxFiles).toBe(3);
		expect(cfg.autoSurfacing.model).toBeUndefined();
		await rm(gdir, { recursive: true, force: true });
		await rm(pdir, { recursive: true, force: true });
	});
});
