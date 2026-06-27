import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createPermissionForwardingLocation,
  isForwardedPermissionRequestForSession,
  resolvePermissionForwardingTargetSessionId,
  SUBAGENT_PARENT_SESSION_ENV_CANDIDATES,
  SUBAGENT_PARENT_SESSION_ENV_KEY,
} from "../src/permission-forwarding";
import { SubagentSessionRegistry } from "../src/subagent-registry";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("SUBAGENT_PARENT_SESSION_ENV_CANDIDATES", () => {
  test("is an array containing PI_AGENT_ROUTER_PARENT_SESSION_ID", () => {
    expect(Array.isArray(SUBAGENT_PARENT_SESSION_ENV_CANDIDATES)).toBe(true);
    expect(SUBAGENT_PARENT_SESSION_ENV_CANDIDATES).toContain(
      "PI_AGENT_ROUTER_PARENT_SESSION_ID",
    );
  });

  test("contains PI_SUBAGENT_PARENT_SESSION for CLI-based subagent extensions", () => {
    expect(SUBAGENT_PARENT_SESSION_ENV_CANDIDATES).toContain(
      "PI_SUBAGENT_PARENT_SESSION",
    );
  });

  test("deprecated SUBAGENT_PARENT_SESSION_ENV_KEY equals the first candidate", () => {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- test verifying the deprecated alias
    expect(SUBAGENT_PARENT_SESSION_ENV_KEY).toBe(
      SUBAGENT_PARENT_SESSION_ENV_CANDIDATES[0],
    );
  });
});

describe("resolvePermissionForwardingTargetSessionId", () => {
  test("hasUI=true returns the current session ID (UI host owns forwarding)", () => {
    expect(
      resolvePermissionForwardingTargetSessionId({
        hasUI: true,
        isSubagent: false,
        currentSessionId: "parent-session-abc",
        env: {},
      }),
    ).toBe("parent-session-abc");
  });

  test("hasUI=true with isSubagent=true still returns current session ID", () => {
    expect(
      resolvePermissionForwardingTargetSessionId({
        hasUI: true,
        isSubagent: true,
        currentSessionId: "session-xyz",
        env: { PI_AGENT_ROUTER_PARENT_SESSION_ID: "other" },
      }),
    ).toBe("session-xyz");
  });

  test("hasUI=false, isSubagent=false returns null", () => {
    expect(
      resolvePermissionForwardingTargetSessionId({
        hasUI: false,
        isSubagent: false,
        currentSessionId: "session-xyz",
        env: { PI_AGENT_ROUTER_PARENT_SESSION_ID: "parent-session-abc" },
      }),
    ).toBeNull();
  });

  test("isSubagent=true, no candidates set returns null", () => {
    expect(
      resolvePermissionForwardingTargetSessionId({
        hasUI: false,
        isSubagent: true,
        currentSessionId: "session-xyz",
        env: {},
      }),
    ).toBeNull();
  });

  test("isSubagent=true, PI_AGENT_ROUTER_PARENT_SESSION_ID set returns its value", () => {
    expect(
      resolvePermissionForwardingTargetSessionId({
        hasUI: false,
        isSubagent: true,
        currentSessionId: "session-xyz",
        env: { PI_AGENT_ROUTER_PARENT_SESSION_ID: "parent-session-abc" },
      }),
    ).toBe("parent-session-abc");
  });

  test("isSubagent=true, PI_SUBAGENT_PARENT_SESSION resolves when PI_AGENT_ROUTER_PARENT_SESSION_ID is absent", () => {
    expect(
      resolvePermissionForwardingTargetSessionId({
        hasUI: false,
        isSubagent: true,
        currentSessionId: "session-xyz",
        env: {
          PI_SUBAGENT_PARENT_SESSION: "parent-from-convention",
        },
      }),
    ).toBe("parent-from-convention");
  });

  test("isSubagent=true, PI_AGENT_ROUTER_PARENT_SESSION_ID takes precedence over PI_SUBAGENT_PARENT_SESSION", () => {
    expect(
      resolvePermissionForwardingTargetSessionId({
        hasUI: false,
        isSubagent: true,
        currentSessionId: "session-xyz",
        env: {
          PI_AGENT_ROUTER_PARENT_SESSION_ID: "parent-from-router",
          PI_SUBAGENT_PARENT_SESSION: "parent-from-convention",
        },
      }),
    ).toBe("parent-from-router");
  });

  test("isSubagent=true, candidate value is empty string returns null", () => {
    expect(
      resolvePermissionForwardingTargetSessionId({
        hasUI: false,
        isSubagent: true,
        currentSessionId: "session-xyz",
        env: { PI_AGENT_ROUTER_PARENT_SESSION_ID: "" },
      }),
    ).toBeNull();
  });

  test("isSubagent=true, candidate value is 'unknown' returns null", () => {
    expect(
      resolvePermissionForwardingTargetSessionId({
        hasUI: false,
        isSubagent: true,
        currentSessionId: "session-xyz",
        env: { PI_AGENT_ROUTER_PARENT_SESSION_ID: "unknown" },
      }),
    ).toBeNull();
  });

  test("env defaults to process.env when omitted", () => {
    vi.stubEnv("PI_AGENT_ROUTER_PARENT_SESSION_ID", "env-session-abc");
    expect(
      resolvePermissionForwardingTargetSessionId({
        hasUI: false,
        isSubagent: true,
      }),
    ).toBe("env-session-abc");
  });
});

describe("resolvePermissionForwardingTargetSessionId — registry resolution", () => {
  const childSessionId = "child-session-abc";

  test("returns parentSessionId from registry when env vars are absent", () => {
    const registry = new SubagentSessionRegistry();
    registry.register(childSessionId, {
      parentSessionId: "parent-from-registry",
    });

    expect(
      resolvePermissionForwardingTargetSessionId({
        hasUI: false,
        isSubagent: true,
        sessionId: childSessionId,
        registry,
        env: {},
      }),
    ).toBe("parent-from-registry");
  });

  test("registry takes priority over env vars", () => {
    const registry = new SubagentSessionRegistry();
    registry.register(childSessionId, {
      parentSessionId: "parent-from-registry",
    });

    expect(
      resolvePermissionForwardingTargetSessionId({
        hasUI: false,
        isSubagent: true,
        sessionId: childSessionId,
        registry,
        env: { PI_AGENT_ROUTER_PARENT_SESSION_ID: "parent-from-env" },
      }),
    ).toBe("parent-from-registry");
  });

  test("falls through to env vars when registry entry has no parentSessionId", () => {
    const registry = new SubagentSessionRegistry();
    registry.register(childSessionId, {}); // no parentSessionId

    expect(
      resolvePermissionForwardingTargetSessionId({
        hasUI: false,
        isSubagent: true,
        sessionId: childSessionId,
        registry,
        env: { PI_AGENT_ROUTER_PARENT_SESSION_ID: "parent-from-env" },
      }),
    ).toBe("parent-from-env");
  });

  test("falls through to env vars when sessionId is not in registry", () => {
    const registry = new SubagentSessionRegistry(); // empty

    expect(
      resolvePermissionForwardingTargetSessionId({
        hasUI: false,
        isSubagent: true,
        sessionId: childSessionId,
        registry,
        env: { PI_AGENT_ROUTER_PARENT_SESSION_ID: "parent-from-env" },
      }),
    ).toBe("parent-from-env");
  });

  test("returns null when registry entry has no parentSessionId and no env vars set", () => {
    const registry = new SubagentSessionRegistry();
    registry.register(childSessionId, {}); // no parentSessionId

    expect(
      resolvePermissionForwardingTargetSessionId({
        hasUI: false,
        isSubagent: true,
        sessionId: childSessionId,
        registry,
        env: {},
      }),
    ).toBeNull();
  });

  test("omitting registry preserves existing behaviour", () => {
    expect(
      resolvePermissionForwardingTargetSessionId({
        hasUI: false,
        isSubagent: true,
        sessionId: childSessionId,
        env: { PI_AGENT_ROUTER_PARENT_SESSION_ID: "parent-from-env" },
      }),
    ).toBe("parent-from-env");
  });
});

// ---------------------------------------------------------------------------
// Moved from permission-system.test.ts catch-all (#342)
// ---------------------------------------------------------------------------

test("Permission forwarding resolves the parent interactive session from subagent runtime env", () => {
  const targetSessionId = resolvePermissionForwardingTargetSessionId({
    hasUI: false,
    isSubagent: true,
    currentSessionId: "child-session",
    env: {
      PI_AGENT_ROUTER_PARENT_SESSION_ID: "parent-session",
    },
  });

  expect(targetSessionId).toBe("parent-session");
});

test("Permission forwarding does not guess a target session when subagent runtime env is missing", () => {
  const targetSessionId = resolvePermissionForwardingTargetSessionId({
    hasUI: false,
    isSubagent: true,
    currentSessionId: "child-session",
    env: {},
  });

  expect(targetSessionId).toBe(null);
});

test("Permission forwarding uses session-scoped directories per interactive session", () => {
  const forwardingRoot = join(tmpdir(), "pi-permission-system-forwarding-root");
  const sessionA = createPermissionForwardingLocation(
    forwardingRoot,
    "session-a",
  );
  const sessionB = createPermissionForwardingLocation(
    forwardingRoot,
    "session-b",
  );

  expect(sessionA.sessionRootDir).not.toBe(sessionB.sessionRootDir);
  expect(sessionA.requestsDir).not.toBe(sessionB.requestsDir);
  expect(sessionA.responsesDir).not.toBe(sessionB.responsesDir);
});

test("Permission forwarding request routing only matches the intended UI session", () => {
  expect(
    isForwardedPermissionRequestForSession(
      { targetSessionId: "session-a" },
      "session-a",
    ),
  ).toBe(true);
  expect(
    isForwardedPermissionRequestForSession(
      { targetSessionId: "session-a" },
      "session-b",
    ),
  ).toBe(false);
});

test("Permission forwarding rejects unresolved sentinel session ids", () => {
  const targetSessionId = resolvePermissionForwardingTargetSessionId({
    hasUI: true,
    isSubagent: false,
    currentSessionId: "unknown",
  });

  expect(targetSessionId).toBe(null);
});
