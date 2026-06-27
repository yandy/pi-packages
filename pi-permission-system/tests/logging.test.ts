import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DEFAULT_EXTENSION_CONFIG } from "../src/extension-config";
import { createPermissionSystemLogger } from "../src/logging";

test("Permission-system logger respects debug toggle and keeps review log enabled by default", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-logs-"));
  const logsDir = join(baseDir, "logs");
  const debugLogPath = join(logsDir, "debug.jsonl");
  const reviewLogPath = join(logsDir, "review.jsonl");
  const config = { ...DEFAULT_EXTENSION_CONFIG };
  const logger = createPermissionSystemLogger({
    getConfig: () => config,
    debugLogPath,
    reviewLogPath,
    ensureLogsDirectory: () => {
      mkdirSync(logsDir, { recursive: true });
      return undefined;
    },
  });

  try {
    const initialDebugWarning = logger.debug("debug.disabled", {
      sample: true,
    });
    const reviewWarning = logger.review("permission_request.waiting", {
      toolName: "write",
    });

    expect(initialDebugWarning).toBe(undefined);
    expect(reviewWarning).toBe(undefined);
    expect(existsSync(debugLogPath)).toBe(false);
    expect(existsSync(reviewLogPath)).toBe(true);

    config.debugLog = true;
    const enabledDebugWarning = logger.debug("debug.enabled", { sample: true });
    expect(enabledDebugWarning).toBe(undefined);
    expect(existsSync(debugLogPath)).toBe(true);
    expect(readFileSync(debugLogPath, "utf8")).toMatch(/debug\.enabled/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
