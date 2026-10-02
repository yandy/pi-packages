import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockConfigValue, dirRef, dirOverrideRef } = vi.hoisted(() => ({
	mockConfigValue: {
		enabled: true,
		memoryDir: "",
		memIndexMaxLines: 200,
		memIndexMaxBytes: 25600,
		// 显式注入的 fixture 不该对 DEFAULT_CONFIG 撒谎（D3：注入预算与写入口径同值）。
		memIndexInjectMaxLines: 200,
		memIndexInjectMaxBytes: 25600,
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
	// Plan D（D1）：跨 session 复位的用例需要「不同 cwd → 不同 memoryDir」。为 null 时沿用
	// dirRef.current，既有用例的行为一字不变。
	dirOverrideRef: { current: null as null | ((cwd: string) => string) },
}));

const { scanEntriesMock, runSideQueryMock, injectSurfacedContentMock, runExtractMock, runDreamMock, shouldNudgeMock, readRecordedMemoryIndexMock, readDreamMetaMock, writeDreamMetaMock } =
	vi.hoisted(() => ({
		scanEntriesMock: vi.fn(),
		runSideQueryMock: vi.fn(),
		injectSurfacedContentMock: vi.fn(),
		runExtractMock: vi.fn().mockResolvedValue({ skipped: false, result: "saved 1" }),
		runDreamMock: vi.fn().mockResolvedValue("consolidated"),
		shouldNudgeMock: vi.fn(),
		readRecordedMemoryIndexMock: vi.fn(),
		readDreamMetaMock: vi.fn(),
		writeDreamMetaMock: vi.fn().mockResolvedValue(undefined),
	}));

vi.mock("../src/config", () => ({
	loadConfig: vi.fn().mockImplementation(async () => ({ ...mockConfigValue, memoryDir: dirRef.current })),
}));

vi.mock("../src/paths", () => ({
	resolveMemoryDir: vi.fn().mockImplementation(async (_config: unknown, cwd: string) =>
		dirOverrideRef.current ? dirOverrideRef.current(cwd) : dirRef.current),
}));

vi.mock("../src/nudge", () => ({
	shouldNudge: shouldNudgeMock,
	writeDreamMeta: writeDreamMetaMock,
	readDreamMeta: readDreamMetaMock,
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

// 只替换 auto-surfacing 的三个函数：buildIndexSection / applyIndexSection / buildInjection
// 走真实实现，这样「sections 注入 + 冻结」这件事本身也被钉住。
vi.mock("../src/inject", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/inject")>();
	return {
		...actual,
		scanEntries: scanEntriesMock,
		runSideQuery: runSideQueryMock,
		injectSurfacedContent: injectSurfacedContentMock,
	};
});

// 录制值重放的真实现由 tests/index-source.test.ts 覆盖（本地 SDK 是 0.80.2，没有
// sessionEntryToContextMessages 导出，真实路径在这里永远拿不到录制值）—— 接线层只钉
// 「哪个 reason 走录制值、拿到/拿不到分别怎么办」。
vi.mock("../src/index-source", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/index-source")>();
	return { ...actual, readRecordedMemoryIndex: readRecordedMemoryIndexMock };
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
		sessionManager: { getEntries: () => [], getLeafId: () => null },
		...over,
	} as any;
}

/** 0.99.2 宿主的 fake 事件：`systemPromptOptions.sections` 是可变对象，注入就地写进去。 */
function sectionsEvent(prompt = "q") {
	return {
		prompt,
		systemPrompt: "BASE_PROMPT",
		systemPromptOptions: { sections: {} as Record<string, string | null> },
	};
}

/** 旧 SDK（本地类型 0.80.2）的 fake 事件：根本没有 `sections`。 */
function legacyEvent(prompt = "q") {
	return { prompt, systemPrompt: "BASE_PROMPT", systemPromptOptions: {} };
}

const DISK_INDEX = "- [SSH](ssh.md) — staging ssh config\n";

describe("index wiring (integration)", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "mem-wiring-"));
		dirRef.current = dir;
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "MEMORY.md"), DISK_INDEX, "utf8");

		scanEntriesMock.mockReset();
		runSideQueryMock.mockReset();
		injectSurfacedContentMock.mockReset();
		runExtractMock.mockReset();
		runExtractMock.mockResolvedValue({ skipped: false, result: "saved 1" });
		runDreamMock.mockClear();
		shouldNudgeMock.mockReset();
		shouldNudgeMock.mockResolvedValue({ nudge: false, message: "", sessions: 0, newEntries: 0 });
		readRecordedMemoryIndexMock.mockReset();
		readRecordedMemoryIndexMock.mockReturnValue(null);
		readDreamMetaMock.mockReset();
		readDreamMetaMock.mockResolvedValue({ lastDreamAt: null });
		writeDreamMetaMock.mockReset();
		writeDreamMetaMock.mockResolvedValue(undefined);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
		delete mockConfigValue.defaults;
		delete (mockConfigValue.autoSurfacing as any).sessionPersistence;
		mockConfigValue.extractMemories.enabled = false;
		mockConfigValue.lock = { timeoutMs: 5000, snapshotKeep: 5 };
		// 防测试重排踩坑：有用例会把 enabled 改成 false
		mockConfigValue.enabled = true;
		dirOverrideRef.current = null;
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

	it("writes the memory_index section on every turn and freezes it byte-for-byte", async () => {
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		const first = sectionsEvent();
		await handlers["before_agent_start"][0](first, uiCtx());
		expect(first.systemPromptOptions.sections["memory_index"]).toBe(DISK_INDEX);

		// 会话中途磁盘上的索引被改了（另一个 worktree 写入）：注入值必须逐字节不变
		await writeFile(join(dir, "MEMORY.md"), "- [SSH](ssh.md) — changed\n", "utf8");
		const second = sectionsEvent();
		const result = await handlers["before_agent_start"][0](second, uiCtx());

		expect(second.systemPromptOptions.sections["memory_index"]).toBe(DISK_INDEX);
		expect(second.systemPromptOptions.sections["memory_index"]).not.toContain("changed");
		// 走 sections 路径时不再返回 systemPrompt（避免全量替换从 position 0 打断缓存）
		expect(result?.systemPrompt).toBeUndefined();
	});

	// Review Focus #1：省略该键 = pi 生成 { memory_index: null } = 索引被静默删除。
	// 三种「用录制值」的 reason 也必须每轮把键写回去。
	it("sets the section for every session_start reason", async () => {
		for (const reason of ["startup", "new", "resume", "fork", "reload", undefined]) {
			const { pi, handlers } = createFakePi();
			memoryFactory(pi as any);
			await handlers["session_start"][0](reason ? { reason } : {}, uiCtx());

			const first = sectionsEvent();
			await handlers["before_agent_start"][0](first, uiCtx());
			const second = sectionsEvent();
			await handlers["before_agent_start"][0](second, uiCtx());

			expect(Object.keys(first.systemPromptOptions.sections), reason).toEqual(["memory_index"]);
			expect(Object.keys(second.systemPromptOptions.sections), reason).toEqual(["memory_index"]);
			expect(second.systemPromptOptions.sections["memory_index"], reason).toBe(DISK_INDEX);
		}
	});

	it("uses the recorded index for resume/fork/reload and never reads the disk", async () => {
		for (const reason of ["resume", "fork", "reload"]) {
			await writeFile(join(dir, "MEMORY.md"), "- [DISK](disk.md) — from disk\n", "utf8");
			readRecordedMemoryIndexMock.mockReturnValue("- [SSH](ssh.md) — recorded\n");
			const sessionManager = { getEntries: () => [], getLeafId: () => null };
			const { pi, handlers } = createFakePi();
			memoryFactory(pi as any);

			await handlers["session_start"][0]({ reason }, uiCtx({ sessionManager }));
			const event = sectionsEvent();
			await handlers["before_agent_start"][0](event, uiCtx({ sessionManager }));

			expect(readRecordedMemoryIndexMock, reason).toHaveBeenCalledWith(sessionManager);
			expect(event.systemPromptOptions.sections["memory_index"], reason).toBe("- [SSH](ssh.md) — recorded\n");
			expect(event.systemPromptOptions.sections["memory_index"], reason).not.toContain("DISK");
			readRecordedMemoryIndexMock.mockReturnValue(null);
		}
	});

	it("reads the disk for startup/new instead of replaying the transcript", async () => {
		for (const reason of ["startup", "new", undefined]) {
			const { pi, handlers } = createFakePi();
			memoryFactory(pi as any);

			await handlers["session_start"][0](reason ? { reason } : {}, uiCtx());

			expect(readRecordedMemoryIndexMock, String(reason)).not.toHaveBeenCalled();
		}
	});

	// Finding 1 / R42：0.99.2 宿主把每个 non-preamble section 渲染成
	// `<memory_index>\n<裸值>\n</memory_index>` 后才写进 transcript，重放拿到的是**带标签**的值。
	// 端到端保真 = 冻结值等于原始裸串，且宿主再渲染一次逐字节等于录制值（不产生新 patch）。
	it("freezes the bare recorded index after resume and never produces a new patch", async () => {
		const raw = "- [SSH](ssh.md) — staging ssh config\n";
		const recorded = `<memory_index>\n${raw}\n</memory_index>`;
		const sessionManager = {
			getEntries: () => [
				{ type: "message", message: { role: "system", content: "", sections: { memory_index: recorded } } },
			],
			getLeafId: () => "leaf-1",
		};

		// 本文件把 index-source 整个 mock 了；这里用真实实现（注入 converter 替代 0.80.2 缺失的
		// SDK 导出），走完「重放 → 脱壳 → 冻结 → 回写」全程。
		const actual = await vi.importActual<typeof import("../src/index-source")>("../src/index-source");
		readRecordedMemoryIndexMock.mockImplementation((sm: unknown) =>
			actual.readRecordedMemoryIndex(sm, {
				sessionEntryToContextMessages: (e: unknown) => [(e as { message: unknown }).message],
			}),
		);

		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({ reason: "resume" }, uiCtx({ sessionManager }));

		const ctx = uiCtx({ sessionManager });
		const first = sectionsEvent();
		await handlers["before_agent_start"][0](first, ctx);
		const frozen = first.systemPromptOptions.sections["memory_index"];

		expect(frozen).toBe(raw);
		// 宿主渲染 = 录制值：头部字节恒等，resume 第一轮没有 patch（D13/D14）
		expect(`<memory_index>\n${frozen}\n</memory_index>`).toBe(recorded);

		const second = sectionsEvent();
		await handlers["before_agent_start"][0](second, ctx);
		expect(second.systemPromptOptions.sections["memory_index"]).toBe(frozen);
	});

	// Review Focus #3：重放拿不到录制值 → 回退磁盘，而不是把索引丢掉。
	it("falls back to the disk index when no recorded value is available", async () => {
		readRecordedMemoryIndexMock.mockReturnValue(null);
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);

		await handlers["session_start"][0]({ reason: "resume" }, uiCtx());
		const event = sectionsEvent();
		await handlers["before_agent_start"][0](event, uiCtx());

		expect(readRecordedMemoryIndexMock).toHaveBeenCalledTimes(1);
		expect(event.systemPromptOptions.sections["memory_index"]).toBe(DISK_INDEX);
	});

	it("falls back to { systemPrompt } when the host SDK exposes no sections", async () => {
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		const event = legacyEvent();
		const result = await handlers["before_agent_start"][0](event, uiCtx());

		expect(result?.systemPrompt).toBe(`BASE_PROMPT\n\n${DISK_INDEX}`);
		expect((event.systemPromptOptions as any).sections).toBeUndefined();
	});

	it("injects an empty section value instead of dropping the key", async () => {
		await writeFile(join(dir, "MEMORY.md"), "", "utf8");
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		const event = sectionsEvent();
		const result = await handlers["before_agent_start"][0](event, uiCtx());

		expect(Object.keys(event.systemPromptOptions.sections)).toEqual(["memory_index"]);
		expect(event.systemPromptOptions.sections["memory_index"]).toBe("");
		expect(result?.systemPrompt).toBeUndefined();
	});

	// D14：compaction 是唯一的会话内刷新点，同时清空已注入集合。
	it("session_compact re-reads the index from disk and clears injectedFiles", async () => {
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		scanEntriesMock.mockResolvedValue([
			{ file: "ssh.md", name: "SSH", description: "d", type: "project", modified: "2026-01-01T00:00:00.000Z" },
		]);
		const injectedAtCall: Array<Set<string>> = [];
		runSideQueryMock.mockImplementation(async (...args: any[]) => {
			injectedAtCall.push(new Set(args[2]));
			return ["ssh.md"];
		});
		injectSurfacedContentMock.mockResolvedValue("<relevant_memories>\n## SSH\nx\n</relevant_memories>");

		const first = sectionsEvent();
		await handlers["before_agent_start"][0](first, uiCtx());
		expect(injectedAtCall[0]).toEqual(new Set());

		await writeFile(join(dir, "MEMORY.md"), "# Memory Index\n\n- [New](new.md) — after compact\n", "utf8");
		await handlers["session_compact"][0]({ type: "session_compact", reason: "manual" }, uiCtx());

		const second = sectionsEvent();
		await handlers["before_agent_start"][0](second, uiCtx());

		expect(second.systemPromptOptions.sections["memory_index"]).toBe(
			"# Memory Index\n\n- [New](new.md) — after compact\n",
		);
		expect(injectedAtCall[1]).toEqual(new Set());
	});

	it("refreshes the index on session_compact only — no other event may", async () => {
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		const first = sectionsEvent();
		await handlers["before_agent_start"][0](first, uiCtx());

		await writeFile(join(dir, "MEMORY.md"), "- [Changed](c.md) — changed\n", "utf8");
		await handlers["agent_end"][0]({ messages: [] }, uiCtx());
		await handlers["session_shutdown"][0]({ type: "session_shutdown", reason: "quit" }, uiCtx());
		const second = sectionsEvent();
		await handlers["before_agent_start"][0](second, uiCtx());

		expect(second.systemPromptOptions.sections["memory_index"]).toBe(DISK_INDEX);
		expect(Object.keys(handlers).sort()).toEqual([
			"agent_end",
			"before_agent_start",
			"session_compact",
			"session_shutdown",
			"session_start",
		]);
	});

	it("session_shutdown waits for an in-flight extract", async () => {
		mockConfigValue.extractMemories.enabled = true;
		let release: (() => void) | undefined;
		runExtractMock.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = () => resolve({ skipped: false, result: "ok" });
				}),
		);
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "hi" }] }, uiCtx());

		let settled = false;
		const shutdown = handlers["session_shutdown"][0]({ type: "session_shutdown", reason: "quit" }, uiCtx()).then(
			() => {
				settled = true;
			},
		);
		await Promise.resolve();
		expect(settled).toBe(false);

		release?.();
		await shutdown;
		expect(settled).toBe(true);
	});

	it("session_shutdown gives up after lock.timeoutMs rather than hanging", async () => {
		mockConfigValue.extractMemories.enabled = true;
		mockConfigValue.lock = { timeoutMs: 30, snapshotKeep: 5 };
		runExtractMock.mockImplementationOnce(() => new Promise(() => {}));
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());
		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "hi" }] }, uiCtx());

		const started = Date.now();
		await handlers["session_shutdown"][0]({ type: "session_shutdown", reason: "quit" }, uiCtx());

		expect(Date.now() - started).toBeLessThan(2000);
	});

	it("session_shutdown resolves immediately when nothing is in flight", async () => {
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		const started = Date.now();
		await handlers["session_shutdown"][0]({ type: "session_shutdown", reason: "quit" }, uiCtx());

		expect(Date.now() - started).toBeLessThan(500);
	});

	// ── Plan C（spec §14 通知）────────────────────────────────────────────
	/**
	 * 排空待处理的微任务（extract / dream 的 `.then` 链是异步的）。
	 * **只覆盖一层宏任务**：链上每个 `await` 都要再 flush 一次，别指望一次 flush 跑完整条链。
	 */
	async function flush(): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	function uiWith(notify = vi.fn()) {
		return { hasUI: true, ui: { notify, confirm: vi.fn(), setStatus: vi.fn() } };
	}

	it("agent_end counts the writes made through the extract tool and notifies once", async () => {
		mockConfigValue.extractMemories.enabled = true;
		let resolveExtract: ((value: { skipped: boolean; result?: string }) => void) | undefined;
		runExtractMock.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveExtract = resolve;
				}),
		);
		const notify = vi.fn();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "hi" }] }, uiCtx(uiWith(notify)));

		// customTools[0] 就是传给 extract 的真工具：直接跑它，onWrite 就是唯一的计数通道
		const tool = runExtractMock.mock.calls[0][0].customTools[0];
		await tool.execute("c1", { action: "add", name: "A", description: "d", content: "正文 A" }, undefined, undefined, undefined);
		await tool.execute("c2", { action: "add", name: "B", description: "d", content: "正文 B" }, undefined, undefined, undefined);
		await tool.execute("c3", { action: "list" }, undefined, undefined, undefined);
		await flush();
		expect(notify).not.toHaveBeenCalled();

		resolveExtract?.({ skipped: false, result: "ok" });
		await flush();

		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith("Extracted 2 memories.", "info");
	});

	it("agent_end uses the singular form for exactly one write", async () => {
		mockConfigValue.extractMemories.enabled = true;
		let resolveExtract: ((value: { skipped: boolean; result?: string }) => void) | undefined;
		runExtractMock.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveExtract = resolve;
				}),
		);
		const notify = vi.fn();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "hi" }] }, uiCtx(uiWith(notify)));
		const tool = runExtractMock.mock.calls[0][0].customTools[0];
		await tool.execute("c1", { action: "add", name: "A", description: "d", content: "正文" }, undefined, undefined, undefined);

		resolveExtract?.({ skipped: false, result: "ok" });
		await flush();

		expect(notify).toHaveBeenCalledWith("Extracted 1 memory.", "info");
	});

	// Review Focus #4：没写东西就不该弹通知；被锁跳过也不该弹。
	it("agent_end stays quiet when extract wrote nothing or was skipped", async () => {
		mockConfigValue.extractMemories.enabled = true;
		const notify = vi.fn();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		runExtractMock.mockResolvedValueOnce({ skipped: false, result: "nothing to save" });
		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "hi" }] }, uiCtx(uiWith(notify)));
		await flush();

		runExtractMock.mockResolvedValueOnce({ skipped: true });
		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "hi" }] }, uiCtx(uiWith(notify)));
		await flush();

		expect(notify).not.toHaveBeenCalled();
	});

	it("agent_end does not notify a headless session about extracted memories", async () => {
		mockConfigValue.extractMemories.enabled = true;
		let resolveExtract: ((value: { skipped: boolean; result?: string }) => void) | undefined;
		runExtractMock.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveExtract = resolve;
				}),
		);
		const notify = vi.fn();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		await handlers["agent_end"][0](
			{ messages: [{ role: "user", content: "hi" }] },
			uiCtx({ hasUI: false, ui: { notify, confirm: vi.fn(), setStatus: vi.fn() } }),
		);
		const tool = runExtractMock.mock.calls[0][0].customTools[0];
		await tool.execute("c1", { action: "add", name: "A", description: "d", content: "正文" }, undefined, undefined, undefined);

		resolveExtract?.({ skipped: false, result: "ok" });
		await flush();

		expect(notify).not.toHaveBeenCalled();
	});

	it("reports an extract failure once per session and resets the quota on session_start", async () => {
		mockConfigValue.extractMemories.enabled = true;
		runExtractMock.mockImplementation(() => Promise.reject(new Error("model exploded")));
		const notify = vi.fn();
		const ui = uiWith(notify);
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		const failed = () => notify.mock.calls.filter((call) => String(call[0]).startsWith("Extract failed:"));

		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "a" }] }, uiCtx(ui));
		await flush();
		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "b" }] }, uiCtx(ui));
		await flush();
		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "c" }] }, uiCtx(ui));
		await flush();

		expect(failed()).toEqual([["Extract failed: model exploded", "error"]]);

		// 新 session 重新给一次配额
		await handlers["session_start"][0]({}, uiCtx());
		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "d" }] }, uiCtx(ui));
		await flush();

		expect(failed()).toHaveLength(2);
	});

	it("does not report an extract failure to a headless session", async () => {
		mockConfigValue.extractMemories.enabled = true;
		runExtractMock.mockImplementation(() => Promise.reject(new Error("model exploded")));
		const notify = vi.fn();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		await handlers["agent_end"][0](
			{ messages: [{ role: "user", content: "a" }] },
			uiCtx({ hasUI: false, ui: { notify, confirm: vi.fn(), setStatus: vi.fn() } }),
		);
		await flush();

		expect(notify).not.toHaveBeenCalled();
	});

	it("notifies Recalled with the number of injected blocks", async () => {
		const notify = vi.fn();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		scanEntriesMock.mockResolvedValue([
			{ file: "ssh.md", name: "SSH", description: "d", type: "project", modified: "2026-01-01T00:00:00.000Z" },
			{ file: "db.md", name: "DB", description: "d", type: "project", modified: "2026-01-01T00:00:00.000Z" },
		]);
		runSideQueryMock.mockResolvedValue(["ssh.md", "db.md"]);
		injectSurfacedContentMock.mockResolvedValue("<relevant_memories>\n## SSH\nx\n\n## DB\ny\n</relevant_memories>");

		await handlers["before_agent_start"][0](sectionsEvent("ssh?"), uiCtx(uiWith(notify)));

		expect(notify).toHaveBeenCalledWith("Recalled: 2 entries", "info");
	});

	it("stays quiet about Recalled when headless or when nothing was injected", async () => {
		const notify = vi.fn();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		scanEntriesMock.mockResolvedValue([
			{ file: "ssh.md", name: "SSH", description: "d", type: "project", modified: "2026-01-01T00:00:00.000Z" },
		]);
		runSideQueryMock.mockResolvedValue(["ssh.md"]);
		injectSurfacedContentMock.mockResolvedValue("");

		await handlers["before_agent_start"][0](sectionsEvent("ssh?"), uiCtx(uiWith(notify)));
		expect(notify).not.toHaveBeenCalled();

		injectSurfacedContentMock.mockResolvedValue("<relevant_memories>\n## SSH\nx\n</relevant_memories>");
		await handlers["before_agent_start"][0](
			sectionsEvent("ssh?"),
			uiCtx({ hasUI: false, ui: { notify, confirm: vi.fn(), setStatus: vi.fn() } }),
		);
		expect(notify).not.toHaveBeenCalled();
	});

	// ── Review 修复轮（R44）：session dispose 之后 ctx 不可再访问 ─────────────
	/**
	 * pi 的 `ExtensionContext` 是代理：`hasUI` / `ui` 的 getter 会先 `runner.assertActive()`，
	 * session dispose（/new、switch、fork、reload、退出宽限超时）之后调用即抛错。
	 * 这里造一个同形状的 fake：`dispose()` 之后读取这两个字段直接抛错。
	 */
	function disposableCtx() {
		let active = true;
		const notify = vi.fn();
		const ui = { notify, confirm: vi.fn(), setStatus: vi.fn() };
		const ctx: any = uiCtx();
		Object.defineProperty(ctx, "hasUI", {
			get: () => {
				if (!active) throw new Error("Extension instance is no longer active");
				return true;
			},
		});
		Object.defineProperty(ctx, "ui", {
			get: () => {
				if (!active) throw new Error("Extension instance is no longer active");
				return ui;
			},
		});
		return {
			ctx,
			notify,
			dispose: () => {
				active = false;
			},
		};
	}

	/**
	 * 收集进程级未处理 rejection。extract 的通知挂在 `void` 链上，没人接住的 rejection 在 pi
	 * 里没有全局 handler（Node 默认打印并退出）—— 这里显式抓住它们。
	 */
	async function captureUnhandledRejections(body: () => Promise<void>): Promise<unknown[]> {
		const caught: unknown[] = [];
		const onUnhandled = (reason: unknown) => {
			caught.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			await body();
			// 未处理 rejection 要等微任务队列排空后的下一轮事件循环才派发。
			await flush();
			await flush();
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
		return caught;
	}

	it("delivers 'Extracted' from the sync UI snapshot when the session dies mid-extract", async () => {
		mockConfigValue.extractMemories.enabled = true;
		let resolveExtract: ((value: { skipped: boolean; result?: string }) => void) | undefined;
		runExtractMock.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveExtract = resolve;
				}),
		);
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		const session = disposableCtx();
		const caught = await captureUnhandledRejections(async () => {
			await handlers["agent_end"][0]({ messages: [{ role: "user", content: "hi" }] }, session.ctx);
			const tool = runExtractMock.mock.calls[0][0].customTools[0];
			await tool.execute("c1", { action: "add", name: "A", description: "d", content: "正文" }, undefined, undefined, undefined);

			// extract 还没回来，session 先被 /new（或退出宽限超时）销毁了
			session.dispose();
			resolveExtract?.({ skipped: false, result: "ok" });
			await flush();
		});

		expect(caught).toEqual([]);
		// UI 是同步段快照的：回调不再访问 ctx（否则这里会抛「no longer active」）
		expect(session.notify).toHaveBeenCalledWith("Extracted 1 memory.", "info");
	});

	it("does not reject unhandled when a failing extract settles after the session died", async () => {
		mockConfigValue.extractMemories.enabled = true;
		let rejectExtract: ((reason?: unknown) => void) | undefined;
		runExtractMock.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					rejectExtract = reject;
				}),
		);
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		const session = disposableCtx();
		const caught = await captureUnhandledRejections(async () => {
			await handlers["agent_end"][0]({ messages: [{ role: "user", content: "hi" }] }, session.ctx);
			session.dispose();
			rejectExtract?.(new Error("model exploded"));
			await flush();
		});

		expect(caught).toEqual([]);
	});

	it("does not misreport a throwing 'Extracted' notice as an extract failure", async () => {
		mockConfigValue.extractMemories.enabled = true;
		let resolveExtract: ((value: { skipped: boolean; result?: string }) => void) | undefined;
		runExtractMock.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveExtract = resolve;
				}),
		);
		const notify = vi.fn((_message: string, _type?: string): void => {
			throw new Error("UI is gone");
		});
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		const caught = await captureUnhandledRejections(async () => {
			await handlers["agent_end"][0]({ messages: [{ role: "user", content: "hi" }] }, uiCtx(uiWith(notify)));
			const tool = runExtractMock.mock.calls[0][0].customTools[0];
			await tool.execute("c1", { action: "add", name: "A", description: "d", content: "正文" }, undefined, undefined, undefined);
			resolveExtract?.({ skipped: false, result: "ok" });
			await flush();
		});

		expect(caught).toEqual([]);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(String(notify.mock.calls[0][0])).not.toMatch(/^Extract failed:/);

		// 成功通知抛错不能烧掉失败通知配额：下一轮真失败仍然要报
		runExtractMock.mockImplementationOnce(() => Promise.reject(new Error("model exploded")));
		const okNotify = vi.fn();
		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "hi" }] }, uiCtx(uiWith(okNotify)));
		await flush();
		expect(okNotify).toHaveBeenCalledWith("Extract failed: model exploded", "error");
	});

	it("renders a non-Error rejection reason without 'undefined'", async () => {
		mockConfigValue.extractMemories.enabled = true;
		runExtractMock.mockImplementationOnce(() => Promise.reject("model exploded"));
		const notify = vi.fn();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "a" }] }, uiCtx(uiWith(notify)));
		await flush();

		expect(notify).toHaveBeenCalledWith("Extract failed: model exploded", "error");
	});

	it("resets the extract failure quota even when the next session boots disabled", async () => {
		mockConfigValue.extractMemories.enabled = true;
		runExtractMock.mockImplementation(() => Promise.reject(new Error("model exploded")));
		const { pi, handlers, commands } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		const firstNotify = vi.fn();
		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "a" }] }, uiCtx(uiWith(firstNotify)));
		await flush();
		expect(firstNotify).toHaveBeenCalledWith("Extract failed: model exploded", "error");

		// 新 session 以 disabled 启动：session_start 提前 return，但配额必须已经重置
		mockConfigValue.enabled = false;
		try {
			await handlers["session_start"][0]({ reason: "reload" }, uiCtx());
			// 用户中途 /memory on：D1 之后 disabled 启动会清空 memoryDir/store，所以这里
			// 是真的重新初始化（resolveMemoryDir 的 mock 仍返回同一个 dir）
			await commands["memory"].handler("on", uiCtx(uiWith()));

			const secondNotify = vi.fn();
			await handlers["agent_end"][0]({ messages: [{ role: "user", content: "b" }] }, uiCtx(uiWith(secondNotify)));
			await flush();
			expect(secondNotify).toHaveBeenCalledWith("Extract failed: model exploded", "error");
		} finally {
			mockConfigValue.enabled = true;
		}
	});

	// ── Review 修复轮（R47/R48/R49）：dream 两条链的 ctx 快照 / 定时器 / section 时机 ──
	it("settles the nudge dream without touching a disposed ctx", async () => {
		shouldNudgeMock.mockResolvedValue({ nudge: true, message: "💡 dream", sessions: 7, newEntries: 7 });
		let resolveDream: ((summary: string) => void) | undefined;
		runDreamMock.mockImplementationOnce(
			() =>
				new Promise<string>((resolve) => {
					resolveDream = resolve;
				}),
		);
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		const session = disposableCtx();
		session.ctx.ui.confirm.mockResolvedValue(true);
		const caught = await captureUnhandledRejections(async () => {
			await handlers["session_start"][0]({}, session.ctx);
			// dream 是长时后台任务（600s timeout），用户先 /new 了：链 settle 时 ctx 已失效
			session.dispose();
			resolveDream?.("consolidated");
			await flush();
		});

		expect(caught).toEqual([]);
		// UI 来自同步段快照：dispose 之后链仍然能通知（通过快照对象，而不是 ctx 代理）
		expect(session.notify).toHaveBeenCalledWith("consolidated", "info");
	});

	// Plan E/next #11：nudge 链的失败分支也要盖到 —— rejected 的值不一定是 Error
	//（pi 的模型层可能抛字符串），`dreamFailureMessage` 必须用 `String(e)` 渲染。
	it("renders a non-Error nudge dream failure with String(e)", async () => {
		shouldNudgeMock.mockResolvedValue({ nudge: true, message: "💡 dream", sessions: 7, newEntries: 7 });
		let rejectDream: ((reason?: unknown) => void) | undefined;
		runDreamMock.mockImplementationOnce(
			() =>
				new Promise<string>((_resolve, reject) => {
					rejectDream = reject;
				}),
		);
		const notify = vi.fn();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);

		await handlers["session_start"][0](
			{},
			uiCtx({ hasUI: true, ui: { notify, confirm: vi.fn().mockResolvedValue(true), setStatus: vi.fn() } }),
		);
		rejectDream?.("model exploded");
		await flush();

		expect(notify).toHaveBeenCalledWith("Dream failed: model exploded", "error");
	});

	it("settles /dream without touching a disposed ctx", async () => {
		let resolveDream: ((summary: string) => void) | undefined;
		runDreamMock.mockImplementationOnce(
			() =>
				new Promise<string>((resolve) => {
					resolveDream = resolve;
				}),
		);
		const { pi, handlers, commands } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		const session = disposableCtx();
		session.ctx.ui.confirm.mockResolvedValue(true);
		// 完成回调里的 `SessionManager.list(cwd)` 会去 getAgentDir() 下建会话目录：
		// 按 docs/guides/testing.md 隔离到本用例的 temp dir（并行/沙箱下不得碰真实 ~/.pi）。
		vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent"));
		try {
			const caught = await captureUnhandledRejections(async () => {
				await commands["dream"].handler("", session.ctx);
				session.dispose();
				resolveDream?.("consolidated");
				await flush();
			});

			expect(caught).toEqual([]);
			expect(session.notify).toHaveBeenCalledWith("consolidated", "info");
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("does not reject unhandled when /dream fails after the session died", async () => {
		let rejectDream: ((reason?: unknown) => void) | undefined;
		runDreamMock.mockImplementationOnce(
			() =>
				new Promise<string>((_resolve, reject) => {
					rejectDream = reject;
				}),
		);
		const { pi, handlers, commands } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		const session = disposableCtx();
		session.ctx.ui.confirm.mockResolvedValue(true);
		const caught = await captureUnhandledRejections(async () => {
			await commands["dream"].handler("", session.ctx);
			session.dispose();
			// rejected 的值不一定是 Error
			rejectDream?.("model exploded");
			await flush();
		});

		expect(caught).toEqual([]);
		expect(session.notify).toHaveBeenCalledWith("Dream failed: model exploded", "error");
	});

	// Plan E/next #11：success 分支里的 `writeDreamMeta` 自己抛错时，不能只走成功通知，
	// 也不能变成无人接管的 rejection（它已被 `track` 登记，但 `.finally` 不会接住）。
	it("/dream reports a failing writeDreamMeta instead of a success notification", async () => {
		writeDreamMetaMock.mockRejectedValueOnce(new Error("meta write failed"));
		const notify = vi.fn();
		const confirm = vi.fn().mockResolvedValue(true);
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());
		// 完成回调里的 `SessionManager.list(cwd)` 会碰 getAgentDir()：隔离到本用例的 temp dir。
		vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent"));
		try {
			const caught = await captureUnhandledRejections(async () => {
				await commands["dream"].handler("", uiCtx({ hasUI: true, ui: { notify, confirm, setStatus: vi.fn() } }));
				await flush();
			});

			expect(caught).toEqual([]);
			expect(notify).toHaveBeenCalledTimes(1);
			expect(notify.mock.calls[0]).toEqual(["Dream failed: meta write failed", "error"]);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("clears the shutdown give-up timer when the in-flight write finishes first", async () => {
		mockConfigValue.extractMemories.enabled = true;
		mockConfigValue.lock = { timeoutMs: 30, snapshotKeep: 5 };
		let release: (() => void) | undefined;
		runExtractMock.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = () => resolve({ skipped: true });
				}),
		);
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());
		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "hi" }] }, uiCtx());

		vi.useFakeTimers();
		try {
			const shutdown = handlers["session_shutdown"][0]({ type: "session_shutdown", reason: "quit" }, uiCtx());
			// 兜底定时器已挂上（在途任务还没收尾）
			expect(vi.getTimerCount()).toBeGreaterThan(0);
			release?.();
			await shutdown;
			// race 由 in-flight 胜出：定时器不能继续挂在事件循环上（会拖长进程退出）
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("writes the memory_index section before auto-surfacing can abort the turn", async () => {
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		scanEntriesMock.mockResolvedValue([
			{ file: "ssh.md", name: "SSH", description: "d", type: "project", modified: "2026-01-01T00:00:00.000Z" },
		]);
		runSideQueryMock.mockResolvedValue(["ssh.md"]);
		let resolveInject: ((value: string) => void) | undefined;
		injectSurfacedContentMock.mockImplementationOnce(
			() =>
				new Promise<string>((resolve) => {
					resolveInject = resolve;
				}),
		);

		const session = disposableCtx();
		const event = sectionsEvent("ssh?");
		// auto-surfacing 的 finally 在 await 之后读 ctx.hasUI：session 在途中 dispose 会让 handler
		// 从那里抛出。section 必须在**任何 await 之前**就已写好，否则宿主收到 { memory_index: null }
		// 就把索引段删掉了（spec §9.1 的 null 陷阱）。
		const handlerDone = handlers["before_agent_start"][0](event, session.ctx).catch(() => undefined);
		await flush();
		expect(resolveInject).toBeDefined();
		session.dispose();
		resolveInject?.("<relevant_memories>\n## SSH\nx\n</relevant_memories>");
		await handlerDone;

		expect(event.systemPromptOptions.sections["memory_index"]).toBe(DISK_INDEX);

		// 下一轮（新 ctx）仍喂回冻结值，逐字节不变
		scanEntriesMock.mockResolvedValue([]);
		const next = sectionsEvent("again?");
		await handlers["before_agent_start"][0](next, uiCtx());
		expect(next.systemPromptOptions.sections["memory_index"]).toBe(DISK_INDEX);
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
		expect(result?.systemPrompt).toContain("- [SSH](ssh.md) — staging ssh config");
	});

	it("does not surface the same entry file twice in one session", async () => {
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		scanEntriesMock.mockResolvedValue([
			{ file: "ssh.md", name: "SSH", description: "d", type: "project", modified: "2026-01-01T00:00:00.000Z" },
		]);
		// Finding Minor 5：injectedFiles 是活 Set，同一引用会在后续轮次被改写 —— 断言必须在
		// 调用瞬间深拷贝，否则「第二轮已含 ssh.md」是拿断言时的集合比它自己，永远成立。
		const injectedAtCall: Array<Set<string>> = [];
		runSideQueryMock.mockImplementation(async (...args: any[]) => {
			injectedAtCall.push(new Set(args[2]));
			return ["ssh.md"];
		});
		injectSurfacedContentMock.mockResolvedValue("<relevant_memories>x</relevant_memories>");

		const event = { prompt: "ssh?", systemPrompt: "sp" };
		await handlers["before_agent_start"][0](event, uiCtx());
		// 第二轮：runSideQuery 收到的 injectedFiles 里已经有 ssh.md
		await handlers["before_agent_start"][0](event, uiCtx());

		expect(injectedAtCall).toHaveLength(2);
		expect(injectedAtCall[0]).toEqual(new Set());
		expect(injectedAtCall[1]).toEqual(new Set(["ssh.md"]));
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
		expect(result?.systemPrompt).toContain("- [SSH](ssh.md) — staging ssh config");
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

	// ── Plan C（spec §14 `/memory` 状态与 `/memory unlock`）─────────────────
	it("/memory prints the whole status block", async () => {
		readDreamMetaMock.mockResolvedValue({ lastDreamAt: "2026-10-01T00:00:00.000Z", sessionCountAtDream: 3 });
		const notify = vi.fn();
		const confirm = vi.fn();
		const { pi, tools, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		await tools[0].execute(
			"c1",
			{ action: "add", name: "DB rules", description: "d", content: "正文" },
			undefined,
			undefined,
			undefined,
		);
		const index = await readFile(join(dir, "MEMORY.md"), "utf8");
		await writeFile(join(dir, "MEMORY.md"), `# Memory Index\n\n${index}手写的一行\n`, "utf8");
		await writeFile(
			join(dir, ".migrated"),
			JSON.stringify({ migratedAt: "2026-09-30T00:00:00.000Z", entries: 4, files: 2, backupDir: "/x" }),
			"utf8",
		);
		await writeFile(
			join(dir, ".lock"),
			JSON.stringify({ pid: process.pid, hostname: "h", startedAt: "2026-10-02T01:02:03.000Z", op: "dream" }),
			"utf8",
		);

		await commands["memory"].handler("", uiCtx({ hasUI: true, ui: { notify, confirm, setStatus: vi.fn() } }));

		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0][1]).toBe("info");
		const lines = notify.mock.calls[0][0].split("\n");
		expect(lines).toHaveLength(7);
		expect(lines[0]).toBe("Memory: enabled");
		expect(lines[1]).toBe(`Dir: ${dir}`);
		expect(lines[2]).toMatch(/^Index: 4\/200 lines, \d+\/25600 bytes, 2 unrecognized lines$/);
		expect(lines[3]).toBe("Entries: 1");
		expect(lines[4]).toBe("Last dream: 2026-10-01T00:00:00.000Z");
		expect(lines[5]).toBe("Migration: migrated at 2026-09-30T00:00:00.000Z (4 entries from 2 files)");
		expect(lines[6]).toBe(`Lock: held by dream (pid ${process.pid} on h, started 2026-10-02T01:02:03.000Z)`);
	});

	it("/memory reports a fresh directory as free / never / not needed", async () => {
		const notify = vi.fn();
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		await commands["memory"].handler("", uiCtx({ hasUI: true, ui: { notify, confirm: vi.fn(), setStatus: vi.fn() } }));

		const lines = notify.mock.calls[0][0].split("\n");
		expect(lines[2]).toBe(
			`Index: 1/200 lines, ${Buffer.byteLength(DISK_INDEX, "utf8")}/25600 bytes, 0 unrecognized lines`,
		);
		expect(lines[3]).toBe("Entries: 0");
		expect(lines[4]).toBe("Last dream: never");
		expect(lines[5]).toBe("Migration: not needed");
		expect(lines[6]).toBe("Lock: free");
	});

	// 迁移标记缺失（上一次迁移失败）或读不懂 → 都按「还没迁移」报告，下次 session_start 会重试。
	it("/memory reports a pending migration when the marker is missing or unreadable", async () => {
		const notify = vi.fn();
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());
		const ctx = () => uiCtx({ hasUI: true, ui: { notify, confirm: vi.fn(), setStatus: vi.fn() } });

		await rm(join(dir, ".migrated"));
		await commands["memory"].handler("", ctx());
		await writeFile(join(dir, ".migrated"), "{oops", "utf8");
		await commands["memory"].handler("", ctx());

		expect(notify.mock.calls[0][0].split("\n")[5]).toBe("Migration: pending");
		expect(notify.mock.calls[1][0].split("\n")[5]).toBe("Migration: pending");
	});

	it("/memory points at /memory unlock when the lock record is unreadable", async () => {
		const notify = vi.fn();
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());
		await writeFile(join(dir, ".lock"), "not json", "utf8");

		await commands["memory"].handler("", uiCtx({ hasUI: true, ui: { notify, confirm: vi.fn(), setStatus: vi.fn() } }));

		expect(notify.mock.calls[0][0].split("\n")[6]).toBe("Lock: unreadable — run /memory unlock");
	});

	it("/memory off is reflected in the status output", async () => {
		const notify = vi.fn();
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());
		const ctx = () => uiCtx({ hasUI: true, ui: { notify, confirm: vi.fn(), setStatus: vi.fn() } });

		await commands["memory"].handler("off", ctx());
		await commands["memory"].handler("", ctx());
		await commands["memory"].handler("on", ctx());
		await commands["memory"].handler("", ctx());

		expect(notify.mock.calls[0]).toEqual(["Memory off", "info"]);
		expect(notify.mock.calls[1][0].split("\n")[0]).toBe("Memory: disabled");
		expect(notify.mock.calls[2]).toEqual(["Memory on", "info"]);
		expect(notify.mock.calls[3][0].split("\n")[0]).toBe("Memory: enabled");
	});

	it("/memory says it is not initialized before session_start", async () => {
		const notify = vi.fn();
		const { pi, commands } = createFakePi();
		memoryFactory(pi as any);

		await commands["memory"].handler("", uiCtx({ hasUI: true, ui: { notify, confirm: vi.fn(), setStatus: vi.fn() } }));

		expect(notify).toHaveBeenCalledWith("Memory not initialized.", "info");
	});

	// Review Focus #5：删锁必须显式确认，而且只删 `.lock`。
	it("/memory unlock removes only the lock file, after an explicit confirm", async () => {
		const notify = vi.fn();
		const confirm = vi.fn().mockResolvedValue(true);
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());
		await writeFile(
			join(dir, ".lock"),
			JSON.stringify({ pid: process.pid, hostname: "h", startedAt: "2026-10-02T01:02:03.000Z", op: "dream" }),
			"utf8",
		);
		await writeFile(join(dir, "keep.md"), "not a lock", "utf8");

		await commands["memory"].handler("unlock", uiCtx({ hasUI: true, ui: { notify, confirm, setStatus: vi.fn() } }));

		// held 的锁：confirm 正文必须点名持有者（op / pid / hostname / startedAt）
		expect(confirm).toHaveBeenCalledWith(
			"Memory lock",
			`Remove the memory lock file? It is held by dream (pid ${process.pid} on h, started 2026-10-02T01:02:03.000Z). Only do this if no memory operation is running.`,
		);
		expect(await readdir(dir)).not.toContain(".lock");
		expect(await readdir(dir)).toContain("keep.md");
		expect(notify).toHaveBeenCalledWith("Memory lock removed.", "info");
	});

	// Plan E/next #1：`unlock` 不需要 store，但**解析目录本身**也可能失败（HOME 不可写、
	// git 探测炸了）。失败必须变成一条 error 通知与干净返回，不能冒泡成 handler 抛错。
	it("/memory unlock reports an unresolvable memory dir instead of throwing", async () => {
		mockConfigValue.enabled = false;
		const notify = vi.fn();
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx()); // disabled：memoryDir 为 null
		dirOverrideRef.current = () => {
			throw new Error("no writable home");
		};

		await expect(commands["memory"].handler("unlock", uiCtx(uiWith(notify)))).resolves.toBeUndefined();

		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0]).toEqual(["Failed to resolve memory dir: no writable home", "error"]);
	});

	it("/memory unlock leaves the lock alone when the user declines", async () => {
		const notify = vi.fn();
		const confirm = vi.fn().mockResolvedValue(false);
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());
		await writeFile(join(dir, ".lock"), JSON.stringify({ pid: process.pid, hostname: "h", startedAt: "x", op: "dream" }), "utf8");

		await commands["memory"].handler("unlock", uiCtx({ hasUI: true, ui: { notify, confirm, setStatus: vi.fn() } }));

		// 取消路径也必须先把持有者摆到用户面前（否则“要不要删”无从判断）
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(confirm.mock.calls[0][0]).toBe("Memory lock");
		expect(confirm.mock.calls[0][1]).toContain(`held by dream (pid ${process.pid} on h, started x)`);
		expect(await readdir(dir)).toContain(".lock");
		expect(notify).not.toHaveBeenCalled();
	});

	it("/memory unlock does not even ask when there is no lock", async () => {
		const notify = vi.fn();
		const confirm = vi.fn();
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		await commands["memory"].handler("unlock", uiCtx({ hasUI: true, ui: { notify, confirm, setStatus: vi.fn() } }));

		expect(confirm).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("No lock present.", "info");
	});

	it("/memory unlock reports a failure instead of pretending the lock is gone", async () => {
		const notify = vi.fn();
		const confirm = vi.fn().mockResolvedValue(true);
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());
		// `.lock` 是一个非空目录：readLockStatus 报 unreadable，unlink 会失败
		await mkdir(join(dir, ".lock"), { recursive: true });
		await writeFile(join(dir, ".lock", "inner"), "x", "utf8");

		await commands["memory"].handler("unlock", uiCtx({ hasUI: true, ui: { notify, confirm, setStatus: vi.fn() } }));

		expect(confirm).toHaveBeenCalled();
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0][0]).toMatch(/^Failed to remove memory lock: /);
		expect(notify.mock.calls[0][1]).toBe("error");
		expect(await readdir(join(dir, ".lock"))).toContain("inner");
	});

	// ── Plan D（D1）：禁用启动的会话也能初始化 + 跨 session 状态复位 ──────────────
	it("/memory reports a not-initialized directory when the session booted disabled", async () => {
		mockConfigValue.enabled = false;
		const notify = vi.fn();
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		await commands["memory"].handler("", uiCtx(uiWith(notify)));

		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0][1]).toBe("info");
		expect(notify.mock.calls[0][0].split("\n")).toEqual([
			"Memory: disabled",
			"Dir: not initialized (run /memory on)",
		]);
	});

	// Review Focus #5 / spec §19：`unlock` 只需要目录、不需要 store —— 以 disabled 启动的
	// 会话也必须能清掉崩溃遗留的 `.lock`（R50：否则唯一的人工恢复入口本 session 不可达）。
	it("/memory unlock removes the lock in a session that booted disabled", async () => {
		mockConfigValue.enabled = false;
		const notify = vi.fn();
		const confirm = vi.fn().mockResolvedValue(true);
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());
		await writeFile(
			join(dir, ".lock"),
			JSON.stringify({ pid: process.pid, hostname: "h", startedAt: "2026-10-02T01:02:03.000Z", op: "dream" }),
			"utf8",
		);
		await writeFile(join(dir, "keep.md"), "not a lock", "utf8");

		await commands["memory"].handler("unlock", uiCtx({ hasUI: true, ui: { notify, confirm, setStatus: vi.fn() } }));

		expect(confirm).toHaveBeenCalledWith(
			"Memory lock",
			`Remove the memory lock file? It is held by dream (pid ${process.pid} on h, started 2026-10-02T01:02:03.000Z). Only do this if no memory operation is running.`,
		);
		expect(await readdir(dir)).not.toContain(".lock");
		expect(await readdir(dir)).toContain("keep.md");
		expect(notify).toHaveBeenCalledWith("Memory lock removed.", "info");
	});

	it("/memory unlock still asks first when the session booted disabled", async () => {
		mockConfigValue.enabled = false;
		const notify = vi.fn();
		const confirm = vi.fn().mockResolvedValue(false);
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());
		await writeFile(
			join(dir, ".lock"),
			JSON.stringify({ pid: process.pid, hostname: "h", startedAt: "x", op: "dream" }),
			"utf8",
		);

		await commands["memory"].handler("unlock", uiCtx({ hasUI: true, ui: { notify, confirm, setStatus: vi.fn() } }));

		expect(confirm).toHaveBeenCalledTimes(1);
		expect(await readdir(dir)).toContain(".lock");
		expect(notify).not.toHaveBeenCalled();
	});

	it("/memory on initialises a session that booted disabled", async () => {
		mockConfigValue.enabled = false;
		const notify = vi.fn();
		const { pi, tools, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());
		// 禁用启动：既没有 store，也不注册工具
		expect(tools).toHaveLength(0);

		await commands["memory"].handler("on", uiCtx(uiWith(notify)));

		expect(notify).toHaveBeenCalledWith("Memory on", "info");
		expect(tools).toHaveLength(1);
		expect(tools[0].parameters.properties.action.enum).toEqual(["add", "replace", "remove", "list", "search"]);

		// 工具真的能写（不再一律 "Memory not initialized"）
		const result = await tools[0].execute(
			"c1",
			{ action: "add", name: "After on", description: "d", content: "正文" },
			undefined,
			undefined,
			undefined,
		);
		expect(result.content[0].text).toBe('Saved "After on" (After-on.md).');
		expect(await readFile(join(dir, "After-on.md"), "utf8")).toContain("name: After on");

		// 索引快照已经构建，并照旧无条件写进 sections（值是 session_start 那一刻的磁盘索引）
		const event = sectionsEvent();
		await handlers["before_agent_start"][0](event, uiCtx());
		expect(event.systemPromptOptions.sections["memory_index"]).toBe(DISK_INDEX);

		// 状态命令回到完整七行
		const status = vi.fn();
		await commands["memory"].handler("", uiCtx(uiWith(status)));
		const lines = status.mock.calls[0][0].split("\n");
		expect(lines).toHaveLength(7);
		expect(lines[0]).toBe("Memory: enabled");
		expect(lines[1]).toBe(`Dir: ${dir}`);
		expect(lines[3]).toBe("Entries: 1");
	});

	// Review Focus #2：上一个 session 是 enabled 的（dir A），本 session 以 disabled 启动且
	// cwd 不同。不清空残留状态的话 `/memory on` 会继续往 A 的目录写。
	it("/memory on after a disabled restart points at the new cwd, not the previous session", async () => {
		const dirB = await mkdtemp(join(tmpdir(), "mem-wiring-b-"));
		const notify = vi.fn();
		const ctxB = () => uiCtx({ cwd: dirB, hasUI: true, ui: { notify, confirm: vi.fn(), setStatus: vi.fn() } });
		try {
			const { pi, commands, handlers } = createFakePi();
			memoryFactory(pi as any);
			await handlers["session_start"][0]({}, uiCtx()); // enabled，dir A = dir

			dirOverrideRef.current = (cwd) => join(cwd, ".memory");
			mockConfigValue.enabled = false;
			await mkdir(join(dirB, ".memory"), { recursive: true });
			await writeFile(join(dirB, ".memory", "MEMORY.md"), "- [B](B.md) — from B\n", "utf8");
			await handlers["session_start"][0]({}, uiCtx({ cwd: dirB }));

			await commands["memory"].handler("on", ctxB());
			await commands["memory"].handler("", ctxB());

			expect(notify.mock.calls[0]).toEqual(["Memory on", "info"]);
			const lines = notify.mock.calls[1][0].split("\n");
			expect(lines).toHaveLength(7);
			expect(lines[1]).toBe(`Dir: ${join(dirB, ".memory")}`);
			expect(lines[1]).not.toContain(dir);
			expect(lines[2]).toMatch(/^Index: 1\/200 lines, \d+\/25600 bytes, 0 unrecognized lines$/);
		} finally {
			mockConfigValue.enabled = true;
			await rm(dirB, { recursive: true, force: true });
		}
	});

	// Plan E/next #2(a)：disabled 重启必须把上一 session 的 memoryDir 清掉 —— 光靠状态行的
	// 两行输出只能证明「memoryDir 与 store 至少有一个被清了」（`/memory` 的守卫是 `||`），
	// 所以这里再用 `/memory unlock` 钉一次 memoryDir 本身：它拿到的必须是**本 cwd** 的目录，
	// 而不是上一 session 的 dirA（否则会去删错项目的锁，真事故）。
	it("/memory after a disabled restart never reports or unlocks the previous session's dir", async () => {
		const dirB = await mkdtemp(join(tmpdir(), "mem-wiring-b-"));
		const notify = vi.fn();
		const confirm = vi.fn().mockResolvedValue(true);
		const ctxB = () => uiCtx({ cwd: dirB, hasUI: true, ui: { notify, confirm, setStatus: vi.fn() } });
		const lock = JSON.stringify({ pid: process.pid, hostname: "h", startedAt: "x", op: "dream" });
		try {
			const { pi, commands, handlers } = createFakePi();
			memoryFactory(pi as any);
			await handlers["session_start"][0]({}, uiCtx()); // enabled @ dirA

			dirOverrideRef.current = (cwd) => join(cwd, ".memory");
			mockConfigValue.enabled = false;
			await handlers["session_start"][0]({}, uiCtx({ cwd: dirB }));

			await commands["memory"].handler("", ctxB());

			expect(notify).toHaveBeenCalledTimes(1);
			expect(notify.mock.calls[0][1]).toBe("info");
			expect(notify.mock.calls[0][0].split("\n")).toEqual([
				"Memory: disabled",
				"Dir: not initialized (run /memory on)",
			]);
			expect(notify.mock.calls[0][0]).not.toContain(dir);

			// 两个目录各放一把锁：unlock 只能动本 cwd（dirB/.memory）的那把
			await writeFile(join(dir, ".lock"), lock, "utf8");
			await mkdir(join(dirB, ".memory"), { recursive: true });
			await writeFile(join(dirB, ".memory", ".lock"), lock, "utf8");
			notify.mockClear();

			await commands["memory"].handler("unlock", ctxB());

			expect(notify.mock.calls[0]).toEqual(["Memory lock removed.", "info"]);
			expect(await readdir(join(dirB, ".memory"))).not.toContain(".lock");
			expect(await readdir(dir)).toContain(".lock");
		} finally {
			mockConfigValue.enabled = true;
			await rm(dirB, { recursive: true, force: true });
		}
	});

	// Plan E/next #2(b)：`/dream` 的守卫是 `!config || !memoryDir || !activeStore`。store 残留
	// 会真的对 dirA 起一轮 dream（而不只是打错一行状态）。
	it("/dream refuses right after a disabled restart instead of dreaming the old dir", async () => {
		const dirB = await mkdtemp(join(tmpdir(), "mem-wiring-b-"));
		const notify = vi.fn();
		const ctxB = () => uiCtx({ cwd: dirB, hasUI: true, ui: { notify, confirm: vi.fn(), setStatus: vi.fn() } });
		try {
			const { pi, commands, handlers } = createFakePi();
			memoryFactory(pi as any);
			await handlers["session_start"][0]({}, uiCtx()); // enabled @ dirA

			dirOverrideRef.current = (cwd) => join(cwd, ".memory");
			mockConfigValue.enabled = false;
			await handlers["session_start"][0]({}, uiCtx({ cwd: dirB }));

			await commands["dream"].handler("", ctxB());

			expect(notify).toHaveBeenCalledWith("Memory not initialized.", "info");
			expect(runDreamMock).not.toHaveBeenCalled();
		} finally {
			mockConfigValue.enabled = true;
			await rm(dirB, { recursive: true, force: true });
		}
	});

	// Review Focus #1：初始化中途抛错不得留下「enabled=true 但没有 store」的半状态。
	it("/memory on rolls the switch back when initialisation fails", async () => {
		mockConfigValue.enabled = false;
		const notify = vi.fn();
		const { pi, tools, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());
		dirOverrideRef.current = () => {
			throw new Error("no writable home");
		};

		await commands["memory"].handler("on", uiCtx(uiWith(notify)));

		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0]).toEqual(["Failed to initialize memory: no writable home", "error"]);
		expect(tools).toHaveLength(0);

		// 回滚是可观测的：状态行说 disabled，而且没有半初始化的目录
		await commands["memory"].handler("", uiCtx(uiWith(notify)));
		expect(notify.mock.calls[1][0].split("\n")).toEqual([
			"Memory: disabled",
			"Dir: not initialized (run /memory on)",
		]);
	});

	// Review Focus #2 的另一半：disabled 启动必须清掉上一 session 的 injectedFiles，
	// 否则 `/memory on` 之后同一条 entry 在本会话再也不会浮现。
	it("a disabled restart clears the injected-file set", async () => {
		const injectedAtCall: Array<Set<string>> = [];
		scanEntriesMock.mockResolvedValue([
			{ file: "ssh.md", name: "SSH", description: "d", type: "project", modified: "2026-01-01T00:00:00.000Z" },
		]);
		// injectedFiles 是活 Set：必须在调用瞬间深拷贝（见 `does not surface the same entry file twice`）
		runSideQueryMock.mockImplementation(async (...args: any[]) => {
			injectedAtCall.push(new Set(args[2]));
			return ["ssh.md"];
		});
		injectSurfacedContentMock.mockResolvedValue("<relevant_memories>x</relevant_memories>");

		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());
		await handlers["before_agent_start"][0](sectionsEvent("ssh?"), uiCtx());

		mockConfigValue.enabled = false;
		await handlers["session_start"][0]({}, uiCtx());
		await commands["memory"].handler("on", uiCtx(uiWith()));
		await handlers["before_agent_start"][0](sectionsEvent("ssh?"), uiCtx());

		expect(injectedAtCall).toHaveLength(2);
		expect(injectedAtCall[0]).toEqual(new Set());
		expect(injectedAtCall[1]).toEqual(new Set());
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
