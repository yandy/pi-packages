import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	MAIN_AGENT_ACTIONS,
	MemoryStore,
	type ExtractMessage,
	type RunExtractOpts,
	type StoreConfig,
	buildExtractTask,
	renderConversation,
	runExtract,
} from "../src/index.js";

/** 假的 `HeadlessAgentPort`。 */
const headlessRun = vi.fn();
/**
 * 假的 `HostTranscriptPort`：透传。core 的测试直接给中立的 `ExtractMessage`，
 * 「宿主消息形状 → ExtractMessage」的翻译是宿主知识，钉在 `pi-memory/tests/host-transcript.test.ts`。
 */
const toExtractMessages = (raw: unknown[]): ExtractMessage[] => raw as ExtractMessage[];
const ports = { headless: { run: headlessRun }, transcript: { toExtractMessages, searchSessions: async () => "" } };
const extract = (o: RunExtractOpts) => runExtract(o, ports);

const LIMITS = { maxToolResultChars: 500, maxAssistantChars: 2000, maxContextTokens: 100_000 };

let dir: string;
let store: MemoryStore;

const CFG = (memoryDir: string): StoreConfig => ({
	memoryDir,
	indexMaxLines: 200,
	indexMaxBytes: 25600,
	lock: { timeoutMs: 5000, snapshotKeep: 5 },
});

/** 逻辑锁「忙」的假 store：tryWithLogicalLock 恒返回 null（= 拿不到锁）。 */
function busyStore(): MemoryStore {
	return {
		tryWithLogicalLock: async () => null,
	} as unknown as MemoryStore;
}

function opts(over: Partial<RunExtractOpts> = {}): RunExtractOpts {
	return {
		effort: "high",
		memoryDir: dir,
		store,
		messages: [{ role: "user", text: "hello" }],
		maxContextTokens: 2000,
		maxToolResultChars: 500,
		maxAssistantChars: 2000,
		model: "deepseek/deepseek-v4-flash",
		...over,
	};
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "mem-extract-"));
	store = new MemoryStore(CFG(dir));
	headlessRun.mockClear();
	headlessRun.mockResolvedValue("saved 2 memories");
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("renderConversation", () => {
	// 根因：v1 只取「第一条 user + 最后一条 assistant」，中间的纠正全部丢失。
	it("keeps every message, numbered in order, including the mid-turn correction", () => {
		const messages: ExtractMessage[] = [
			{ role: "user", text: "first" },
			{ role: "assistant", text: "reply" },
			{ role: "user", text: "no, the other way round" },
			{ role: "assistant", text: "fixed" },
		];
		expect(renderConversation(messages, LIMITS)).toBe(
			"[1] user: first\n[2] assistant: reply\n[3] user: no, the other way round\n[4] assistant: fixed",
		);
	});

	it("renders an assistant tool call with a short argument summary", () => {
		const messages: ExtractMessage[] = [
			{ role: "assistant", text: "Let me look.", toolCalls: [{ name: "memory", args: '{"action":"list"}' }] },
		];
		expect(renderConversation(messages, LIMITS)).toBe(
			'[1] assistant: Let me look. | tool_call: memory({"action":"list"})',
		);
	});

	it("clips assistant text but never user text", () => {
		const messages: ExtractMessage[] = [
			{ role: "user", text: "u".repeat(500) },
			{ role: "assistant", text: "a".repeat(500) },
		];
		const out = renderConversation(messages, { ...LIMITS, maxAssistantChars: 100 });
		expect(out).toContain("u".repeat(500));
		expect(out).toContain("a".repeat(100));
		expect(out).not.toContain("a".repeat(101));
		expect(out).toContain("[truncated: 400 chars omitted]");
	});

	it("clips a tool_result and marks failures", () => {
		const messages: ExtractMessage[] = [
			{ role: "toolResult", toolName: "bash", text: "x".repeat(300) },
			{ role: "toolResult", toolName: "bash", text: "boom", isError: true },
		];
		const out = renderConversation(messages, { ...LIMITS, maxToolResultChars: 50 });
		expect(out).toContain(`[1] tool_result: ${"x".repeat(50)}`);
		expect(out).not.toContain("x".repeat(51));
		expect(out).toContain("[2] tool_result: [error] boom");
	});

	it("counts a bash result's `$ cmd` prefix toward maxToolResultChars", () => {
		// 宿主把一次 bash 执行映射成 `text: "$ run\n" + output`；那 6 个字符的前缀也算进预算，
		// 所以 86 字符的正文按 20 的上限截掉 66。
		const out = renderConversation(
			[{ role: "toolResult", toolName: "bash", text: `$ run\n${"x".repeat(80)}` }],
			{ ...LIMITS, maxToolResultChars: 20 },
		);
		expect(out).toContain("[1] tool_result: $ run\n");
		expect(out).toContain("[truncated: 66 chars omitted]");
	});

	it("clips the middle when the total exceeds maxContextTokens * 4", () => {
		const messages: ExtractMessage[] = [
			{ role: "user", text: `HEAD${"a".repeat(300)}` },
			{ role: "assistant", text: `MID${"b".repeat(300)}` },
			{ role: "user", text: `${"c".repeat(300)}TAIL` },
		];
		const out = renderConversation(messages, { ...LIMITS, maxContextTokens: 100 });

		expect(out).toContain("[1] user: HEAD");
		expect(out).toContain("TAIL");
		expect(out).toContain("chars omitted from the middle");
		expect(out).not.toContain("MID");
		expect(out.length).toBeLessThan(600);
		// 块级丢了一块、字符串回退又裁了一次：输出里仍然只能有一个标记，
		// N = 块级省略 + 字符串省略（旧实现报 327，因为它把块级标记丢在了裁掉的中段里）。
		expect(out.match(/\[truncated:/g)).toHaveLength(1);
		expect(out).toContain("[truncated: 599 chars omitted from the middle]");
	});

	// 「优先保留全部 user 消息」：中段裁减只丢非 user 块，中间的纠正必须留下。
	it("keeps a mid-turn user correction when the budget is exceeded", () => {
		const messages: ExtractMessage[] = [
			{ role: "assistant", text: `LEFT${"a".repeat(300)}` },
			{ role: "user", text: "no, the port is 2222" },
			{ role: "toolResult", toolName: "bash", text: `RIGHT${"r".repeat(300)}` },
		];
		const out = renderConversation(messages, { ...LIMITS, maxContextTokens: 95 });

		expect(out).toContain("[2] user: no, the port is 2222");
		expect(out).toContain("chars omitted from the middle");
		expect(out).not.toContain("LEFT");
		expect(out).not.toContain("RIGHT");
		expect(out.length).toBeLessThanOrEqual(380);
	});

	it("falls back to the string middle clip when only user blocks exceed the budget", () => {
		const messages: ExtractMessage[] = [
			{ role: "user", text: `HEAD${"u".repeat(300)}` },
			{ role: "user", text: `${"v".repeat(300)}TAIL` },
		];
		const out = renderConversation(messages, { ...LIMITS, maxContextTokens: 100 });

		expect(out).toContain("[1] user: HEAD");
		expect(out).toContain("TAIL");
		expect(out).toContain("chars omitted from the middle");
		expect(out.length).toBeLessThanOrEqual(400);
	});

	// 块级标记被 `assemble` 追加在末尾时，字符串回退会在它之外
	// 再插一个标记（输出里出现两个 `[truncated: …]`），而且回退标记的 N 把旧标记自身的
	// 长度也算成「省略的正文」。
	it("emits exactly one middle marker when the fallback runs after a trailing block drop", () => {
		const messages: ExtractMessage[] = [
			{ role: "user", text: `ONE${"u".repeat(300)}` },
			{ role: "user", text: `TWO${"v".repeat(300)}` },
			{ role: "assistant", text: `MID${"a".repeat(300)}` },
		];

		const out = renderConversation(messages, { ...LIMITS, maxContextTokens: 100 });

		expect(out.match(/\[truncated:/g)).toHaveLength(1);
		expect(out).toContain("[truncated: 598 chars omitted from the middle]");
		expect(out).toContain("[1] user: ONE");
		expect(out).toContain("v".repeat(100)); // 结尾的 user 块优先保留
		expect(out).not.toContain("MID");
		expect(out.length).toBeLessThanOrEqual(400);
	});

	it("keeps one marker and honours an extreme budget", () => {
		const messages: ExtractMessage[] = [
			{ role: "user", text: "u".repeat(500) },
			{ role: "toolResult", toolName: "bash", text: "t".repeat(500) },
			{ role: "user", text: "v".repeat(500) },
		];

		const out = renderConversation(messages, { ...LIMITS, maxContextTokens: 20 });

		expect(out.match(/\[truncated:/g)).toHaveLength(1);
		expect(out).toContain("[truncated: 1510 chars omitted from the middle]");
		expect(out).toContain("[1] user: u");
		expect(out.length).toBeLessThanOrEqual(80);
	});

	// user 正文里恰好出现与块级标记逐字相同的串（模型抄了
	// 我们自己的截断标记）。`String.replace` 删**首次**出现 → 误删正文里的那一份，真正的
	// 标记留在输出里，于是 N 与保留下来的首尾全部错位；`lastIndexOf` 只删我们自己那一个。
	it("removes only the block-level marker when a user block carries the same string", () => {
		const spoof = "[truncated: 319 chars omitted from the middle]";
		const messages: ExtractMessage[] = [
			{ role: "user", text: `HEAD ${spoof} ${"u".repeat(200)}` },
			{ role: "assistant", text: `MID${"a".repeat(300)}` },
			{ role: "user", text: `${"v".repeat(200)} TAIL` },
		];

		const out = renderConversation(messages, { ...LIMITS, maxContextTokens: 100 });

		// 正文里的同款串活着（修复前它被当成块级标记删掉了，`HEAD` 后面直接跟 u）
		expect(out).toContain(`HEAD ${spoof} `);
		// 块级标记只有一个，N 精确（修复前是 402，因为它把误删的正文也算进了省略量）
		expect(out).toContain("[truncated: 448 chars omitted from the middle]");
		expect(out).not.toContain("[truncated: 402 chars omitted from the middle]");
		expect(out).toContain("TAIL");
		expect(out.length).toBeLessThanOrEqual(400);
	});

	// 仿冒串与真标记**逐字相同**（N 也相同），但位置在真标记**之后**
	// —— 落在未被丢弃的尾部 user 块里。按字符串搜索删除（删首次或删末次都一样）会命中正文里
	// 的那一份、把真正的块级标记留在输出里：输出出现两个 `[truncated: …]`，N 与首尾全部错位。
	// 按 `assemble()` 已知的插入位置删除，输出里才恰有一个标记、N 是真实省略量。
	it("keeps exactly one marker when a same-string spoof follows the real one", () => {
		// 唯一被丢的是中间那条 assistant 块（318 字符）→ 块级 omitted = 318 + 1 = 319；
		// `spoof` 由它派生，保证与真标记逐字相同（字符串与 N 都一致）。
		const dropped = `[2] assistant: MID${"a".repeat(300)}`;
		const spoof = `[truncated: ${dropped.length + 1} chars omitted from the middle]`;
		const messages: ExtractMessage[] = [
			{ role: "user", text: "HEAD" },
			{ role: "assistant", text: `MID${"a".repeat(300)}` },
			{ role: "user", text: `${"v".repeat(200)}${spoof}${"w".repeat(200)} TAIL-END` },
		];

		const out = renderConversation(messages, { ...LIMITS, maxContextTokens: 100 });

		// 输出里恰好一个块级标记、N 是真实省略量（修复前真标记被留在输出里 → 两个标记，
		// 且回退标记的 N 把多删的那 46 个字符也算进了省略量 → 451）。
		expect(out.match(/\[truncated: \d+ chars omitted from the middle\]/g)).toHaveLength(1);
		expect(out).toContain("[truncated: 450 chars omitted from the middle]");
		expect(out).not.toContain("[truncated: 451 chars omitted from the middle]");
		// 首尾正文都在（尾部那一段用可识别的尾文字标注），不会被错位的标记吃掉。
		expect(out).toContain("[1] user: HEAD");
		expect(out).toContain(`${"w".repeat(50)} TAIL-END`);
		expect(out.length).toBeLessThanOrEqual(400);
	});

	it("leaves a short conversation untouched", () => {
		const messages: ExtractMessage[] = [{ role: "user", text: "hi" }];
		expect(renderConversation(messages, { ...LIMITS, maxContextTokens: 2000 })).toBe("[1] user: hi");
	});
});

describe("buildExtractTask", () => {
	it("renders the whole conversation, not just two messages", () => {
		const messages: ExtractMessage[] = [
			{ role: "user", text: "how do I debug SSH?" },
			{ role: "assistant", text: "Use ssh -vvv" },
			{ role: "user", text: "no, the port is wrong" },
			{ role: "toolResult", toolName: "bash", text: "Connection refused on 22", isError: true },
		];
		const task = buildExtractTask(messages, 2000, [], { maxToolResultChars: 500, maxAssistantChars: 2000 });

		expect(task).toContain("[1] user: how do I debug SSH?");
		expect(task).toContain("[2] assistant: Use ssh -vvv");
		expect(task).toContain("[3] user: no, the port is wrong");
		expect(task).toContain("[4] tool_result: [error] Connection refused on 22");
	});

	it("describes the memory tool and the one-memory-per-file model", () => {
		const task = buildExtractTask([{ role: "user", text: "hi" }], 2000, [], {
			maxToolResultChars: 500,
			maxAssistantChars: 2000,
		});
		expect(task).toContain("memory extraction agent");
		expect(task).toContain("Your ONLY tool is `memory`");
		expect(task).toContain('memory(action="add"');
		expect(task).toContain('memory(action="replace"');
		expect(task).toContain('memory(action="list")');
		expect(task).toContain('memory(action="search"');
		expect(task).toContain("One memory = one file");
		expect(task).toContain("`content` IS the memory");
		expect(task).toContain("`description` is required in practice");
		expect(task).toContain("## What to Remember");
		expect(task).toContain("## What to Skip");
	});

	it("drops the legacy wording and the legacy tool names", () => {
		const task = buildExtractTask([{ role: "user", text: "hi" }], 2000, [], {
			maxToolResultChars: 500,
			maxAssistantChars: 2000,
		});
		expect(task.toLowerCase()).not.toContain("topic");
		expect(task).not.toContain("memory_add");
		expect(task).not.toContain("memory_search");
		expect(task).not.toContain("- ls —");
		expect(task).not.toContain("User: ");
	});

	it("inserts AGENTS.md blocks after the Output section and before the Conversation", () => {
		const blocks = [
			'<project_instructions path="/home/user/.agent/AGENTS.md">\nglobal: use Chinese\n</project_instructions>',
			'<project_instructions path="/project/AGENTS.md">\nproject: never skip tests\n</project_instructions>',
		];
		const task = buildExtractTask([{ role: "user", text: "hi" }], 2000, blocks, {
			maxToolResultChars: 500,
			maxAssistantChars: 2000,
		});

		expect(task).toContain("## AGENTS.md Rules");
		expect(task).toContain("global: use Chinese");
		expect(task).toContain("project: never skip tests");
		expect(task.indexOf("## Output")).toBeLessThan(task.indexOf("## AGENTS.md Rules"));
		expect(task.indexOf("## AGENTS.md Rules")).toBeLessThan(task.indexOf("=== Conversation ==="));
		expect(task).toContain("refer to the AGENTS.md content below");
	});

	it("omits the AGENTS.md section when there are no blocks", () => {
		const task = buildExtractTask([{ role: "user", text: "hi" }], 2000, [], {
			maxToolResultChars: 500,
			maxAssistantChars: 2000,
		});
		expect(task).not.toContain("## AGENTS.md Rules");
	});

	it("applies the per-message char limits", () => {
		const messages: ExtractMessage[] = [
			{ role: "assistant", text: "a".repeat(400) },
			{ role: "toolResult", text: "r".repeat(400) },
		];
		const task = buildExtractTask(messages, 100_000, [], {
			maxToolResultChars: 30,
			maxAssistantChars: 40,
		});
		expect(task).toContain("a".repeat(40));
		expect(task).not.toContain("a".repeat(41));
		expect(task).toContain("r".repeat(30));
		expect(task).not.toContain("r".repeat(31));
	});
});

describe("runExtract", () => {
	// extract **不等待**逻辑锁 —— 拿不到即跳过本轮。
	it("returns skipped without calling the headless agent when the logical lock is busy", async () => {
		const out = await extract(opts({ store: busyStore() }));
		expect(out).toEqual({ skipped: true });
		expect(headlessRun).not.toHaveBeenCalled();
	});

	it("skips without calling the host when the transcript maps to nothing", async () => {
		expect(await extract(opts({ messages: [] }))).toEqual({ skipped: true });
		expect(headlessRun).not.toHaveBeenCalled();

		// 「垃圾消息映射成空数组」是宿主的责任；core 的契约只有一条：映射结果为空 → 跳过本轮。
		const empty = {
			headless: { run: headlessRun },
			transcript: { toExtractMessages: () => [], searchSessions: async () => "" },
		};
		expect(await runExtract(opts({ messages: [null, 42, {}] }), empty)).toEqual({ skipped: true });
		expect(headlessRun).not.toHaveBeenCalled();
	});

	it("asks for no builtin tools, five actions, maxTurns=5 and a 120s timeout", async () => {
		const out = await extract(
			opts({
				model: "deepseek/deepseek-v4-flash",
				sessionPersistence: { enabled: true },
			}),
		);

		expect(out).toEqual({ skipped: false, result: "saved 2 memories" });
		expect(headlessRun).toHaveBeenCalledTimes(1);
		expect(headlessRun).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: dir,
				effort: "high",
				maxTurns: 5,
				timeoutMs: 120_000,
				// 「关 builtin、只留 memory 工具」在 core 里就是这两个字段；
				// 白名单陷阱（宿主的 tools: [] 会连 customTools 一起滤掉）由适配层躲开。
				builtinTools: "none",
				memoryTool: { actions: MAIN_AGENT_ACTIONS, skipLogicalLock: true, onWrite: undefined },
				model: "deepseek/deepseek-v4-flash",
				sessionPersistence: { enabled: true },
			}),
		);
	});

	it("forwards onWrite into the memory tool spec so the adapter can count writes", async () => {
		const onWrite = vi.fn();
		await extract(opts({ onWrite }));
		expect(headlessRun.mock.calls[0][0].memoryTool).toMatchObject({ onWrite });
	});

	it("releases the logical lock after a successful run", async () => {
		await extract(opts());
		expect(store.logicalLockActive()).toBe(false);
	});

	it("renders the configured char limits into the task", async () => {
		await extract(
			opts({
				messages: [
					{ role: "assistant", text: "a".repeat(400) },
					{ role: "toolResult", toolName: "bash", text: "r".repeat(400) },
				],
				maxToolResultChars: 30,
				maxAssistantChars: 40,
			}),
		);
		const task: string = headlessRun.mock.calls[0][0].task;
		expect(task).toContain("a".repeat(40));
		expect(task).not.toContain("a".repeat(41));
		expect(task).toContain("r".repeat(30));
		expect(task).not.toContain("r".repeat(31));
	});

	it("passes the AGENTS.md blocks through", async () => {
		await extract(opts({ agentsMdBlocks: ['<project_instructions path="/x">\nrule\n</project_instructions>'] }));
		expect(headlessRun.mock.calls[0][0].task).toContain("## AGENTS.md Rules");
	});

	// extract 失败不得被静默吞掉。
	it("propagates a headless-agent failure instead of swallowing it", async () => {
		headlessRun.mockRejectedValueOnce(new Error("extract failed"));
		await expect(extract(opts())).rejects.toThrow("extract failed");
		expect(store.logicalLockActive()).toBe(false);
	});
});
