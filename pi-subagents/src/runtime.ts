/**
 * runtime.ts — SubagentRuntime: composition root for all mutable extension state.
 *
 * Eliminates module-scope state in agent-runner.ts and closure-scoped state
 * in index.ts by consolidating them into a single, testable object.
 * Follows the same pattern as pi-permission-system's ExtensionRuntime.
 */

import { buildParentSnapshot, type ParentSnapshot } from "./lifecycle/parent-snapshot";
import type { ModelInfo } from "./tools/spawn-config";
import type { SessionContext } from "./types";

/**
 * Narrow config subset read by Agent when driving the turn loop (defaultMaxTurns, graceTurns).
 * Kept separate so callers can satisfy it without depending on the full runtime.
 */
export interface RunConfig {
  readonly defaultMaxTurns: number | undefined;
  readonly graceTurns: number;
}

/**
 * All mutable state owned by the pi-subagents extension.
 *
 * Created once inside `piSubagentsExtension()` via `createSubagentRuntime()`.
 * Tests construct a fresh runtime per test for full isolation.
 */
export class SubagentRuntime {
  // ── Session state (was closure-scoped in index.ts) ───────────────────────
  /** Active Pi session context — set on session_start, cleared on session_shutdown. */
  currentCtx: SessionContext | undefined = undefined;

  // ── Session-context methods ──────────────────────────────────────────────

  /** Store the active Pi session context (called from session_start). */
  setSessionContext(ctx: SessionContext): void {
    this.currentCtx = ctx;
  }

  /** Clear the session context (called from session_shutdown). */
  clearSessionContext(): void {
    this.currentCtx = undefined;
  }

  /**
   * Build a parent snapshot from the current session context.
   * Only valid during an active session (currentCtx is defined).
   */
  buildSnapshot(inheritContext: boolean): ParentSnapshot {

    return buildParentSnapshot(this.currentCtx!, inheritContext);
  }

  /** Extract model info from the current session context. */
  getModelInfo(): ModelInfo {
    return {
      parentModel: this.currentCtx?.model as ModelInfo["parentModel"],
      modelRegistry: this.currentCtx?.modelRegistry,
    };
  }

  /** Extract session identity from the current session context. */
  getSessionInfo(): { parentSessionFile: string; parentSessionId: string } {
    return {
      parentSessionFile: this.currentCtx?.sessionManager.getSessionFile() ?? "",
      parentSessionId: this.currentCtx?.sessionManager.getSessionId() ?? "",
    };
  }
}

/**
 * Create a fully-initialized SubagentRuntime with default values.
 *
 * Call once at extension startup; pass the result to factories and handlers.
 */
export function createSubagentRuntime(): SubagentRuntime {
  return new SubagentRuntime();
}
