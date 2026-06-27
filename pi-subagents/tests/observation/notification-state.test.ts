import { describe, expect, it } from "vitest";
import { NotificationState } from "../../src/observation/notification-state";

describe("NotificationState — constructor", () => {
	it("stores toolCallId", () => {
		const state = new NotificationState("call-abc-123");
		expect(state.toolCallId).toBe("call-abc-123");
	});

	it("resultConsumed starts false", () => {
		const state = new NotificationState("call-abc-123");
		expect(state.resultConsumed).toBe(false);
	});
});

describe("NotificationState — markConsumed", () => {
	it("sets resultConsumed to true", () => {
		const state = new NotificationState("call-xyz");
		state.markConsumed();
		expect(state.resultConsumed).toBe(true);
	});

	it("is idempotent — marking consumed twice stays true", () => {
		const state = new NotificationState("call-xyz");
		state.markConsumed();
		state.markConsumed();
		expect(state.resultConsumed).toBe(true);
	});

	it("toolCallId is unchanged after markConsumed", () => {
		const state = new NotificationState("call-xyz");
		state.markConsumed();
		expect(state.toolCallId).toBe("call-xyz");
	});
});
