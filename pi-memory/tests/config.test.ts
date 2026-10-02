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
		// D3：读写同口径
		expect(DEFAULT_CONFIG.memIndexInjectMaxLines).toBe(200);
		expect(DEFAULT_CONFIG.memIndexInjectMaxBytes).toBe(25600);
		expect(DEFAULT_CONFIG.lock).toEqual({ timeoutMs: 5000, snapshotKeep: 5 });
		expect(DEFAULT_CONFIG.defaults).toEqual({ sessionPersistence: { enabled: false } });
		expect(DEFAULT_CONFIG.dream.model).toBeUndefined();
		expect(DEFAULT_CONFIG.sessionSearch.maxSessions).toBe(10);
		expect(DEFAULT_CONFIG.autoSurfacing.maxEntryBytes).toBe(3072);
		expect(DEFAULT_CONFIG.extractMemories.maxToolResultChars).toBe(500);
		expect(DEFAULT_CONFIG.extractMemories.maxAssistantChars).toBe(2000);
	});

	// D3 的实质：一个 entry 一行索引，注入预算必须与写入上限同量级，
	// 否则写满 200 条时模型只看得到最旧的一批。
	it("keeps the injection budget at the same scale as the write capacity (D3)", () => {
		expect(DEFAULT_CONFIG.memIndexInjectMaxLines).toBe(DEFAULT_CONFIG.memIndexMaxLines);
		expect(DEFAULT_CONFIG.memIndexInjectMaxBytes).toBe(DEFAULT_CONFIG.memIndexMaxBytes);
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
			maxFiles: 3,
			maxEntryBytes: 3072,
			maxInjectionBytes: 10240,
		});
	});

	it("has extractMemories defaults", async () => {
		const cfg = await loadConfig({ cwd: "/tmp", isProjectTrusted: () => false, _globalDir: globalDir, _configDirName: ".pi" });
		expect(cfg.extractMemories).toEqual({
			enabled: true,
			thinkLevel: "high",
			maxContextTokens: 2000,
			maxToolResultChars: 500,
			maxAssistantChars: 2000,
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

	it("propagates defaults.sessionPersistence to all tasks", async () => {
		await writeFile(
			join(globalDir, "memory.json"),
			JSON.stringify({ defaults: { sessionPersistence: { enabled: true } } }),
		);
		const cfg = await loadConfig({
			cwd: projectDir,
			isProjectTrusted: () => true,
			_globalDir: globalDir,
			_configDirName: ".pi",
		});
		expect(cfg.defaults?.sessionPersistence).toEqual({ enabled: true });
		expect(cfg.dream.sessionPersistence).toBeUndefined();
		expect(cfg.autoSurfacing.sessionPersistence).toBeUndefined();
		expect(cfg.extractMemories.sessionPersistence).toBeUndefined();
	});

	it("per-task sessionPersistence overrides defaults", async () => {
		await writeFile(
			join(globalDir, "memory.json"),
			JSON.stringify({
				defaults: { sessionPersistence: { enabled: true } },
				dream: { sessionPersistence: { enabled: false } },
			}),
		);
		const cfg = await loadConfig({
			cwd: projectDir,
			isProjectTrusted: () => true,
			_globalDir: globalDir,
			_configDirName: ".pi",
		});
		expect(cfg.defaults?.sessionPersistence).toEqual({ enabled: true });
		expect(cfg.dream.sessionPersistence).toEqual({ enabled: false });
	});

	it("defaults.model propagates correctly", async () => {
		await writeFile(
			join(globalDir, "memory.json"),
			JSON.stringify({ defaults: { model: "deepseek/flash" } }),
		);
		const cfg = await loadConfig({
			cwd: projectDir,
			isProjectTrusted: () => true,
			_globalDir: globalDir,
			_configDirName: ".pi",
		});
		expect(cfg.defaults?.model).toBe("deepseek/flash");
		expect(cfg.dream.model).toBeUndefined();
	});

	it("per-task model overrides defaults.model", async () => {
		await writeFile(
			join(globalDir, "memory.json"),
			JSON.stringify({
				defaults: { model: "deepseek/flash" },
				dream: { model: "tencent/glm" },
			}),
		);
		const cfg = await loadConfig({
			cwd: projectDir,
			isProjectTrusted: () => true,
			_globalDir: globalDir,
			_configDirName: ".pi",
		});
		expect(cfg.dream.model).toBe("tencent/glm");
	});

	it("ships defaults.sessionPersistence disabled so headless sessions stay in memory", async () => {
		const cfg = await loadConfig({
			cwd: projectDir,
			isProjectTrusted: () => true,
			_globalDir: globalDir,
			_configDirName: ".pi",
		});
		expect(cfg.defaults).toEqual({ sessionPersistence: { enabled: false } });
		expect(cfg.dream.thinkLevel).toBe("high");
		expect(cfg.dream.sessionPersistence).toBeUndefined();
	});

	it("has lock defaults", async () => {
		const cfg = await loadConfig({
			cwd: projectDir,
			isProjectTrusted: () => false,
			_globalDir: globalDir,
			_configDirName: ".pi",
		});
		expect(cfg.lock).toEqual({ timeoutMs: 5000, snapshotKeep: 5 });
	});

	it("deep-merges the lock section, keeping the untouched sibling", async () => {
		await writeFile(join(globalDir, "memory.json"), JSON.stringify({ lock: { timeoutMs: 1000 } }));
		const cfg = await loadConfig({
			cwd: projectDir,
			isProjectTrusted: () => true,
			_globalDir: globalDir,
			_configDirName: ".pi",
		});
		expect(cfg.lock).toEqual({ timeoutMs: 1000, snapshotKeep: 5 });
	});

	// v1 的 autoSurfacing.maxTopicBytes 语义是「一个 topic 文件的注入上限」，v2 的 maxEntryBytes 是
	// 「一条 entry 的注入上限」。旧键必须彻底失效：若它还生效，用户配置里的旧值会静默改变 v2 的注入预算。
	it("ignores the legacy autoSurfacing.maxTopicBytes key", async () => {
		await writeFile(join(globalDir, "memory.json"), JSON.stringify({ autoSurfacing: { maxTopicBytes: 999 } }));
		const cfg = await loadConfig({
			cwd: projectDir,
			isProjectTrusted: () => true,
			_globalDir: globalDir,
			_configDirName: ".pi",
		});
		expect(cfg.autoSurfacing.maxEntryBytes).toBe(3072);
	});

	it("deep-merges the new extractMemories char limits", async () => {
		await writeFile(
			join(globalDir, "memory.json"),
			JSON.stringify({ extractMemories: { maxToolResultChars: 200 } }),
		);
		const cfg = await loadConfig({
			cwd: projectDir,
			isProjectTrusted: () => true,
			_globalDir: globalDir,
			_configDirName: ".pi",
		});
		expect(cfg.extractMemories).toEqual({
			enabled: true,
			thinkLevel: "high",
			maxContextTokens: 2000,
			maxToolResultChars: 200,
			maxAssistantChars: 2000,
		});
	});
});
