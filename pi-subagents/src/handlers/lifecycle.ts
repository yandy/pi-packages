import type { EvictedSubagent } from "../lifecycle/subagent-manager";
import type { SessionContext } from "../types";

/**
 * Session lifecycle event handlers: session_start, session_before_switch, session_shutdown.
 *
 * Extracted from index.ts so each handler can be tested in isolation
 * with mocked narrow interfaces.
 */

/** Narrow manager interface — only the methods lifecycle handlers call. */
export interface LifecycleManager {
	clearCompleted(): void;
	abortAll(): void;
	dispose(): void;
	/** Repopulate evicted descriptors recovered from disk on session start. */
	restoreEvicted(descriptors: readonly EvictedSubagent[]): void;
}

/** Narrow runtime interface — only the methods lifecycle handlers call. */
export interface LifecycleRuntime {
	setSessionContext(ctx: SessionContext): void;
	clearSessionContext(): void;
}

/** Recovers evicted subagent descriptors from the parent session file. */
export type RecoverEvicted = (parentSessionFile: string | undefined) => EvictedSubagent[];

/**
 * Handles session lifecycle events.
 *
 * Constructor deps:
 * - `runtime` — owns session context state
 * - `manager` — manages agent lifecycle (clear, abort, dispose, restore)
 * - `disposeNotifications` — tears down the notification system on shutdown
 * - `unpublishService` — unpublishes the SubagentsService symbol on shutdown
 * - `recoverEvicted` — rebuilds navigable descriptors from the parent session
 *   file so `/subagents:sessions` works after resume/fork (the extension is
 *   re-instantiated per session, so the in-memory evicted map starts empty)
 */
export class SessionLifecycleHandler {
	constructor(
		private readonly runtime: LifecycleRuntime,
		private readonly manager: LifecycleManager,
		private readonly disposeNotifications: () => void,
		private readonly unpublishService: () => void,
		private readonly recoverEvicted: RecoverEvicted,
	) {}

	handleSessionStart(_event: unknown, ctx: unknown): void {
		const sessionCtx = ctx as SessionContext;
		this.runtime.setSessionContext(sessionCtx);
		this.manager.clearCompleted();
		// Re-discover persisted subagent sessions from the parent session file so
		// they remain viewable after resume/fork (the in-memory map starts empty).
		this.manager.restoreEvicted(this.recoverEvicted(sessionCtx.sessionManager?.getSessionFile()));
	}

	handleSessionBeforeSwitch(): void {
		this.manager.clearCompleted();
	}

	// Cleanup order matters:
	// 1. Unpublish service — prevent new cross-extension calls
	// 2. Clear session context — no more session state
	// 3. Abort all agents — stop running work
	// 4. Dispose notifications — cancel pending nudges/timers
	// 5. Dispose manager — final cleanup
	handleSessionShutdown(): Promise<void> {
		this.unpublishService();
		this.runtime.clearSessionContext();
		this.manager.abortAll();
		this.disposeNotifications();
		this.manager.dispose();
		return Promise.resolve();
	}
}
