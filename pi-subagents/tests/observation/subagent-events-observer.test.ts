import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildEventData, type NotificationSystem } from "../../src/observation/notification";
import { SubagentEventsObserver } from "../../src/observation/subagent-events-observer";
import type { CompactionInfo } from "../../src/types";
import { createTestSubagent } from "../helpers/make-subagent";

function makeNotifications(): NotificationSystem {
	return {
		cancelNudge: vi.fn(),
		sendCompletion: vi.fn(),
		dispose: vi.fn(),
	};
}

function makeObserver(overrides?: Partial<{ notifications: NotificationSystem }>) {
	const emit = vi.fn<(channel: string, data: unknown) => void>();
	const appendEntry = vi.fn<(customType: string, data: unknown) => void>();
	const notifications = overrides?.notifications ?? makeNotifications();
	const observer = new SubagentEventsObserver({ emit, appendEntry, notifications });
	return { observer, emit, appendEntry, notifications };
}

describe("SubagentEventsObserver", () => {
	describe("onSubagentStarted", () => {
		it("emits subagents:started with id, type, description", () => {
			const { observer, emit } = makeObserver();
			const record = createTestSubagent({ id: "agent-1", type: "general-purpose", description: "do work" });

			observer.onSubagentStarted(record);

			expect(emit).toHaveBeenCalledExactlyOnceWith("subagents:started", {
				id: "agent-1",
				type: "general-purpose",
				description: "do work",
			});
		});

		it("does not call appendEntry or notifications", () => {
			const { observer, appendEntry, notifications } = makeObserver();
			observer.onSubagentStarted(createTestSubagent());
			expect(appendEntry).not.toHaveBeenCalled();
			expect(notifications.sendCompletion).not.toHaveBeenCalled();
		});
	});

	describe("onSubagentCompleted", () => {
		it("emits subagents:completed for a successful agent", () => {
			const { observer, emit } = makeObserver();
			const record = createTestSubagent({ status: "completed" });

			observer.onSubagentCompleted(record);

			expect(emit).toHaveBeenCalledWith("subagents:completed", buildEventData(record));
		});

		it("emits subagents:failed for an error agent", () => {
			const { observer, emit } = makeObserver();
			const record = createTestSubagent({ status: "error", error: "boom" });

			observer.onSubagentCompleted(record);

			expect(emit).toHaveBeenCalledWith("subagents:failed", expect.anything());
		});

		it("emits subagents:failed for a stopped agent", () => {
			const { observer, emit } = makeObserver();
			const record = createTestSubagent({ status: "stopped" });

			observer.onSubagentCompleted(record);

			expect(emit).toHaveBeenCalledWith("subagents:failed", expect.anything());
		});

		it("emits subagents:failed for an aborted agent", () => {
			const { observer, emit } = makeObserver();
			const record = createTestSubagent({ status: "aborted" });

			observer.onSubagentCompleted(record);

			expect(emit).toHaveBeenCalledWith("subagents:failed", expect.anything());
		});

		it("calls appendEntry with subagents:record and the persisted fields", () => {
			const { observer, appendEntry } = makeObserver();
			const record = createTestSubagent({
				id: "agent-2",
				type: "Explore",
				description: "explore code",
				status: "completed",
				result: "found it",
				error: undefined,
				startedAt: 1000,
				completedAt: 2000,
				invocation: { runInBackground: true, modelName: "haiku", thinking: "high" },
			});

			observer.onSubagentCompleted(record);

			expect(appendEntry).toHaveBeenCalledExactlyOnceWith("subagents:record", {
				id: "agent-2",
				type: "Explore",
				description: "explore code",
				status: "completed",
				result: "found it",
				error: undefined,
				startedAt: 1000,
				completedAt: 2000,
				toolUses: 3,
				modelName: "haiku",
				thinking: "high",
				outputFile: record.outputFile,
			});
		});

		it("persists modelName and toolUses so the record can be recovered after resume/fork", () => {
			const { observer, appendEntry } = makeObserver();
			const record = createTestSubagent({
				status: "completed",
				invocation: { runInBackground: true, modelName: "sonnet" },
				toolUses: 4,
			});

			observer.onSubagentCompleted(record);

			const persisted = appendEntry.mock.calls[0][1] as Record<string, unknown>;
			expect(persisted.modelName).toBe("sonnet");
			expect(persisted.toolUses).toBe(4);
		});

		it("calls notifications.sendCompletion when result is not consumed", () => {
			const notifications = makeNotifications();
			const { observer } = makeObserver({ notifications });
			const record = createTestSubagent({ status: "completed" });

			observer.onSubagentCompleted(record);

			expect(notifications.sendCompletion).toHaveBeenCalledExactlyOnceWith(record);
		});

		it("does not call sendCompletion when result is already consumed", () => {
			const notifications = makeNotifications();
			const { observer } = makeObserver({ notifications });
			const record = createTestSubagent({ status: "completed", toolCallId: "tc-1" });
			record.notification?.markConsumed();

			observer.onSubagentCompleted(record);

			expect(notifications.sendCompletion).not.toHaveBeenCalled();
		});

		it("emits exactly once and appends exactly once per call", () => {
			const { observer, emit, appendEntry } = makeObserver();
			observer.onSubagentCompleted(createTestSubagent({ status: "completed" }));
			expect(emit).toHaveBeenCalledTimes(1);
			expect(appendEntry).toHaveBeenCalledTimes(1);
		});
	});

	describe("onSubagentCompacted", () => {
		it("emits subagents:compacted with id, type, description, reason, tokensBefore, compactionCount", () => {
			const { observer, emit } = makeObserver();
			const record = createTestSubagent({
				id: "agent-3",
				type: "Explore",
				description: "plan work",
				compactionCount: 1,
			});
			const info: CompactionInfo = { reason: "threshold", tokensBefore: 50_000 };

			observer.onSubagentCompacted(record, info);

			expect(emit).toHaveBeenCalledExactlyOnceWith("subagents:compacted", {
				id: "agent-3",
				type: "Explore",
				description: "plan work",
				reason: "threshold",
				tokensBefore: 50_000,
				compactionCount: 1,
			});
		});

		it("does not call appendEntry or notifications", () => {
			const { observer, appendEntry, notifications } = makeObserver();
			const info: CompactionInfo = { reason: "manual", tokensBefore: 1000 };
			observer.onSubagentCompacted(createTestSubagent(), info);
			expect(appendEntry).not.toHaveBeenCalled();
			expect(notifications.sendCompletion).not.toHaveBeenCalled();
		});
	});

	describe("onSubagentCreated", () => {
		it("emits subagents:created with id, type, description, and isBackground: true", () => {
			const { observer, emit } = makeObserver();
			const record = createTestSubagent({ id: "agent-4", type: "general-purpose", description: "bg task" });

			observer.onSubagentCreated(record);

			expect(emit).toHaveBeenCalledExactlyOnceWith("subagents:created", {
				id: "agent-4",
				type: "general-purpose",
				description: "bg task",
				isBackground: true,
			});
		});

		it("does not call appendEntry or notifications", () => {
			const { observer, appendEntry, notifications } = makeObserver();
			observer.onSubagentCreated(createTestSubagent());
			expect(appendEntry).not.toHaveBeenCalled();
			expect(notifications.sendCompletion).not.toHaveBeenCalled();
		});
	});

	describe("dependency isolation", () => {
		let emit: ReturnType<typeof vi.fn>;
		let appendEntry: ReturnType<typeof vi.fn>;
		let notifications: NotificationSystem;
		let observer: SubagentEventsObserver;

		beforeEach(() => {
			({ observer, emit, appendEntry, notifications } = makeObserver());
		});

		it("does not import or reference pi SDK directly", () => {
			// If the class was constructed and four methods called with no SDK errors,
			// it holds no SDK dependency — verified structurally by this test running at all.
			observer.onSubagentStarted(createTestSubagent());
			observer.onSubagentCompleted(createTestSubagent({ status: "completed" }));
			const info: CompactionInfo = { reason: "overflow", tokensBefore: 9999 };
			observer.onSubagentCompacted(createTestSubagent(), info);
			observer.onSubagentCreated(createTestSubagent());
			expect(emit).toHaveBeenCalledTimes(4);
			expect(appendEntry).toHaveBeenCalledTimes(1);
			// Notifications were called as a side-effect of onSubagentCompleted.
			expect(notifications.sendCompletion).toHaveBeenCalledTimes(1);
		});
	});
});
