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
}

/** Narrow runtime interface — only the methods lifecycle handlers call. */
export interface LifecycleRuntime {
  setSessionContext(ctx: SessionContext): void;
  clearSessionContext(): void;
}

/**
 * Handles session lifecycle events.
 *
 * Constructor deps:
 * - `runtime` — owns session context state
 * - `manager` — manages agent lifecycle (clear, abort, dispose)
 * - `disposeNotifications` — tears down the notification system on shutdown
 * - `unpublishService` — unpublishes the SubagentsService symbol on shutdown
 */
export class SessionLifecycleHandler {
  constructor(
    private readonly runtime: LifecycleRuntime,
    private readonly manager: LifecycleManager,
    private readonly disposeNotifications: () => void,
    private readonly unpublishService: () => void,
  ) {}

  handleSessionStart(_event: unknown, ctx: unknown): void {
    this.runtime.setSessionContext(ctx as SessionContext);
    this.manager.clearCompleted();
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
