/**
 * subagent-registry.ts — In-process subagent session registry.
 *
 * In-process subagent extensions (e.g. `@yandy0725/pi-subagents`) register
 * each child session here before calling `bindExtensions()` so that
 * `isSubagentExecutionContext()` and permission-forwarding target resolution
 * can detect them without relying on environment variables or filesystem
 * heuristics.
 *
 * The registry is keyed by the child's **session id**, which is unique per
 * child and available to both producer (via `sessionManager.getSessionId()`
 * after `newSession()` in `create-subagent-session.ts`) and consumer (via
 * `ctx.sessionManager.getSessionId()`). Two concurrent siblings of the same
 * parent therefore occupy distinct keys, so one sibling's `disposed` event
 * cannot evict the entry the others depend on.
 *
 * The single registry instance is stored on `globalThis` (via `Symbol.for()`)
 * so that the parent's permission-system instance (which registers children
 * on the parent's event bus) and each child's separate jiti instance (which
 * reads the registry to detect itself and resolve its forwarding target) share
 * one store across per-session event buses. See `getSubagentSessionRegistry()`.
 *
 * When a future code path needs the child's agent name, read it from
 * `tcc.agentName` (resolved from the `<active_agent>` system-prompt tag) —
 * not from this registry.
 */

/** Process-global key for the shared registry slot. */
const SUBAGENT_SESSION_REGISTRY_KEY = Symbol.for(
  "@yandy0725/pi-permission-system:subagent-registry",
);

/**
 * Return the process-global SubagentSessionRegistry, creating it on first call.
 *
 * Backed by `globalThis` + `Symbol.for()` so the parent's permission-system
 * instance (which registers children on the parent event bus) and each child's
 * separate jiti instance (which reads the registry to detect itself and resolve
 * its forwarding target) share one store across per-session event buses.
 *
 * Intentionally has no shutdown/unpublish hook — a child's `session_shutdown`
 * must not be able to wipe the parent's registrations. Entries are added and
 * removed exclusively by the parent's `subagents:child:session-created` /
 * `subagents:child:disposed` subscription.
 */
export function getSubagentSessionRegistry(): SubagentSessionRegistry {
  const store = globalThis as Record<symbol, unknown>;
  const existing = store[SUBAGENT_SESSION_REGISTRY_KEY] as
    | SubagentSessionRegistry
    | undefined;
  if (existing) {
    return existing;
  }
  const registry = new SubagentSessionRegistry();
  store[SUBAGENT_SESSION_REGISTRY_KEY] = registry;
  return registry;
}

/** Signal stored per registered in-process subagent session. */
export interface SubagentSessionInfo {
  /** Parent session ID for permission forwarding. Omit when unknown. */
  parentSessionId?: string;
}

/**
 * Registry of active in-process subagent sessions.
 *
 * A process-global singleton — obtain it via `getSubagentSessionRegistry()`,
 * never `new` (see that accessor for why). Written exclusively by
 * `subscribeSubagentLifecycle` via the `subagents:child:session-created` /
 * `subagents:child:disposed` event subscription (ADR 0002 — the core
 * publishes, consumers observe).
 *
 * Keyed by child session id. Each concurrent child of the same parent receives
 * a unique session id from `sessionManager.newSession()`, so siblings occupy
 * distinct keys and one sibling's `disposed` cannot evict another's entry.
 */
export class SubagentSessionRegistry {
  private readonly sessions = new Map<string, SubagentSessionInfo>();

  /**
   * Register an in-process subagent session.
   *
   * If a previous entry exists for `sessionId`, it is overwritten
   * (last-write-wins; single-writer expected per key).
   */
  register(sessionId: string, info: SubagentSessionInfo): void {
    this.sessions.set(sessionId, info);
  }

  /** Remove a previously registered session. No-op if the key is absent. */
  unregister(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Return the registered info for `sessionId`, or `undefined` if absent. */
  get(sessionId: string): SubagentSessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  /** Return `true` when `sessionId` has a registered entry. */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }
}
