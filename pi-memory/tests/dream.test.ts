import { describe, it, expect, vi } from "vitest";
import { buildDreamTask, runDream } from "../src/dream";

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
  it("spawns general-purpose subagent and resolves with result on completion", async () => {
    const completedHandlers: Array<(data: any) => void> = [];
    const failedHandlers: Array<(data: any) => void> = [];

    const fakeService = {
      spawn: vi.fn().mockReturnValue("agent-dream-1"),
      getRecord: vi.fn().mockReturnValue({ result: "merged 3 entries" }),
      registerWorkspaceProvider: vi.fn().mockReturnValue(vi.fn()),
      abort: vi.fn(),
    };
    const events = {
      on: vi.fn((channel: string, handler: (data: any) => void) => {
        if (channel === "subagents:completed") completedHandlers.push(handler);
        if (channel === "subagents:failed") failedHandlers.push(handler);
        return () => {}; // unsubscribe stub
      }),
    };

    const promise = runDream({
      model: "auto",
      memoryDir: "/mem/x",
      service: fakeService as any,
      events: events as any,
    });

    // Verify spawn called
    expect(fakeService.registerWorkspaceProvider).toHaveBeenCalled();
    expect(fakeService.spawn).toHaveBeenCalledWith(
      "general-purpose",
      expect.stringContaining("/mem/x"),
      {},
    );

    // Simulate completed event
    completedHandlers[0]({ id: "agent-dream-1" });

    const summary = await promise;
    expect(summary).toBe("merged 3 entries");
  });

  it("rejects when subagent fails", async () => {
    const failedHandlers: Array<(data: any) => void> = [];

    const fakeService = {
      spawn: vi.fn().mockReturnValue("agent-dream-2"),
      getRecord: vi.fn().mockReturnValue({ error: "something broke" }),
      registerWorkspaceProvider: vi.fn().mockReturnValue(vi.fn()),
      abort: vi.fn(),
    };
    const events = {
      on: vi.fn((channel: string, handler: (data: any) => void) => {
        if (channel === "subagents:failed") failedHandlers.push(handler);
        return () => {};
      }),
    };

    const promise = runDream({
      model: "auto",
      memoryDir: "/mem/x",
      service: fakeService as any,
      events: events as any,
    });

    // Simulate failed event
    failedHandlers[0]({ id: "agent-dream-2", error: "something broke" });

    await expect(promise).rejects.toThrow("something broke");
  });

  it("passes model to spawn when not auto", async () => {
    const fakeService = {
      spawn: vi.fn().mockReturnValue("agent-dream-3"),
      getRecord: vi.fn().mockReturnValue({}),
      registerWorkspaceProvider: vi.fn().mockReturnValue(vi.fn()),
      abort: vi.fn(),
    };
    const events = {
      on: vi.fn(() => () => {}),
    };

    // Fire completion immediately after spawn via microtask
    setTimeout(() => {
      const handler = (events.on as any).mock.calls.find(
        (c: any) => c[0] === "subagents:completed"
      )?.[1];
      handler?.({ id: "agent-dream-3" });
    }, 0);

    await runDream({
      model: "deepseek/deepseek-v4-flash",
      memoryDir: "/mem/x",
      service: fakeService as any,
      events: events as any,
    });

    expect(fakeService.spawn).toHaveBeenCalledWith(
      "general-purpose",
      expect.any(String),
      { model: "deepseek/deepseek-v4-flash" },
    );
  });

  it("aborts on signal", async () => {
    const fakeService = {
      spawn: vi.fn().mockReturnValue("agent-dream-4"),
      getRecord: vi.fn().mockReturnValue({}),
      registerWorkspaceProvider: vi.fn().mockReturnValue(vi.fn()),
      abort: vi.fn(),
    };
    const events = { on: vi.fn(() => () => {}) };
    const controller = new AbortController();

    const promise = runDream({
      model: "auto",
      memoryDir: "/mem/x",
      service: fakeService as any,
      events: events as any,
      signal: controller.signal,
    });

    controller.abort();
    expect(fakeService.abort).toHaveBeenCalledWith("agent-dream-4");

    // pi-subagents ensures events fire even for abort-while-queued
    const handler = (events.on as any).mock.calls.find(
      (c: any) => c[0] === "subagents:failed"
    )?.[1];
    handler?.({ id: "agent-dream-4", error: "aborted" });
    await expect(promise).rejects.toThrow("aborted");
  });

  it("throws when service is undefined", async () => {
    await expect(
      runDream({ model: "auto", memoryDir: "/mem/x" } as any)
    ).rejects.toThrow("pi-subagents not available");
  });
});
