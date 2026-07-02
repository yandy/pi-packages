import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { MOCK_BASE } = vi.hoisted(() => ({
	MOCK_BASE: `/tmp/pi-memory-wiring-${process.pid}`,
}));

vi.mock("../src/config", () => ({
	loadConfig: vi.fn().mockResolvedValue({
		enabled: true,
		memoryDir: MOCK_BASE,
		memIndexMaxLines: 200,
		memIndexMaxBytes: 25600,
		dream: { nudgeAfterSessions: 5, nudgeAfterHours: 24, model: "auto" },
		sessionSearch: { maxSessions: 10, maxMatches: 5 },
	}),
}));

vi.mock("../src/paths", () => ({
	resolveMemoryDir: vi.fn().mockResolvedValue(MOCK_BASE),
	safeTopicPath: vi.fn((_dir: string, topic: string) => `${_dir}/${topic}`),
	projectHash: vi.fn().mockResolvedValue("deadbeef"),
}));

vi.mock("../src/nudge", () => ({
	shouldNudge: vi.fn().mockResolvedValue({ nudge: false, message: "" }),
	writeDreamMeta: vi.fn().mockResolvedValue(undefined),
	readDreamMeta: vi.fn().mockResolvedValue({ lastDreamAt: null }),
}));

vi.mock("../src/session-search", () => ({
	searchSessions: vi.fn().mockResolvedValue(""),
}));

vi.mock("../src/dream", () => ({
	runDream: vi.fn().mockResolvedValue("done"),
	resolveDreamModel: vi.fn().mockReturnValue("test-model"),
}));

import memoryFactory from "../index";

function createFakePi() {
	const handlers: Record<string, Array<(event: any, ctx: any) => any | Promise<any>>> = {};
	const tools: any[] = [];
	const commands: Record<string, any> = {};

	return {
		handlers,
		tools,
		commands,
		pi: {
			on(event: string, handler: (event: any, ctx: any) => any | Promise<any>) {
				if (!handlers[event]) handlers[event] = [];
				handlers[event].push(handler);
			},
			registerTool(def: any) {
				tools.push(def);
			},
			registerCommand(name: string, opts: any) {
				commands[name] = opts;
			},
		},
	};
}

describe("index wiring (integration)", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "mem-wiring-"));
		await mkdir(MOCK_BASE, { recursive: true });
		await writeFile(
			`${MOCK_BASE}/MEMORY.md`,
			"- [SSH](ssh.md) — staging ssh config\n",
			"utf8",
		).catch(() => {});
	});

	afterEach(async () => {
		await rm(MOCK_BASE, { recursive: true, force: true }).catch(() => {});
		await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	});

	it("registers tool, commands, and freezes snapshot across before_agent_start calls", async () => {
		const { pi, tools, commands, handlers } = createFakePi();

		// Drive the factory with the fake pi
		memoryFactory(pi as any);

		// session_start must fire before before_agent_start
		expect(handlers["session_start"]).toBeDefined();
		expect(handlers["before_agent_start"]).toBeDefined();

		// Drive session_start with a fake ctx
		const fakeCtx = {
			cwd: tmpDir,
			hasUI: false,
			isProjectTrusted: () => true,
		};
		await handlers["session_start"][0]({}, fakeCtx);

		// Drive before_agent_start twice
		const event1 = { systemPrompt: "BASE_PROMPT" };
		const event2 = { systemPrompt: "BASE_PROMPT" };

		const result1 = await handlers["before_agent_start"][0](event1, undefined as any);
		const result2 = await handlers["before_agent_start"][0](event2, undefined as any);

		// Snapshot must be frozen: both returns should be identical
		expect(result1?.systemPrompt).toBeDefined();
		expect(result2?.systemPrompt).toBeDefined();
		expect(result1?.systemPrompt).toBe(result2?.systemPrompt);

		// The injected prompt should contain "# Memory Index" + the MEMORY.md content
		expect(result1?.systemPrompt).toContain("# Memory Index");
		expect(result1?.systemPrompt).toContain("[SSH](ssh.md)");

		// Tool must be registered
		expect(tools.length).toBeGreaterThanOrEqual(1);
		expect(tools[0].name).toBe("memory");

		// /memory and /dream commands must be registered
		expect(commands["memory"]).toBeDefined();
		expect(commands["dream"]).toBeDefined();
	});

	it("tool execute throws when config.enabled is false", async () => {
		const { createMemoryTool } = await import("../src/memory-tool");
		const tool = createMemoryTool({
			getMemoryDir: () => "/fake/dir",
			getConfig: () => ({ memIndexMaxLines: 200, memIndexMaxBytes: 25600, sessionSearch: { maxSessions: 10, maxMatches: 5 } }),
			getEnabled: () => false,
			searchSessions: async () => "",
			cwd: () => tmpDir,
		});

		await expect(
			tool.execute("id", { action: "search", query: "x", scope: "memory" }, undefined, undefined, undefined),
		).rejects.toThrow("Memory is disabled (run /memory on)");
	});
});
