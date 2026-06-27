import { afterEach, describe, expect, test } from "vitest";
import {
	getSubagentSessionRegistry,
	type SubagentSessionInfo,
	SubagentSessionRegistry,
} from "../src/subagent-registry";

const REGISTRY_KEY = Symbol.for("@yandy0725/pi-permission-system:subagent-registry");

function makeInfo(overrides: Partial<SubagentSessionInfo> = {}): SubagentSessionInfo {
	return { ...overrides };
}

describe("SubagentSessionRegistry", () => {
	test("has() returns false for an unregistered key", () => {
		const registry = new SubagentSessionRegistry();
		expect(registry.has("session-abc")).toBe(false);
	});

	test("get() returns undefined for an unregistered key", () => {
		const registry = new SubagentSessionRegistry();
		expect(registry.get("session-abc")).toBeUndefined();
	});

	test("has() returns true after register()", () => {
		const registry = new SubagentSessionRegistry();
		registry.register("session-abc", makeInfo());
		expect(registry.has("session-abc")).toBe(true);
	});

	test("get() returns the registered info after register()", () => {
		const registry = new SubagentSessionRegistry();
		const info = makeInfo({ parentSessionId: "parent-123" });
		registry.register("session-abc", info);
		expect(registry.get("session-abc")).toEqual(info);
	});

	test("register() stores entry without parentSessionId", () => {
		const registry = new SubagentSessionRegistry();
		registry.register("session-abc", makeInfo());
		expect(registry.get("session-abc")).toEqual({});
	});

	test("has() returns false after unregister()", () => {
		const registry = new SubagentSessionRegistry();
		registry.register("session-abc", makeInfo());
		registry.unregister("session-abc");
		expect(registry.has("session-abc")).toBe(false);
	});

	test("get() returns undefined after unregister()", () => {
		const registry = new SubagentSessionRegistry();
		registry.register("session-abc", makeInfo());
		registry.unregister("session-abc");
		expect(registry.get("session-abc")).toBeUndefined();
	});

	test("unregister() is a no-op for an unknown key", () => {
		const registry = new SubagentSessionRegistry();
		expect(() => registry.unregister("session-nonexistent")).not.toThrow();
	});

	test("register() overwrites a previous entry for the same key", () => {
		const registry = new SubagentSessionRegistry();
		registry.register("session-abc", makeInfo({ parentSessionId: "parent-1" }));
		registry.register("session-abc", makeInfo({ parentSessionId: "parent-2" }));
		expect(registry.get("session-abc")?.parentSessionId).toBe("parent-2");
	});

	// ── #298 regression: concurrent siblings must be independent ──────────────

	test("two sibling session ids are registered independently", () => {
		const registry = new SubagentSessionRegistry();
		registry.register("child-session-A", makeInfo({ parentSessionId: "parent-P" }));
		registry.register("child-session-B", makeInfo({ parentSessionId: "parent-P" }));

		expect(registry.has("child-session-A")).toBe(true);
		expect(registry.has("child-session-B")).toBe(true);
	});

	test("disposing one sibling does not evict the other (collision regression)", () => {
		const registry = new SubagentSessionRegistry();
		registry.register("child-session-A", makeInfo({ parentSessionId: "parent-P" }));
		registry.register("child-session-B", makeInfo({ parentSessionId: "parent-P" }));

		// Sibling A finishes — should not affect B.
		registry.unregister("child-session-A");

		expect(registry.has("child-session-A")).toBe(false);
		expect(registry.has("child-session-B")).toBe(true);
		expect(registry.get("child-session-B")?.parentSessionId).toBe("parent-P");
	});
});

// ── process-global accessor ────────────────────────────────────────────────

describe("getSubagentSessionRegistry (process-global accessor)", () => {
	afterEach(() => {
		// eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- Symbol-keyed global property; Map.delete() is not applicable
		delete (globalThis as Record<symbol, unknown>)[REGISTRY_KEY];
	});

	test("returns a SubagentSessionRegistry instance", () => {
		const registry = getSubagentSessionRegistry();
		expect(registry).toBeInstanceOf(SubagentSessionRegistry);
	});

	test("returns the same instance on repeated calls", () => {
		const first = getSubagentSessionRegistry();
		const second = getSubagentSessionRegistry();
		expect(first).toBe(second);
	});

	test("state registered through one call is visible through another call", () => {
		const writer = getSubagentSessionRegistry();
		writer.register("child-session-xyz", {
			parentSessionId: "parent-abc",
		});

		const reader = getSubagentSessionRegistry();
		expect(reader.has("child-session-xyz")).toBe(true);
		expect(reader.get("child-session-xyz")?.parentSessionId).toBe("parent-abc");
	});

	test("starts empty on first call", () => {
		const registry = getSubagentSessionRegistry();
		expect(registry.has("any-session-id")).toBe(false);
	});
});
