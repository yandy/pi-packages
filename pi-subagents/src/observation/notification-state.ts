/**
 * notification-state.ts — NotificationState: notification-scoped tracking per background agent.
 *
 * Constructed once when agent-tool assigns the tool call ID (background agents only).
 * Foreground agents never get a NotificationState — record.notification stays undefined.
 */

export class NotificationState {
	/** The tool call ID that spawned this background agent. Used in task-notification XML. */
	readonly toolCallId: string;

	private _resultConsumed = false;

	constructor(toolCallId: string) {
		this.toolCallId = toolCallId;
	}

	/** Whether the parent agent has already consumed this result (suppresses duplicate notifications). */
	get resultConsumed(): boolean {
		return this._resultConsumed;
	}

	/** Mark the result as consumed — suppresses the completion notification. */
	markConsumed(): void {
		this._resultConsumed = true;
	}
}
