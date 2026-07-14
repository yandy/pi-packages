import { describe, it, expect, vi } from "vitest";
import { buildDreamTask, runDream } from "../src/dream";

const { runHeadlessAgentMock } = vi.hoisted(() => ({
	runHeadlessAgentMock: vi.fn(),
}));
vi.mock("../src/agent-runner", () => ({
	runHeadlessAgent: runHeadlessAgentMock,
}));

describe("buildDreamTask", () => {
  it("includes memory dir + consolidation instructions + line limit + rules from DREAM_SYSTEM_PROMPT", () => {
    const task = buildDreamTask("/mem/abc123", 200);
    expect(task).toContain("/mem/abc123");
    expect(task).toContain("200");
    expect(task).toContain("## Entry Title");
    expect(task).toContain("MEMORY.md");
    // Rules merged from DREAM_SYSTEM_PROMPT
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
    expect(task).toContain("per topic file");
    expect(task).toContain("~150 chars");
    expect(task).toContain("name:");
    expect(task).toContain("description:");
    expect(task).toContain("type:");
  });
});

describe("runDream", () => {
	const fakeRegistry = { find: vi.fn(), getAvailable: vi.fn().mockReturnValue([]) };

	it("calls runHeadlessAgent with correct params and returns result", async () => {
		runHeadlessAgentMock.mockResolvedValue("merged 3 entries");

		const result = await runDream({
			model: undefined,
			thinkLevel: "high",
			memoryDir: "/mem/x",
			modelRegistry: fakeRegistry as any,
		});

		expect(runHeadlessAgentMock).toHaveBeenCalledWith({
			task: expect.stringContaining("/mem/x"),
			cwd: "/mem/x",
			modelRegistry: fakeRegistry,
			model: undefined,
			parentModel: undefined,
			thinkLevel: "high",
			maxTurns: undefined,
			timeoutMs: 600_000,
		});
		expect(result).toBe("merged 3 entries");
	});

	it("rejects when runHeadlessAgent throws", async () => {
		runHeadlessAgentMock.mockRejectedValue(new Error("something broke"));

		await expect(
			runDream({
				model: undefined,
				thinkLevel: "high",
				memoryDir: "/mem/x",
				modelRegistry: fakeRegistry as any,
			}),
		).rejects.toThrow("something broke");
	});

	it("passes model and parentModel to runHeadlessAgent", async () => {
		runHeadlessAgentMock.mockResolvedValue("done");

		const fakeParentModel = { provider: "test", id: "test-model" };

		await runDream({
			model: "deepseek/deepseek-v4-flash",
			thinkLevel: "medium",
			memoryDir: "/mem/x",
			modelRegistry: fakeRegistry as any,
			parentModel: fakeParentModel as any,
		});

		expect(runHeadlessAgentMock).toHaveBeenCalledWith(
			expect.objectContaining({
				model: "deepseek/deepseek-v4-flash",
				parentModel: fakeParentModel,
				thinkLevel: "medium",
			}),
		);
	});
});
