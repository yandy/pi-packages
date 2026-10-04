import { describe, expect, it, vi } from "vitest";
import { createMockSession, emitResumeUsageAndCompaction } from "./mock-session";

describe("createMockSession", () => {
	it("supports multiple concurrent subscribers", () => {
		const session = createMockSession();
		const a: unknown[] = [];
		const b: unknown[] = [];
		session.subscribe((e) => a.push(e));
		session.subscribe((e) => b.push(e));
		session.emit({ type: "ping" });
		expect(a).toEqual([{ type: "ping" }]);
		expect(b).toEqual([{ type: "ping" }]);
	});

	it("unsubscribes when the returned disposer is called", () => {
		const session = createMockSession();
		const events: unknown[] = [];
		const unsubscribe = session.subscribe((e) => events.push(e));
		session.emit({ type: "before" });
		unsubscribe();
		session.emit({ type: "after" });
		expect(events).toEqual([{ type: "before" }]);
	});

	it("accepts overrides that replace default fields", async () => {
		const err = new Error("fail");
		const session = createMockSession({
			steer: vi.fn().mockRejectedValue(err),
		});
		await expect(session.steer("x")).rejects.toThrow("fail");
	});

	it("accepts overrides that add extra fields", () => {
		const session = createMockSession({ extra: "value" });
		expect((session as Record<string, unknown>).extra).toBe("value");
	});
});

describe("emitResumeUsageAndCompaction", () => {
	it("emits a usage message_end then a compaction_end with the standard payloads", () => {
		const session = createMockSession();
		const events: unknown[] = [];
		session.subscribe((e) => events.push(e));
		emitResumeUsageAndCompaction(session);
		expect(events).toEqual([
			{ type: "message_end", message: { role: "assistant", usage: { input: 70, output: 30, cacheWrite: 5 } } },
			{ type: "compaction_end", aborted: false, result: { tokensBefore: 999 }, reason: "overflow" },
		]);
	});
});
