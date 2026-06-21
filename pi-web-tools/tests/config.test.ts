import { beforeEach, describe, expect, it, vi } from "vitest";

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
			if (path === "/home/user/.myapp/agent/web-tools.json") {
				return JSON.stringify({ aliyun: { baseUrl: "https://global.example.com" } });
			}
			throw new Error("ENOENT");
		});

		await importModule();
		const config = loadConfig("/project");

		expect(config.aliyun?.baseUrl).toBe("https://global.example.com");
	});

	it("loads project config from cwd/CONFIG_DIR_NAME/agent/web-tools.json", async () => {
		mockReadFileSync.mockImplementation((path: string) => {
			if (path === "/project/.myapp/agent/web-tools.json") {
				return JSON.stringify({ aliyun: { baseUrl: "https://project.example.com" } });
			}
			throw new Error("ENOENT");
		});

		await importModule();
		const config = loadConfig("/project");

		expect(config.aliyun?.baseUrl).toBe("https://project.example.com");
	});

	it("project config overrides global config at section level", async () => {
		mockReadFileSync.mockImplementation((path: string) => {
			if (path === "/home/user/.myapp/agent/web-tools.json") {
				return JSON.stringify({
					aliyun: { baseUrl: "https://global.example.com", aliyunProviderKey: "global-provider" },
				});
			}
			if (path === "/project/.myapp/agent/web-tools.json") {
				return JSON.stringify({ aliyun: { baseUrl: "https://project.example.com" } });
			}
			throw new Error("ENOENT");
		});

		await importModule();
		const config = loadConfig("/project");

		expect(config.aliyun?.baseUrl).toBe("https://project.example.com");
		expect(config.aliyun?.aliyunProviderKey).toBe("global-provider");
	});

	it("returns empty config when neither global nor project config exists", async () => {
		mockReadFileSync.mockImplementation(() => {
			throw new Error("ENOENT");
		});

		await importModule();
		const config = loadConfig("/project");

		expect(config).toEqual({});
	});

	it("uses global config when project config is absent", async () => {
		mockReadFileSync.mockImplementation((path: string) => {
			if (path === "/home/user/.myapp/agent/web-tools.json") {
				return JSON.stringify({ aliyun: { baseUrl: "https://global.example.com" } });
			}
			throw new Error("ENOENT");
		});

		await importModule();
		const config = loadConfig("/project");

		expect(config.aliyun?.baseUrl).toBe("https://global.example.com");
	});

	it("caches config per cwd", async () => {
		let readCount = 0;
		mockReadFileSync.mockImplementation((path: string) => {
			readCount++;
			if (path === "/home/user/.myapp/agent/web-tools.json") {
				return JSON.stringify({ aliyun: { baseUrl: "https://global.example.com" } });
			}
			throw new Error("ENOENT");
		});

		await importModule();
		loadConfig("/project");
		loadConfig("/project");

		expect(readCount).toBeLessThanOrEqual(2);
	});
});
