import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import registerCheckpoint from "../src/index.js";
import { CHECKPOINT_ENTRY_TYPE } from "../src/session.js";

describe("pi-checkpoint extension entry", () => {
	it("registers only run-level capture events and read-only UI", () => {
		const events = new Map<string, (...args: never[]) => unknown>();
		const pi = {
			appendEntry: vi.fn(),
			on: vi.fn((event: string, handler: (...args: never[]) => unknown) => {
				events.set(event, handler);
				return vi.fn();
			}),
			registerEntryRenderer: vi.fn(),
			registerCommand: vi.fn(),
			registerTool: vi.fn(),
		} as unknown as ExtensionAPI;

		registerCheckpoint(pi);

		expect(events.has("before_agent_start")).toBe(true);
		expect(events.has("agent_settled")).toBe(true);
		expect(events.has("session_start")).toBe(true);
		expect(events.has("session_shutdown")).toBe(true);
		expect(events.has("turn_end")).toBe(false);
		expect(pi.registerEntryRenderer).toHaveBeenCalledWith(CHECKPOINT_ENTRY_TYPE, expect.any(Function));
		expect(pi.registerCommand).toHaveBeenCalledWith(
			"checkpoint",
			expect.objectContaining({ handler: expect.any(Function) }),
		);
		expect(pi.registerTool).not.toHaveBeenCalled();
	});
});
