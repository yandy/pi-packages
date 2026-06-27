import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanupPermissionForwardingLocationIfEmpty,
  formatUnknownErrorMessage,
  isErrnoCode,
  logPermissionForwardingError,
  logPermissionForwardingWarning,
  tryRemoveDirectoryIfEmpty,
} from "../../src/forwarded-permissions/io";
import { createPermissionForwardingLocation } from "../../src/permission-forwarding";
import type { DebugReviewLogger } from "../../src/session-logger";

// ── helpers ────────────────────────────────────────────────────────────────

function makeLogger(): DebugReviewLogger {
  return {
    review: vi.fn(),
    debug: vi.fn(),
  };
}

// ── formatUnknownErrorMessage ──────────────────────────────────────────────

describe("formatUnknownErrorMessage", () => {
  it("returns the error message for Error instances", () => {
    expect(formatUnknownErrorMessage(new Error("oops"))).toBe("oops");
  });

  it("converts non-Error values to string", () => {
    expect(formatUnknownErrorMessage("raw string")).toBe("raw string");
    expect(formatUnknownErrorMessage(42)).toBe("42");
  });

  it("falls back to String(error) for Error with empty message", () => {
    // error.message is falsy (""), so the function falls through to String(error)
    const e = new Error("");
    expect(formatUnknownErrorMessage(e)).toBe("Error");
  });
});

// ── isErrnoCode ────────────────────────────────────────────────────────────

describe("isErrnoCode", () => {
  it("returns true when code matches", () => {
    expect(isErrnoCode({ code: "ENOENT" }, "ENOENT")).toBe(true);
  });

  it("returns false when code does not match", () => {
    expect(isErrnoCode({ code: "EACCES" }, "ENOENT")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isErrnoCode(null, "ENOENT")).toBe(false);
  });

  it("returns false when no code property", () => {
    expect(isErrnoCode({}, "ENOENT")).toBe(false);
  });
});

// ── logPermissionForwardingWarning ─────────────────────────────────────────

describe("logPermissionForwardingWarning", () => {
  it("calls logger.review with the warning event", () => {
    const logger = makeLogger();
    logPermissionForwardingWarning(logger, "something went wrong");
    expect(logger.review).toHaveBeenCalledWith(
      "permission_forwarding.warning",
      { message: "something went wrong" },
    );
  });

  it("calls logger.debug with the warning event", () => {
    const logger = makeLogger();
    logPermissionForwardingWarning(logger, "something went wrong");
    expect(logger.debug).toHaveBeenCalledWith("permission_forwarding.warning", {
      message: "something went wrong",
    });
  });

  it("includes formatted error when an error is provided", () => {
    const logger = makeLogger();
    logPermissionForwardingWarning(logger, "bad thing", new Error("fs fail"));
    expect(logger.review).toHaveBeenCalledWith(
      "permission_forwarding.warning",
      { message: "bad thing", error: "fs fail" },
    );
  });

  it("does not throw when logger is null", () => {
    expect(() => logPermissionForwardingWarning(null, "ignored")).not.toThrow();
  });

  it("does not call anything when logger is null", () => {
    // Verify the null-logger path is a true no-op — cannot easily spy on null,
    // but we can verify the call succeeds silently.
    expect(() =>
      logPermissionForwardingWarning(null, "msg", new Error("err")),
    ).not.toThrow();
  });
});

// ── logPermissionForwardingError ───────────────────────────────────────────

describe("logPermissionForwardingError", () => {
  it("calls logger.review with the error event", () => {
    const logger = makeLogger();
    logPermissionForwardingError(logger, "critical failure");
    expect(logger.review).toHaveBeenCalledWith("permission_forwarding.error", {
      message: "critical failure",
    });
  });

  it("calls logger.debug with the error event", () => {
    const logger = makeLogger();
    logPermissionForwardingError(logger, "critical failure");
    expect(logger.debug).toHaveBeenCalledWith("permission_forwarding.error", {
      message: "critical failure",
    });
  });

  it("includes formatted error when an error is provided", () => {
    const logger = makeLogger();
    logPermissionForwardingError(logger, "io error", new Error("ENOENT"));
    expect(logger.review).toHaveBeenCalledWith("permission_forwarding.error", {
      message: "io error",
      error: "ENOENT",
    });
  });

  it("does not throw when logger is null", () => {
    expect(() => logPermissionForwardingError(null, "ignored")).not.toThrow();
  });
});

// ── tryRemoveDirectoryIfEmpty ──────────────────────────────────────────────

describe("tryRemoveDirectoryIfEmpty", () => {
  let root: string;

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns true when the directory does not exist", () => {
    root = mkdtempSync(join(tmpdir(), "io-test-"));
    const absent = join(root, "nonexistent");
    expect(tryRemoveDirectoryIfEmpty(null, absent, "test")).toBe(true);
  });

  it("returns true and removes an empty directory", () => {
    root = mkdtempSync(join(tmpdir(), "io-test-"));
    const dir = join(root, "empty");
    mkdirSync(dir);
    expect(tryRemoveDirectoryIfEmpty(null, dir, "test")).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it("returns false and leaves a non-empty directory in place", () => {
    root = mkdtempSync(join(tmpdir(), "io-test-"));
    const dir = join(root, "nonempty");
    mkdirSync(dir);
    writeFileSync(join(dir, "file.json"), "{}", "utf-8");
    expect(tryRemoveDirectoryIfEmpty(null, dir, "test")).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });
});

// ── cleanupPermissionForwardingLocationIfEmpty ─────────────────────────────

describe("cleanupPermissionForwardingLocationIfEmpty", () => {
  let root: string;

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("preserves responses/ when requests/ is non-empty (the concurrent-request race)", () => {
    root = mkdtempSync(join(tmpdir(), "io-cleanup-"));
    const forwardingDir = join(root, "forwarding");
    const location = createPermissionForwardingLocation(
      forwardingDir,
      "parent-session",
    );
    // Simulate: requests/ has a pending file, responses/ is momentarily empty
    mkdirSync(location.requestsDir, { recursive: true });
    mkdirSync(location.responsesDir, { recursive: true });
    writeFileSync(join(location.requestsDir, "req-b.json"), "{}", "utf-8");
    // responses/ is empty (sibling subagent A already cleaned up its response)

    cleanupPermissionForwardingLocationIfEmpty(null, location);

    // requests/ is non-empty → should NOT be removed
    expect(existsSync(location.requestsDir)).toBe(true);
    // responses/ must survive — removing it causes the ENOENT write loop
    expect(existsSync(location.responsesDir)).toBe(true);
    // sessionRoot must also survive while subdirs are present
    expect(existsSync(location.sessionRootDir)).toBe(true);
  });

  it("removes both subdirs and sessionRoot when both are empty (normal serial cleanup)", () => {
    root = mkdtempSync(join(tmpdir(), "io-cleanup-"));
    const forwardingDir = join(root, "forwarding");
    const location = createPermissionForwardingLocation(
      forwardingDir,
      "parent-session",
    );
    mkdirSync(location.requestsDir, { recursive: true });
    mkdirSync(location.responsesDir, { recursive: true });
    // Both empty — normal end-of-lifecycle state

    cleanupPermissionForwardingLocationIfEmpty(null, location);

    expect(existsSync(location.requestsDir)).toBe(false);
    expect(existsSync(location.responsesDir)).toBe(false);
    expect(existsSync(location.sessionRootDir)).toBe(false);
  });

  it("leaves responses/ in place when it is non-empty even if requests/ is empty", () => {
    root = mkdtempSync(join(tmpdir(), "io-cleanup-"));
    const forwardingDir = join(root, "forwarding");
    const location = createPermissionForwardingLocation(
      forwardingDir,
      "parent-session",
    );
    mkdirSync(location.requestsDir, { recursive: true });
    mkdirSync(location.responsesDir, { recursive: true });
    writeFileSync(join(location.responsesDir, "resp.json"), "{}", "utf-8");
    // requests/ is empty, responses/ has a stale response

    cleanupPermissionForwardingLocationIfEmpty(null, location);

    // requests/ is empty so it gets removed
    expect(existsSync(location.requestsDir)).toBe(false);
    // responses/ is non-empty → survives
    expect(existsSync(location.responsesDir)).toBe(true);
    // sessionRoot survives because responses/ is still present
    expect(existsSync(location.sessionRootDir)).toBe(true);
  });
});
