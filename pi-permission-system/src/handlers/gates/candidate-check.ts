import type { PermissionCheckResult, PermissionState } from "../../types";

/** Restrictiveness ordering: deny is the most restrictive, allow the least. */
const RESTRICTIVENESS: Record<PermissionState, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

/**
 * Select the most restrictive permission result from a list (deny > ask > allow).
 *
 * The first occurrence wins on ties, so a caller passing results in candidate
 * order receives the earliest worst case. Returns `undefined` for an empty list.
 *
 * Shared by the bash gates (path, external-directory) to combine the per-candidate
 * `checkPermission` results their tree-sitter token extraction produces.
 */
export function pickMostRestrictive(
  results: readonly PermissionCheckResult[],
): PermissionCheckResult | undefined {
  let worst: PermissionCheckResult | undefined;
  for (const result of results) {
    if (
      worst === undefined ||
      RESTRICTIVENESS[result.state] > RESTRICTIVENESS[worst.state]
    ) {
      worst = result;
    }
  }
  return worst;
}
