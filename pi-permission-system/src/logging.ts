import { appendFileSync } from "node:fs";

import {
  EXTENSION_ID,
  type PermissionSystemExtensionConfig,
} from "./extension-config";

export function safeJsonStringify(value: unknown): string | undefined {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, currentValue) => {
    if (currentValue instanceof Error) {
      return {
        name: currentValue.name,
        message: currentValue.message,
        stack: currentValue.stack,
      };
    }

    if (typeof currentValue === "bigint") {
      return currentValue.toString();
    }

    if (typeof currentValue === "object" && currentValue !== null) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- JSON.stringify replacer receives any; currentValue is narrowed to object here
      if (seen.has(currentValue)) {
        return "[Circular]";
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- same as above
      seen.add(currentValue);
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- JSON.stringify replacer must return any
    return currentValue;
  });
}

export interface PermissionSystemLogger {
  debug: (
    event: string,
    details?: Record<string, unknown>,
  ) => string | undefined;
  review: (
    event: string,
    details?: Record<string, unknown>,
  ) => string | undefined;
}

interface PermissionSystemLoggerOptions {
  getConfig: () => PermissionSystemExtensionConfig;
  debugLogPath: string;
  reviewLogPath: string;
  ensureLogsDirectory: () => string | undefined;
}

export function createPermissionSystemLogger(
  options: PermissionSystemLoggerOptions,
): PermissionSystemLogger {
  const { debugLogPath, reviewLogPath, ensureLogsDirectory } = options;

  const writeLine = (
    stream: "debug" | "review",
    path: string,
    event: string,
    details: Record<string, unknown>,
  ): string | undefined => {
    const directoryError = ensureLogsDirectory();
    if (directoryError) {
      return directoryError;
    }

    try {
      const line = safeJsonStringify({
        timestamp: new Date().toISOString(),
        extension: EXTENSION_ID,
        stream,
        event,
        ...details,
      });
      if (!line) {
        return `Failed to write permission-system ${stream} log '${path}': event could not be serialized.`;
      }
      appendFileSync(path, `${line}\n`, "utf-8");
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Failed to write permission-system ${stream} log '${path}': ${message}`;
    }
  };

  const debug = (
    event: string,
    details: Record<string, unknown> = {},
  ): string | undefined => {
    if (!options.getConfig().debugLog) {
      return undefined;
    }

    return writeLine("debug", debugLogPath, event, details);
  };

  const review = (
    event: string,
    details: Record<string, unknown> = {},
  ): string | undefined => {
    if (!options.getConfig().permissionReviewLog) {
      return undefined;
    }

    return writeLine("review", reviewLogPath, event, details);
  };

  return { debug, review };
}
