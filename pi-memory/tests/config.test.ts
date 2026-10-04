import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DEFAULT_CONFIG, loadConfig, modelConfigErrors, requiredModel, requiredModels, taskModel, type MemoryConfig } from "../src/config";

describe("DEFAULT_CONFIG", () => {
	it("has expected defaults", () => {
		expect(DEFAULT_CONFIG.memIndexMaxLines).toBe(200);
		expect(DEFAULT_CONFIG.memIndexMaxBytes).toBe(25600);
		// 注入口径**独立于**写入口径（v2.3.0 起）：窗口只取索引最新的 50 行。
		expect(DEFAULT_CONFIG.memIndexInjectMaxLines).toBe(50);
		expect(DEFAULT_CONFIG.memIndexInjectMaxBytes).toBe(16384);
		expect(DEFAULT_CONFIG.lock).toEqual({ timeoutMs: 5000, snapshotKeep: 5 });
		// 模型没有默认值：必须由用户显式配置，否则启动即报错（设计 §2.1）
		expect(DEFAULT_CONFIG.defaults).toEqual({ sessionPersistence: { enabled: false } });
		expect(DEFAULT_CONFIG.defaults?.model).toBeUndefined();
		expect(DEFAULT_CONFIG.dream.model).toBeUndefined();
		expect(DEFAULT_CONFIG.sessionSearch.maxSessions).toBe(10);
		expect(DEFAULT_CONFIG.autoSurfacing.maxEntryBytes).toBe(3072);
		// extract 是 opt-in：每轮都要跑一次模型调用，默认关闭。
		expect(DEFAULT_CONFIG.extractMemories.enabled).toBe(false);
		expect(DEFAULT_CONFIG.extractMemories.maxToolResultChars).toBe(500);
		expect(DEFAULT_CONFIG.extractMemories.maxAssistantChars).toBe(2000);
	});

	// v2.3.0 起读写**不再**同口径：注入窗口只取索引最新的 50 行（写入口径保持 200 行 / 25600 B，
	// 窗口外的旧记忆仍可由 auto-surfacing / memory 工具检索）。这两条断言钉的是「窗口确实比写入
	// 容量小」这件事本身 —— 任何一边被改回同值都会红。
	it("keeps the injection window smaller than the write capacity", () => {
		expect(DEFAULT_CONFIG.memIndexInjectMaxLines).toBeLessThan(DEFAULT_CONFIG.memIndexMaxLines);
		expect(DEFAULT_CONFIG.memIndexInjectMaxBytes).toBeLessThan(DEFAULT_CONFIG.memIndexMaxBytes);
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
		expect(cfg.memIndexMaxLines).toBe(200);
	});

	// 本次移除的回归钉子：包级 `enabled` 已不是 schema 的一部分。残留键会随 deepMerge 进入运行时
	// 对象（与 v1 的 maxTopicBytes 同例），但不得影响任何行为 —— `requiredModels` 仍然列出 dream，
	// 也就是「写 enabled: false 不再能免掉模型校验」。
	it("ignores a leftover top-level enabled key", async () => {
		await writeFile(
			join(globalDir, "memory.json"),
			JSON.stringify({ enabled: false, autoSurfacing: { enabled: false }, dream: { model: "test/dream" } }),
		);
		const cfg = await loadConfig({ cwd: projectDir, isProjectTrusted: () => true, _globalDir: globalDir, _configDirName: ".pi" });

		expect(requiredModels(cfg)).toEqual([{ task: "dream", value: "test/dream" }]);
		expect(modelConfigErrors(cfg, () => true)).toEqual([]);
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
		expect(cfg.memoryDir).toBe(join(homedir(), "mymem"));
	});
	it("handles malformed JSON gracefully", async () => {
		await writeFile(join(globalDir, "memory.json"), "this is not json");
		const cfg = await loadConfig({ cwd: projectDir, isProjectTrusted: () => true, _globalDir: globalDir, _configDirName: ".pi" });
		expect(cfg.memIndexMaxLines).toBe(200);
	});
	it("expands bare ~ to homedir", async () => {
		await writeFile(join(globalDir, "memory.json"), JSON.stringify({ memoryDir: "~" }));
		const cfg = await loadConfig({ cwd: projectDir, isProjectTrusted: () => true, _globalDir: globalDir, _configDirName: ".pi" });
		expect(cfg.memoryDir).toBe(homedir());
	});

	it("expands ~\\ in memoryDir on win32", async () => {
		await writeFile(join(globalDir, "memory.json"), JSON.stringify({ memoryDir: "~\\.pi\\memory" }));
		const cfg = await loadConfig({
			cwd: projectDir,
			isProjectTrusted: () => true,
			_globalDir: globalDir,
			_configDirName: ".pi",
			_platform: "win32",
		});
		// 注入的 `_platform` 只改展开条件，拼接仍走宿主的 join（POSIX 上反斜杠是普通字符，不是分隔符）。
		// 真 Windows 上本期望与 `join(homedir(), ".pi", "memory")` 逐字节相同。
		expect(cfg.memoryDir).toBe(join(homedir(), ".pi\\memory"));
	});

	it("leaves ~\\ alone on POSIX (it is a legal file name there)", async () => {
		await writeFile(join(globalDir, "memory.json"), JSON.stringify({ memoryDir: "~\\.pi\\memory" }));
		const cfg = await loadConfig({
			cwd: projectDir,
			isProjectTrusted: () => true,
			_globalDir: globalDir,
			_configDirName: ".pi",
			_platform: "linux",
		});
		expect(cfg.memoryDir).toBe("~\\.pi\\memory");
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
			enabled: false,
			thinkLevel: "high",
			maxContextTokens: 2000,
			maxToolResultChars: 500,
			maxAssistantChars: 2000,
		});
	});

	it("lets memory.json opt back into extractMemories", async () => {
		await writeFile(join(globalDir, "memory.json"), JSON.stringify({ extractMemories: { enabled: true } }));
		const cfg = await loadConfig({
			cwd: projectDir,
			isProjectTrusted: () => true,
			_globalDir: globalDir,
			_configDirName: ".pi",
		});
		// 默认关闭只是默认值：显式 true 必须能覆盖它（deepMerge 的正路径）。
		expect(cfg.extractMemories.enabled).toBe(true);
		expect(cfg.extractMemories.thinkLevel).toBe("high");
		// 模型校验跟着开关走：开启后 extract 也要模型。
		expect(requiredModels(cfg).map((m) => m.task)).toContain("extractMemories");
	});

	it("loads config from memory.json not pi-memory.json", async () => {
		const cfgContent = JSON.stringify({
			autoSurfacing: { enabled: false },
			extractMemories: { maxContextTokens: 1000 },
		});
		await writeFile(join(globalDir, "memory.json"), cfgContent);
		// 标题承诺的负向断言：pi-memory.json（按包名直觉的错拼）必须被忽略 ——
		// 若它被读进来，enabled 会翻回 true、maxFiles 会变成 99。
		await writeFile(join(globalDir, "pi-memory.json"), JSON.stringify({ autoSurfacing: { enabled: true, maxFiles: 99 } }));
		const cfg = await loadConfig({ cwd: projectDir, isProjectTrusted: () => true, _globalDir: globalDir, _configDirName: ".pi" });
		expect(cfg.autoSurfacing.enabled).toBe(false);
		expect(cfg.autoSurfacing.maxFiles).toBe(3);
		expect(cfg.extractMemories.maxContextTokens).toBe(1000);
		expect(cfg.autoSurfacing.model).toBeUndefined();
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

	// 模型没有默认值：必须由用户显式配置，否则启动即报错（设计 §2.1）
	it("ships no model default, so models must be configured explicitly", async () => {
		const cfg = await loadConfig({
			cwd: projectDir,
			isProjectTrusted: () => true,
			_globalDir: globalDir,
			_configDirName: ".pi",
		});
		expect(cfg.defaults?.model).toBeUndefined();
	});

	it("lets memory.json defaults.model provide the shared model", async () => {
		await writeFile(join(globalDir, "memory.json"), JSON.stringify({ defaults: { model: "other/model" } }));
		const cfg = await loadConfig({
			cwd: projectDir,
			isProjectTrusted: () => true,
			_globalDir: globalDir,
			_configDirName: ".pi",
		});
		expect(cfg.defaults?.model).toBe("other/model");
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
			enabled: false,
			thinkLevel: "high",
			maxContextTokens: 2000,
			maxToolResultChars: 200,
			maxAssistantChars: 2000,
		});
	});
});

describe("model config", () => {
	const cfg = (over: Partial<MemoryConfig> = {}): MemoryConfig => ({ ...DEFAULT_CONFIG, ...over });
	const allOn = (over: Partial<MemoryConfig> = {}): MemoryConfig =>
		cfg({
			defaults: { sessionPersistence: { enabled: false } },
			extractMemories: { ...DEFAULT_CONFIG.extractMemories, enabled: true },
			autoSurfacing: { ...DEFAULT_CONFIG.autoSurfacing, enabled: true },
			...over,
		});

	it("only requires dream when extract and auto-surfacing are disabled", () => {
		const c = allOn({
			dream: { ...DEFAULT_CONFIG.dream, model: "test/dream" },
			extractMemories: { ...DEFAULT_CONFIG.extractMemories, enabled: false },
			autoSurfacing: { ...DEFAULT_CONFIG.autoSurfacing, enabled: false },
		});
		expect(requiredModels(c)).toEqual([{ task: "dream", value: "test/dream" }]);
		expect(modelConfigErrors(c, () => true)).toEqual([]);
	});

	it("lets defaults.model satisfy every task", () => {
		const c = allOn({ defaults: { model: "test/shared", sessionPersistence: { enabled: false } } });
		expect(requiredModels(c)).toEqual([
			{ task: "dream", value: "test/shared" },
			{ task: "extractMemories", value: "test/shared" },
			{ task: "autoSurfacing", value: "test/shared" },
		]);
		expect(modelConfigErrors(c, () => true)).toEqual([]);
	});

	it("reports every missing model with the exact wording and order", () => {
		expect(modelConfigErrors(allOn(), () => true)).toEqual([
			'no model for dream — set "dream.model" or "defaults.model" in memory.json',
			'no model for extractMemories — set "extractMemories.model" or "defaults.model" in memory.json',
			'no model for autoSurfacing — set "autoSurfacing.model" or "defaults.model" in memory.json',
		]);
	});

	it("reports the per-task value when it overrides defaults.model", () => {
		const c = allOn({
			defaults: { model: "test/shared", sessionPersistence: { enabled: false } },
			dream: { ...DEFAULT_CONFIG.dream, model: "bad/dream" },
		});
		expect(modelConfigErrors(c, (v) => v !== "bad/dream")).toEqual([
			'model "bad/dream" for dream is not resolvable (unknown id or missing credentials)',
		]);
	});

	it("requiredModel returns the resolved value and throws when missing", () => {
		const c = allOn({ defaults: { model: "test/shared", sessionPersistence: { enabled: false } } });
		expect(requiredModel(c, "extractMemories")).toBe("test/shared");
		expect(() => requiredModel(allOn(), "dream")).toThrow(
			'no model for dream — set "dream.model" or "defaults.model" in memory.json',
		);
	});

	// `deepMerge` 会把用户写的 `"dream": null` 原样带进来：不能抛 TypeError，而是退到 defaults.model。
	it("degrades a module config set to null to defaults.model instead of throwing", () => {
		const withDefaults = allOn({
			defaults: { model: "test/shared", sessionPersistence: { enabled: false } },
			dream: null as unknown as MemoryConfig["dream"],
		});

		expect(modelConfigErrors(withDefaults, () => true)).toEqual([]);
		expect(requiredModel(withDefaults, "dream")).toBe("test/shared");

		// 没有 defaults.model 时给出一条可读错误（而不是让 TypeError 变成「初始化失败」）。
		const withoutDefaults = cfg({
			dream: null as unknown as MemoryConfig["dream"],
			autoSurfacing: { ...DEFAULT_CONFIG.autoSurfacing, enabled: false },
		});

		expect(modelConfigErrors(withoutDefaults, () => true)).toEqual([
			'no model for dream — set "dream.model" or "defaults.model" in memory.json',
		]);
	});
});

describe("taskModel", () => {
	it("prefers the per-task model and falls back to defaults.model", () => {
		const shared = { ...DEFAULT_CONFIG, defaults: { model: "shared/model" } };

		expect(taskModel(shared, "dream")).toBe("shared/model");
		expect(taskModel({ ...shared, dream: { ...shared.dream, model: "own/model" } }, "dream")).toBe("own/model");
		expect(taskModel({ ...shared, defaults: undefined }, "autoSurfacing")).toBeUndefined();
	});
});
