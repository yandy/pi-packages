import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DEFAULT_CONFIG, loadConfig } from "../src/config";

describe("DEFAULT_CONFIG", () => {
	it("has expected defaults", () => {
		expect(DEFAULT_CONFIG.enabled).toBe(true);
		expect(DEFAULT_CONFIG.memIndexMaxLines).toBe(200);
		expect(DEFAULT_CONFIG.memIndexMaxBytes).toBe(25600);
		expect(DEFAULT_CONFIG.dream.model).toBe("auto");
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
		await writeFile(join(globalDir, "pi-memory.json"), JSON.stringify({ memIndexMaxLines: 100 }));
		const cfg = await loadConfig({ cwd: projectDir, isProjectTrusted: () => true, _globalDir: globalDir, _configDirName: ".pi" });
		expect(cfg.memIndexMaxLines).toBe(100);
		expect(cfg.memIndexMaxBytes).toBe(25600); // unchanged default
	});
	it("project overrides global", async () => {
		await writeFile(join(globalDir, "pi-memory.json"), JSON.stringify({ memIndexMaxLines: 100 }));
		await mkdir(join(projectDir, ".pi"), { recursive: true });
		await writeFile(join(projectDir, ".pi", "pi-memory.json"), JSON.stringify({ memIndexMaxLines: 50 }));
		const cfg = await loadConfig({ cwd: projectDir, isProjectTrusted: () => true, _globalDir: globalDir, _configDirName: ".pi" });
		expect(cfg.memIndexMaxLines).toBe(50);
	});
	it("ignores project config when not trusted", async () => {
		await mkdir(join(projectDir, ".pi"), { recursive: true });
		await writeFile(join(projectDir, ".pi", "pi-memory.json"), JSON.stringify({ memIndexMaxLines: 50 }));
		const cfg = await loadConfig({ cwd: projectDir, isProjectTrusted: () => false, _globalDir: globalDir, _configDirName: ".pi" });
		expect(cfg.memIndexMaxLines).toBe(200); // default, project ignored
	});
	it("expands ~ in memoryDir", async () => {
		await writeFile(join(globalDir, "pi-memory.json"), JSON.stringify({ memoryDir: "~/mymem" }));
		const cfg = await loadConfig({ cwd: projectDir, isProjectTrusted: () => true, _globalDir: globalDir, _configDirName: ".pi" });
		expect(cfg.memoryDir).not.toContain("~");
	});
});
