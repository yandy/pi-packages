import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debugLog, isDebug } from "../src/debug";

describe("debugLog", () => {
	beforeEach(() => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("does not call console.warn when PI_SUBAGENTS_DEBUG is unset", () => {
		delete process.env.PI_SUBAGENTS_DEBUG;
		debugLog("test context", new Error("boom"));
		expect(console.warn).not.toHaveBeenCalled();
	});

	it("does not call console.warn when PI_SUBAGENTS_DEBUG=0", () => {
		vi.stubEnv("PI_SUBAGENTS_DEBUG", "0");
		debugLog("test context", new Error("boom"));
		expect(console.warn).not.toHaveBeenCalled();
	});

	it("calls console.warn with formatted message when PI_SUBAGENTS_DEBUG=1", () => {
		vi.stubEnv("PI_SUBAGENTS_DEBUG", "1");
		const err = new Error("something failed");
		debugLog("cleanup worktree", err);
		expect(console.warn).toHaveBeenCalledWith("[pi-subagents:debug] cleanup worktree:", err);
	});

	it("isDebug() returns true when PI_SUBAGENTS_DEBUG=1", () => {
		vi.stubEnv("PI_SUBAGENTS_DEBUG", "1");
		expect(isDebug()).toBe(true);
	});

	it("isDebug() returns false when PI_SUBAGENTS_DEBUG is unset", () => {
		delete process.env.PI_SUBAGENTS_DEBUG;
		expect(isDebug()).toBe(false);
	});
});
