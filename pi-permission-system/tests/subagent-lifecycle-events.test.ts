import { createEventBus } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	SUBAGENT_CHILD_DISPOSED,
	SUBAGENT_CHILD_SESSION_CREATED,
	subscribeSubagentLifecycle,
} from "../src/subagent-lifecycle-events";
import { SubagentSessionRegistry } from "../src/subagent-registry";

describe("subscribeSubagentLifecycle", () => {
	let registry: SubagentSessionRegistry;

	beforeEach(() => {
		registry = new SubagentSessionRegistry();
	});

	it("registers a child session on session-created", () => {
		const bus = createEventBus();
		subscribeSubagentLifecycle(bus, registry);

		bus.emit(SUBAGENT_CHILD_SESSION_CREATED, {
			sessionId: "child-session-abc",
			parentSessionId: "parent-42",
		});

		expect(registry.get("child-session-abc")).toEqual({
			parentSessionId: "parent-42",
		});
	});

	it("populates the registry synchronously — before emit() returns", () => {
		// Guards the pre-bindExtensions ordering: the core emits session-created
		// on the same synchronous call stack right before bindExtensions(), so the
		// handler must complete before emit() returns. A real EventEmitter-backed
		// bus dispatches synchronously; this fails loudly if the handler ever
		// becomes async (awaiting before registry.register).
		const bus = createEventBus();
		subscribeSubagentLifecycle(bus, registry);

		bus.emit(SUBAGENT_CHILD_SESSION_CREATED, {
			sessionId: "child-session-sync",
		});

		// No await between emit and this assertion.
		expect(registry.has("child-session-sync")).toBe(true);
	});

	it("omits parentSessionId when the event does not carry one", () => {
		const bus = createEventBus();
		subscribeSubagentLifecycle(bus, registry);

		bus.emit(SUBAGENT_CHILD_SESSION_CREATED, {
			sessionId: "child-session-xyz",
		});

		expect(registry.get("child-session-xyz")).toEqual({
			parentSessionId: undefined,
		});
	});

	it("unregisters a child session on disposed", () => {
		const bus = createEventBus();
		subscribeSubagentLifecycle(bus, registry);
		registry.register("child-session-abc", { parentSessionId: "parent-42" });

		bus.emit(SUBAGENT_CHILD_DISPOSED, { sessionId: "child-session-abc" });

		expect(registry.has("child-session-abc")).toBe(false);
	});

	it("detaches both handlers when the returned unsubscribe is called", () => {
		const bus = createEventBus();
		const unsubscribe = subscribeSubagentLifecycle(bus, registry);

		unsubscribe();

		bus.emit(SUBAGENT_CHILD_SESSION_CREATED, {
			sessionId: "child-session-abc",
		});
		bus.emit(SUBAGENT_CHILD_DISPOSED, { sessionId: "child-session-abc" });

		expect(registry.has("child-session-abc")).toBe(false);
	});

	it("subscribes to a fake bus on the exact channel names", () => {
		const handlers = new Map<string, (data: unknown) => void>();
		const bus = {
			on: vi.fn((channel: string, handler: (data: unknown) => void) => {
				handlers.set(channel, handler);
				return () => handlers.delete(channel);
			}),
		};

		subscribeSubagentLifecycle(bus, registry);

		expect(bus.on).toHaveBeenCalledTimes(2);
		expect(handlers.has("subagents:child:session-created")).toBe(true);
		expect(handlers.has("subagents:child:disposed")).toBe(true);
	});

	it("exposes the canonical channel-name strings", () => {
		expect(SUBAGENT_CHILD_SESSION_CREATED).toBe("subagents:child:session-created");
		expect(SUBAGENT_CHILD_DISPOSED).toBe("subagents:child:disposed");
	});

	// ── #298 regression: concurrent siblings must be independent ──────────────

	it("disposing one sibling does not evict the other (collision regression)", () => {
		const bus = createEventBus();
		subscribeSubagentLifecycle(bus, registry);

		// Two concurrent children of the same parent register under distinct ids.
		bus.emit(SUBAGENT_CHILD_SESSION_CREATED, {
			sessionId: "child-A",
			parentSessionId: "parent-P",
		});
		bus.emit(SUBAGENT_CHILD_SESSION_CREATED, {
			sessionId: "child-B",
			parentSessionId: "parent-P",
		});

		// Sibling A finishes first.
		bus.emit(SUBAGENT_CHILD_DISPOSED, { sessionId: "child-A" });

		// B must still be detected as a registered subagent.
		expect(registry.has("child-A")).toBe(false);
		expect(registry.has("child-B")).toBe(true);
		expect(registry.get("child-B")?.parentSessionId).toBe("parent-P");
	});
});
