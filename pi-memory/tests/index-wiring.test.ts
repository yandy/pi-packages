import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { MOCK_BASE, mockConfigValue } = vi.hoisted(() => {
	const cfg: Record<string, any> = {
		enabled: true,
		memoryDir: "",
		memIndexMaxLines: 200,
		memIndexMaxBytes: 25600,
		dream: { nudgeAfterSessions: 5, nudgeAfterHours: 24, thinkLevel: "high" as const },
		sessionSearch: { maxSessions: 10, maxMatches: 5 },
		autoSurfacing: {
			enabled: true,
			maxFiles: 5,
			maxTopicBytes: 4096,
			maxInjectionBytes: 20480,
			thinkLevel: "off" as const,
		},
		extractMemories: {
			enabled: false,
			maxContextTokens: 2000,
			thinkLevel: "high" as const,
		},
	};
	return { MOCK_BASE: `/tmp/pi-memory-wiring-${process.pid}`, mockConfigValue: cfg };
});

const { scanTopicsMock, runSideQueryMock, injectSurfacedContentMock } = vi.hoisted(() => ({
	scanTopicsMock: vi.fn(),
	runSideQueryMock: vi.fn(),
	injectSurfacedContentMock: vi.fn(),
}));

vi.mock("../src/config", () => ({
	loadConfig: vi.fn().mockImplementation(async () => {
		const cfg = { ...mockConfigValue };
		cfg.memoryDir = MOCK_BASE;
		return cfg;
	}),
}));

vi.mock("../src/paths", () => ({
	resolveMemoryDir: vi.fn().mockResolvedValue(MOCK_BASE),
	safeTopicPath: vi.fn((_dir: string, topic: string) => `${_dir}/${topic}`),
	projectHash: vi.fn().mockResolvedValue("deadbeef"),
}));

vi.mock("../src/nudge", () => ({
	shouldNudge: vi.fn().mockResolvedValue({ nudge: false, message: "", sessions: 0, newEntries: 0 }),
	writeDreamMeta: vi.fn().mockResolvedValue(undefined),
	readDreamMeta: vi.fn().mockResolvedValue({ lastDreamAt: null }),
}));

vi.mock("../src/session-search", () => ({
	searchSessions: vi.fn().mockResolvedValue(""),
}));

vi.mock("../src/dream", () => ({
	runDream: vi.fn().mockResolvedValue("done"),
	buildDreamTask: vi.fn().mockReturnValue("dream task"),
}));

vi.mock("../src/inject", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/inject")>();
	return {
		...actual,
		scanTopics: scanTopicsMock,
		runSideQuery: runSideQueryMock,
		injectSurfacedContent: injectSurfacedContentMock,
	};
});

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

		// Reset mock call counts
		scanTopicsMock.mockReset();
		runSideQueryMock.mockReset();
		injectSurfacedContentMock.mockReset();
	});

	afterEach(async () => {
		await rm(MOCK_BASE, { recursive: true, force: true }).catch(() => {});
		await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	});

	it("registers tool, commands, and freezes snapshot across before_agent_start calls", async () => {
		const { pi, tools, commands, handlers } = createFakePi();

		memoryFactory(pi as any);

		expect(handlers["session_start"]).toBeDefined();
		expect(handlers["before_agent_start"]).toBeDefined();

		const fakeCtx = { cwd: tmpDir, hasUI: false, isProjectTrusted: () => true };
		await handlers["session_start"][0]({}, fakeCtx);

		// Drive before_agent_start twice (no prompt → auto-surfacing skipped)
		const event1 = { systemPrompt: "BASE_PROMPT" };
		const event2 = { systemPrompt: "BASE_PROMPT" };

		const result1 = await handlers["before_agent_start"][0](event1, undefined as any);
		const result2 = await handlers["before_agent_start"][0](event2, undefined as any);

		expect(result1?.systemPrompt).toBeDefined();
		expect(result2?.systemPrompt).toBeDefined();
		expect(result1?.systemPrompt).toBe(result2?.systemPrompt);
		expect(result1?.systemPrompt).toContain("# Memory Index");
		expect(result1?.systemPrompt).toContain("[SSH](ssh.md)");

		expect(tools.length).toBeGreaterThanOrEqual(1);
		expect(tools[0].name).toBe("memory");

		expect(commands["memory"]).toBeDefined();
		expect(commands["dream"]).toBeDefined();
	});

	it("runs auto-surfacing for main agents", async () => {
		const { pi, handlers } = createFakePi();

		memoryFactory(pi as any);

		const fakeCtx = { cwd: tmpDir, hasUI: false, isProjectTrusted: () => true };
		await handlers["session_start"][0]({}, fakeCtx);

		// Mock auto-surfacing functions
		scanTopicsMock.mockResolvedValue([
			{ filename: "ssh.md", name: "SSH", description: "ssh config", type: "project", mtimeMs: 100 },
		]);
		runSideQueryMock.mockResolvedValue(["ssh.md"]);
		// biome-ignore lint/style/useTemplate: clear separator
		injectSurfacedContentMock.mockResolvedValue(
			"<relevant_memories>\n## ssh.md\nssh config\n</relevant_memories>",
		);

		// Main agent event (simple prompt with no subagent-specific checks)
		const mainEvent = {
			prompt: "how do I debug SSH?",
			systemPrompt: "Normal system prompt",
			systemPromptOptions: {
				cwd: tmpDir,
				selectedTools: ["read", "bash", "edit", "write", "grep", "find", "websearch"],
			},
		};

		const mainCtx = {
			cwd: tmpDir,
			hasUI: false,
			modelRegistry: {},
			model: undefined,
		};
		const result = await handlers["before_agent_start"][0](mainEvent, mainCtx as any);

		// Auto-surfacing must have run
		expect(scanTopicsMock).toHaveBeenCalledTimes(1);
		expect(runSideQueryMock).toHaveBeenCalledTimes(1);
		expect(runSideQueryMock).toHaveBeenCalledWith(
			expect.any(Array), expect.any(String), expect.any(Set), 5, "off",
			undefined, expect.any(Object), undefined, MOCK_BASE, undefined,
		);

		// Result must include both injected content and MEMORY.md index
		expect(result?.systemPrompt).toBeDefined();
		expect(result?.systemPrompt).toContain("# Memory Index");
	});

	it("skips auto-surfacing for subagents (has <active_agent> tag in systemPrompt)", async () => {
		const { pi, handlers } = createFakePi();

		memoryFactory(pi as any);

		const fakeCtx = { cwd: tmpDir, hasUI: false, isProjectTrusted: () => true };
		await handlers["session_start"][0]({}, fakeCtx);

		scanTopicsMock.mockResolvedValue([
			{ filename: "ssh.md", name: "SSH", description: "ssh config", type: "project", mtimeMs: 100 },
		]);

		// Subagent: systemPrompt contains pi-subagents' <active_agent> marker
		const subagentCtx = {
			cwd: tmpDir,
			hasUI: false,
			modelRegistry: {},
			model: undefined,
		};
		const subagentEvent = {
			prompt: "how do I debug SSH?",
			systemPrompt: "Normal system prompt\n\n<active_agent name=\"general-purpose\"/>\n\n# Environment\nWorking directory: /project",
			systemPromptOptions: { cwd: tmpDir, selectedTools: ["read", "write", "edit", "ls"] },
		};

		const result = await handlers["before_agent_start"][0](subagentEvent, subagentCtx as any);

		// Auto-surfacing must NOT run for subagents
		expect(scanTopicsMock).not.toHaveBeenCalled();
		expect(runSideQueryMock).not.toHaveBeenCalled();
		// MEMORY.md index injection still happens
		expect(result?.systemPrompt).toContain("# Memory Index");
	});

	it("resolveDefault: uses defaults.sessionPersistence when per-task is undefined", async () => {
		mockConfigValue.defaults = { sessionPersistence: { enabled: true } };
		// Ensure per-task has no sessionPersistence
		delete (mockConfigValue.autoSurfacing as any).sessionPersistence;

		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);

		const fakeCtx = { cwd: tmpDir, hasUI: false, isProjectTrusted: () => true };
		await handlers["session_start"][0]({}, fakeCtx);

		scanTopicsMock.mockResolvedValue([
			{ filename: "ssh.md", name: "SSH", description: "ssh config", type: "project", mtimeMs: 100 },
		]);
		runSideQueryMock.mockResolvedValue(["ssh.md"]);
		injectSurfacedContentMock.mockResolvedValue("<relevant_memories>\n## ssh.md\nssh config\n</relevant_memories>");

		const mainEvent = {
			prompt: "how do I debug SSH?",
			systemPrompt: "Normal system prompt",
			systemPromptOptions: { cwd: tmpDir, selectedTools: ["read", "bash"] },
		};
		const mainCtx = { cwd: tmpDir, hasUI: false, modelRegistry: {}, model: undefined };
		await handlers["before_agent_start"][0](mainEvent, mainCtx as any);

		// defaults.sessionPersistence flows through resolveDefault to runSideQuery
		expect(runSideQueryMock).toHaveBeenCalledWith(
			expect.any(Array), expect.any(String), expect.any(Set), 5, "off",
			undefined, expect.any(Object), undefined, MOCK_BASE, { enabled: true },
		);

		// Clean up
		delete mockConfigValue.defaults;
	});

	it("resolveDefault: per-task sessionPersistence overrides defaults.sessionPersistence", async () => {
		mockConfigValue.defaults = { sessionPersistence: { enabled: true } };
		(mockConfigValue.autoSurfacing as any).sessionPersistence = { enabled: false };

		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);

		const fakeCtx = { cwd: tmpDir, hasUI: false, isProjectTrusted: () => true };
		await handlers["session_start"][0]({}, fakeCtx);

		scanTopicsMock.mockResolvedValue([
			{ filename: "ssh.md", name: "SSH", description: "ssh config", type: "project", mtimeMs: 100 },
		]);
		runSideQueryMock.mockResolvedValue(["ssh.md"]);
		injectSurfacedContentMock.mockResolvedValue("<relevant_memories>\n## ssh.md\nssh config\n</relevant_memories>");

		const mainEvent = {
			prompt: "how do I debug SSH?",
			systemPrompt: "Normal system prompt",
			systemPromptOptions: { cwd: tmpDir, selectedTools: ["read", "bash"] },
		};
		const mainCtx = { cwd: tmpDir, hasUI: false, modelRegistry: {}, model: undefined };
		await handlers["before_agent_start"][0](mainEvent, mainCtx as any);

		// Per-task override wins over defaults
		expect(runSideQueryMock).toHaveBeenCalledWith(
			expect.any(Array), expect.any(String), expect.any(Set), 5, "off",
			undefined, expect.any(Object), undefined, MOCK_BASE, { enabled: false },
		);

		// Clean up
		delete mockConfigValue.defaults;
		delete (mockConfigValue.autoSurfacing as any).sessionPersistence;
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
