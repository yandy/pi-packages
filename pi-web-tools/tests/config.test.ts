import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 与实现同构：实现用 resolve(agentDir, "web-tools.json") 与 resolve(cwd, CONFIG_DIR_NAME, "web-tools.json")
// 构造路径（src/config.ts），mock 期望值必须走同一组合，Windows 上才会命中。
const GLOBAL_CONFIG_PATH = resolve("/home/user/.myapp/agent", "web-tools.json");
const PROJECT_CONFIG_PATH = resolve("/project", ".myapp", "web-tools.json");

const mockReadFileSync = vi.fn();
vi.mock("node:fs", () => ({
	readFileSync: mockReadFileSync,
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	CONFIG_DIR_NAME: ".myapp",
	getAgentDir: () => "/home/user/.myapp/agent",
}));

let loadConfig: typeof import("../src/config.js").loadConfig;

beforeEach(() => {
	vi.resetModules();
	mockReadFileSync.mockReset();
});

async function importModule() {
	const mod = await import("../src/config.js");
	loadConfig = mod.loadConfig;
	return mod;
}

describe("loadConfig", () => {
	it("loads global config from AgentDir/web-tools.json", async () => {
		mockReadFileSync.mockImplementation((path: string) => {
			if (path === GLOBAL_CONFIG_PATH) {
				return JSON.stringify({ websearch: { provider: "deepseek" } });
			}
			throw new Error("ENOENT");
		});

		await importModule();
		const config = loadConfig("/project");

		expect(config.websearch?.provider).toBe("deepseek");
	});

	it("loads project config from cwd/CONFIG_DIR_NAME/web-tools.json", async () => {
		mockReadFileSync.mockImplementation((path: string) => {
			if (path === PROJECT_CONFIG_PATH) {
				return JSON.stringify({ webfetch: { provider: "deepseek" } });
			}
			throw new Error("ENOENT");
		});

		await importModule();
		const config = loadConfig("/project");

		expect(config.webfetch?.provider).toBe("deepseek");
	});

	it("project config overrides global config at section level", async () => {
		mockReadFileSync.mockImplementation((path: string) => {
			if (path === GLOBAL_CONFIG_PATH) {
				return JSON.stringify({
					websearch: { provider: "exa" },
					webfetch: { provider: "deepseek" },
				});
			}
			if (path === PROJECT_CONFIG_PATH) {
				return JSON.stringify({ websearch: { provider: "aliyun" } });
			}
			throw new Error("ENOENT");
		});

		await importModule();
		const config = loadConfig("/project");

		expect(config.websearch?.provider).toBe("aliyun");
		expect(config.webfetch?.provider).toBe("deepseek");
	});

	it("merges independent sections from global and project", async () => {
		mockReadFileSync.mockImplementation((path: string) => {
			if (path === GLOBAL_CONFIG_PATH) {
				return JSON.stringify({ websearch: { provider: "deepseek" } });
			}
			if (path === PROJECT_CONFIG_PATH) {
				return JSON.stringify({ webfetch: { provider: "deepseek" } });
			}
			throw new Error("ENOENT");
		});

		await importModule();
		const config = loadConfig("/project");

		expect(config.websearch?.provider).toBe("deepseek");
		expect(config.webfetch?.provider).toBe("deepseek");
	});

	it("returns empty config when neither global nor project config exists", async () => {
		mockReadFileSync.mockImplementation(() => {
			throw new Error("ENOENT");
		});

		await importModule();
		const config = loadConfig("/project");

		expect(config).toEqual({});
	});

	it("caches config per cwd", async () => {
		let readCount = 0;
		mockReadFileSync.mockImplementation((path: string) => {
			readCount++;
			if (path === GLOBAL_CONFIG_PATH) {
				return JSON.stringify({ websearch: { provider: "exa" } });
			}
			throw new Error("ENOENT");
		});

		await importModule();
		loadConfig("/project");
		loadConfig("/project");

		expect(readCount).toBeLessThanOrEqual(2);
	});
});
