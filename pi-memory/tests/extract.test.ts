import { describe, it, expect, vi } from "vitest";
import { buildExtractTask, runExtract } from "../src/extract";

const { runHeadlessAgentMock } = vi.hoisted(() => ({
	runHeadlessAgentMock: vi.fn().mockResolvedValue("done"),
}));
vi.mock("../src/agent-runner", () => ({
	runHeadlessAgent: runHeadlessAgentMock,
}));

describe("buildExtractTask", () => {
	it("builds extraction task prompt with context", () => {
		const messages = [
			{ role: "user", content: "how to debug SSH?" },
			{ role: "assistant", content: "Use ssh -vvv user@host" },
		];
		const task = buildExtractTask("/tmp/mem", messages, 2000);
		expect(task).toContain("memory extraction agent");
		expect(task).toContain("/tmp/mem");
		expect(task).toContain("how to debug SSH?");
		expect(task).toContain("ssh -vvv");
	});

	it("truncates long messages", () => {
		const longMsg = "x".repeat(5000);
		const task = buildExtractTask("/tmp/mem", [{ role: "user", content: longMsg }], 100);
		expect(task.length).toBeLessThan(5000);
	});

	it("buildExtractTask instructs LLM to use ls/read + memory tools not write/edit", () => {
		const messages = [
			{ role: "user", content: "help" },
			{ role: "assistant", content: "answer" },
		];
		const task = buildExtractTask("/mem", messages, 2000);
		expect(task).toContain("memory_add");
		expect(task).toContain("ls");
		expect(task).toContain("memory_search");
		expect(task).toContain("Do NOT use 'bash', 'write', 'edit', or any other tools");
		expect(task).not.toContain("file read/write/edit tools");
	});
});

describe("runExtract", () => {
	it("calls runHeadlessAgent with maxTurns=5, tools=[], customTools, and configured thinkLevel (fire-and-forget)", () => {
		runHeadlessAgentMock.mockClear();
		const fakeTools = [{ name: "memory_add", description: "", parameters: {}, execute: async () => ({ content: [] }) }];
		runExtract({
			thinkLevel: "high",
			memoryDir: "/mem/x",
			messages: [{ role: "user", content: "hello" }],
			maxContextTokens: 2000,
			modelRegistry: {} as any,
			parentModel: { id: "parent" } as any,
			customTools: fakeTools,
		});

		expect(runHeadlessAgentMock).toHaveBeenCalledTimes(1);
		expect(runHeadlessAgentMock).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/mem/x",
				thinkLevel: "high",
				maxTurns: 5,
				parentModel: { id: "parent" },
				tools: ["read", "ls"],
				customTools: fakeTools,
			}),
		);
		expect(runHeadlessAgentMock.mock.calls[0][0].task).toContain("/mem/x");
	});

	it("passes configured model string when set", () => {
		runHeadlessAgentMock.mockClear();
		runExtract({
			model: "deepseek/deepseek-v4-flash",
			thinkLevel: "medium",
			memoryDir: "/mem/x",
			messages: [{ role: "user", content: "hello" }],
			maxContextTokens: 2000,
			modelRegistry: {} as any,
		});

		expect(runHeadlessAgentMock.mock.calls[0][0]).toMatchObject({
			model: "deepseek/deepseek-v4-flash",
			thinkLevel: "medium",
			tools: ["read", "ls"],
		});
	});

	it("skips when messages array is empty", () => {
		runHeadlessAgentMock.mockClear();
		runExtract({
			thinkLevel: "high",
			memoryDir: "/mem/x",
			messages: [],
			maxContextTokens: 2000,
			modelRegistry: {} as any,
		});
		expect(runHeadlessAgentMock).not.toHaveBeenCalled();
	});

	it("passes sessionPersistence through to runHeadlessAgent", () => {
		runHeadlessAgentMock.mockClear();
		runExtract({
			thinkLevel: "high",
			memoryDir: "/mem/x",
			messages: [{ role: "user", content: "hi" }],
			maxContextTokens: 1000,
			modelRegistry: {} as any,
			sessionPersistence: { enabled: true },
		});
		expect(runHeadlessAgentMock).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionPersistence: { enabled: true },
			}),
		);
	});
});
