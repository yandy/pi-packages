import { describe, it, expect, vi, beforeEach } from "vitest";

const { createAgentSessionMock } = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    createAgentSession: createAgentSessionMock,
  };
});

import { runHeadlessAgent } from "../src/agent-runner";

function createFakeSession() {
  const listeners: Array<(event: any) => void> = [];
  return {
    listeners,
    session: {
      subscribe: vi.fn((fn: (event: any) => void) => {
        listeners.push(fn);
        return () => {}; // unsubscribe stub
      }),
      prompt: vi.fn().mockResolvedValue(undefined),
      steer: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      getLastAssistantText: vi.fn().mockReturnValue(""),
    },
  };
}

beforeEach(() => {
  createAgentSessionMock.mockReset();
});

describe("runHeadlessAgent", () => {
  it("creates session with noExtensions and correct tools", async () => {
    const fake = createFakeSession();
    createAgentSessionMock.mockResolvedValue({ session: fake.session, extensionsResult: {} });

    fake.session.prompt.mockImplementation(async () => {
      fake.listeners.forEach((fn) => fn({ type: "agent_end" }));
    });

    await runHeadlessAgent({
      task: "test task",
      cwd: "/tmp/mem",
      modelRegistry: { find: vi.fn(), getAvailable: vi.fn().mockReturnValue([]) } as any,
      thinkLevel: "high",
    });

    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
    const callArgs = createAgentSessionMock.mock.calls[0][0];
    expect(callArgs.cwd).toBe("/tmp/mem");
    expect(callArgs.tools).toEqual(["read", "write", "edit", "ls"]);
    expect(callArgs.thinkingLevel).toBe("high");
    expect(callArgs.sessionManager).toBeDefined();
    expect(callArgs.settingsManager).toBeDefined();
    expect(callArgs.resourceLoader).toBeDefined();

    expect(fake.session.prompt).toHaveBeenCalledWith("test task");
    expect(fake.session.dispose).toHaveBeenCalled();
  });

  it("collects response text from text_delta events", async () => {
    const fake = createFakeSession();
    createAgentSessionMock.mockResolvedValue({ session: fake.session, extensionsResult: {} });

    fake.session.prompt.mockImplementation(async () => {
      fake.listeners.forEach((fn) => fn({ type: "message_start" }));
      fake.listeners.forEach((fn) =>
        fn({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "Hello " },
        }),
      );
      fake.listeners.forEach((fn) =>
        fn({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "World" },
        }),
      );
      fake.listeners.forEach((fn) => fn({ type: "message_end" }));
      fake.listeners.forEach((fn) => fn({ type: "agent_end" }));
    });

    const result = await runHeadlessAgent({
      task: "test",
      cwd: "/tmp",
      modelRegistry: { find: vi.fn(), getAvailable: vi.fn().mockReturnValue([]) } as any,
    });

    expect(result).toBe("Hello World");
  });

  it("soft limit: steers at maxTurns and aborts at maxTurns+3", async () => {
    const fake = createFakeSession();
    createAgentSessionMock.mockResolvedValue({ session: fake.session, extensionsResult: {} });

    let turnCount = 0;
    fake.session.prompt.mockImplementation(async () => {
      // Emit enough turn_end events to trigger steer and then abort
      for (let i = 0; i < 6; i++) {
        turnCount++;
        fake.listeners.forEach((fn) => fn({ type: "turn_end" }));
      }
      fake.listeners.forEach((fn) => fn({ type: "agent_end" }));
    });

    await runHeadlessAgent({
      task: "test",
      cwd: "/tmp",
      modelRegistry: { find: vi.fn(), getAvailable: vi.fn().mockReturnValue([]) } as any,
      maxTurns: 2,
    });

    // steer should have been called at turn 2
    expect(fake.session.steer).toHaveBeenCalledWith(
      "Please wrap up and provide a final response.",
    );
    // abort should have been called at turn 5 (maxTurns+3)
    expect(fake.session.abort).toHaveBeenCalled();
  });

  it("hard limit: aborts on timeout", async () => {
    const fake = createFakeSession();
    createAgentSessionMock.mockResolvedValue({ session: fake.session, extensionsResult: {} });

    // Never resolve prompt — timeout triggers
    fake.session.prompt.mockImplementation(
      () => new Promise(() => {}), // never resolves
    );

    const promise = runHeadlessAgent({
      task: "test",
      cwd: "/tmp",
      modelRegistry: { find: vi.fn(), getAvailable: vi.fn().mockReturnValue([]) } as any,
      timeoutMs: 10,
    });

    await expect(promise).rejects.toThrow("Timed out");
    expect(fake.session.abort).toHaveBeenCalled();
    expect(fake.session.dispose).toHaveBeenCalled();
  });

  it("inherits parentModel when model string is undefined", async () => {
    const fake = createFakeSession();
    createAgentSessionMock.mockResolvedValue({ session: fake.session, extensionsResult: {} });
    fake.session.prompt.mockImplementation(async () => {
      fake.listeners.forEach((fn) => fn({ type: "agent_end" }));
    });

    const parentModel = { provider: "deepseek", id: "deepseek-v4-flash" };
    await runHeadlessAgent({
      task: "test",
      cwd: "/tmp",
      modelRegistry: { find: vi.fn(), getAvailable: vi.fn().mockReturnValue([]) } as any,
      parentModel: parentModel as any,
      // model is undefined → should inherit parentModel
    });

    expect(createAgentSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: parentModel }),
    );
  });

  it("disposes session even when prompt throws", async () => {
    const fake = createFakeSession();
    createAgentSessionMock.mockResolvedValue({ session: fake.session, extensionsResult: {} });
    fake.session.prompt.mockRejectedValue(new Error("API error"));

    await expect(
      runHeadlessAgent({
        task: "test",
        cwd: "/tmp",
        modelRegistry: { find: vi.fn(), getAvailable: vi.fn().mockReturnValue([]) } as any,
      }),
    ).rejects.toThrow("API error");

    expect(fake.session.dispose).toHaveBeenCalled();
  });
});
