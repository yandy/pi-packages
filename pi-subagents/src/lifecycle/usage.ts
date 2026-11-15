/** usage.ts — Token usage: shapes, accumulator operators, session-stats readers. */

import type { Usage } from "@earendil-works/pi-ai";

/**
 * Lifetime usage components, accumulated via `message_end` events. Survives
 * compaction (which replaces session.state.messages and would reset any
 * stats-derived sum). cacheRead is excluded because each turn's cacheRead is
 * the cumulative cached prefix re-read on that one call — summing across
 * turns counts the prefix N times. See issue #38.
 */
export type LifetimeUsage = { input: number; output: number; cacheWrite: number };

/** Sum of lifetime usage components, or 0 if undefined. */
export function getLifetimeTotal(u?: LifetimeUsage): number {
	return u ? u.input + u.output + u.cacheWrite : 0;
}

/** Add a usage delta into a target accumulator (mutates target). */
export function addUsage(into: LifetimeUsage, delta: LifetimeUsage): void {
	into.input += delta.input;
	into.output += delta.output;
	into.cacheWrite += delta.cacheWrite;
}

/** Minimal shape we read from upstream `getSessionStats()`. */
export type SessionStatsLike = {
	tokens: { input: number; output: number; cacheWrite: number };
	contextUsage?: { percent: number | null };
};
export type SessionLike = { getSessionStats(): SessionStatsLike };

/**
 * Session-scoped token count: input + output + cacheWrite as reported by
 * upstream `getSessionStats().tokens` for the *current* session window.
 *
 * RESETS at compaction — upstream replaces `session.state.messages` and the
 * stats are derived from that array. For a lifetime total that survives
 * compaction, use `getLifetimeTotal(lifetimeUsage)` instead, which reads
 * from an independent accumulator fed by `message_end` events.
 *
 * Avoids upstream's `tokens.total` field, which sums per-turn `cacheRead`
 * and so counts the cumulative cached prefix N times across N turns
 * (issue #38).
 */
export function getSessionTokens(session: SessionLike | undefined): number {
	if (!session) return 0;
	try {
		const t = session.getSessionStats().tokens;
		return t.input + t.output + t.cacheWrite;
	} catch {
		return 0;
	}
}

/**
 * Context-window utilization (0–100), or null when unavailable
 * (no model contextWindow, or post-compaction before the next response).
 */
export function getSessionContextPercent(session: SessionLike | undefined): number | null {
	if (!session) return null;
	try {
		return session.getSessionStats().contextUsage?.percent ?? null;
	} catch {
		return null;
	}
}

// ── Session usage snapshots (cost settle) ─────────────────────────────────────

/**
 * Point-in-time totals of one child session, mapped from upstream
 * `getSessionStats()`: the same accounting basis the parent footer uses for
 * itself (assistant/toolResult/usage-entry/compaction usage, compaction-safe).
 * Cost settle computes field-wise deltas between two snapshots.
 */
export interface SessionUsageSnapshot {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

/** Field-wise `current - last`; `last === undefined` → a copy of `current`. */
export function usageDelta(current: SessionUsageSnapshot, last?: SessionUsageSnapshot): SessionUsageSnapshot {
	if (!last) return { ...current };
	return {
		input: current.input - last.input,
		output: current.output - last.output,
		cacheRead: current.cacheRead - last.cacheRead,
		cacheWrite: current.cacheWrite - last.cacheWrite,
		totalTokens: current.totalTokens - last.totalTokens,
		cost: current.cost - last.cost,
	};
}

/** True iff every field of the snapshot is 0 (nothing to report). */
export function snapshotIsZero(s: SessionUsageSnapshot): boolean {
	return (
		s.input === 0 &&
		s.output === 0 &&
		s.cacheRead === 0 &&
		s.cacheWrite === 0 &&
		s.totalTokens === 0 &&
		s.cost === 0
	);
}

/**
 * Map a snapshot onto the pi-ai `Usage` shape for `appendUsage`. Token fields
 * are real; the per-category cost split is zero-filled because the source is
 * a scalar — downstream consumers (`addUsageToTotals`, `getUsageCostBreakdown`,
 * TUI) read only `cost.total` and the token fields.
 */
export function toUsageEntryUsage(s: SessionUsageSnapshot): Usage {
	return {
		input: s.input,
		output: s.output,
		cacheRead: s.cacheRead,
		cacheWrite: s.cacheWrite,
		totalTokens: s.totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: s.cost },
	};
}

/**
 * Narrow write-side of the parent session's `SessionManager` for cost settle.
 * The extension ctx type omits `appendUsage` (ReadonlySessionManager), so the
 * runtime object is feature-detected against this shape at the wiring point.
 */
export interface UsageSink {
	appendUsage(kind: string, provider: string, model: string, usage: Usage, note?: string): unknown;
}
