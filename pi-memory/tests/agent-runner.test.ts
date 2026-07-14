import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mocks — plain vi.fn() so vi.mock factory can reference them.
// Configuration (mockResolvedValue, etc.) happens after vi.mock.
const mocks = vi.hoisted(() => ({
	promptMock: vi.fn(),
	abortMock: vi.fn(),
	steerMock: vi.fn(),
	disposeMock: vi.fn(),
	subscribeMock: vi.fn(),
	createAgentSessionMock: vi.fn(),
	inMemoryMock: vi.fn().mockReturnValue({ getSessionId: () => "s1" }),
	createSessionMock: vi.fn().mockReturnValue({ getSessionId: () => "s2" }),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	createAgentSession: mocks.createAgentSessionMock,
	DefaultResourceLoader: vi.fn().mockImplementation(() => ({
		reload: vi.fn().mockResolvedValue(undefined),
	})),
	SessionManager: {
		inMemory: mocks.inMemoryMock,
		create: mocks.createSessionMock,
	},
	SettingsManager: { inMemory: vi.fn().mockReturnValue({}) },
	getAgentDir: vi.fn().mockReturnValue("/home/fake/.pi/agent"),
}));

// Configure mocks after vi.mock (but before any tests run)
mocks.promptMock.mockResolvedValue(undefined);
mocks.abortMock.mockResolvedValue(undefined);
mocks.steerMock.mockResolvedValue(undefined);
mocks.subscribeMock.mockReturnValue(() => {});
mocks.createAgentSessionMock.mockResolvedValue({
	session: {
		prompt: mocks.promptMock,
		subscribe: mocks.subscribeMock,
		abort: mocks.abortMock,
		steer: mocks.steerMock,
		dispose: mocks.disposeMock,
		getLastAssistantText: vi.fn().mockReturnValue(""),
		getActiveToolNames: () => ["read", "write", "edit", "ls"],
		setActiveToolsByName: vi.fn(),
	},
	extensionsResult: {},
});

import { runHeadlessAgent } from "../src/agent-runner";

const { promptMock, abortMock, steerMock, disposeMock, subscribeMock, createAgentSessionMock, inMemoryMock, createSessionMock } = mocks;

const fakeRegistry = {
	find: vi.fn((_p: string, id: string) => (id === "deepseek-v4-flash" ? { id } : undefined)),
	getAvailable: () => [{ provider: "deepseek", id: "deepseek-v4-flash", name: "Flash" }],
	getAll: () => [{ provider: "deepseek", id: "deepseek-v4-flash", name: "Flash" }],
} as any;

beforeEach(() => {
	promptMock.mockClear();
	abortMock.mockClear();
	steerMock.mockClear();
	disposeMock.mockClear();
	subscribeMock.mockClear();
	createAgentSessionMock.mockClear();
	inMemoryMock.mockClear();
	createSessionMock.mockClear();
});

describe("runHeadlessAgent", () => {
	it("creates session with inMemory managers, no bindExtensions, disposes in finally", async () => {
		// subscribe captures the listener; we emit agent_end to let prompt resolve
		subscribeMock.mockImplementation((listener: any) => {
			// emit turn_end + message sequence after prompt is called
			queueMicrotask(() => {
				listener({ type: "message_start", message: {} });
				listener({
					type: "message_update",
					message: {},
					assistantMessageEvent: { type: "text_delta", delta: "Hello ", contentIndex: 0 },
				});
				listener({
					type: "message_update",
					message: {},
					assistantMessageEvent: { type: "text_delta", delta: "world", contentIndex: 0 },
				});
				listener({ type: "message_end", message: {} });
				listener({ type: "turn_end", message: {}, toolResults: [] });
				listener({ type: "agent_end", messages: [], willRetry: false });
			});
			return () => {};
		});

		const result = await runHeadlessAgent({
			task: "do something",
			cwd: "/mem",
			modelRegistry: fakeRegistry,
			parentModel: { id: "parent-model" } as any,
			thinkLevel: "high",
		});

		expect(result).toBe("Hello world");
		expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
		// tools restricted to memory agent tools
		const opts = createAgentSessionMock.mock.calls[0][0];
		expect(opts.tools).toEqual(["read", "write", "edit", "ls"]);
		expect(opts.sessionManager).toBeDefined(); // inMemory
		// disposed
		expect(disposeMock).toHaveBeenCalledTimes(1);
	});

	it("inherits parentModel when model is undefined", async () => {
		subscribeMock.mockImplementation((listener: any) => {
			queueMicrotask(() => {
				listener({ type: "message_end", message: {} });
				listener({ type: "turn_end", message: {}, toolResults: [] });
				listener({ type: "agent_end", messages: [], willRetry: false });
			});
			return () => {};
		});

		await runHeadlessAgent({
			task: "x",
			cwd: "/mem",
			modelRegistry: fakeRegistry,
			parentModel: { id: "parent-model" } as any,
		});

		const opts = createAgentSessionMock.mock.calls[0][0];
		expect(opts.model).toEqual({ id: "parent-model" });
	});

	it("resolves configured model string via resolver", async () => {
		subscribeMock.mockImplementation((listener: any) => {
			queueMicrotask(() => {
				listener({ type: "message_end", message: {} });
				listener({ type: "turn_end", message: {}, toolResults: [] });
				listener({ type: "agent_end", messages: [], willRetry: false });
			});
			return () => {};
		});

		await runHeadlessAgent({
			task: "x",
			cwd: "/mem",
			modelRegistry: fakeRegistry,
			model: "deepseek/deepseek-v4-flash",
			parentModel: { id: "parent" } as any,
		});

		const opts = createAgentSessionMock.mock.calls[0][0];
		expect(opts.model).toEqual({ id: "deepseek-v4-flash" });
	});

	it("disposes even when prompt throws", async () => {
		promptMock.mockRejectedValueOnce(new Error("boom"));
		await expect(
			runHeadlessAgent({
				task: "x",
				cwd: "/mem",
				modelRegistry: fakeRegistry,
				parentModel: {} as any,
			}),
		).rejects.toThrow("boom");
		expect(disposeMock).toHaveBeenCalledTimes(1);
	});

	it("aborts on signal", async () => {
		const controller = new AbortController();

		// Make prompt hang so abort fires during execution
		let resolvePrompt: () => void;
		const pendingPrompt = new Promise<void>((r) => {
			resolvePrompt = r;
		});
		promptMock.mockReturnValueOnce(pendingPrompt);

		subscribeMock.mockImplementation((listener: any) => {
			queueMicrotask(() => {
				listener({ type: "message_end", message: {} });
				listener({ type: "turn_end", message: {}, toolResults: [] });
				listener({ type: "agent_end", messages: [], willRetry: false });
			});
			return () => {};
		});

		const p = runHeadlessAgent({
			task: "x",
			cwd: "/mem",
			modelRegistry: fakeRegistry,
			parentModel: {} as any,
			signal: controller.signal,
		});
		// Let createAgentSession + subscribe events drain
		await new Promise((r) => setTimeout(r, 0));
		controller.abort();
		resolvePrompt!();
		await p;
		expect(abortMock).toHaveBeenCalled();
	});

	it("rejects after timeoutMs and disposes", async () => {
		// prompt stays pending forever (never resolves)
		const neverPromise = new Promise<void>(() => {});
		promptMock.mockReturnValueOnce(neverPromise);

		// subscribe mock: no-op listener that returns no-op unsubscribe
		subscribeMock.mockReturnValue(() => {});

		await expect(
			runHeadlessAgent({
				task: "x",
				cwd: "/mem",
				modelRegistry: fakeRegistry,
				parentModel: {} as any,
				timeoutMs: 50,
			}),
		).rejects.toThrow(/timed out after 50ms/);

		// finally block still runs on timeout rejection
		expect(disposeMock).toHaveBeenCalledTimes(1);
	});

	it("enforces maxTurns soft-limit and hard-abort", async () => {
		// prompt stays pending until we explicitly resolve
		let resolvePrompt: () => void = () => {};
		const pendingPrompt = new Promise<void>((r) => {
			resolvePrompt = r;
		});
		promptMock.mockReturnValueOnce(pendingPrompt);

		let listener: any;
		subscribeMock.mockImplementation((l: any) => {
			listener = l;
			return () => {};
		});

		const promise = runHeadlessAgent({
			task: "x",
			cwd: "/mem",
			modelRegistry: fakeRegistry,
			parentModel: {} as any,
			maxTurns: 2,
		});

		// Wait for runHeadlessAgent to reach await promptPromise
		// (loader.reload + createAgentSession both resolve in microtasks)
		await new Promise((r) => setTimeout(r, 0));

		// 1st turn_end: no limits triggered
		listener({ type: "turn_end", message: {}, toolResults: [] });
		expect(steerMock).not.toHaveBeenCalled();
		expect(abortMock).not.toHaveBeenCalled();

		// 2nd turn_end: turnCount=2 >= maxTurns=2 -> soft limit, steer called
		listener({ type: "turn_end", message: {}, toolResults: [] });
		expect(steerMock).toHaveBeenCalledTimes(1);
		expect(steerMock).toHaveBeenCalledWith(
			"You have reached your turn limit. Finish now.",
		);
		expect(abortMock).not.toHaveBeenCalled();

		// 3rd turn_end: turnCount=3 = maxTurns+GRACE_TURNS -> hard abort
		listener({ type: "turn_end", message: {}, toolResults: [] });
		expect(abortMock).toHaveBeenCalledTimes(1);

		// Resolve prompt so the function can finish and finally block runs
		resolvePrompt();
		await promise;
		expect(disposeMock).toHaveBeenCalledTimes(1);
	});

	it("uses SessionManager.create when sessionPersistence.enabled is true", async () => {
		subscribeMock.mockImplementation((listener: any) => {
			queueMicrotask(() => {
				listener({ type: "message_end", message: {} });
				listener({ type: "turn_end", message: {}, toolResults: [] });
				listener({ type: "agent_end", messages: [], willRetry: false });
			});
			return () => {};
		});

		await runHeadlessAgent({
			task: "x",
			cwd: "/mem",
			modelRegistry: fakeRegistry,
			parentModel: {} as any,
			sessionPersistence: { enabled: true },
		});

		expect(createSessionMock).toHaveBeenCalledWith("/mem", "/mem/sessions");
		expect(inMemoryMock).not.toHaveBeenCalled();
	});

	it("uses custom sessionDir when sessionPersistence.sessionDir is set", async () => {
		subscribeMock.mockImplementation((listener: any) => {
			queueMicrotask(() => {
				listener({ type: "message_end", message: {} });
				listener({ type: "turn_end", message: {}, toolResults: [] });
				listener({ type: "agent_end", messages: [], willRetry: false });
			});
			return () => {};
		});

		await runHeadlessAgent({
			task: "x",
			cwd: "/mem",
			modelRegistry: fakeRegistry,
			parentModel: {} as any,
			sessionPersistence: { enabled: true, sessionDir: "/custom/sessions" },
		});

		expect(createSessionMock).toHaveBeenCalledWith("/mem", "/custom/sessions");
		expect(inMemoryMock).not.toHaveBeenCalled();
	});
});
