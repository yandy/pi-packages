import { describe, expect, it, vi } from "vitest";
import type { LspClient } from "../../src/lsp/client";
import { LspManager } from "../../src/lsp/manager";
import type { ServerDef } from "../../src/lsp/servers";

// Mock resolveServerForFile so tests don't depend on typescript-language-server
// being on PATH. Returns installed:true for .ts files.
const tsServer: ServerDef = {
	id: "ts",
	command: ["fake"],
	extensions: [".ts"],
	languageId: "typescript",
	installHint: "fake install hint",
};
vi.mock("../../src/lsp/servers", () => ({
	resolveServerForFile: (path: string) => (path.endsWith(".ts") ? { server: tsServer, installed: true } : null),
}));

class FakeLspClient {
	alive = false;
	starts = 0;
	stops = 0;
	hoverCalls = 0;
	markDead = () => {
		this.alive = false;
	};
	constructor(
		public root: string,
		public server: ServerDef,
	) {}
	async start() {
		this.starts++;
		this.alive = true;
	}
	async initialize() {}
	async openFile() {}
	async hover() {
		this.hoverCalls++;
		return { contents: "type" };
	}
	async documentSymbols() {
		return [];
	}
	async definition() {
		return null;
	}
	async references() {
		return [];
	}
	isAlive() {
		return this.alive;
	}
	command() {
		return this.server.command;
	}
	async stop() {
		this.stops++;
		this.alive = false;
	}
}

describe("LspManager", () => {
	it("lazily creates + caches one client per language", async () => {
		const factory = vi.fn((root, server) => new FakeLspClient(root, server) as unknown as LspClient);
		const m = new LspManager({ clientFactory: factory });
		await m.getClientForFile("/p/a.ts", "/p", undefined);
		await m.getClientForFile("/p/b.ts", "/p", undefined);
		expect(factory).toHaveBeenCalledTimes(1); // 同语言复用
		await m.dispose();
	});

	it("reaps idle client after timeout", async () => {
		vi.useFakeTimers();
		const fake = new FakeLspClient("/p", tsServer);
		const m = new LspManager({
			clientFactory: () => fake as unknown as LspClient,
			now: () => Date.now(),
			idleTimeoutMs: 1000,
			reaperIntervalMs: 500,
		});
		await m.getClientForFile("/p/a.ts", "/p", undefined);
		expect(fake.stops).toBe(0);
		vi.advanceTimersByTime(1500);
		expect(fake.stops).toBe(1); // 被空闲回收
		vi.useRealTimers();
		await m.dispose();
	});

	it("restarts once after crash (dead client) for read op", async () => {
		const fake = new FakeLspClient("/p", tsServer);
		const m = new LspManager({ clientFactory: () => fake as unknown as LspClient });
		await m.getClientForFile("/p/a.ts", "/p", undefined);
		fake.markDead();
		// 再次获取应重建（start 计数 +1）
		await m.getClientForFile("/p/a.ts", "/p", undefined);
		expect(fake.starts).toBe(2);
		await m.dispose();
	});

	it("dispose stops all", async () => {
		const fake = new FakeLspClient("/p", tsServer);
		const m = new LspManager({ clientFactory: () => fake as unknown as LspClient });
		await m.getClientForFile("/p/a.ts", "/p", undefined);
		await m.dispose();
		expect(fake.stops).toBeGreaterThanOrEqual(1);
	});
});
