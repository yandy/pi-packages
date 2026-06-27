import type { CreateSubagentSessionParams } from "../../src/lifecycle/create-subagent-session";
import { Subagent, type SubagentExecution } from "../../src/lifecycle/subagent";
import type { SubagentSession } from "../../src/lifecycle/subagent-session";
import { SubagentState, type SubagentStatus } from "../../src/lifecycle/subagent-state";
import type { AgentInvocation, SubagentType } from "../../src/types";
import { createSubagentSessionStub, toSubagentSession } from "../helpers/mock-session";
import { STUB_SNAPSHOT } from "../helpers/stub-ctx";

/**
 * A minimal, mandatory SubagentExecution for tests that build a passive record
 * and never call run(). The factory resolves to a default session stub.
 */
export function makeStubExecution(overrides: Partial<SubagentExecution> = {}): SubagentExecution {
	return {
		createSubagentSession: async (_params: CreateSubagentSessionParams): Promise<SubagentSession> =>
			toSubagentSession(createSubagentSessionStub()),
		snapshot: STUB_SNAPSHOT,
		prompt: "do something",
		baseCwd: "",
		...overrides,
	};
}

export interface TestSubagentOptions {
	id?: string;
	type?: SubagentType;
	description?: string;
	invocation?: AgentInvocation;
	execution?: SubagentExecution;
	/** Shorthand to wire a NotificationState via the constructor path. Ignored when execution is supplied. */
	toolCallId?: string;
	/** Passive lifecycle state shorthands. */
	status?: SubagentStatus;
	result?: string;
	error?: string;
	startedAt?: number;
	completedAt?: number;
	/** Set toolUses via incrementToolUses(). */
	toolUses?: number;
	/** Set lifetimeUsage via addUsage(). */
	lifetimeUsage?: { input: number; output: number; cacheWrite: number };
	/** Set compactionCount via incrementCompactions(). */
	compactionCount?: number;
	/**
	 * Set turnCount. Starts at 1; pass a higher value to simulate multiple turns.
	 * Ignored when `execution` is supplied (maxTurns lives on the execution, not state).
	 */
	turnCount?: number;
	/** Seed active tools by name — each entry calls addActiveTool(name). */
	activeTools?: string[];
	/** Seed responseText via appendResponseText(). */
	responseText?: string;
	/** Thread maxTurns into the stub execution. Ignored when `execution` is supplied. */
	maxTurns?: number;
}

export function createTestSubagent(overrides: TestSubagentOptions = {}): Subagent {
	const {
		id,
		type,
		description,
		invocation,
		execution,
		toolCallId,
		toolUses,
		lifetimeUsage,
		compactionCount,
		turnCount,
		activeTools,
		responseText,
		maxTurns,
		...stateOverrides
	} = overrides;
	const state = new SubagentState({
		status: "completed",
		result: "All done.",
		startedAt: 1000,
		completedAt: 2000,
		...stateOverrides,
	});
	const record = new Subagent({
		id: id ?? "agent-1",
		type: type ?? "general-purpose",
		description: description ?? "Test task",
		invocation,
		execution:
			execution ??
			makeStubExecution({
				...(toolCallId ? { parentSession: { toolCallId } } : {}),
				...(maxTurns !== undefined ? { maxTurns } : {}),
			}),
		state,
	});
	// Apply stat overrides via mutation methods
	if (toolUses !== undefined) {
		for (let i = 0; i < toolUses; i++) record.incrementToolUses();
	} else {
		// Factory default: 3 tool uses
		for (let i = 0; i < 3; i++) record.incrementToolUses();
	}
	if (lifetimeUsage !== undefined) {
		record.addUsage(lifetimeUsage);
	} else {
		// Factory default
		record.addUsage({ input: 500, output: 500, cacheWrite: 0 });
	}
	if (compactionCount !== undefined) {
		for (let i = 0; i < compactionCount; i++) record.incrementCompactions();
	}
	// Live-activity shorthands — drive SubagentState directly (not exposed on Subagent)
	if (turnCount !== undefined && turnCount > 1) {
		for (let i = 1; i < turnCount; i++) state.incrementTurnCount();
	}
	if (activeTools !== undefined) {
		for (const name of activeTools) state.addActiveTool(name);
	}
	if (responseText !== undefined) {
		state.appendResponseText(responseText);
	}
	return record;
}
