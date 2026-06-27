import { dirname, sep } from "node:path";

import type { Ruleset } from "./rule";
import type { SessionApproval } from "./session-approval";
import type { SessionApprovalRecorder } from "./session-approval-recorder";

/**
 * Ephemeral in-memory store of session-scoped permission approvals.
 *
 * Each approval is stored as a `Rule` with `action: "allow"`, making the
 * ruleset directly usable with `evaluate()` — no custom matching engine needed.
 *
 * Cleared on session_shutdown — never persisted to disk.
 */
export class SessionRules implements SessionApprovalRecorder {
  private rules: Ruleset = [];

  /** Record a wildcard pattern as approved for the given surface. */
  approve(surface: string, pattern: string): void {
    this.rules.push({
      surface,
      pattern,
      action: "allow",
      layer: "session",
      origin: "session",
    });
  }

  /** Return a defensive copy of the current session ruleset. */
  getRuleset(): Ruleset {
    return [...this.rules];
  }

  /**
   * Record all patterns from a `SessionApproval` value object.
   *
   * The loop lives here so callers never need to know whether an approval
   * carries one pattern or many — they just tell the store to record it.
   */
  recordSessionApproval(approval: SessionApproval): void {
    for (const pattern of approval.patterns) {
      this.approve(approval.surface, pattern);
    }
  }

  /** Remove all session approvals. */
  clear(): void {
    this.rules = [];
  }
}

/**
 * Derive the wildcard glob pattern to approve from a normalized path.
 *
 * Returns `<parent-dir>/*` so that `evaluate()` / `wildcardMatch()` matches
 * all paths under the approved directory — identical semantics to the former
 * `SessionApprovalCache` prefix matching, using the unified wildcard engine.
 *
 * For paths that already end with a separator (directories), the separator
 * is treated as the directory boundary and `*` is appended directly.
 *
 * The path is expected to be the canonical (cwd-resolved, absolute) form used
 * for policy matching, so the derived pattern matches the same policy values a
 * later tool call produces. Callers that hold a working directory resolve the
 * path to that form first; the function itself stays free of cwd state.
 */
export function deriveApprovalPattern(normalizedPath: string): string {
  // If the path already ends with a separator, it's a directory — glob its contents.
  if (normalizedPath.endsWith(sep)) {
    return `${normalizedPath}*`;
  }
  const dir = dirname(normalizedPath);
  if (dir === normalizedPath) {
    // Root path — dirname('/') === '/'
    return `${dir}*`;
  }
  const prefix = dir.endsWith(sep) ? dir : `${dir}${sep}`;
  return `${prefix}*`;
}
