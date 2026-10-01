import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockConfigValue, dirRef } = vi.hoisted(() => ({
	mockConfigValue: {
		enabled: true,
		memoryDir: "",
		memIndexMaxLines: 200,
		memIndexMaxBytes: 25600,
		memIndexInjectMaxLines: 20,
		memIndexInjectMaxBytes: 3072,
		lock: { timeoutMs: 5000, snapshotKeep: 5 },
		dream: { nudgeAfterSessions: 5, nudgeAfterHours: 24, thinkLevel: "high" as const },
		sessionSearch: { maxSessions: 10, maxMatches: 5 },
		autoSurfacing: {
			enabled: true,
			maxFiles: 5,
			maxEntryBytes: 4096,
			maxInjectionBytes: 20480,
			thinkLevel: "off" as const,
		},
		extractMemories: {
			enabled: false,
			maxContextTokens: 2000,
			maxToolResultChars: 500,
			maxAssistantChars: 2000,
			thinkLevel: "high" as const,
		},
	} as Record<string, any>,
	// vi.mock 的工厂是 hoisted 的，拿不到 beforeEach 里创建的目录 —— 用一个可变引用桥接
	// （docs/guides/testing.md 的「getAgentDir 隔离」一节）。
	dirRef: { current: "" },
}));

const { scanEntriesMock, runSideQueryMock, injectSurfacedContentMock, runExtractMock, runDreamMock, shouldNudgeMock } =
	vi.hoisted(() => ({
		scanEntriesMock: vi.fn(),
		runSideQueryMock: vi.fn(),
		injectSurfacedContentMock: vi.fn(),
		runExtractMock: vi.fn().mockResolvedValue({ skipped: false, result: "saved 1" }),
		runDreamMock: vi.fn().mockResolvedValue("consolidated"),
		shouldNudgeMock: vi.fn(),
	}));

vi.mock("../src/config", () => ({
	loadConfig: vi.fn().mockImplementation(async () => ({ ...mockConfigValue, memoryDir: dirRef.current })),
}));

vi.mock("../src/paths", () => ({
	resolveMemoryDir: vi.fn().mockImplementation(async () => dirRef.current),
}));

vi.mock("../src/nudge", () => ({
	shouldNudge: shouldNudgeMock,
	writeDreamMeta: vi.fn().mockResolvedValue(undefined),
	readDreamMeta: vi.fn().mockResolvedValue({ lastDreamAt: null }),
}));

vi.mock("../src/session-search", () => ({
	searchSessions: vi.fn().mockResolvedValue(""),
}));

vi.mock("../src/dream", () => ({
	runDream: runDreamMock,
	buildDreamTask: vi.fn().mockReturnValue("dream task"),
}));

vi.mock("../src/extract", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/extract")>();
	return { ...actual, runExtract: runExtractMock };
});

// 只替换 auto-surfacing 的三个函数：loadIndexSnapshot / buildInjection 走真实实现，
// 这样「索引注入在 Plan B 保持现状」这件事本身也被钉住。
vi.mock("../src/inject", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/inject")>();
	return {
		...actual,
		scanEntries: scanEntriesMock,
		runSideQuery: runSideQueryMock,
		injectSurfacedContent: injectSurfacedContentMock,
	};
});

import memoryFactory from "../index";

const LEGACY_TOPIC = [
	"---",
	"name: debugging",
	"description: SSH",
	"type: project",
	"updated: 2026-07-03",
	"---",
	"",
	"## SSH Gotcha",
	"",
	"staging 的 SSH 用 2222 端口",
	"",
].join("\n");

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

function uiCtx(over: Record<string, unknown> = {}) {
	return {
		cwd: dirRef.current,
		hasUI: false,
		isProjectTrusted: () => true,
		modelRegistry: {},
		model: undefined,
		...over,
	} as any;
}

describe("index wiring (integration)", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "mem-wiring-"));
		dirRef.current = dir;
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "MEMORY.md"), "- [SSH](ssh.md) — staging ssh config\n", "utf8");

		scanEntriesMock.mockReset();
		runSideQueryMock.mockReset();
		injectSurfacedContentMock.mockReset();
		runExtractMock.mockClear();
		runDreamMock.mockClear();
		shouldNudgeMock.mockReset();
		shouldNudgeMock.mockResolvedValue({ nudge: false, message: "", sessions: 0, newEntries: 0 });
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
		delete mockConfigValue.defaults;
		delete (mockConfigValue.autoSurfacing as any).sessionPersistence;
		mockConfigValue.extractMemories.enabled = false;
	});

	it("registers exactly one memory tool with the five main-agent actions", async () => {
		const { pi, tools, commands, handlers } = createFakePi();
		memoryFactory(pi as any);

		expect(handlers["session_start"]).toBeDefined();
		expect(handlers["before_agent_start"]).toBeDefined();
		expect(handlers["agent_end"]).toBeDefined();

		await handlers["session_start"][0]({}, uiCtx());

		expect(tools).toHaveLength(1);
		expect(tools[0].name).toBe("memory");
		// D12：主 agent 的 schema 只有 5 个 action，且不含 dream 专属的 new_name 参数
		expect(tools[0].parameters.properties.action.enum).toEqual([
			"add",
			"replace",
			"remove",
			"list",
			"search",
		]);
		expect(Object.keys(tools[0].parameters.properties)).not.toContain("new_name");
		expect(commands["memory"]).toBeDefined();
		expect(commands["dream"]).toBeDefined();
	});

	it("registers the tool only once across sessions", async () => {
		const { pi, tools, handlers } = createFakePi();
		memoryFactory(pi as any);

		await handlers["session_start"][0]({}, uiCtx());
		await handlers["session_start"][0]({}, uiCtx());

		expect(tools).toHaveLength(1);
	});

	it("writes through the store end to end", async () => {
		const { pi, tools, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		const result = await tools[0].execute(
			"call-1",
			{ action: "add", name: "Use real DB in tests", description: "不要 mock", content: "集成测试必须连真实 PostgreSQL。" },
			undefined,
			undefined,
			undefined as any,
		);

		expect(result.content[0].text).toBe('Saved "Use real DB in tests" (Use-real-DB-in-tests.md).');
		const raw = await readFile(join(dir, "Use-real-DB-in-tests.md"), "utf8");
		expect(raw).toContain("name: Use real DB in tests");
		expect(raw).toContain("modified:");
		expect(raw).not.toContain("updated:");
		const index = await readFile(join(dir, "MEMORY.md"), "utf8");
		expect(index).toContain("- [SSH](ssh.md) — staging ssh config");
		expect(index).toContain("- [Use real DB in tests](Use-real-DB-in-tests.md) — 不要 mock");
	});

	it("freezes the index snapshot across before_agent_start calls", async () => {
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		const result1 = await handlers["before_agent_start"][0]({ systemPrompt: "BASE_PROMPT" }, uiCtx());
		// 会话中途磁盘上的索引被改了（另一个 worktree 写入）：注入值必须不变
		await writeFile(join(dir, "MEMORY.md"), "- [SSH](ssh.md) — changed\n", "utf8");
		const result2 = await handlers["before_agent_start"][0]({ systemPrompt: "BASE_PROMPT" }, uiCtx());

		expect(result1?.systemPrompt).toBe(
			"BASE_PROMPT\n\n# Memory Index\n- [SSH](ssh.md) — staging ssh config\n",
		);
		expect(result2?.systemPrompt).toBe(result1?.systemPrompt);
		expect(result2?.systemPrompt).not.toContain("changed");
	});

	it("runs auto-surfacing through the store for main agents", async () => {
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		scanEntriesMock.mockResolvedValue([
			{ file: "ssh.md", name: "SSH", description: "ssh config", type: "project", modified: "2026-01-01T00:00:00.000Z" },
		]);
		runSideQueryMock.mockResolvedValue(["ssh.md"]);
		injectSurfacedContentMock.mockResolvedValue("<relevant_memories>\n## SSH\nssh config\n</relevant_memories>");

		const result = await handlers["before_agent_start"][0](
			{ prompt: "how do I debug SSH?", systemPrompt: "Normal system prompt" },
			uiCtx(),
		);

		expect(scanEntriesMock).toHaveBeenCalledTimes(1);
		// 清单来自 store（不是逐文件 readFile）
		expect(typeof scanEntriesMock.mock.calls[0][0].readEntry).toBe("function");
		expect(runSideQueryMock).toHaveBeenCalledTimes(1);
		expect(runSideQueryMock.mock.calls[0][2]).toBeInstanceOf(Set);
		expect(injectSurfacedContentMock).toHaveBeenCalledWith(
			scanEntriesMock.mock.calls[0][0],
			["ssh.md"],
			4096,
			20480,
		);
		expect(result?.message).toEqual({
			customType: "memory-auto-surfacing",
			content: "<relevant_memories>\n## SSH\nssh config\n</relevant_memories>",
			display: false,
		});
		expect(result?.systemPrompt).toContain("# Memory Index");
	});

	it("does not surface the same entry file twice in one session", async () => {
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		scanEntriesMock.mockResolvedValue([
			{ file: "ssh.md", name: "SSH", description: "d", type: "project", modified: "2026-01-01T00:00:00.000Z" },
		]);
		runSideQueryMock.mockResolvedValue(["ssh.md"]);
		injectSurfacedContentMock.mockResolvedValue("<relevant_memories>x</relevant_memories>");

		const event = { prompt: "ssh?", systemPrompt: "sp" };
		await handlers["before_agent_start"][0](event, uiCtx());
		// 第二轮：runSideQuery 收到的 injectedFiles 里已经有 ssh.md
		await handlers["before_agent_start"][0](event, uiCtx());

		expect(runSideQueryMock.mock.calls[1][2]).toEqual(new Set(["ssh.md"]));
	});

	it("skips auto-surfacing for subagents", async () => {
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());
		scanEntriesMock.mockResolvedValue([
			{ file: "ssh.md", name: "SSH", description: "d", type: "project", modified: "2026-01-01T00:00:00.000Z" },
		]);

		const result = await handlers["before_agent_start"][0](
			{
				prompt: "how do I debug SSH?",
				systemPrompt: 'sp\n\n<active_agent name="general-purpose"/>\n',
			},
			uiCtx(),
		);

		expect(scanEntriesMock).not.toHaveBeenCalled();
		expect(runSideQueryMock).not.toHaveBeenCalled();
		expect(result?.systemPrompt).toContain("# Memory Index");
	});

	it("resolveDefault: defaults.sessionPersistence flows through to runSideQuery", async () => {
		mockConfigValue.defaults = { sessionPersistence: { enabled: true } };
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		scanEntriesMock.mockResolvedValue([
			{ file: "ssh.md", name: "SSH", description: "d", type: "project", modified: "2026-01-01T00:00:00.000Z" },
		]);
		runSideQueryMock.mockResolvedValue([]);

		await handlers["before_agent_start"][0]({ prompt: "q", systemPrompt: "sp" }, uiCtx());

		expect(runSideQueryMock.mock.calls[0][9]).toEqual({ enabled: true });
	});

	it("resolveDefault: per-task sessionPersistence overrides defaults", async () => {
		mockConfigValue.defaults = { sessionPersistence: { enabled: true } };
		(mockConfigValue.autoSurfacing as any).sessionPersistence = { enabled: false };
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		scanEntriesMock.mockResolvedValue([
			{ file: "ssh.md", name: "SSH", description: "d", type: "project", modified: "2026-01-01T00:00:00.000Z" },
		]);
		runSideQueryMock.mockResolvedValue([]);

		await handlers["before_agent_start"][0]({ prompt: "q", systemPrompt: "sp" }, uiCtx());

		expect(runSideQueryMock.mock.calls[0][9]).toEqual({ enabled: false });
	});

	it("agent_end hands the raw messages, char limits and a 5-action tool to runExtract", async () => {
		mockConfigValue.extractMemories.enabled = true;
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		const messages = [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: [{ type: "text", text: "hi" }] },
		];
		await handlers["agent_end"][0]({ messages }, uiCtx());

		expect(runExtractMock).toHaveBeenCalledTimes(1);
		const args = runExtractMock.mock.calls[0][0];
		// spec §11.1：消息**原样**透传，不再被压成 {role, content} 字符串
		expect(args.messages).toBe(messages);
		expect(args.maxContextTokens).toBe(2000);
		expect(args.maxToolResultChars).toBe(500);
		expect(args.maxAssistantChars).toBe(2000);
		expect(typeof args.store.tryWithLogicalLock).toBe("function");
		expect(args.customTools).toHaveLength(1);
		expect(args.customTools[0].name).toBe("memory");
		expect(args.customTools[0].parameters.properties.action.enum).toEqual([
			"add",
			"replace",
			"remove",
			"list",
			"search",
		]);
	});

	it("agent_end extracts AGENTS.md blocks from the last system prompt", async () => {
		mockConfigValue.extractMemories.enabled = true;
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		const sysPrompt = [
			"pi base...",
			'<project_instructions path="/home/user/.pi/agent/AGENTS.md">',
			"global: use Chinese",
			"</project_instructions>",
			'<project_instructions path="/project/AGENTS.md">',
			"project: never skip tests",
			"</project_instructions>",
		].join("\n");
		await handlers["before_agent_start"][0]({ systemPrompt: sysPrompt }, uiCtx());
		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "hello" }] }, uiCtx());

		const blocks = runExtractMock.mock.calls[0][0].agentsMdBlocks;
		expect(blocks).toHaveLength(2);
		expect(blocks[0]).toContain("global: use Chinese");
		expect(blocks[1]).toContain("project: never skip tests");
	});

	it("agent_end passes an empty AGENTS.md list when there are none", async () => {
		mockConfigValue.extractMemories.enabled = true;
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		await handlers["before_agent_start"][0]({ systemPrompt: "no AGENTS.md here" }, uiCtx());
		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "hello" }] }, uiCtx());

		expect(runExtractMock.mock.calls[0][0].agentsMdBlocks).toEqual([]);
	});

	it("agent_end does nothing when extract is disabled", async () => {
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "hello" }] }, uiCtx());

		expect(runExtractMock).not.toHaveBeenCalled();
	});

	it("migrates a legacy directory during session_start and notifies the user", async () => {
		await writeFile(join(dir, "debugging.md"), LEGACY_TOPIC, "utf8");
		const notify = vi.fn();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);

		await handlers["session_start"][0]({}, uiCtx({ hasUI: true, ui: { notify, confirm: vi.fn(), setStatus: vi.fn() } }));

		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0][0]).toContain("Migrated 1 memories from 1 topic files");
		expect(notify.mock.calls[0][0]).toContain(join(dir, ".backups", "migrate-"));
		expect(notify.mock.calls[0][1]).toBe("info");
		// 迁移发生在读 indexSnapshot 之前：注入的是迁移后的索引
		expect(await readFile(join(dir, "MEMORY.md"), "utf8")).toContain("- [SSH Gotcha](SSH-Gotcha.md)");
		expect(await readdir(dir)).not.toContain("debugging.md");
	});

	it("does not notify about migration when there is nothing to migrate", async () => {
		const notify = vi.fn();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);

		await handlers["session_start"][0]({}, uiCtx({ hasUI: true, ui: { notify, confirm: vi.fn(), setStatus: vi.fn() } }));

		expect(notify).not.toHaveBeenCalled();
		expect(await readFile(join(dir, ".migrated"), "utf8")).toContain('"entries": 0');
	});

	it("reports a migration failure without killing session_start", async () => {
		await writeFile(join(dir, "debugging.md"), LEGACY_TOPIC, "utf8");
		// .backups 是普通文件 → 建回滚点时 mkdir 抛错 → 迁移失败
		await writeFile(join(dir, ".backups"), "not a directory", "utf8");
		const notify = vi.fn();
		const { pi, tools, handlers } = createFakePi();
		memoryFactory(pi as any);

		await handlers["session_start"][0]({}, uiCtx({ hasUI: true, ui: { notify, confirm: vi.fn(), setStatus: vi.fn() } }));

		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0][0]).toContain("Memory migration failed:");
		expect(notify.mock.calls[0][1]).toBe("error");
		// session_start 没有中断：工具照常注册，`.migrated` 没写（下次重试）
		expect(tools).toHaveLength(1);
		expect(await readdir(dir)).not.toContain(".migrated");
		expect(await readdir(dir)).toContain("debugging.md");
	});

	it("/dream hands the store, the line limit and the 7-action tool set to runDream", async () => {
		const confirm = vi.fn().mockResolvedValue(true);
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		await commands["dream"].handler("", uiCtx({ hasUI: true, ui: { confirm, notify: vi.fn(), setStatus: vi.fn() } }));

		expect(runDreamMock).toHaveBeenCalledTimes(1);
		const args = runDreamMock.mock.calls[0][0];
		expect(args.memoryDir).toBe(dir);
		expect(args.maxLines).toBe(200);
		expect(typeof args.store.withLogicalLock).toBe("function");
		expect(args.customTools).toHaveLength(1);
		expect(args.customTools[0].parameters.properties.action.enum).toEqual([
			"add",
			"replace",
			"remove",
			"list",
			"search",
			"rename",
			"rebuild_index",
		]);
		expect(Object.keys(args.customTools[0].parameters.properties)).toContain("new_name");
	});

	it("/dream refuses when memory was never initialized", async () => {
		const notify = vi.fn();
		const { pi, commands } = createFakePi();
		memoryFactory(pi as any);

		await commands["dream"].handler("", uiCtx({ hasUI: true, ui: { notify, confirm: vi.fn(), setStatus: vi.fn() } }));

		expect(notify).toHaveBeenCalledWith("Memory not initialized.", "info");
		expect(runDreamMock).not.toHaveBeenCalled();
	});

	it("the session_start nudge path passes the same dream arguments", async () => {
		shouldNudgeMock.mockResolvedValue({ nudge: true, message: "💡 dream", sessions: 7, newEntries: 7 });
		const confirm = vi.fn().mockResolvedValue(true);
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);

		await handlers["session_start"][0]({}, uiCtx({ hasUI: true, ui: { notify: vi.fn(), confirm, setStatus: vi.fn() } }));

		expect(confirm).toHaveBeenCalled();
		expect(runDreamMock).toHaveBeenCalledTimes(1);
		expect(runDreamMock.mock.calls[0][0].customTools[0].parameters.properties.action.enum).toHaveLength(7);
	});

	it("tool execute throws when memory is disabled", async () => {
		mockConfigValue.enabled = false;
		const { createMemoryTool } = await import("../src/memory-tool");
		const tool = createMemoryTool({
			getMemoryDir: () => dir,
			getStore: () => null,
			getConfig: () => ({
				memIndexMaxLines: 200,
				memIndexMaxBytes: 25600,
				sessionSearch: { maxSessions: 10, maxMatches: 5 },
			}),
			getEnabled: () => false,
			searchSessions: async () => "",
			cwd: () => dir,
		});

		await expect(
			tool.execute("id", { action: "list" }, undefined, undefined, undefined as any),
		).rejects.toThrow("Memory is disabled (run /memory on)");
		mockConfigValue.enabled = true;
	});

	it("tool execute throws when the store is not initialized", async () => {
		const { createMemoryTool } = await import("../src/memory-tool");
		const tool = createMemoryTool({
			getMemoryDir: () => null,
			getStore: () => null,
			getConfig: () => ({
				memIndexMaxLines: 200,
				memIndexMaxBytes: 25600,
				sessionSearch: { maxSessions: 10, maxMatches: 5 },
			}),
			getEnabled: () => true,
			searchSessions: async () => "",
			cwd: () => dir,
		});

		await expect(
			tool.execute("id", { action: "list" }, undefined, undefined, undefined as any),
		).rejects.toThrow("Memory not initialized (no session_start yet)");
	});
});
