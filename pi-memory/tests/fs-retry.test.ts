import { describe, expect, it, vi } from "vitest";
import { isTransientFsError, withFsRetry } from "../src/fs-retry";

function errnoError(code: string): NodeJS.ErrnoException {
	const e = new Error(`${code}: simulated`) as NodeJS.ErrnoException;
	e.code = code;
	return e;
}

describe("isTransientFsError", () => {
	it("treats EBUSY/EMFILE/ENFILE/ENOTEMPTY as transient on every platform", () => {
		for (const platform of ["linux", "darwin", "win32"] as const) {
			for (const code of ["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY"]) {
				expect(isTransientFsError(errnoError(code), platform), `${platform}/${code}`).toBe(true);
			}
		}
	});

	it("treats EPERM/EACCES as transient only on win32", () => {
		for (const code of ["EPERM", "EACCES"]) {
			expect(isTransientFsError(errnoError(code), "win32"), code).toBe(true);
			expect(isTransientFsError(errnoError(code), "linux"), code).toBe(false);
			expect(isTransientFsError(errnoError(code), "darwin"), code).toBe(false);
		}
	});

	it("never treats other errors, non-errors or code-less errors as transient", () => {
		expect(isTransientFsError(errnoError("ENOENT"), "win32")).toBe(false);
		expect(isTransientFsError(errnoError("EISDIR"), "win32")).toBe(false);
		expect(isTransientFsError(new Error("boom"), "win32")).toBe(false);
		expect(isTransientFsError(null, "win32")).toBe(false);
		expect(isTransientFsError("EPERM", "win32")).toBe(false);
	});
});

describe("withFsRetry", () => {
	const noSleep = () => Promise.resolve();

	it("returns the value without retrying when the call succeeds", async () => {
		const fn = vi.fn().mockResolvedValue("ok");
		await expect(withFsRetry(fn, { platform: "win32", sleep: noSleep })).resolves.toBe("ok");
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("retries a transient error until the call succeeds", async () => {
		const fn = vi
			.fn()
			.mockRejectedValueOnce(errnoError("EPERM"))
			.mockRejectedValueOnce(errnoError("EBUSY"))
			.mockResolvedValue("ok");
		await expect(withFsRetry(fn, { platform: "win32", sleep: noSleep })).resolves.toBe("ok");
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it("backs off exponentially with the spec's ladder (20/40/80/160/300/300)", async () => {
		const delays: number[] = [];
		const fn = vi.fn().mockRejectedValue(errnoError("EBUSY"));
		await expect(
			withFsRetry(fn, {
				platform: "linux",
				sleep: (ms) => {
					delays.push(ms);
					return Promise.resolve();
				},
			}),
		).rejects.toThrow("EBUSY");
		expect(delays).toEqual([20, 40, 80, 160, 300, 300]);
		expect(fn).toHaveBeenCalledTimes(7); // 首次 + 6 次重试
	});

	it("rethrows the original error after the retry budget is exhausted", async () => {
		const original = errnoError("EPERM");
		const fn = vi.fn().mockRejectedValue(original);
		await expect(withFsRetry(fn, { platform: "win32", retries: 1, sleep: noSleep })).rejects.toBe(original);
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("rethrows a non-transient error immediately without retrying", async () => {
		const original = errnoError("ENOENT");
		const fn = vi.fn().mockRejectedValue(original);
		await expect(withFsRetry(fn, { platform: "win32", sleep: noSleep })).rejects.toBe(original);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("does not retry EPERM on POSIX (permanent there)", async () => {
		const fn = vi.fn().mockRejectedValue(errnoError("EPERM"));
		await expect(withFsRetry(fn, { platform: "linux", sleep: noSleep })).rejects.toThrow("EPERM");
		expect(fn).toHaveBeenCalledTimes(1);
	});
});
