import { debugLog } from "../debug";
import type { SubagentManagerObserver } from "../lifecycle/subagent-manager";
import type { CompactionInfo, Subagent } from "../types";

/**
 * Fans out SubagentManager lifecycle notifications to multiple observers.
 *
 * Lets the manager keep its single-observer contract while several independent
 * consumers (event/notification dispatch, the reactive widget) subscribe.
 * Each delegate is isolated: a throw in one does not suppress the others.
 */
export class CompositeSubagentObserver implements SubagentManagerObserver {
	private readonly delegates: SubagentManagerObserver[];

	constructor(delegates: SubagentManagerObserver[]) {
		this.delegates = [...delegates];
	}

	/** Register an additional observer (breaks the widget↔manager construction cycle). */
	add(observer: SubagentManagerObserver): void {
		this.delegates.push(observer);
	}

	onSubagentStarted(record: Subagent): void {
		this.dispatch((o) => o.onSubagentStarted(record), "onSubagentStarted");
	}

	onSubagentCreated(record: Subagent): void {
		this.dispatch((o) => o.onSubagentCreated(record), "onSubagentCreated");
	}

	onSubagentCompleted(record: Subagent): void {
		this.dispatch((o) => o.onSubagentCompleted(record), "onSubagentCompleted");
	}

	onSubagentCompacted(record: Subagent, info: CompactionInfo): void {
		this.dispatch((o) => o.onSubagentCompacted(record, info), "onSubagentCompacted");
	}

	private dispatch(call: (o: SubagentManagerObserver) => void, label: string): void {
		for (const o of this.delegates) {
			try {
				call(o);
			} catch (err) {
				debugLog(`CompositeSubagentObserver.${label}`, err);
			}
		}
	}
}
