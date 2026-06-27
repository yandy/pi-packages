import { afterEach, describe, expect, test, vi } from "vitest";
import type { PermissionSystemExtensionConfig } from "../src/extension-config";
import { DEFAULT_EXTENSION_CONFIG } from "../src/extension-config";
import { resolvePermissionForwardingTargetSessionId } from "../src/permission-forwarding";
import {
  canResolveAskPermissionRequest,
  shouldAutoApprovePermissionState,
} from "../src/yolo-mode";

afterEach(() => {
  vi.restoreAllMocks();
});

function makeConfig(
  yoloMode: boolean | undefined,
): PermissionSystemExtensionConfig {
  return { yoloMode } as PermissionSystemExtensionConfig;
}

describe("shouldAutoApprovePermissionState", () => {
  test("returns true for 'ask' when yolo mode is on", () => {
    expect(shouldAutoApprovePermissionState("ask", makeConfig(true))).toBe(
      true,
    );
  });

  test("returns false for 'ask' when yolo mode is off", () => {
    expect(shouldAutoApprovePermissionState("ask", makeConfig(false))).toBe(
      false,
    );
  });

  test("returns false for 'ask' when yolo mode is undefined", () => {
    expect(shouldAutoApprovePermissionState("ask", makeConfig(undefined))).toBe(
      false,
    );
  });

  test("returns false for 'allow' even when yolo mode is on", () => {
    expect(shouldAutoApprovePermissionState("allow", makeConfig(true))).toBe(
      false,
    );
  });

  test("returns false for 'deny' even when yolo mode is on", () => {
    expect(shouldAutoApprovePermissionState("deny", makeConfig(true))).toBe(
      false,
    );
  });
});

describe("canResolveAskPermissionRequest", () => {
  test("returns true when hasUI is true regardless of other flags", () => {
    expect(
      canResolveAskPermissionRequest({
        config: makeConfig(false),
        hasUI: true,
        isSubagent: false,
      }),
    ).toBe(true);
  });

  test("returns true when isSubagent is true regardless of other flags", () => {
    expect(
      canResolveAskPermissionRequest({
        config: makeConfig(false),
        hasUI: false,
        isSubagent: true,
      }),
    ).toBe(true);
  });

  test("returns true when yolo mode is on regardless of UI/subagent flags", () => {
    expect(
      canResolveAskPermissionRequest({
        config: makeConfig(true),
        hasUI: false,
        isSubagent: false,
      }),
    ).toBe(true);
  });

  test("returns false when no UI, not a subagent, and yolo mode is off", () => {
    expect(
      canResolveAskPermissionRequest({
        config: makeConfig(false),
        hasUI: false,
        isSubagent: false,
      }),
    ).toBe(false);
  });

  test("returns false when no UI, not a subagent, and yolo mode is undefined", () => {
    expect(
      canResolveAskPermissionRequest({
        config: makeConfig(undefined),
        hasUI: false,
        isSubagent: false,
      }),
    ).toBe(false);
  });

  test("returns true when all three conditions are true", () => {
    expect(
      canResolveAskPermissionRequest({
        config: makeConfig(true),
        hasUI: true,
        isSubagent: true,
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Moved from permission-system.test.ts catch-all (#342)
// ---------------------------------------------------------------------------

test("Yolo mode only auto-approves ask-state permissions", () => {
  expect(
    shouldAutoApprovePermissionState("ask", DEFAULT_EXTENSION_CONFIG),
  ).toBe(false);
  expect(
    shouldAutoApprovePermissionState("ask", {
      ...DEFAULT_EXTENSION_CONFIG,
      yoloMode: true,
    }),
  ).toBe(true);
  expect(
    shouldAutoApprovePermissionState("deny", {
      ...DEFAULT_EXTENSION_CONFIG,
      yoloMode: true,
    }),
  ).toBe(false);
  expect(
    shouldAutoApprovePermissionState("allow", {
      ...DEFAULT_EXTENSION_CONFIG,
      yoloMode: true,
    }),
  ).toBe(false);
});

test("Yolo mode resolves ask permissions without UI or delegation forwarding", () => {
  expect(
    canResolveAskPermissionRequest({
      config: DEFAULT_EXTENSION_CONFIG,
      hasUI: false,
      isSubagent: false,
    }),
  ).toBe(false);
  expect(
    canResolveAskPermissionRequest({
      config: { ...DEFAULT_EXTENSION_CONFIG, yoloMode: true },
      hasUI: false,
      isSubagent: false,
    }),
  ).toBe(true);
  expect(
    canResolveAskPermissionRequest({
      config: DEFAULT_EXTENSION_CONFIG,
      hasUI: false,
      isSubagent: true,
    }),
  ).toBe(true);
});

test("Yolo mode bypasses delegated ask routing when no parent forwarding target is available", () => {
  const targetSessionId = resolvePermissionForwardingTargetSessionId({
    hasUI: false,
    isSubagent: true,
    currentSessionId: "child-session",
    env: {},
  });

  expect(targetSessionId).toBe(null);
  expect(
    canResolveAskPermissionRequest({
      config: { ...DEFAULT_EXTENSION_CONFIG, yoloMode: true },
      hasUI: false,
      isSubagent: true,
    }),
  ).toBe(true);
  expect(
    shouldAutoApprovePermissionState("ask", {
      ...DEFAULT_EXTENSION_CONFIG,
      yoloMode: true,
    }),
  ).toBe(true);
});
