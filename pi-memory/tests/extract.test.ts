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
});

describe("runExtract", () => {
	it("calls runHeadlessAgent with maxTurns=5 and configured thinkLevel (fire-and-forget)", () => {
		runHeadlessAgentMock.mockClear();
		runExtract({
			thinkLevel: "high",
			memoryDir: "/mem/x",
			messages: [{ role: "user", content: "hello" }],
			maxContextTokens: 2000,
			modelRegistry: {} as any,
			parentModel: { id: "parent" } as any,
		});

		expect(runHeadlessAgentMock).toHaveBeenCalledTimes(1);
		expect(runHeadlessAgentMock).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/mem/x",
				thinkLevel: "high",
				maxTurns: 5,
				parentModel: { id: "parent" },
			}),
		);
		// task contains memory dir
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
