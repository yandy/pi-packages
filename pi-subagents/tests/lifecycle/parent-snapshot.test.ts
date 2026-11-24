import { describe, expect, it, vi } from "vitest";

const { buildParentContextMock } = vi.hoisted(() => ({
	buildParentContextMock: vi.fn((): string => ""),
}));

vi.mock("../../src/session/context", () => ({
	buildParentContext: buildParentContextMock,
}));

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildParentSnapshot } from "../../src/lifecycle/parent-snapshot";
import { makeUsage } from "../helpers/usage";

function makeCtx(overrides: Record<string, unknown> = {}) {
	return {
		cwd: "/test/project",
		model: { id: "claude-sonnet" },
		modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
		sessionManager: { getBranch: vi.fn(() => []) },
		...overrides,
	} as unknown as ExtensionContext;
}

describe("buildParentSnapshot", () => {
	it("captures cwd from ctx", () => {
		const snapshot = buildParentSnapshot(makeCtx({ cwd: "/custom/path" }));
		expect(snapshot.cwd).toBe("/custom/path");
	});

	it("does not capture the parent system prompt", () => {
		const snapshot = buildParentSnapshot(makeCtx());
		expect(snapshot).not.toHaveProperty("systemPrompt");
	});

	it("captures model from ctx", () => {
		const model = { id: "claude-haiku", provider: "anthropic" };
		const snapshot = buildParentSnapshot(makeCtx({ model }));
		expect(snapshot.model).toBe(model);
	});

	it("captures modelRegistry from ctx", () => {
		const registry = { find: vi.fn(), getAvailable: vi.fn(() => []) };
		const snapshot = buildParentSnapshot(makeCtx({ modelRegistry: registry }));
		expect(snapshot.modelRegistry).toBe(registry);
	});

	it("forwards subagent usage to the captured parent session manager", () => {
		const appended: unknown[] = [];
		const sessionManager = {
			getBranch: vi.fn(() => []),
			appendUsage: (kind: string, provider: string, model: string, usage: unknown, note?: string) => {
				appended.push({ kind, provider, model, usage, note });
			},
		};
		const snapshot = buildParentSnapshot(makeCtx({ sessionManager }));
		const usage = makeUsage();

		snapshot.recordUsage?.({
			provider: "ark",
			model: "kimi-k3",
			usage,
			note: "Subagent agent-1: Inspect costs",
		});

		expect(appended).toEqual([
			{
				kind: "subagent",
				provider: "ark",
				model: "kimi-k3",
				usage,
				note: "Subagent agent-1: Inspect costs",
			},
		]);
	});

	it("sets parentContext to undefined when inheritContext is undefined", () => {
		const snapshot = buildParentSnapshot(makeCtx());
		expect(snapshot.parentContext).toBeUndefined();
		expect(buildParentContextMock).not.toHaveBeenCalled();
	});

	it("populates parentContext when inheritContext is true and conversation exists", () => {
		buildParentContextMock.mockReturnValueOnce("# Parent Conversation\n...");
		const snapshot = buildParentSnapshot(makeCtx(), true);
		expect(snapshot.parentContext).toBe("# Parent Conversation\n...");
		expect(buildParentContextMock).toHaveBeenCalledTimes(1);
	});

	it("sets parentContext to undefined when inheritContext is true but conversation is empty", () => {
		buildParentContextMock.mockReturnValueOnce("");
		const snapshot = buildParentSnapshot(makeCtx(), true);
		expect(snapshot.parentContext).toBeUndefined();
	});

	it("captures the parent's active tool names", () => {
		const snapshot = buildParentSnapshot(makeCtx({ getActiveTools: () => ["read", "bash", "ext_tool"] }));
		expect(snapshot.activeToolNames).toEqual(["read", "bash", "ext_tool"]);
	});

	it("captures a known-empty active set as an empty array", () => {
		const snapshot = buildParentSnapshot(makeCtx({ getActiveTools: () => [] }));
		expect(snapshot.activeToolNames).toEqual([]);
	});

	it("leaves the tool names unknown when the host cannot report them", () => {
		const snapshot = buildParentSnapshot(makeCtx({}));
		expect(snapshot.activeToolNames).toBeUndefined();
	});
});
