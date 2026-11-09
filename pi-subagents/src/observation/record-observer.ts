/**
 * record-observer.ts — The single interpreter of raw session events for live
 * state: accumulates SubagentState stats, drives `streamingMessage`, and is the
 * single change notifier.
 *
 * Replaces the scattered callback-wrapping logic in SubagentManager's startAgent()
 * and resume() with a single direct subscription. The observer targets the
 * SubagentState value object directly, so it carries no dependency on Subagent;
 * the caller forwards itself to its own lifecycle observer via onCompact.
 */

import type { SubagentState } from "../lifecycle/subagent-state";
import type { CompactionInfo, SubscribableSession } from "../types";

export interface SubagentObserverOptions {
	onCompact?: (info: CompactionInfo) => void;
	/** Called after every event's state mutation, so consumers always read post-mutation state. */
	onChange?: () => void;
}

/**
 * Subscribe to session events and accumulate stats on the subagent state.
 *
 * Handles:
 * - `tool_execution_start` → `state.addActiveTool(name)`
 * - `tool_execution_end` → `state.removeActiveTool(name)`, `state.incrementToolUses()`
 * - `message_start` → `state.setStreamingMessage(assistant ? message : undefined)`
 * - `message_update` → `state.setStreamingMessage(message)` (assistant only)
 * - `message_end` → `state.setStreamingMessage(undefined)`, `state.addUsage(…)` (assistant, with usage)
 * - `turn_end` → `state.incrementTurnCount()`
 * - `compaction_end` (not aborted) → `state.incrementCompactions()`, call `onCompact`
 *
 * @returns An unsubscribe function.
 */
export function subscribeSubagentObserver(
	session: SubscribableSession,
	state: SubagentState,
	options?: SubagentObserverOptions,
): () => void {
	return session.subscribe((event) => {
		if (event.type === "tool_execution_start") {
			state.addActiveTool(event.toolName);
		}

		if (event.type === "tool_execution_end") {
			state.removeActiveTool(event.toolName);
			state.incrementToolUses();
		}

		if (event.type === "message_start") {
			state.setStreamingMessage(event.message.role === "assistant" ? event.message : undefined);
		}

		if (event.type === "message_update" && event.message.role === "assistant") {
			state.setStreamingMessage(event.message);
		}

		if (event.type === "message_end") {
			state.setStreamingMessage(undefined);
		}

		if (event.type === "turn_end") {
			state.incrementTurnCount();
		}

		if (event.type === "message_end" && event.message.role === "assistant") {
			const u = event.message.usage;
			state.addUsage({
				input: u.input,
				output: u.output,
				cacheWrite: u.cacheWrite,
			});
		}

		if (event.type === "compaction_end" && !event.aborted && event.result) {
			state.incrementCompactions();
			options?.onCompact?.({
				reason: event.reason,
				tokensBefore: event.result.tokensBefore,
			});
		}

		options?.onChange?.();
	});
}
