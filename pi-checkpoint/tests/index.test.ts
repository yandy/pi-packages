import type {
	ExtensionAPI,
	ExtensionCommandContext,
	RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHECKPOINT_ENTRY_TYPE } from "../src/session.js";

const mocks = vi.hoisted(() => ({
	maintenance: {
		sessionStart: vi.fn(),
		agentSettled: vi.fn(),
		prune: vi.fn(),
		reset: vi.fn(),
	},
	coordinator: {
		beforeAgentStart: vi.fn(),
		agentSettled: vi.fn(),
		reset: vi.fn(),
	},
	createMaintenance: vi.fn(),
	createCoordinator: vi.fn(),
}));

vi.mock("../src/maintenance.js", () => ({
	createCheckpointMaintenance: mocks.createMaintenance,
}));

vi.mock("../src/coordinator.js", () => ({
	createCheckpointCoordinator: mocks.createCoordinator,
}));

const { default: registerCheckpoint } = await import("../src/index.js");

type Handler = (event: unknown, ctx: unknown) => unknown;

function register() {
	const events = new Map<string, Handler>();
	const pi = {
		appendEntry: vi.fn(),
		on: vi.fn((event: string, handler: Handler) => {
			events.set(event, handler);
			return vi.fn();
		}),
		registerEntryRenderer: vi.fn(),
		registerCommand: vi.fn(),
		registerTool: vi.fn(),
	} as unknown as ExtensionAPI;
	registerCheckpoint(pi);
	return { events, pi };
}

function handlerFor(events: Map<string, Handler>, event: string): Handler {
	const handler = events.get(event);
	if (!handler) throw new Error(`missing ${event} handler`);
	return handler;
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

beforeEach(() => {
	for (const fn of Object.values(mocks.maintenance)) fn.mockReset();
	for (const fn of Object.values(mocks.coordinator)) fn.mockReset();
	mocks.createMaintenance.mockReset().mockReturnValue(mocks.maintenance);
	mocks.createCoordinator.mockReset().mockReturnValue(mocks.coordinator);
});

describe("pi-checkpoint extension entry", () => {
	it("registers only run-level capture events and read-only UI", () => {
		const { events, pi } = register();

		expect(events.has("before_agent_start")).toBe(true);
		expect(events.has("agent_settled")).toBe(true);
		expect(events.has("session_start")).toBe(true);
		expect(events.has("session_shutdown")).toBe(true);
		expect(events.has("turn_end")).toBe(false);
		expect(mocks.createCoordinator).toHaveBeenCalledTimes(1);
		expect(mocks.createMaintenance).toHaveBeenCalledTimes(1);
		expect(pi.registerEntryRenderer).toHaveBeenCalledWith(CHECKPOINT_ENTRY_TYPE, expect.any(Function));
		expect(pi.registerCommand).toHaveBeenCalledWith(
			"checkpoint",
			expect.objectContaining({ handler: expect.any(Function) }),
		);
		expect(pi.registerTool).not.toHaveBeenCalled();
	});

	it("routes the checkpoint prune command through maintenance", async () => {
		const { pi } = register();
		const command = vi.mocked(pi.registerCommand).mock.calls[0]?.[1] as RegisteredCommand;
		const notify = vi.fn();
		const ctx = { cwd: "/repo", ui: { notify } } as unknown as ExtensionCommandContext;

		await command.handler("prune --dry-run", ctx);

		expect(mocks.maintenance.prune).toHaveBeenCalledWith(ctx, true);
		expect(notify).not.toHaveBeenCalled();
	});

	it("routes baseline capture to the coordinator", async () => {
		const { events } = register();
		const event = { type: "before_agent_start", messageType: "user", prompt: "hi" };
		const ctx = { cwd: "/repo" };

		await handlerFor(events, "before_agent_start")(event, ctx);

		expect(mocks.coordinator.beforeAgentStart).toHaveBeenCalledWith(event, ctx);
		expect(mocks.maintenance.agentSettled).not.toHaveBeenCalled();
	});

	it("waits for checkpoint capture before requesting maintenance on settle", async () => {
		const capture = deferred();
		mocks.coordinator.agentSettled.mockImplementation(() => capture.promise);
		mocks.maintenance.agentSettled.mockResolvedValue(undefined);
		const { events } = register();
		const event = { type: "agent_settled", aborted: false };
		const ctx = { cwd: "/repo" };

		const settled = handlerFor(events, "agent_settled")(event, ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(mocks.maintenance.agentSettled).not.toHaveBeenCalled();

		capture.resolve();
		await settled;

		expect(mocks.coordinator.agentSettled).toHaveBeenCalledWith(event, ctx);
		expect(mocks.maintenance.agentSettled).toHaveBeenCalledWith(ctx);
	});

	it("skips the settle sweep when a new session starts while capture is pending", async () => {
		const capture = deferred();
		mocks.coordinator.agentSettled.mockImplementation(() => capture.promise);
		mocks.maintenance.sessionStart.mockResolvedValue(undefined);
		mocks.maintenance.agentSettled.mockResolvedValue(undefined);
		const { events } = register();
		const oldCtx = { cwd: "/old-repo" };
		const newCtx = { cwd: "/new-repo" };

		const settled = handlerFor(events, "agent_settled")({ type: "agent_settled", aborted: false }, oldCtx);
		await new Promise((resolve) => setTimeout(resolve, 0));

		await handlerFor(events, "session_start")({ type: "session_start" }, newCtx);
		expect(mocks.maintenance.sessionStart).toHaveBeenCalledWith(newCtx);

		capture.resolve();
		await settled;

		expect(mocks.coordinator.agentSettled).toHaveBeenCalledWith({ type: "agent_settled", aborted: false }, oldCtx);
		expect(mocks.maintenance.agentSettled).not.toHaveBeenCalled();
	});

	it("skips the settle sweep when the session shuts down while capture is pending", async () => {
		const capture = deferred();
		mocks.coordinator.agentSettled.mockImplementation(() => capture.promise);
		mocks.maintenance.agentSettled.mockResolvedValue(undefined);
		const { events } = register();
		const ctx = { cwd: "/repo" };

		const settled = handlerFor(events, "agent_settled")({ type: "agent_settled", aborted: false }, ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));

		handlerFor(events, "session_shutdown")({ type: "session_shutdown" }, ctx);
		capture.resolve();
		await settled;

		expect(mocks.maintenance.agentSettled).not.toHaveBeenCalled();
	});

	it("resets capture state and starts maintenance at session start", async () => {
		const order: string[] = [];
		mocks.coordinator.reset.mockImplementation(() => {
			order.push("capture.reset");
		});
		mocks.maintenance.sessionStart.mockImplementation(async () => {
			order.push("maintenance.sessionStart");
		});
		const { events } = register();
		const ctx = { cwd: "/repo" };

		await handlerFor(events, "session_start")({ type: "session_start" }, ctx);

		expect(order).toEqual(["capture.reset", "maintenance.sessionStart"]);
		expect(mocks.maintenance.sessionStart).toHaveBeenCalledWith(ctx);
	});

	it("resets capture and maintenance state at session shutdown", () => {
		const { events } = register();

		handlerFor(events, "session_shutdown")({ type: "session_shutdown" }, { cwd: "/repo" });

		expect(mocks.coordinator.reset).toHaveBeenCalledTimes(1);
		expect(mocks.maintenance.reset).toHaveBeenCalledTimes(1);
	});
});
