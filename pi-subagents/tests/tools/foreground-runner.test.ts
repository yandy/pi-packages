import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Subagent } from "../../src/lifecycle/subagent";
import { SubagentState } from "../../src/lifecycle/subagent-state";
import { type ForegroundParams, runForeground } from "../../src/tools/foreground-runner";
import type { SessionMessage } from "../../src/types";
import { createToolDeps } from "../helpers/make-deps";
import { createResolvedSpawnConfig } from "../helpers/make-spawn-config";
import { createTestSubagent, makeStubExecution } from "../helpers/make-subagent";
import { STUB_SNAPSHOT } from "../helpers/stub-ctx";

function makeParams(overrides: Partial<ForegroundParams> = {}): ForegroundParams {
	return {
		config: createResolvedSpawnConfig({ description: "fg task" }),
		snapshot: STUB_SNAPSHOT,
		parentSession: { parentSessionFile: "/sessions/parent.jsonl", parentSessionId: "session-1" },
		...overrides,
	};
}

describe("runForeground", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns completion message with tool use count on success", async () => {
		const { manager } = createToolDeps();
		const result = await runForeground(manager, makeParams(), undefined, undefined);
		expect(result.content[0].text).toContain("Agent completed");
		expect(result.content[0].text).toContain("3 tool uses");
		expect(result.content[0].text).toContain("All done.");
	});

	it("threads effectiveTimeoutSeconds into spawnAndWait opts", async () => {
		const { manager } = createToolDeps();
		await runForeground(
			manager,
			makeParams({ config: createResolvedSpawnConfig({ description: "fg task", timeout: 300 }) }),
			undefined,
			undefined,
		);
		const spawnOpts = (manager.spawnAndWait as ReturnType<typeof vi.fn>).mock.calls[0][3];
		expect(spawnOpts.timeoutSeconds).toBe(300);
	});

	it("returns error message when agent record status is error", async () => {
		const deps = createToolDeps({
			manager: {
				...createToolDeps().manager,
				spawnAndWait: vi.fn().mockResolvedValue(createTestSubagent({ status: "error", error: "Context window exceeded" })),
			},
		});
		const result = await runForeground(deps.manager, makeParams(), undefined, undefined);
		expect(result.content[0].text).toContain("Agent failed");
		expect(result.content[0].text).toContain("Context window exceeded");
	});

	it("returns error text when spawnAndWait throws", async () => {
		const deps = createToolDeps({
			manager: {
				...createToolDeps().manager,
				spawnAndWait: vi.fn().mockRejectedValue(new Error("runner crashed")),
			},
		});
		const result = await runForeground(deps.manager, makeParams(), undefined, undefined);
		expect(result.content[0].text).toContain("runner crashed");
	});

	it("includes fallback note when fellBack is true", async () => {
		const { manager } = createToolDeps();
		const result = await runForeground(
			manager,
			makeParams({
				config: createResolvedSpawnConfig({ rawType: "unknown-type", fellBack: true, description: "fg task" }),
			}),
			undefined,
			undefined,
		);
		expect(result.content[0].text).toContain('Unknown agent type "unknown-type"');
	});

	it("calls onUpdate with streaming details while running", async () => {
		let resolve!: (r: any) => void;
		const promise = new Promise<any>((res) => {
			resolve = res;
		});
		const deps = createToolDeps({
			manager: {
				...createToolDeps().manager,
				spawnAndWait: vi.fn().mockReturnValue(promise),
			},
		});
		const onUpdate = vi.fn();
		const runPromise = runForeground(deps.manager, makeParams(), undefined, onUpdate);

		// Advance timer to trigger a spinner tick
		await vi.advanceTimersByTimeAsync(100);
		expect(onUpdate).toHaveBeenCalled();

		resolve(createTestSubagent({ result: "done" }));
		await runPromise;
	});

	it("streams the record's in-flight message text as the activity line", async () => {
		const state = new SubagentState({ status: "running", startedAt: Date.now() - 100 });
		const partial = {
			role: "assistant",
			content: [{ type: "text", text: "Reviewing the diff" }],
		} as unknown as SessionMessage;
		state.setStreamingMessage(partial);
		const record = new Subagent({
			id: "stream-1",
			type: "general-purpose",
			description: "streaming task",
			execution: makeStubExecution(),
			state,
		});

		let resolveSpawn!: (record: Subagent) => void;
		const spawnPromise = new Promise<Subagent>((res) => {
			resolveSpawn = res;
		});
		const deps = createToolDeps({
			manager: {
				...createToolDeps().manager,
				spawnAndWait: vi.fn().mockImplementation((_snapshot, _type, _prompt, opts) => {
					opts.observer.onSessionCreated(record);
					return spawnPromise;
				}),
			},
		});
		const onUpdate = vi.fn();
		const runPromise = runForeground(deps.manager, makeParams(), undefined, onUpdate);

		await vi.advanceTimersByTimeAsync(100);
		expect(onUpdate).toHaveBeenCalled();

		const activities = onUpdate.mock.calls.map((call) => call[0]?.details?.activity);
		expect(activities).toContain("Reviewing the diff");

		resolveSpawn(record);
		await runPromise;
	});

	it("clears spinner interval on error and does not leave it running", async () => {
		const deps = createToolDeps({
			manager: {
				...createToolDeps().manager,
				spawnAndWait: vi.fn().mockRejectedValue(new Error("fail")),
			},
		});
		const onUpdate = vi.fn();
		await runForeground(deps.manager, makeParams(), undefined, onUpdate);

		onUpdate.mockClear();
		await vi.advanceTimersByTimeAsync(200);
		// Interval must have been cleared — no further onUpdate calls
		expect(onUpdate).not.toHaveBeenCalled();
	});
});
