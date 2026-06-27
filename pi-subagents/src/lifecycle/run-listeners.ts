/**
 * run-listeners.ts — Per-run observer-unsubscribe and signal-detach handles.
 *
 * Owns the two teardown handles that a Subagent wires at run start (signal
 * listener) and after session creation (record-observer unsub), releasing
 * both atomically when the run ends or the agent is resumed.
 */

/** Owns the per-run observer-unsubscribe and signal-detach handles. */
export class RunListeners {
	private unsub?: () => void;
	private detach?: () => void;

	/**
	 * Wire a parent AbortSignal so it triggers onAbort when fired.
	 * No-op when signal is undefined.
	 */
	wireSignal(signal: AbortSignal | undefined, onAbort: () => void): void {
		if (!signal) return;
		const listener = () => onAbort();
		signal.addEventListener("abort", listener, { once: true });
		this.detach = () => signal.removeEventListener("abort", listener);
	}

	/** Store the record-observer unsubscribe handle. */
	attachObserver(unsub: () => void): void {
		this.unsub = unsub;
	}

	/** Release the observer + signal handles. Idempotent. */
	release(): void {
		this.unsub?.();
		this.unsub = undefined;
		this.detach?.();
		this.detach = undefined;
	}
}
