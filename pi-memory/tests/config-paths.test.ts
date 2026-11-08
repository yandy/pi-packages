import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configFiles, loadConfig } from "../src/config";

/**
 * pi 侧配置层的全部职责：**读哪些文件**。
 *
 * 合并语义、`~` 展开、默认值都在 core（钉在 `auto-memory/tests/config.test.ts`）；这里只钉
 * `configFiles` 的路径组装与信任门 —— 那是宿主知识，core 对 `.pi` 一无所知（spec D4）。
 */
describe("configFiles", () => {
	it("lists the global file first and the project file second when trusted", () => {
		// 期望值一律用 join() 派生：写死 "/g/memory.json" 在 Windows 上会变成 `\g\memory.json`
		expect(configFiles({ cwd: "/proj", isProjectTrusted: () => true, _globalDir: "/g", _configDirName: ".pi" })).toEqual([
			join("/g", "memory.json"),
			join("/proj", ".pi", "memory.json"),
		]);
	});

	it("omits the project file when the project is not trusted", () => {
		expect(configFiles({ cwd: "/proj", isProjectTrusted: () => false, _globalDir: "/g", _configDirName: ".pi" })).toEqual([
			join("/g", "memory.json"),
		]);
	});

	it("honours the injected config dir name", () => {
		expect(configFiles({ cwd: "/proj", isProjectTrusted: () => true, _globalDir: "/g", _configDirName: ".other" })).toEqual([
			join("/g", "memory.json"),
			join("/proj", ".other", "memory.json"),
		]);
	});

	it("defaults to pi's agent dir and config dir name when no seam is given", () => {
		expect(configFiles({ cwd: "/proj", isProjectTrusted: () => true })).toEqual([
			join(getAgentDir(), "memory.json"),
			join("/proj", CONFIG_DIR_NAME, "memory.json"),
		]);
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

	const ctx = (isProjectTrusted: boolean) => ({
		cwd: projectDir,
		isProjectTrusted: () => isProjectTrusted,
		_globalDir: globalDir,
		_configDirName: ".pi",
	});

	it("lets the project config override the global one when trusted", async () => {
		await writeFile(join(globalDir, "memory.json"), JSON.stringify({ memIndexMaxLines: 100 }));
		await mkdir(join(projectDir, ".pi"), { recursive: true });
		await writeFile(join(projectDir, ".pi", "memory.json"), JSON.stringify({ memIndexMaxLines: 50 }));
		expect((await loadConfig(ctx(true))).memIndexMaxLines).toBe(50);
	});

	it("ignores the project config when the project is not trusted", async () => {
		await mkdir(join(projectDir, ".pi"), { recursive: true });
		await writeFile(join(projectDir, ".pi", "memory.json"), JSON.stringify({ memIndexMaxLines: 50 }));
		expect((await loadConfig(ctx(false))).memIndexMaxLines).toBe(200); // default, project ignored
	});

	it("reads memory.json, not pi-memory.json", async () => {
		await writeFile(
			join(globalDir, "memory.json"),
			JSON.stringify({ autoSurfacing: { enabled: false }, extractMemories: { maxContextTokens: 1000 } }),
		);
		// 负向断言：按包名直觉的错拼必须被忽略 —— 若它被读进来，enabled 会翻回 true、maxFiles 会变成 99。
		await writeFile(join(globalDir, "pi-memory.json"), JSON.stringify({ autoSurfacing: { enabled: true, maxFiles: 99 } }));
		const cfg = await loadConfig(ctx(true));
		expect(cfg.autoSurfacing.enabled).toBe(false);
		expect(cfg.autoSurfacing.maxFiles).toBe(3);
		expect(cfg.extractMemories.maxContextTokens).toBe(1000);
		expect(cfg.autoSurfacing.model).toBeUndefined();
	});

	it("passes the platform seam through to the tilde expansion", async () => {
		// `~\` 只在 win32 展开；POSIX 上它是合法文件名。两边各跑一次才能钉住「缝确实传下去了」。
		await writeFile(join(globalDir, "memory.json"), JSON.stringify({ memoryDir: "~\\mem" }));
		expect((await loadConfig({ ...ctx(false), _platform: "win32" })).memoryDir).toBe(join(homedir(), "mem"));
		expect((await loadConfig({ ...ctx(false), _platform: "linux" })).memoryDir).toBe("~\\mem");
	});
});
