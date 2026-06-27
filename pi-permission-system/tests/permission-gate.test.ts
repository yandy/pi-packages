import { describe, expect, it, vi } from "vitest";
import type { PermissionPromptDecision } from "../src/permission-dialog";
import {
  applyPermissionGate,
  type PermissionGateParams,
} from "../src/permission-gate";

function makeParams(
  overrides: Partial<PermissionGateParams> = {},
): PermissionGateParams {
  return {
    state: "allow",
    canConfirm: true,
    promptForApproval: vi.fn<() => Promise<PermissionPromptDecision>>(),
    writeLog: vi.fn(),
    logContext: { source: "test" },
    messages: {
      denyReason: "Denied by policy.",
      unavailableReason: "No interactive UI available.",
      userDeniedReason: (d) =>
        d.denialReason
          ? `User denied. Reason: ${d.denialReason}.`
          : "User denied.",
    },
    ...overrides,
  };
}

describe("applyPermissionGate", () => {
  describe("deny branch", () => {
    it("returns block with deny reason when state is deny", async () => {
      const params = makeParams({ state: "deny" });
      const result = await applyPermissionGate(params);
      expect(result).toEqual({
        action: "block",
        reason: "Denied by policy.",
      });
    });

    it("calls writeLog with policy_denied resolution", async () => {
      const params = makeParams({
        state: "deny",
        logContext: { source: "tool_call", toolName: "bash" },
      });
      await applyPermissionGate(params);
      expect(params.writeLog).toHaveBeenCalledOnce();
      expect(params.writeLog).toHaveBeenCalledWith(
        "permission_request.blocked",
        {
          source: "tool_call",
          toolName: "bash",
          resolution: "policy_denied",
        },
      );
    });

    it("does not call promptForApproval when state is deny", async () => {
      const params = makeParams({ state: "deny" });
      await applyPermissionGate(params);
      expect(params.promptForApproval).not.toHaveBeenCalled();
    });
  });

  describe("ask branch — unavailable", () => {
    it("returns block with unavailable reason when canConfirm is false", async () => {
      const params = makeParams({ state: "ask", canConfirm: false });
      const result = await applyPermissionGate(params);
      expect(result).toEqual({
        action: "block",
        reason: "No interactive UI available.",
      });
    });

    it("calls writeLog with confirmation_unavailable resolution", async () => {
      const params = makeParams({
        state: "ask",
        canConfirm: false,
        logContext: { source: "skill_read", skillName: "foo" },
      });
      await applyPermissionGate(params);
      expect(params.writeLog).toHaveBeenCalledOnce();
      expect(params.writeLog).toHaveBeenCalledWith(
        "permission_request.blocked",
        {
          source: "skill_read",
          skillName: "foo",
          resolution: "confirmation_unavailable",
        },
      );
    });

    it("does not call promptForApproval when canConfirm is false", async () => {
      const params = makeParams({ state: "ask", canConfirm: false });
      await applyPermissionGate(params);
      expect(params.promptForApproval).not.toHaveBeenCalled();
    });
  });

  describe("ask branch — user rejects", () => {
    it("returns block with user-denied reason when user rejects", async () => {
      const decision: PermissionPromptDecision = {
        approved: false,
        state: "denied",
      };
      const promptForApproval = vi.fn().mockResolvedValue(decision);
      const params = makeParams({
        state: "ask",
        canConfirm: true,
        promptForApproval,
      });
      const result = await applyPermissionGate(params);
      expect(result).toEqual({ action: "block", reason: "User denied." });
    });

    it("passes denial reason through userDeniedReason formatter", async () => {
      const decision: PermissionPromptDecision = {
        approved: false,
        state: "denied_with_reason",
        denialReason: "not now",
      };
      const promptForApproval = vi.fn().mockResolvedValue(decision);
      const params = makeParams({
        state: "ask",
        canConfirm: true,
        promptForApproval,
      });
      const result = await applyPermissionGate(params);
      expect(result).toEqual({
        action: "block",
        reason: "User denied. Reason: not now.",
      });
    });

    it("does not call writeLog when user rejects (logged by promptPermission)", async () => {
      const decision: PermissionPromptDecision = {
        approved: false,
        state: "denied",
      };
      const promptForApproval = vi.fn().mockResolvedValue(decision);
      const params = makeParams({
        state: "ask",
        canConfirm: true,
        promptForApproval,
      });
      await applyPermissionGate(params);
      expect(params.writeLog).not.toHaveBeenCalled();
    });
  });

  describe("ask branch — user approves", () => {
    it("returns allow when user approves", async () => {
      const decision: PermissionPromptDecision = {
        approved: true,
        state: "approved",
      };
      const promptForApproval = vi.fn().mockResolvedValue(decision);
      const params = makeParams({
        state: "ask",
        canConfirm: true,
        promptForApproval,
      });
      const result = await applyPermissionGate(params);
      expect(result).toEqual({ action: "allow" });
    });

    it("does not call writeLog when user approves", async () => {
      const decision: PermissionPromptDecision = {
        approved: true,
        state: "approved",
      };
      const promptForApproval = vi.fn().mockResolvedValue(decision);
      const params = makeParams({
        state: "ask",
        canConfirm: true,
        promptForApproval,
      });
      await applyPermissionGate(params);
      expect(params.writeLog).not.toHaveBeenCalled();
    });
  });

  describe("ask branch — approved_for_session with sessionApproval", () => {
    it("attaches sessionApproval to result when decision is approved_for_session and param provided", async () => {
      const decision: PermissionPromptDecision = {
        approved: true,
        state: "approved_for_session",
      };
      const promptForApproval = vi.fn().mockResolvedValue(decision);
      const params = makeParams({
        state: "ask",
        canConfirm: true,
        promptForApproval,
        sessionApproval: { surface: "bash", pattern: "git *" },
      });
      const result = await applyPermissionGate(params);
      expect(result).toEqual({
        action: "allow",
        sessionApproval: { surface: "bash", pattern: "git *" },
      });
    });

    it("does not attach sessionApproval when decision is approved (once)", async () => {
      const decision: PermissionPromptDecision = {
        approved: true,
        state: "approved",
      };
      const promptForApproval = vi.fn().mockResolvedValue(decision);
      const params = makeParams({
        state: "ask",
        canConfirm: true,
        promptForApproval,
        sessionApproval: { surface: "bash", pattern: "git *" },
      });
      const result = await applyPermissionGate(params);
      expect(result).toEqual({ action: "allow" });
    });

    it("does not attach sessionApproval when no sessionApproval param", async () => {
      const decision: PermissionPromptDecision = {
        approved: true,
        state: "approved_for_session",
      };
      const promptForApproval = vi.fn().mockResolvedValue(decision);
      const params = makeParams({
        state: "ask",
        canConfirm: true,
        promptForApproval,
      });
      const result = await applyPermissionGate(params);
      expect(result).toEqual({ action: "allow" });
    });

    it("does not attach sessionApproval when user denies", async () => {
      const decision: PermissionPromptDecision = {
        approved: false,
        state: "denied",
      };
      const promptForApproval = vi.fn().mockResolvedValue(decision);
      const params = makeParams({
        state: "ask",
        canConfirm: true,
        promptForApproval,
        sessionApproval: { surface: "bash", pattern: "git *" },
      });
      const result = await applyPermissionGate(params);
      expect(result).toEqual({ action: "block", reason: "User denied." });
    });
  });

  describe("allow branch", () => {
    it("returns allow immediately when state is allow", async () => {
      const params = makeParams({ state: "allow" });
      const result = await applyPermissionGate(params);
      expect(result).toEqual({ action: "allow" });
    });

    it("does not call writeLog when state is allow", async () => {
      const params = makeParams({ state: "allow" });
      await applyPermissionGate(params);
      expect(params.writeLog).not.toHaveBeenCalled();
    });

    it("does not call promptForApproval when state is allow", async () => {
      const params = makeParams({ state: "allow" });
      await applyPermissionGate(params);
      expect(params.promptForApproval).not.toHaveBeenCalled();
    });
  });
});
