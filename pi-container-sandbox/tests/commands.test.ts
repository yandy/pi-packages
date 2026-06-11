import { describe, it, expect, afterEach } from "vitest";
import { createSandboxCommandHandlers } from "../src/commands/sandbox";
import { clearSbx } from "../src/session";
import { mockRuntime, mockSbx } from "./_helpers";

function mockPathApprovals() {
  return {
    list: () => [],
    revoke: () => false,
    add: () => {},
    find: () => undefined,
  };
}

function notifyCtx() {
  const notifications: { msg: string; level: string }[] = [];
  return {
    notifications,
    ui: {
      notify: (msg: string, level?: string) => notifications.push({ msg, level: level ?? "info" }),
      setStatus: (_key: string, _msg: string) => {},
    },
  };
}

afterEach(() => clearSbx());

describe("/sandbox stop", () => {
  it("blocks stop when keep is true", async () => {
    const ctx = notifyCtx();
    const handlers = createSandboxCommandHandlers("/tmp", mockPathApprovals());
    mockSbx({ keep: true });

    await handlers.stop("", ctx);
    expect(ctx.notifications.some((n) => n.msg.includes("keep/persist"))).toBe(true);
  });

  it("executes shutdown when keep is false", async () => {
    const ctx = notifyCtx();
    const handlers = createSandboxCommandHandlers("/tmp", mockPathApprovals());

    let shutdownCalled = false;
    const rt = mockRuntime({ shutdown: async () => { shutdownCalled = true; } });
    mockSbx({ keep: false, runtime: rt });

    await handlers.stop("", ctx);
    expect(shutdownCalled).toBe(true);
    expect(ctx.notifications.some((n) => n.msg.includes("stopped and removed"))).toBe(true);
  });
});

describe("/sandbox build", () => {
  it("calls rebuildImage on the runtime with progress callback", async () => {
    const ctx = notifyCtx();
    const handlers = createSandboxCommandHandlers("/tmp", mockPathApprovals());

    let rebuildCalled = false;
    let progressFn: ((msg: string) => void) | undefined;
    const rt = mockRuntime({
      rebuildImage: async (onProgress) => { rebuildCalled = true; progressFn = onProgress; },
    });
    mockSbx({ runtime: rt });

    await handlers.build("", ctx);
    expect(rebuildCalled).toBe(true);
    expect(typeof progressFn).toBe("function");
  });

  it("shows error when sandbox is not active", async () => {
    const ctx = notifyCtx();
    const handlers = createSandboxCommandHandlers("/tmp", mockPathApprovals());

    await handlers.build("", ctx);
    expect(ctx.notifications.some((n) => n.msg.includes("not active"))).toBe(true);
  });

  it("shows error on build failure", async () => {
    const ctx = notifyCtx();
    const handlers = createSandboxCommandHandlers("/tmp", mockPathApprovals());

    const rt = mockRuntime({ rebuildImage: async () => { throw new Error("build failed"); } });
    mockSbx({ runtime: rt });

    await handlers.build("", ctx);
    expect(ctx.notifications.some((n) => n.msg.includes("Build failed"))).toBe(true);
  });
});

describe("/sandbox exec", () => {
  it("executes command and shows output", async () => {
    const ctx = notifyCtx();
    const handlers = createSandboxCommandHandlers("/tmp", mockPathApprovals());

    const rt = mockRuntime({
      exec: async () => ({ exitCode: 0, stdout: Buffer.from("hello"), stderr: Buffer.alloc(0) }),
    });
    mockSbx({ runtime: rt });

    await handlers.exec("echo hello", ctx);
    expect(ctx.notifications.some((n) => n.msg.includes("hello"))).toBe(true);
  });

  it("shows error for empty command", async () => {
    const ctx = notifyCtx();
    const handlers = createSandboxCommandHandlers("/tmp", mockPathApprovals());
    mockSbx();

    await handlers.exec("", ctx);
    expect(ctx.notifications.some((n) => n.msg.includes("Usage"))).toBe(true);
  });
});

describe("/sandbox keep", () => {
  it("updates config with container name", async () => {
    const ctx = notifyCtx();
    const handlers = createSandboxCommandHandlers("/tmp", mockPathApprovals());
    mockSbx({ name: "my-container" });

    await handlers.keep("my-container", ctx);
    expect(ctx.notifications.some((n) => n.msg.includes("saved to sandbox.json"))).toBe(true);
  });
});
