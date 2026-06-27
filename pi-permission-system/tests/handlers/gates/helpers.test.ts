import { describe, expect, it } from "vitest";

import {
  buildDecisionEvent,
  deriveDecisionValue,
  deriveResolution,
} from "../../../src/handlers/gates/helpers";
import type { PermissionCheckResult } from "../../../src/types";

describe("deriveDecisionValue", () => {
  it("returns command for bash", () => {
    expect(deriveDecisionValue("bash", { command: "git status" })).toBe(
      "git status",
    );
  });

  it("falls back to toolName when bash has no command", () => {
    expect(deriveDecisionValue("bash", {})).toBe("bash");
  });

  it("returns target for mcp", () => {
    expect(deriveDecisionValue("mcp", { target: "exa:search" })).toBe(
      "exa:search",
    );
  });

  it("falls back to toolName when mcp has no target", () => {
    expect(deriveDecisionValue("mcp", {})).toBe("mcp");
  });

  it("returns toolName for non-path-bearing tools", () => {
    expect(deriveDecisionValue("my_extension_tool", {})).toBe(
      "my_extension_tool",
    );
  });

  it("returns path for path-bearing tools when path is provided", () => {
    expect(deriveDecisionValue("read", {}, "/project/src/main.ts")).toBe(
      "/project/src/main.ts",
    );
    expect(deriveDecisionValue("write", {}, "src/.env")).toBe("src/.env");
  });

  it("falls back to toolName for path-bearing tools when path is missing", () => {
    expect(deriveDecisionValue("read", {})).toBe("read");
    expect(deriveDecisionValue("write", {}, undefined)).toBe("write");
  });
});

describe("deriveResolution", () => {
  it("returns policy_allow for allow state", () => {
    expect(deriveResolution("allow", "allow", false, true)).toBe(
      "policy_allow",
    );
  });

  it("returns policy_deny for deny state", () => {
    expect(deriveResolution("deny", "block", false, true)).toBe("policy_deny");
  });

  it("returns user_approved for ask + allow without session", () => {
    expect(deriveResolution("ask", "allow", false, true)).toBe("user_approved");
  });

  it("returns user_approved_for_session for ask + allow with session", () => {
    expect(deriveResolution("ask", "allow", true, true)).toBe(
      "user_approved_for_session",
    );
  });

  it("returns auto_approved when autoApproved flag is set", () => {
    expect(deriveResolution("ask", "allow", false, true, true)).toBe(
      "auto_approved",
    );
  });

  it("returns user_denied for ask + block with canConfirm", () => {
    expect(deriveResolution("ask", "block", false, true)).toBe("user_denied");
  });

  it("returns confirmation_unavailable for ask + block without canConfirm", () => {
    expect(deriveResolution("ask", "block", false, false)).toBe(
      "confirmation_unavailable",
    );
  });
});

describe("buildDecisionEvent", () => {
  function makeCheck(
    overrides: Partial<PermissionCheckResult> = {},
  ): PermissionCheckResult {
    return {
      state: "allow",
      toolName: "read",
      source: "tool",
      origin: "builtin",
      matchedPattern: "*",
      ...overrides,
    };
  }

  it("builds a decision event with all fields populated", () => {
    const event = buildDecisionEvent(
      { surface: "read", value: "read" },
      makeCheck({ origin: "global", matchedPattern: "read" }),
      "test-agent",
      "allow",
      "policy_allow",
    );
    expect(event).toEqual({
      surface: "read",
      value: "read",
      result: "allow",
      resolution: "policy_allow",
      origin: "global",
      agentName: "test-agent",
      matchedPattern: "read",
    });
  });

  it("normalises undefined origin to null", () => {
    const event = buildDecisionEvent(
      { surface: "bash", value: "git status" },
      makeCheck({ origin: undefined }),
      null,
      "allow",
      "user_approved",
    );
    expect(event.origin).toBeNull();
  });

  it("normalises null agentName to null", () => {
    const event = buildDecisionEvent(
      { surface: "read", value: "read" },
      makeCheck(),
      null,
      "deny",
      "policy_deny",
    );
    expect(event.agentName).toBeNull();
  });

  it("normalises undefined matchedPattern to null", () => {
    const event = buildDecisionEvent(
      { surface: "read", value: "read" },
      makeCheck({ matchedPattern: undefined }),
      null,
      "deny",
      "policy_deny",
    );
    expect(event.matchedPattern).toBeNull();
  });

  it("passes result and resolution through", () => {
    const event = buildDecisionEvent(
      { surface: "bash", value: "rm -rf /" },
      makeCheck(),
      null,
      "deny",
      "user_denied",
    );
    expect(event.result).toBe("deny");
    expect(event.resolution).toBe("user_denied");
  });
});
