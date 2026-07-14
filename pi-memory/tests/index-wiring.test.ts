import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { MOCK_BASE } = vi.hoisted(() => ({
	MOCK_BASE: `/tmp/pi-memory-wiring-${process.pid}`,
}));

const { scanTopicsMock, runSideQueryMock, injectSurfacedContentMock } = vi.hoisted(() => ({
	scanTopicsMock: vi.fn(),
	runSideQueryMock: vi.fn(),
	injectSurfacedContentMock: vi.fn(),
}));

vi.mock("../src/config", () => ({
	loadConfig: vi.fn().mockResolvedValue({
		enabled: true,
		memoryDir: MOCK_BASE,
		memIndexMaxLines: 200,
		memIndexMaxBytes: 25600,
		dream: { nudgeAfterSessions: 5, nudgeAfterHours: 24, thinkLevel: "high" },
		sessionSearch: { maxSessions: 10, maxMatches: 5 },
		autoSurfacing: {
			enabled: true,
			thinkLevel: "off",
			maxFiles: 5,
			maxTopicBytes: 4096,
			maxInjectionBytes: 20480,
		},
		extractMemories: {
			enabled: false,
			thinkLevel: "high",
			maxContextTokens: 2000,
		},
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

const fakeModelRegistry = { find: vi.fn(), getAvailable: vi.fn().mockReturnValue([]) };

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

		const fakeCtx = { cwd: tmpDir, hasUI: false, isProjectTrusted: () => true, modelRegistry: fakeModelRegistry };
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

	it("skips auto-surfacing when systemPrompt has <active_agent name= marker", async () => {
		const { pi, handlers } = createFakePi();

		memoryFactory(pi as any);

		const fakeCtx = { cwd: tmpDir, hasUI: false, isProjectTrusted: () => true, modelRegistry: fakeModelRegistry };
		await handlers["session_start"][0]({}, fakeCtx);

		scanTopicsMock.mockResolvedValue([]);

		const subagentEvent = {
			prompt: "Some subagent task...",
			systemPrompt: "Base prompt\n<active_agent name=\"general-purpose\"/>\n\n# Environment\n...",
			systemPromptOptions: {
				cwd: tmpDir,
				selectedTools: ["read", "write", "edit", "ls"],
			},
		};

		const result = await handlers["before_agent_start"][0](subagentEvent, fakeCtx);
		expect(result?.systemPrompt).toContain("# Memory Index");
		expect(scanTopicsMock).not.toHaveBeenCalled();
	});

	it("runs auto-surfacing when systemPrompt has no <active_agent name= marker", async () => {
		const { pi, handlers } = createFakePi();

		memoryFactory(pi as any);

		const fakeCtx = { cwd: tmpDir, hasUI: false, isProjectTrusted: () => true, modelRegistry: fakeModelRegistry };
		await handlers["session_start"][0]({}, fakeCtx);

		scanTopicsMock.mockResolvedValue([
			{ filename: "ssh.md", name: "SSH", description: "ssh config", type: "project", mtimeMs: 100 },
		]);
		runSideQueryMock.mockResolvedValue(["ssh.md"]);
		injectSurfacedContentMock.mockResolvedValue(
			"<relevant_memories>\n## ssh.md\nssh config\n</relevant_memories>",
		);

		const mainEvent = {
			prompt: "how do I debug SSH?",
			systemPrompt: "Normal system prompt",
			systemPromptOptions: {
				cwd: tmpDir,
				selectedTools: ["read", "bash", "edit", "write"],
			},
		};

		const result = await handlers["before_agent_start"][0](mainEvent, fakeCtx);
		expect(scanTopicsMock).toHaveBeenCalledTimes(1);
		expect(runSideQueryMock).toHaveBeenCalledTimes(1);
		expect(result?.systemPrompt).toContain("# Memory Index");
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
