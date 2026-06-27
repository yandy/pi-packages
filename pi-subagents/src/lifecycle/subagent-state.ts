/**
 * subagent-state.ts — SubagentState value object: lifecycle status, metrics, and live activity.
 *
 * Owns the passive, readable state of a subagent — status, result, error,
 * timestamps, stats (toolUses, lifetimeUsage, compactionCount), and live-activity
 * fields (turnCount, activeTools, responseText) — together with the transition
 * methods (markRunning, markCompleted, …), accumulation methods
 * (incrementToolUses, addUsage, incrementCompactions), and live-activity
 * transition methods (incrementTurnCount, addActiveTool, removeActiveTool,
 * resetResponseText, appendResponseText) that mutate them.
 *
 * State is encapsulated behind getters; external code reads through them but
 * mutates only via the transition/accumulation methods. The value object owns
 * all of its own mutations — no field is written from outside.
 *
 * Subagent holds one of these privately and delegates its getters and mutation
 * methods to it. Extracting it lets the lifecycle state machine and the
 * session-event observer be unit-tested without constructing an executor.
 */

import type { LifetimeUsage } from "../lifecycle/usage";
import { addUsage } from "../lifecycle/usage";

export type SubagentStatus =
	| "queued"
	| "running"
	| "completed"
	| "steered"
	| "aborted"
	| "stopped"
	| "error";

export interface SubagentStateInit {
	status?: SubagentStatus;
	result?: string;
	error?: string;
	startedAt?: number;
	completedAt?: number;
}

export class SubagentState {
	// Transition state — encapsulated behind getters, mutated only via transition methods
	private _status: SubagentStatus;
	get status(): SubagentStatus { return this._status; }

	private _result?: string;
	get result(): string | undefined { return this._result; }

	private _error?: string;
	get error(): string | undefined { return this._error; }

	private _startedAt: number;
	get startedAt(): number { return this._startedAt; }

	private _completedAt?: number;
	get completedAt(): number | undefined { return this._completedAt; }

	// Stats — accumulated via mutation methods, readable via getters
	private _toolUses = 0;
	get toolUses(): number { return this._toolUses; }

	private _lifetimeUsage: LifetimeUsage = { input: 0, output: 0, cacheWrite: 0 };
	get lifetimeUsage(): Readonly<LifetimeUsage> { return this._lifetimeUsage; }

	private _compactionCount = 0;
	get compactionCount(): number { return this._compactionCount; }

	// Live activity — accumulated via transition methods, readable via getters
	private _turnCount = 1;
	get turnCount(): number { return this._turnCount; }

	private _activeTools = new Map<string, string>();
	get activeTools(): ReadonlyMap<string, string> { return this._activeTools; }

	private _toolKeySeq = 0;

	private _responseText = "";
	get responseText(): string { return this._responseText; }

	constructor(init: SubagentStateInit = {}) {
		this._status = init.status ?? "queued";
		this._result = init.result;
		this._error = init.error;
		this._startedAt = init.startedAt ?? Date.now();
		this._completedAt = init.completedAt;
	}

	/** Increment tool use count. Called by record-observer on tool_execution_end. */
	incrementToolUses(): void {
		this._toolUses++;
	}

	/** Accumulate a usage delta into lifetimeUsage. Called by record-observer on message_end. */
	addUsage(delta: { input: number; output: number; cacheWrite: number }): void {
		addUsage(this._lifetimeUsage, delta);
	}

	/** Increment compaction count. Called by record-observer on compaction_end. */
	incrementCompactions(): void {
		this._compactionCount++;
	}

	/** Record a turn boundary. Called by record-observer on turn_end. */
	incrementTurnCount(): void {
		this._turnCount++;
	}

	/** Record a tool starting. Called by record-observer on tool_execution_start. */
	addActiveTool(toolName: string): void {
		this._activeTools.set(toolName + "_" + (++this._toolKeySeq), toolName);
	}

	/** Remove one active tool by name (first match). Called by record-observer on tool_execution_end. */
	removeActiveTool(toolName: string): void {
		for (const [key, name] of this._activeTools) {
			if (name === toolName) {
				this._activeTools.delete(key);
				break;
			}
		}
	}

	/** Reset the current response text. Called by record-observer on message_start. */
	resetResponseText(): void {
		this._responseText = "";
	}

	/** Append a text delta to the current response text. Called by record-observer on message_update. */
	appendResponseText(delta: string): void {
		this._responseText += delta;
	}

	/** Transition to running state. Sets status and startedAt. */
	markRunning(startedAt: number): void {
		this._status = "running";
		this._startedAt = startedAt;
	}

	/**
	 * Transition to completed state.
	 * Always sets result and completedAt (??=). Only changes status if not stopped.
	 */
	markCompleted(result: string, completedAt?: number): void {
		this._result = result;
		this._completedAt ??= completedAt ?? Date.now();
		if (this._status !== "stopped") {
			this._status = "completed";
		}
	}

	/**
	 * Transition to aborted state.
	 * Always sets result and completedAt (??=). Only changes status if not stopped.
	 */
	markAborted(result: string, completedAt?: number): void {
		this._result = result;
		this._completedAt ??= completedAt ?? Date.now();
		if (this._status !== "stopped") {
			this._status = "aborted";
		}
	}

	/**
	 * Transition to steered state.
	 * Always sets result and completedAt (??=). Only changes status if not stopped.
	 */
	markSteered(result: string, completedAt?: number): void {
		this._result = result;
		this._completedAt ??= completedAt ?? Date.now();
		if (this._status !== "stopped") {
			this._status = "steered";
		}
	}

	/**
	 * Transition to error state.
	 * Always sets error (formatted) and completedAt (??=). Only changes status if not stopped.
	 */
	markError(error: unknown, completedAt?: number): void {
		this._error = error instanceof Error ? error.message : String(error);
		this._completedAt ??= completedAt ?? Date.now();
		if (this._status !== "stopped") {
			this._status = "error";
		}
	}

	/** Transition to stopped state. Always valid — no guard. */
	markStopped(completedAt?: number): void {
		this._status = "stopped";
		this._completedAt = completedAt ?? Date.now();
	}

	/** Reset for resume: running status, new startedAt, clear completedAt/result/error. */
	resetForResume(startedAt: number): void {
		this._status = "running";
		this._startedAt = startedAt;
		this._completedAt = undefined;
		this._result = undefined;
		this._error = undefined;
	}
}
