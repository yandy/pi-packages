import type { Rule, Ruleset } from "./rule";
import type { FlatPermissionConfig } from "./types";
import { isDenyWithReason, isPermissionState } from "./value-guards";

/**
 * Convert a flat permission config into a Ruleset.
 *
 * Each key is a surface name. A string value is shorthand for
 * `{ "*": action }`. An object value maps patterns to actions.
 * A pattern value may be a PermissionState string or a `DenyWithReason`
 * object (`{ action: "deny", reason?: string }`).
 * Invalid action values are silently skipped.
 *
 * The universal fallback key `"*"` is included if present — callers
 * that use `"*"` only for `synthesizeDefaults()` should strip it before
 * calling this function.
 */
export function normalizeFlatConfig(permission: FlatPermissionConfig): Ruleset {
  const rules: Rule[] = [];
  for (const [surface, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      if (isPermissionState(value)) {
        rules.push({ surface, pattern: "*", action: value, origin: "builtin" });
      }
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive null check; value type does not include null but runtime JSON may
    } else if (typeof value === "object" && value !== null) {
      for (const [pattern, action] of Object.entries(value)) {
        if (isDenyWithReason(action)) {
          rules.push({
            surface,
            pattern,
            action: "deny",
            reason: action.reason,
            origin: "builtin",
          });
        } else if (isPermissionState(action)) {
          rules.push({ surface, pattern, action, origin: "builtin" });
        }
      }
    }
  }
  return rules;
}
