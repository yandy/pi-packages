import { describe, expect, it, vi } from "vitest";

import type { DenialContext } from "../../../src/denial-messages";
import { EXTENSION_TAG } from "../../../src/denial-messages";
import type { GateBypass } from "../../../src/handlers/gates/descriptor";
import { SessionApproval } from "../../../src/session-approval";
import {
  makeDenialDescriptor,
  makeDescriptor,
  makeGateRunner,
} from "../../helpers/gate-fixtures";
import { makeCheckResult } from "../../helpers/handler-fixtures";

// ── GateRunner — descriptor path ───────────────────────────────────────────

describe("GateRunner — descriptor path", () => {
  it("returns allow and emits policy_allow when policy is allow", async () => {
    const { runner, deps } = makeGateRunner();
    const result = await runner.run(makeDescriptor(), null, "tc-1");
    expect(result).toEqual({ action: "allow" });
    expect(deps.reporter.emitDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "read",
        value: "read",
        result: "allow",
        resolution: "policy_allow",
      }),
    );
  });

  it("returns block and emits policy_deny when policy is deny", async () => {
    const { runner, deps } = makeGateRunner({
      resolveResult: makeCheckResult({ state: "deny", matchedPattern: "*" }),
    });
    const result = await runner.run(makeDescriptor(), null, "tc-1");
    expect(result).toMatchObject({ action: "block" });
    expect(deps.reporter.emitDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        result: "deny",
        resolution: "policy_deny",
      }),
    );
    expect(deps.reporter.writeReviewLog).toHaveBeenCalledWith(
      "permission_request.blocked",
      expect.objectContaining({ resolution: "policy_denied" }),
    );
  });

  it("returns allow and emits session_approved on session hit", async () => {
    const { runner, deps } = makeGateRunner({
      resolveResult: makeCheckResult({
        source: "session",
        matchedPattern: "git *",
      }),
    });
    const result = await runner.run(
      makeDescriptor({
        surface: "bash",
        input: { command: "git status" },
        decision: { surface: "bash", value: "git status" },
      }),
      null,
      "tc-1",
    );
    expect(result).toEqual({ action: "allow" });
    expect(deps.reporter.writeReviewLog).toHaveBeenCalledWith(
      "permission_request.session_approved",
      expect.objectContaining({
        resolution: "session_approved",
        sessionApprovalPattern: "git *",
      }),
    );
    expect(deps.reporter.emitDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: "session_approved",
        matchedPattern: "git *",
      }),
    );
  });

  it("returns allow and emits user_approved when ask + user approves", async () => {
    const { runner, deps } = makeGateRunner({
      resolveResult: makeCheckResult({ state: "ask", matchedPattern: "*" }),
      prompt: vi.fn().mockResolvedValue({ approved: true, state: "approved" }),
    });
    const result = await runner.run(makeDescriptor(), null, "tc-1");
    expect(result).toEqual({ action: "allow" });
    expect(deps.reporter.emitDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        result: "allow",
        resolution: "user_approved",
      }),
    );
  });

  it("returns allow, emits user_approved_for_session, and records session rule on approved_for_session", async () => {
    const { runner, deps } = makeGateRunner({
      resolveResult: makeCheckResult({ state: "ask", matchedPattern: "*" }),
      prompt: vi
        .fn()
        .mockResolvedValue({ approved: true, state: "approved_for_session" }),
    });
    const descriptor = makeDescriptor({
      sessionApproval: SessionApproval.single("read", "*"),
    });
    const result = await runner.run(descriptor, null, "tc-1");
    expect(result).toEqual({ action: "allow" });
    expect(deps.reporter.emitDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: "user_approved_for_session",
      }),
    );
    expect(deps.recordSessionApproval).toHaveBeenCalledWith(
      SessionApproval.single("read", "*"),
    );
  });

  it("calls recordSessionApproval once with the full SessionApproval when sessionApproval has multiple patterns", async () => {
    const { runner, deps } = makeGateRunner({
      resolveResult: makeCheckResult({ state: "ask", matchedPattern: "*" }),
      prompt: vi
        .fn()
        .mockResolvedValue({ approved: true, state: "approved_for_session" }),
    });
    const approval = SessionApproval.multiple("external_directory", [
      "/outside/a/*",
      "/outside/b/*",
    ]);
    const descriptor = makeDescriptor({ sessionApproval: approval });
    const result = await runner.run(descriptor, null, "tc-1");
    expect(result).toEqual({ action: "allow" });
    expect(deps.recordSessionApproval).toHaveBeenCalledTimes(1);
    expect(deps.recordSessionApproval).toHaveBeenCalledWith(approval);
  });

  it("returns block and emits user_denied when ask + user denies", async () => {
    const { runner, deps } = makeGateRunner({
      resolveResult: makeCheckResult({ state: "ask", matchedPattern: "*" }),
      prompt: vi.fn().mockResolvedValue({ approved: false, state: "denied" }),
    });
    const result = await runner.run(makeDescriptor(), null, "tc-1");
    expect(result).toMatchObject({ action: "block" });
    expect(deps.reporter.emitDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        result: "deny",
        resolution: "user_denied",
      }),
    );
  });

  it("returns block and emits confirmation_unavailable when ask + no UI", async () => {
    const { runner, deps } = makeGateRunner({
      resolveResult: makeCheckResult({ state: "ask", matchedPattern: "*" }),
      canConfirm: vi.fn().mockReturnValue(false),
    });
    const result = await runner.run(makeDescriptor(), null, "tc-1");
    expect(result).toMatchObject({ action: "block" });
    expect(deps.reporter.emitDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        result: "deny",
        resolution: "confirmation_unavailable",
      }),
    );
  });

  it("emits auto_approved resolution when decision has autoApproved flag", async () => {
    const { runner, deps } = makeGateRunner({
      resolveResult: makeCheckResult({ state: "ask", matchedPattern: "*" }),
      prompt: vi.fn().mockResolvedValue({
        approved: true,
        state: "approved",
        autoApproved: true,
      }),
    });
    const result = await runner.run(makeDescriptor(), null, "tc-1");
    expect(result).toEqual({ action: "allow" });
    expect(deps.reporter.emitDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: "auto_approved",
      }),
    );
  });

  it("uses preResolved.state instead of calling resolve", async () => {
    const { runner, deps } = makeGateRunner();
    const descriptor = makeDescriptor({
      preResolved: { state: "deny" },
    });
    const result = await runner.run(descriptor, null, "tc-1");
    expect(result).toMatchObject({ action: "block" });
    expect(deps.resolve).not.toHaveBeenCalled();
    expect(deps.reporter.emitDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: "policy_deny",
      }),
    );
  });

  it("uses preResolved.state allow without calling resolve", async () => {
    const { runner, deps } = makeGateRunner();
    const descriptor = makeDescriptor({
      preResolved: { state: "allow" },
    });
    const result = await runner.run(descriptor, null, "tc-1");
    expect(result).toEqual({ action: "allow" });
    expect(deps.resolve).not.toHaveBeenCalled();
    expect(deps.reporter.emitDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: "policy_allow",
      }),
    );
  });

  it("passes agentName to resolve and decision event", async () => {
    const { runner, deps } = makeGateRunner();
    const result = await runner.run(makeDescriptor(), "test-agent", "tc-1");
    expect(result).toEqual({ action: "allow" });
    expect(deps.resolve).toHaveBeenCalledWith({
      kind: "tool",
      surface: "read",
      input: {},
      agentName: "test-agent",
    });
    expect(deps.reporter.emitDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: "test-agent",
      }),
    );
  });

  it("passes requestId from toolCallId to prompt", async () => {
    const { runner, deps } = makeGateRunner({
      resolveResult: makeCheckResult({ state: "ask", matchedPattern: "*" }),
    });
    await runner.run(makeDescriptor(), null, "tc-42");
    expect(deps.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "tc-42" }),
    );
  });

  it("does not call recordSessionApproval when user approves once (no sessionApproval)", async () => {
    const { runner, deps } = makeGateRunner({
      resolveResult: makeCheckResult({ state: "ask", matchedPattern: "*" }),
      prompt: vi.fn().mockResolvedValue({ approved: true, state: "approved" }),
    });
    await runner.run(makeDescriptor(), null, "tc-1");
    expect(deps.recordSessionApproval).not.toHaveBeenCalled();
  });

  it("uses preCheck result directly instead of calling resolve", async () => {
    const { runner, deps } = makeGateRunner();
    const descriptor = makeDescriptor({
      preCheck: makeCheckResult({
        state: "deny",
        origin: "global",
        matchedPattern: "rm *",
      }),
    });
    const result = await runner.run(descriptor, null, "tc-1");
    expect(result).toMatchObject({ action: "block" });
    expect(deps.resolve).not.toHaveBeenCalled();
    expect(deps.reporter.emitDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: "policy_deny",
        origin: "global",
        matchedPattern: "rm *",
      }),
    );
  });

  it("does not call recordSessionApproval when user approves for session but no sessionApproval on descriptor", async () => {
    const { runner, deps } = makeGateRunner({
      resolveResult: makeCheckResult({ state: "ask", matchedPattern: "*" }),
      prompt: vi
        .fn()
        .mockResolvedValue({ approved: true, state: "approved_for_session" }),
    });
    // No sessionApproval on descriptor
    await runner.run(makeDescriptor(), null, "tc-1");
    expect(deps.recordSessionApproval).not.toHaveBeenCalled();
  });

  describe("denialContext formatting", () => {
    it("uses denialContext to format denyReason with extension tag", async () => {
      const { runner } = makeGateRunner({
        resolveResult: makeCheckResult({ state: "deny", matchedPattern: "*" }),
      });
      const ctx: DenialContext = {
        kind: "tool",
        check: makeCheckResult({ state: "deny", matchedPattern: "*" }),
        agentName: "test-agent",
      };
      const result = await runner.run(
        makeDenialDescriptor(ctx),
        "test-agent",
        "tc-1",
      );
      expect(result.action).toBe("block");
      if (result.action === "block") {
        expect(result.reason).toContain(EXTENSION_TAG);
        expect(result.reason).not.toContain("Hard stop");
      }
    });

    it("uses denialContext to format unavailableReason with extension tag", async () => {
      const { runner } = makeGateRunner({
        resolveResult: makeCheckResult({ state: "ask", matchedPattern: "*" }),
        canConfirm: vi.fn().mockReturnValue(false),
      });
      const ctx: DenialContext = {
        kind: "tool",
        check: makeCheckResult({ state: "ask", matchedPattern: "*" }),
      };
      const result = await runner.run(makeDenialDescriptor(ctx), null, "tc-1");
      expect(result.action).toBe("block");
      if (result.action === "block") {
        expect(result.reason).toContain(EXTENSION_TAG);
        expect(result.reason).toContain("no interactive UI");
      }
    });

    it("uses denialContext to format userDeniedReason with extension tag", async () => {
      const { runner } = makeGateRunner({
        resolveResult: makeCheckResult({ state: "ask", matchedPattern: "*" }),
        prompt: vi.fn().mockResolvedValue({
          approved: false,
          state: "denied",
          denialReason: "too risky",
        }),
      });
      const ctx: DenialContext = {
        kind: "tool",
        check: makeCheckResult({ state: "ask", matchedPattern: "*" }),
      };
      const result = await runner.run(makeDenialDescriptor(ctx), null, "tc-1");
      expect(result.action).toBe("block");
      if (result.action === "block") {
        expect(result.reason).toContain(EXTENSION_TAG);
        expect(result.reason).toContain("too risky");
      }
    });
  });
});

// ── GateRunner.run — null and bypass dispatch ──────────────────────────────

describe("GateRunner.run — null and bypass dispatch", () => {
  it("returns allow for a null gate", async () => {
    const { runner, deps } = makeGateRunner();
    const result = await runner.run(null, null, "tc-1");
    expect(result).toEqual({ action: "allow" });
    expect(deps.reporter.writeReviewLog).not.toHaveBeenCalled();
    expect(deps.reporter.emitDecision).not.toHaveBeenCalled();
  });

  it("returns allow for a bypass with no log or decision", async () => {
    const { runner, deps } = makeGateRunner();
    const bypass: GateBypass = { action: "allow" };
    const result = await runner.run(bypass, null, "tc-1");
    expect(result).toEqual({ action: "allow" });
    expect(deps.reporter.writeReviewLog).not.toHaveBeenCalled();
    expect(deps.reporter.emitDecision).not.toHaveBeenCalled();
  });

  it("fires writeReviewLog for a bypass with a log entry", async () => {
    const { runner, deps } = makeGateRunner();
    const bypass: GateBypass = {
      action: "allow",
      log: { event: "infra.bypass", details: { path: "/x" } },
    };
    await runner.run(bypass, null, "tc-1");
    expect(deps.reporter.writeReviewLog).toHaveBeenCalledWith("infra.bypass", {
      path: "/x",
    });
    expect(deps.reporter.emitDecision).not.toHaveBeenCalled();
  });

  it("fires emitDecision for a bypass with a decision", async () => {
    const { runner, deps } = makeGateRunner();
    const decision = {
      surface: "path",
      value: "/x",
      result: "allow" as const,
      resolution: "policy_allow" as const,
      origin: null,
      agentName: null,
      matchedPattern: null,
    };
    const bypass: GateBypass = { action: "allow", decision };
    await runner.run(bypass, null, "tc-1");
    expect(deps.reporter.emitDecision).toHaveBeenCalledWith(decision);
    expect(deps.reporter.writeReviewLog).not.toHaveBeenCalled();
  });

  it("routes a descriptor to the gate check logic and returns allow", async () => {
    const { runner } = makeGateRunner();
    const result = await runner.run(makeDescriptor(), null, "tc-1");
    expect(result).toEqual({ action: "allow" });
  });

  it("routes a descriptor to the gate check logic and returns block", async () => {
    const { runner } = makeGateRunner({
      resolveResult: makeCheckResult({ state: "deny", matchedPattern: "*" }),
    });
    const result = await runner.run(makeDescriptor(), null, "tc-1");
    expect(result).toMatchObject({ action: "block" });
  });
});
