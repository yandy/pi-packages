/**
 * service.ts — Public API surface for cross-extension access to subagents.
 *
 * Consumers declare this package as an optional peer dependency and use
 * dynamic import to access the accessor functions:
 *
 *   const { getSubagentsService } = await import("@yandy0725/pi-subagents");
 *   const svc = getSubagentsService();
 *   svc?.spawn("Explore", "Check for stale TODOs");
 */

import type { SubagentStatus } from "../lifecycle/subagent";
import type { LifetimeUsage } from "../lifecycle/usage";

// SubagentStatus is defined in the lifecycle layer (single home) and re-exported
// here for the public API surface — mirrors the LifetimeUsage pattern.
export type { SubagentStatus } from "../lifecycle/subagent";
export type { LifetimeUsage };

/** Serializable snapshot of an agent's state — no live session objects. */
export interface SubagentRecord {
	id: string;
	type: string;
	description: string;
	status: SubagentStatus;
	result?: string;
	error?: string;
	toolUses: number;
	startedAt: number;
	completedAt?: number;
	lifetimeUsage: LifetimeUsage;
	compactionCount: number;
	/** Short display model name (always shown; falls back to parent model when unset). */
	modelName?: string;
}

/** Options for spawning an agent via the service. */
export interface SpawnOptions {
	description?: string;
	model?: string;
	maxTurns?: number;
	/** Hard wall-clock timeout in seconds (0/undefined = unlimited). Normalize before passing, or pass an already-normalized value. */
	timeoutSeconds?: number;
	thinkingLevel?: string;
	inheritContext?: boolean;
	foreground?: boolean;
	bypassQueue?: boolean;
}

/** The public service contract for cross-extension subagent access. */
export interface SubagentsService {
	/** Spawn an agent. Returns the agent ID immediately. */
	spawn(type: string, prompt: string, options?: SpawnOptions): string;

	/** Get a snapshot of an agent's current state. */
	getRecord(id: string): SubagentRecord | undefined;

	/** List all tracked agents, most recent first. */
	listAgents(): SubagentRecord[];

	/** Abort a running or queued agent. Returns false if not found. */
	abort(id: string): boolean;

	/** Send a steering message to a running agent. */
	steer(id: string, message: string): Promise<boolean>;

	/** Wait for all running and queued agents to complete. */
	waitForAll(): Promise<void>;

	/** Whether any agents are running or queued. */
	hasRunning(): boolean;

}

/** Event channel constants for pi.events subscriptions. */
export const SUBAGENT_EVENTS = {
	STARTED: "subagents:started",
	COMPLETED: "subagents:completed",
	FAILED: "subagents:failed",
	COMPACTED: "subagents:compacted",
	CREATED: "subagents:created",
	STEERED: "subagents:steered",
} as const;

// ---- Accessor functions ----

const SERVICE_KEY = Symbol.for("@yandy0725/pi-subagents:service");

/** Publish the SubagentsService on globalThis for cross-extension access. */
export function publishSubagentsService(service: SubagentsService): void {
	(globalThis as Record<symbol, unknown>)[SERVICE_KEY] = service;
}

/** Retrieve the published SubagentsService, or undefined if not yet published. */
export function getSubagentsService(): SubagentsService | undefined {
	return (globalThis as Record<symbol, unknown>)[SERVICE_KEY] as SubagentsService | undefined;
}

/** Remove the SubagentsService from globalThis (call on shutdown/reload). */
export function unpublishSubagentsService(): void {
	// eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- Symbol-keyed global property; Map.delete() is not applicable
	delete (globalThis as Record<symbol, unknown>)[SERVICE_KEY];
}
