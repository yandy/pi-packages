import { describe, it, expect, vi } from "vitest";
import { buildExtractTask, runExtract } from "../src/extract";

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
	it("spawns with configured thinkLevel (default high) and maxTurns=5 when model is auto", () => {
		const fakeService = {
			spawn: vi.fn(),
			registerWorkspaceProvider: vi.fn().mockReturnValue(vi.fn()),
		};

		runExtract({
			model: "auto",
			thinkLevel: "high",
			memoryDir: "/mem/x",
			messages: [{ role: "user", content: "hello" }],
			maxContextTokens: 2000,
			service: fakeService as any,
		});

		expect(fakeService.spawn).toHaveBeenCalledWith(
			"memory-agent",
			expect.any(String),
			{ inheritContext: false, maxTurns: 5, thinkingLevel: "high" },
		);
	});

	it("passes model and thinkLevel when model is not auto", () => {
		const fakeService = {
			spawn: vi.fn(),
			registerWorkspaceProvider: vi.fn().mockReturnValue(vi.fn()),
		};

		runExtract({
			model: "deepseek/deepseek-v4-flash",
			thinkLevel: "medium",
			memoryDir: "/mem/x",
			messages: [{ role: "user", content: "hello" }],
			maxContextTokens: 2000,
			service: fakeService as any,
		});

		expect(fakeService.spawn).toHaveBeenCalledWith(
			"memory-agent",
			expect.any(String),
			{ model: "deepseek/deepseek-v4-flash", inheritContext: false, maxTurns: 5, thinkingLevel: "medium" },
		);
	});

	it("skips when messages array is empty", () => {
		const fakeService = {
			spawn: vi.fn(),
			registerWorkspaceProvider: vi.fn().mockReturnValue(vi.fn()),
		};

		runExtract({
			model: "auto",
			thinkLevel: "high",
			memoryDir: "/mem/x",
			messages: [],
			maxContextTokens: 2000,
			service: fakeService as any,
		});

		expect(fakeService.spawn).not.toHaveBeenCalled();
	});
});
