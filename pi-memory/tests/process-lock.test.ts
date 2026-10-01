import { describe, expect, it } from "vitest";
import {
	isProcessLockActive,
	ProcessLockTimeoutError,
	tryWithProcessLock,
	withProcessLock,
} from "../src/process-lock";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("withProcessLock", () => {
	it("serialises overlapping calls on the same key", async () => {
		let active = 0;
		let maxActive = 0;
		await Promise.all(
			[1, 2, 3, 4, 5].map((n) =>
				withProcessLock("k1", 5000, async () => {
					active += 1;
					maxActive = Math.max(maxActive, active);
					await sleep(5);
					active -= 1;
					return n;
				}),
			),
		);
		expect(maxActive).toBe(1);
	});

	it("does not couple different keys", async () => {
		let active = 0;
		let maxActive = 0;
		const body = async () => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await sleep(10);
			active -= 1;
		};
		await Promise.all([withProcessLock("key-a", 5000, body), withProcessLock("key-b", 5000, body)]);
		expect(maxActive).toBe(2);
	});

	it("throws a clear error when the wait exceeds the timeout", async () => {
		let release: (() => void) | undefined;
		const held = withProcessLock("busy", 5000, () => new Promise<void>((resolve) => (release = resolve)));

		await expect(withProcessLock("busy", 30, async () => "never")).rejects.toThrow(ProcessLockTimeoutError);
		await expect(withProcessLock("busy", 30, async () => "never")).rejects.toThrow(
			/already running in this process/,
		);
		release?.();
		await held;
	});

	it("keeps working after a waiter timed out (the queue must not stall)", async () => {
		let release: (() => void) | undefined;
		const held = withProcessLock("q", 5000, () => new Promise<void>((resolve) => (release = resolve)));
		await expect(withProcessLock("q", 20, async () => "x")).rejects.toThrow(ProcessLockTimeoutError);

		// 超时的等待者必须把自己的 gate 放掉，否则后面的调用会被永久挂住
		const after = withProcessLock("q", 2000, async () => "after");
		release?.();
		await held;
		await expect(after).resolves.toBe("after");
	});

	it("releases when the body throws", async () => {
		await expect(withProcessLock("t", 5000, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
		await expect(withProcessLock("t", 5000, async () => "ok")).resolves.toBe("ok");
	});

	it("holds a long scope exclusively against a millisecond-scoped writer", async () => {
		// 模拟 dream 整轮持锁期间，一次 memory add 的到达
		let release: (() => void) | undefined;
		const dream = withProcessLock("dir", 5000, () => new Promise<void>((resolve) => (release = resolve)));
		await sleep(1);

		await expect(withProcessLock("dir", 20, async () => "add")).rejects.toThrow(ProcessLockTimeoutError);
		await expect(tryWithProcessLock("dir", async () => "add")).resolves.toBeNull();

		release?.();
		await dream;
		await expect(withProcessLock("dir", 50, async () => "add")).resolves.toBe("add");
	});
});

describe("tryWithProcessLock", () => {
	it("runs the body when the key is free", async () => {
		await expect(tryWithProcessLock("free", async () => "ran")).resolves.toBe("ran");
	});

	it("never waits when the key is busy", async () => {
		let release: (() => void) | undefined;
		const held = withProcessLock("busy2", 5000, () => new Promise<void>((resolve) => (release = resolve)));
		const started = Date.now();
		await expect(tryWithProcessLock("busy2", async () => "no")).resolves.toBeNull();
		expect(Date.now() - started).toBeLessThan(50);
		release?.();
		await held;
	});
});

describe("isProcessLockActive", () => {
	it("is false when free and true while held, including while others wait", async () => {
		expect(isProcessLockActive("s")).toBe(false);
		let release: (() => void) | undefined;
		const held = withProcessLock("s", 5000, () => new Promise<void>((resolve) => (release = resolve)));
		await sleep(1);
		expect(isProcessLockActive("s")).toBe(true);
		release?.();
		await held;
		expect(isProcessLockActive("s")).toBe(false);
	});
});
