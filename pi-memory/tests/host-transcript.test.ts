import { describe, expect, it } from "vitest";
import { toExtractMessages } from "../src/host-transcript";

/**
 * pi 的消息形状 → core 的中立 `ExtractMessage`。
 *
 * 这一整个文件都是宿主知识：core 只认 `ExtractMessage`，对 pi 的 `AgentMessage`、bash 执行记录、
 * branch/compaction 摘要一无所知。渲染与预算钉在 `auto-memory/tests/extract.test.ts`。
 */
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

	it("maps a custom message to assistant text", () => {
		const out = toExtractMessages([
			{ role: "custom", customType: "note", content: "preserved", display: true, timestamp: 1 },
			{
				role: "custom",
				customType: "note",
				content: [
					{ type: "text", text: "part one" },
					{ type: "text", text: "part two" },
				],
				display: false,
				timestamp: 2,
			},
			{
				role: "custom",
				customType: "note",
				content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
				display: false,
				timestamp: 3,
			},
		]);
		expect(out).toEqual([
			{ role: "assistant", text: "preserved" },
			{ role: "assistant", text: "part one part two" },
		]);
	});

	// Minor（复核者点名）：memory-auto-surfacing 是 pi-memory 自己注入的 <relevant_memories>。
	// 把它渲染成 assistant 文本会再次进入 extract prompt，等于让 extract 从自己的记忆里反复提取。
	it("skips the memory-auto-surfacing self-injection but keeps other custom messages", () => {
		const out = toExtractMessages([
			{
				role: "custom",
				customType: "memory-auto-surfacing",
				content: "<relevant_memories>\n## SSH\n2222\n</relevant_memories>",
				display: false,
				timestamp: 1,
			},
			{ role: "custom", customType: "note", content: "kept", display: true, timestamp: 2 },
		]);

		expect(out).toEqual([{ role: "assistant", text: "kept" }]);
	});

	it("maps bash executions to bash tool results and honours excludeFromContext", () => {
		const out = toExtractMessages([
			{
				role: "bashExecution",
				command: "npm test",
				output: "boom",
				exitCode: 1,
				cancelled: false,
				truncated: false,
				timestamp: 1,
			},
			{
				role: "bashExecution",
				command: "ls",
				output: "a b",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 2,
			},
			{
				role: "bashExecution",
				command: "sleep 10",
				output: "killed",
				exitCode: undefined,
				cancelled: true,
				truncated: false,
				timestamp: 3,
			},
			{
				role: "bashExecution",
				command: "cat secret",
				output: "hidden",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				excludeFromContext: true,
				timestamp: 4,
			},
		]);
		expect(out).toEqual([
			{ role: "toolResult", toolName: "bash", text: "$ npm test\nboom", isError: true },
			{ role: "toolResult", toolName: "bash", text: "$ ls\na b", isError: false },
			{ role: "toolResult", toolName: "bash", text: "$ sleep 10\nkilled", isError: false },
		]);
	});

	it("maps branch and compaction summaries to assistant context", () => {
		const out = toExtractMessages([
			{ role: "branchSummary", summary: "back from the refactor branch", fromId: "e12", timestamp: 1 },
			{ role: "compactionSummary", summary: "the compacted history", tokensBefore: 90_000, timestamp: 2 },
			{ role: "compactionSummary", tokensBefore: 90_000, timestamp: 3 },
		]);
		expect(out).toEqual([
			{ role: "assistant", text: "[branch summary] back from the refactor branch" },
			{ role: "assistant", text: "[compaction summary] the compacted history" },
		]);
	});

	it("keeps an unknown role as assistant text and never as a user rule", () => {
		const out = toExtractMessages([
			{ role: "system", content: "from content" },
			{ role: "mystery", output: "from output" },
			{ role: "mystery", text: "from text" },
			{ role: "mystery", summary: "from summary" },
			{ role: "mystery", content: [{ type: "text", text: "from array" }] },
		]);
		expect(out).toEqual([
			{ role: "assistant", text: "from content" },
			{ role: "assistant", text: "from output" },
			{ role: "assistant", text: "from text" },
			{ role: "assistant", text: "from summary" },
			{ role: "assistant", text: "from array" },
		]);
	});

	it("drops messages that have no text at all", () => {
		expect(toExtractMessages([null, 42, {}, { role: "mystery" }, { role: "user", content: [] }])).toEqual([]);
	});
});

