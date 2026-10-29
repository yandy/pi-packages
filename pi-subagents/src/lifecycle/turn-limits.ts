/**
 * turn-limits.ts — Pure run-limit normalization for subagent execution
 * (max turns and wall-clock timeout).
 *
 * Extracted from agent-runner.ts (issue #265) so the run-limit policy has a
 * focused home independent of session assembly. Consumed by the subagent tool's
 * spawn-config resolution and by the turn loop in SubagentSession.
 */

/** Normalize max turns. undefined or 0 = unlimited, otherwise minimum 1. */
export function normalizeMaxTurns(n: number | undefined): number | undefined {
	if (n == null || n === 0) return undefined;
	return Math.max(1, n);
}

/** Normalize a wall-clock timeout in seconds. undefined or 0 = unlimited, otherwise minimum 1. Non-finite → unlimited. */
export function normalizeTimeoutSeconds(s: number | undefined): number | undefined {
	if (s == null || !Number.isFinite(s) || s === 0) return undefined;
	return Math.max(1, s);
}
