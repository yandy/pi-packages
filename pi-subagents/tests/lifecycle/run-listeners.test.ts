import { describe, expect, it, vi } from "vitest";
import { RunListeners } from "../../src/lifecycle/run-listeners";

describe("RunListeners — wireSignal", () => {
	it("fires onAbort when the signal aborts", () => {
		const listeners = new RunListeners();
		const controller = new AbortController();
		const onAbort = vi.fn();
		listeners.wireSignal(controller.signal, onAbort);
		controller.abort();
		expect(onAbort).toHaveBeenCalledOnce();
	});

	it("is a no-op when signal is undefined", () => {
		const listeners = new RunListeners();
		expect(() => listeners.wireSignal(undefined, vi.fn())).not.toThrow();
	});

	it("release() detaches the signal listener so onAbort is not called after release", () => {
		const listeners = new RunListeners();
		const controller = new AbortController();
		const onAbort = vi.fn();
		listeners.wireSignal(controller.signal, onAbort);
		listeners.release();
		controller.abort();
		expect(onAbort).not.toHaveBeenCalled();
	});
});

describe("RunListeners — attachObserver / release", () => {
	it("calls the unsub handle on release", () => {
		const listeners = new RunListeners();
		const unsub = vi.fn();
		listeners.attachObserver(unsub);
		listeners.release();
		expect(unsub).toHaveBeenCalledOnce();
	});

	it("clears the handle so a second release does not double-call", () => {
		const listeners = new RunListeners();
		const unsub = vi.fn();
		listeners.attachObserver(unsub);
		listeners.release();
		listeners.release();
		expect(unsub).toHaveBeenCalledOnce();
	});

	it("release is idempotent with no handles attached", () => {
		const listeners = new RunListeners();
		expect(() => {
			listeners.release();
			listeners.release();
		}).not.toThrow();
	});
});

describe("RunListeners — combined wire + attach", () => {
	it("release clears both the signal listener and the observer unsub", () => {
		const listeners = new RunListeners();
		const controller = new AbortController();
		const onAbort = vi.fn();
		const unsub = vi.fn();
		listeners.wireSignal(controller.signal, onAbort);
		listeners.attachObserver(unsub);
		listeners.release();
		controller.abort();
		expect(onAbort).not.toHaveBeenCalled();
		expect(unsub).toHaveBeenCalledOnce();
	});
});
