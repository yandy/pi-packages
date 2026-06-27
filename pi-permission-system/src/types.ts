export type PermissionState = "allow" | "deny" | "ask";

import type { RuleOrigin } from "./rule";

export type { RuleOrigin };

/**
 * A deny action with an optional reason annotation, used when a pattern maps
 * to an object instead of a plain PermissionState string.
 */
export interface DenyWithReason {
  action: "deny";
  reason?: string;
}

/** A pattern value: a PermissionState string OR a DenyWithReason object. */
export type PatternValue = PermissionState | DenyWithReason;

/**
 * The on-disk permission shape inside the `"permission"` key.
 * A surface value is a PermissionState string (shorthand for `{ "*": action }`)
 * or a pattern→value map. Pattern values may be a PermissionState string or a
 * DenyWithReason object. A top-level value is never a bare DenyWithReason.
 */
export type FlatPermissionConfig = Record<
  string,
  PermissionState | Record<string, PatternValue>
>;

/**
 * Per-scope permission config shape after loading and validation.
 * Holds only the flat permission map — all policy is expressed there.
 */
export interface ScopeConfig {
  permission?: FlatPermissionConfig;
}

/**
 * Execution context of a bash command nested inside a substitution or subshell.
 * Absent for current-shell (top-level) commands.
 */
export type BashCommandContext =
  | "command_substitution"
  | "process_substitution"
  | "subshell";

export interface PermissionCheckResult {
  toolName: string;
  state: PermissionState;
  /** Custom denial reason from a deny-with-reason pattern, when present. */
  reason?: string;
  matchedPattern?: string;
  command?: string;
  target?: string;
  source: "tool" | "bash" | "mcp" | "skill" | "special" | "default" | "session";
  /** Which source contributed the winning rule. */
  origin: RuleOrigin;
  /**
   * Execution context of the offending nested command, when the winning bash
   * unit came from a substitution or subshell. Absent for current-shell
   * (top-level) commands.
   */
  commandContext?: BashCommandContext;
}
