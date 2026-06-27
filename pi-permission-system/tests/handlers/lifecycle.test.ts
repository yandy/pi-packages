import { describe, expect, it, vi } from "vitest";

import { SessionLifecycleHandler } from "../../src/handlers/lifecycle";
import type { ServiceLifecycle } from "../../src/service-lifecycle";

import { makeCtx } from "../helpers/handler-fixtures";
import {
  makeLogger,
  makeRealResolver,
  makeRealSession,
} from "../helpers/session-fixtures";

// ── status stub ────────────────────────────────────────────────────────────
vi.mock("../../src/status", () => ({
  PERMISSION_SYSTEM_STATUS_KEY: "permission-system",
  syncPermissionSystemStatus: vi.fn(),
  getPermissionSystemStatus: vi.fn(),
}));

// ── helpers ────────────────────────────────────────────────────────────────

function makeSetup(opts?: { configIssues?: string[] }) {
  const { session, permissionManager, sessionRules, forwarding, configStore } =
    makeRealSession();
  const { resolver } = makeRealResolver(permissionManager, sessionRules);
  if (opts?.configIssues) {
    vi.mocked(permissionManager.getConfigIssues).mockReturnValue(
      opts.configIssues,
    );
  }
  const serviceLifecycle: ServiceLifecycle = {
    activate: vi.fn<ServiceLifecycle["activate"]>(),
    teardown: vi.fn<ServiceLifecycle["teardown"]>(),
  };
  // Use a session-independent logger so assertions verify direct injection,
  // not reach-through to session.logger.
  const logger = makeLogger();
  const audit = { writeSummary: vi.fn<(logger: unknown) => void>() };
  const handler = new SessionLifecycleHandler(
    session,
    resolver,
    serviceLifecycle,
    logger,
    audit,
  );
  return {
    handler,
    session,
    resolver,
    permissionManager,
    logger,
    forwarding,
    configStore,
    serviceLifecycle,
    audit,
  };
}

// ── handleSessionStart ─────────────────────────────────────────────────────

describe("handleSessionStart", () => {
  it("refreshes config with ctx", async () => {
    const ctx = makeCtx();
    const { handler, configStore } = makeSetup();
    await handler.handleSessionStart({ reason: "startup" }, ctx);
    expect(configStore.refresh).toHaveBeenCalledWith(ctx);
  });

  it("calls resetForNewSession with ctx", async () => {
    const ctx = makeCtx();
    const { handler, session } = makeSetup();
    const spy = vi.spyOn(session, "resetForNewSession");
    await handler.handleSessionStart({ reason: "startup" }, ctx);
    expect(spy).toHaveBeenCalledWith(ctx);
  });

  it("logs resolved config paths", async () => {
    const { handler, configStore } = makeSetup();
    await handler.handleSessionStart({ reason: "startup" }, makeCtx());
    expect(configStore.logResolvedPaths).toHaveBeenCalledOnce();
  });

  it("resolves agent name from ctx", async () => {
    const ctx = makeCtx();
    const { handler, session } = makeSetup();
    const spy = vi.spyOn(session, "resolveAgentName");
    await handler.handleSessionStart({ reason: "startup" }, ctx);
    expect(spy).toHaveBeenCalledWith(ctx);
  });

  it("notifies each policy issue", async () => {
    const { handler, logger } = makeSetup({
      configIssues: ["issue A", "issue B"],
    });
    await handler.handleSessionStart({ reason: "startup" }, makeCtx());
    expect(logger.warn).toHaveBeenCalledWith("issue A");
    expect(logger.warn).toHaveBeenCalledWith("issue B");
  });

  it("does not warn when there are no policy issues", async () => {
    const { handler, logger } = makeSetup();
    await handler.handleSessionStart({ reason: "startup" }, makeCtx());
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("writes lifecycle.reload debug log when reason is reload", async () => {
    const ctx = makeCtx({ cwd: "/proj" });
    const { handler, logger } = makeSetup();
    await handler.handleSessionStart({ reason: "reload" }, ctx);
    expect(logger.debug).toHaveBeenCalledWith("lifecycle.reload", {
      triggeredBy: "session_start",
      reason: "reload",
      cwd: "/proj",
    });
  });

  it("does not write lifecycle.reload debug log for non-reload reasons", async () => {
    const { handler, logger } = makeSetup();
    await handler.handleSessionStart({ reason: "startup" }, makeCtx());
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it("activates the service for the session with ctx", async () => {
    const ctx = makeCtx();
    const { handler, serviceLifecycle } = makeSetup();
    await handler.handleSessionStart({ reason: "startup" }, ctx);
    expect(serviceLifecycle.activate).toHaveBeenCalledWith(ctx);
  });

  it("calls refreshConfig before resetForNewSession", async () => {
    const callOrder: string[] = [];
    const { handler, session, configStore } = makeSetup();
    vi.spyOn(configStore, "refresh").mockImplementation(() => {
      callOrder.push("refreshConfig");
    });
    vi.spyOn(session, "resetForNewSession").mockImplementation(() => {
      callOrder.push("resetForNewSession");
    });
    await handler.handleSessionStart({ reason: "startup" }, makeCtx());
    expect(callOrder).toEqual(["refreshConfig", "resetForNewSession"]);
  });
});

// ── handleResourcesDiscover ────────────────────────────────────────────────

describe("handleResourcesDiscover", () => {
  it("does nothing when reason is not reload", async () => {
    const { handler, session } = makeSetup();
    const spy = vi.spyOn(session, "reload");
    await handler.handleResourcesDiscover({ reason: "startup" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("calls reload on the session on reload", async () => {
    const { handler, session } = makeSetup();
    const spy = vi.spyOn(session, "reload");
    await handler.handleResourcesDiscover({ reason: "reload" });
    expect(spy).toHaveBeenCalledOnce();
  });

  it("writes lifecycle.reload debug log on reload", async () => {
    const ctx = makeCtx({ cwd: "/proj" });
    const { handler, session, logger } = makeSetup();
    session.activate(ctx);
    await handler.handleResourcesDiscover({ reason: "reload" });
    expect(logger.debug).toHaveBeenCalledWith("lifecycle.reload", {
      triggeredBy: "resources_discover",
      reason: "reload",
      cwd: "/proj",
    });
  });

  it("logs cwd as null when runtimeContext is null on reload", async () => {
    const { handler, logger } = makeSetup();
    await handler.handleResourcesDiscover({ reason: "reload" });
    expect(logger.debug).toHaveBeenCalledWith("lifecycle.reload", {
      triggeredBy: "resources_discover",
      reason: "reload",
      cwd: null,
    });
  });
});

// ── handleSessionShutdown ──────────────────────────────────────────────────

describe("handleSessionShutdown", () => {
  it("clears UI status when runtime context is present", async () => {
    const ctx = makeCtx();
    const { handler, session } = makeSetup();
    session.activate(ctx);
    await handler.handleSessionShutdown();
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "permission-system",
      undefined,
    );
  });

  it("does not throw when runtime context is null", async () => {
    const { handler } = makeSetup();
    await expect(handler.handleSessionShutdown()).resolves.not.toThrow();
  });

  it("calls shutdown on the session", async () => {
    const { handler, session } = makeSetup();
    const spy = vi.spyOn(session, "shutdown");
    await handler.handleSessionShutdown();
    expect(spy).toHaveBeenCalledOnce();
  });

  it("calls serviceLifecycle.teardown", async () => {
    const { handler, serviceLifecycle } = makeSetup();
    await handler.handleSessionShutdown();
    expect(serviceLifecycle.teardown).toHaveBeenCalledOnce();
  });

  it("writes the decision-audit summary to the logger", async () => {
    const { handler, audit, logger } = makeSetup();
    await handler.handleSessionShutdown();
    expect(audit.writeSummary).toHaveBeenCalledWith(logger);
  });
});
