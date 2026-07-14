import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildDreamTask, runDream } from "../src/dream";

const { runHeadlessAgentMock } = vi.hoisted(() => ({
	runHeadlessAgentMock: vi.fn(),
}));
vi.mock("../src/agent-runner", () => ({
	runHeadlessAgent: runHeadlessAgentMock,
}));

describe("buildDreamTask", () => {
	it("includes memory dir + consolidation instructions + line limit", () => {
		const task = buildDreamTask("/mem/abc123", 200);
		expect(task).toContain("/mem/abc123");
		expect(task).toContain("200");
		expect(task).toContain("## Entry Title");
		expect(task).toContain("MEMORY.md");
		expect(task).toMatch(/deduplicat|consolidat/i);
		expect(task).toContain("meaningful name");
		expect(task).toContain("one line per topic file");
	});

	it("builds four-phase dream task prompt", () => {
		const task = buildDreamTask("/tmp/mem", 200);
		expect(task).toContain("Phase 1 — Orient");
		expect(task).toContain("Phase 2 — Gather Signal");
		expect(task).toContain("Phase 3 — Consolidate");
		expect(task).toContain("Phase 4 — Prune & Index");
		expect(task).toContain("~150 chars");
	});
});

describe("runDream", () => {
	beforeEach(() => {
		runHeadlessAgentMock.mockClear();
	});

	it("calls runHeadlessAgent with no maxTurns (unlimited) and resolves with its result", async () => {
		runHeadlessAgentMock.mockResolvedValueOnce("merged 3 entries");
		const summary = await runDream({
			thinkLevel: "high",
			memoryDir: "/mem/x",
			modelRegistry: {} as any,
			parentModel: { id: "parent" } as any,
		});
		expect(runHeadlessAgentMock).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/mem/x",
				thinkLevel: "high",
				maxTurns: undefined,
				parentModel: { id: "parent" },
			}),
		);
		expect(summary).toBe("merged 3 entries");
	});

	it("passes configured model string when set", async () => {
		runHeadlessAgentMock.mockResolvedValueOnce("ok");
		await runDream({
			model: "deepseek/deepseek-v4-flash",
			thinkLevel: "medium",
			memoryDir: "/mem/x",
			modelRegistry: {} as any,
		});
		expect(runHeadlessAgentMock.mock.calls[0][0]).toMatchObject({
			model: "deepseek/deepseek-v4-flash",
			thinkLevel: "medium",
		});
	});

	it("propagates failure from runHeadlessAgent", async () => {
		runHeadlessAgentMock.mockRejectedValueOnce(new Error("dream failed"));
		await expect(
			runDream({ thinkLevel: "high", memoryDir: "/mem/x", modelRegistry: {} as any }),
		).rejects.toThrow("dream failed");
	});
});
