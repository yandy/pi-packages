import { describe, it, expect, vi } from "vitest";
import { buildExtractTask, runExtract } from "../src/extract";

const { runHeadlessAgentMock } = vi.hoisted(() => ({
	runHeadlessAgentMock: vi.fn(),
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
		expect(task).toContain("Worth remembering");
		expect(task).toContain("NOT worth remembering");
		expect(task).toContain("frontmatter");
		expect(task).toContain("## Entry Title");
	});

	it("truncates long messages", () => {
		const longMsg = "x".repeat(5000);
		const task = buildExtractTask("/tmp/mem", [{ role: "user", content: longMsg }], 100);
		expect(task.length).toBeLessThan(5000);
	});
});

describe("runExtract", () => {
	const fakeRegistry = { find: vi.fn(), getAvailable: vi.fn().mockReturnValue([]) };

	it("calls runHeadlessAgent with maxTurns=5 and timeoutMs=120000", () => {
		runHeadlessAgentMock.mockResolvedValue("ok");

		runExtract({
			model: undefined,
			thinkLevel: "high",
			memoryDir: "/mem/x",
			messages: [{ role: "user", content: "hello" }],
			maxContextTokens: 2000,
			modelRegistry: fakeRegistry as any,
		});

		expect(runHeadlessAgentMock).toHaveBeenCalledWith({
			task: expect.any(String),
			cwd: "/mem/x",
			modelRegistry: fakeRegistry,
			model: undefined,
			parentModel: undefined,
			thinkLevel: "high",
			maxTurns: 5,
			timeoutMs: 120_000,
		});
	});

	it("passes model and thinkLevel when model is specified", () => {
		runHeadlessAgentMock.mockResolvedValue("ok");

		runExtract({
			model: "deepseek/deepseek-v4-flash",
			thinkLevel: "medium",
			memoryDir: "/mem/x",
			messages: [{ role: "user", content: "hello" }],
			maxContextTokens: 2000,
			modelRegistry: fakeRegistry as any,
		});

		expect(runHeadlessAgentMock).toHaveBeenCalledWith(
			expect.objectContaining({
				model: "deepseek/deepseek-v4-flash",
				thinkLevel: "medium",
			}),
		);
	});

	it("skips when messages array is empty", () => {
		runHeadlessAgentMock.mockReset();

		runExtract({
			model: undefined,
			thinkLevel: "high",
			memoryDir: "/mem/x",
			messages: [],
			maxContextTokens: 2000,
			modelRegistry: fakeRegistry as any,
		});

		expect(runHeadlessAgentMock).not.toHaveBeenCalled();
	});
});
