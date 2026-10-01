import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildExtractTask,
	type ExtractMessage,
	renderConversation,
	runExtract,
	type RunExtractOpts,
	toExtractMessages,
} from "../src/extract";
import { MemoryStore, type StoreConfig } from "../src/memory-store";

const { runHeadlessAgentMock } = vi.hoisted(() => ({
	runHeadlessAgentMock: vi.fn().mockResolvedValue("saved 2 memories"),
}));
vi.mock("../src/agent-runner", () => ({
	runHeadlessAgent: runHeadlessAgentMock,
}));

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
		thinkLevel: "high",
		memoryDir: dir,
		store,
		messages: [{ role: "user", content: "hello" }],
		maxContextTokens: 2000,
		maxToolResultChars: 500,
		maxAssistantChars: 2000,
		modelRegistry: {} as any,
		customTools: [],
		...over,
	};
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "mem-extract-"));
	store = new MemoryStore(CFG(dir));
	runHeadlessAgentMock.mockClear();
	runHeadlessAgentMock.mockResolvedValue("saved 2 memories");
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("toExtractMessages", () => {
	it("maps a pi user message with string content", () => {
		expect(toExtractMessages([{ role: "user", content: "hello", timestamp: 1 }])).toEqual([
			{ role: "user", text: "hello" },
		]);
	});

	it("maps block content and renders images as a placeholder", () => {
		const out = toExtractMessages([
			{
				role: "user",
				content: [
					{ type: "text", text: "look" },
					{ type: "image", data: "AAAA", mimeType: "image/png" },
				],
			},
		]);
		expect(out).toEqual([{ role: "user", text: "look\n[image]" }]);
	});

	it("maps an assistant message with text and tool calls", () => {
		const out = toExtractMessages([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "ok" },
					{ type: "toolCall", id: "t1", name: "memory", arguments: { action: "add" } },
				],
			},
		]);
		expect(out).toEqual([
			{ role: "assistant", text: "ok", toolCalls: [{ name: "memory", args: '{"action":"add"}' }] },
		]);
	});

	it("drops thinking blocks but keeps the assistant text next to them", () => {
		const out = toExtractMessages([
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hmm" },
					{ type: "text", text: "answer" },
				],
			},
		]);
		expect(out).toEqual([{ role: "assistant", text: "answer" }]);
	});

	it("maps a tool result and keeps the error flag", () => {
		const out = toExtractMessages([
			{
				role: "toolResult",
				toolCallId: "t1",
				toolName: "bash",
				content: [{ type: "text", text: "exit 1" }],
				isError: true,
			},
		]);
		expect(out).toEqual([{ role: "toolResult", text: "exit 1", toolName: "bash", isError: true }]);
	});

	it("keeps text from an unknown shape and drops messages that have none", () => {
		const out = toExtractMessages([
			{ role: "custom", content: "preserved" },
			{ role: "custom", output: "from output" },
			null,
			42,
			{},
			{ role: "user", content: [] },
		]);
		expect(out).toEqual([
			{ role: "user", text: "preserved" },
			{ role: "user", text: "from output" },
		]);
	});
});

describe("renderConversation", () => {
	// spec §11.1 的根因：v1 只取「第一条 user + 最后一条 assistant」，中间的纠正全部丢失。
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
	});

	it("leaves a short conversation untouched", () => {
		const messages: ExtractMessage[] = [{ role: "user", text: "hi" }];
		expect(renderConversation(messages, { ...LIMITS, maxContextTokens: 2000 })).toBe("[1] user: hi");
	});
});

describe("buildExtractTask", () => {
	it("renders the whole conversation, not just two messages", () => {
		const messages = toExtractMessages([
			{ role: "user", content: "how do I debug SSH?" },
			{ role: "assistant", content: [{ type: "text", text: "Use ssh -vvv" }] },
			{ role: "user", content: "no, the port is wrong" },
			{
				role: "toolResult",
				toolName: "bash",
				content: [{ type: "text", text: "Connection refused on 22" }],
				isError: true,
			},
		]);
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
			'<project_instructions path="/home/user/.pi/agent/AGENTS.md">\nglobal: use Chinese\n</project_instructions>',
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
	// spec §5.2：extract **不等待**逻辑锁 —— 拿不到即跳过本轮。
	it("returns skipped without calling the headless agent when the logical lock is busy", async () => {
		const out = await runExtract(opts({ store: busyStore() }));
		expect(out).toEqual({ skipped: true });
		expect(runHeadlessAgentMock).not.toHaveBeenCalled();
	});

	it("skips when nothing renderable is left", async () => {
		const out = await runExtract(opts({ messages: [] }));
		expect(out).toEqual({ skipped: true });
		expect(runHeadlessAgentMock).not.toHaveBeenCalled();

		const out2 = await runExtract(opts({ messages: [null, 42, {}] }));
		expect(out2).toEqual({ skipped: true });
		expect(runHeadlessAgentMock).not.toHaveBeenCalled();
	});

	it("runs the headless agent with no built-in tools, maxTurns=5 and the custom tools", async () => {
		const customTools = [{ name: "memory" } as unknown as ToolDefinition];
		const out = await runExtract(
			opts({
				customTools,
				model: "deepseek/deepseek-v4-flash",
				parentModel: { id: "parent" } as any,
				sessionPersistence: { enabled: true },
			}),
		);

		expect(out).toEqual({ skipped: false, result: "saved 2 memories" });
		expect(runHeadlessAgentMock).toHaveBeenCalledTimes(1);
		expect(runHeadlessAgentMock).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: dir,
				thinkLevel: "high",
				maxTurns: 5,
				timeoutMs: 120_000,
				tools: [],
				customTools,
				model: "deepseek/deepseek-v4-flash",
				parentModel: { id: "parent" },
				sessionPersistence: { enabled: true },
			}),
		);
	});

	it("releases the logical lock after a successful run", async () => {
		await runExtract(opts());
		expect(store.logicalLockActive()).toBe(false);
	});

	it("renders the configured char limits into the task", async () => {
		await runExtract(
			opts({
				messages: [
					{ role: "assistant", content: [{ type: "text", text: "a".repeat(400) }] },
					{ role: "toolResult", toolName: "bash", content: [{ type: "text", text: "r".repeat(400) }] },
				],
				maxToolResultChars: 30,
				maxAssistantChars: 40,
			}),
		);
		const task: string = runHeadlessAgentMock.mock.calls[0][0].task;
		expect(task).toContain("a".repeat(40));
		expect(task).not.toContain("a".repeat(41));
		expect(task).toContain("r".repeat(30));
		expect(task).not.toContain("r".repeat(31));
	});

	it("passes the AGENTS.md blocks through", async () => {
		await runExtract(opts({ agentsMdBlocks: ['<project_instructions path="/x">\nrule\n</project_instructions>'] }));
		expect(runHeadlessAgentMock.mock.calls[0][0].task).toContain("## AGENTS.md Rules");
	});

	// spec §14：extract 失败不得被静默吞掉（v1 内部就有一层 .catch(() => {})）。
	it("propagates a headless-agent failure instead of swallowing it", async () => {
		runHeadlessAgentMock.mockRejectedValueOnce(new Error("extract failed"));
		await expect(runExtract(opts())).rejects.toThrow("extract failed");
		expect(store.logicalLockActive()).toBe(false);
	});
});
