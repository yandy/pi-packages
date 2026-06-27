/**
 * turn_start event handler that aborts subagents on a parent interrupt (ESC).
 *
 * The parent agent loop creates a fresh AbortController per run and only aborts
 * it on an explicit interrupt — never on normal completion. So latching to the
 * current run's signal and aborting on its `abort` event fires exactly on ESC.
 *
 * `turn_start` carries the live per-run `ctx.signal`, so re-latching each turn
 * keeps the handler tracking the current signal across runs and tool-less turns.
 */

/** Narrow manager interface — only the method the interrupt handler calls. */
export interface InterruptManager {
  abortAll(): number;
}

/** Minimal context shape — only the field the handler reads. */
interface InterruptCtx {
  signal: AbortSignal | undefined;
}

/**
 * Latches the current parent abort signal and aborts all subagents when it fires.
 *
 * The latch dedups by reference: most turns reuse the same signal (no-op); a new
 * run's signal triggers a detach-and-rewire. The `abort` listener is one-shot.
 */
export class InterruptHandler {
  private latched?: AbortSignal;
  private detach?: () => void;

  constructor(private readonly manager: InterruptManager) {}

  handleTurnStart(ctx: InterruptCtx): void {
    const signal = ctx.signal;
    if (signal === this.latched) return;

    this.detach?.();
    this.detach = undefined;
    this.latched = signal;
    if (!signal) return;

    const onAbort = (): void => {
      this.manager.abortAll();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    this.detach = () => signal.removeEventListener("abort", onAbort);
  }
}
