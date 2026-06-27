/**
 * turn-limits.ts — Pure turn-limit normalization for subagent execution.
 *
 * Extracted from agent-runner.ts (issue #265) so the turn-counting policy has a
 * focused home independent of session assembly. Consumed by the subagent tool's
 * spawn-config resolution and by the turn loop in SubagentSession.
 */

/** Normalize max turns. undefined or 0 = unlimited, otherwise minimum 1. */
export function normalizeMaxTurns(n: number | undefined): number | undefined {
  if (n == null || n === 0) return undefined;
  return Math.max(1, n);
}
