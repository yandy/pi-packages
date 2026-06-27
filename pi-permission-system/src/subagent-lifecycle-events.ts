/**
 * subagent-lifecycle-events.ts — Subscribe to @yandy0725/pi-subagents' child
 * lifecycle events and keep the SubagentSessionRegistry in sync.
 *
 * @yandy0725/pi-subagents publishes its child-execution lifecycle on the Pi
 * event bus (ADR 0002): it no longer calls this package's service directly.
 * We register the child on `session-created` and unregister it on `disposed`.
 *
 * The channel names and payload shapes are declared independently here (the two
 * packages must not depend on each other under jiti) and MUST match the
 * publisher in `@yandy0725/pi-subagents` (`src/lifecycle/child-lifecycle.ts`).
 *
 * The `session-created` handler MUST stay synchronous: the core emits it on the
 * same synchronous call stack immediately before `bindExtensions()`, and the
 * event bus dispatches listeners synchronously, so a synchronous handler lands
 * the registry entry before binding proceeds. Introducing an `await` before
 * `registry.register(...)` would break the pre-bind ordering.
 */

import type { SubagentSessionRegistry } from "./subagent-registry";

/** Emitted by the core after session creation, before `bindExtensions()`. */
export const SUBAGENT_CHILD_SESSION_CREATED = "subagents:child:session-created";

/** Emitted by the core in the run's `finally` (success and error). */
export const SUBAGENT_CHILD_DISPOSED = "subagents:child:disposed";

/** Minimal event-bus surface this module needs (subscribe only). */
interface LifecycleEventBus {
  on(channel: string, handler: (data: unknown) => void): () => void;
}

/** Fields read from the `session-created` payload (ISP). */
interface ChildSessionCreatedEvent {
  /** Child session id — the registry key. Must match the publisher. */
  sessionId: string;
  parentSessionId?: string;
}

/** Fields read from the `disposed` payload (ISP). */
interface ChildDisposedEvent {
  /** Child session id — the registry key. Must match the publisher. */
  sessionId: string;
}

/**
 * Subscribe to the subagent child lifecycle.
 *
 * @returns an unsubscribe that detaches both handlers (call during
 *          `session_shutdown`).
 */
export function subscribeSubagentLifecycle(
  events: LifecycleEventBus,
  registry: SubagentSessionRegistry,
): () => void {
  const unsubCreated = events.on(SUBAGENT_CHILD_SESSION_CREATED, (data) => {
    const event = data as ChildSessionCreatedEvent;
    registry.register(event.sessionId, {
      parentSessionId: event.parentSessionId,
    });
  });

  const unsubDisposed = events.on(SUBAGENT_CHILD_DISPOSED, (data) => {
    const event = data as ChildDisposedEvent;
    registry.unregister(event.sessionId);
  });

  return () => {
    unsubCreated();
    unsubDisposed();
  };
}
