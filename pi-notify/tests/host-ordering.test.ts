/**
 * Host-scheduling tests: these drive the *real* `ExtensionRunner` prompt wrapper
 * (`withUIPrompt` → `queueMicrotask` → `emit` → `await handler`) instead of feeding
 * `ui_prompt_start` / `ui_prompt_end` straight into pi-notify.
 *
 * That distinction matters: the real `/subagents:sessions` chain is
 * `select` closes → its `ui_prompt_end` is queued as a microtask → the awaiting
 * command continuation announces the next prompt and mounts `custom` → the
 * `ui_prompt_start(custom)` microtask lands *after* that end. Any state pi-notify
 * clears on `ui_prompt_end` is already gone by the time the announced prompt opens,
 * and an end handler that yields can even let the new start overtake it.
 */

import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension, { NON_BLOCKING_PROMPT_CHANNEL, PROMPT_NOTIFY_DELAY_MS } from "../src/index.js";

type Handler = (event: any, ctx: any) => unknown;

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

/** Let every queued microtask (the host's prompt events included) drain. */
async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

function createBus() {
	const listeners: Record<string, Handler[]> = {};
	return {
		emit: (channel: string, data: unknown) => {
			for (const handler of listeners[channel] ?? []) handler(data, undefined);
		},
		on: (channel: string, handler: Handler) => {
			(listeners[channel] ??= []).push(handler);
			return () => {};
		},
	};
}

interface Harness {
	/** The host's wrapped UI context — exactly what an extension command receives. */
	ui: any;
	bus: { emit: (channel: string, data: unknown) => void; on: (channel: string, handler: Handler) => () => void };
	notify: ReturnType<typeof vi.fn>;
	resolveSelect(value: string | undefined): void;
	/** Mount a viewer the way `SessionNavigatorHandler` does: announce, then `custom`. */
	mountAnnouncedViewer(): Promise<unknown>;
	/** Mount an unannounced `custom` prompt (an interactive tool such as `ask_user`). */
	mountToolPrompt(): void;
	runner: { emit: (event: unknown) => Promise<unknown> };
}

/**
 * Build a runner over one pi-notify extension, optionally preceded by a "slow"
 * extension whose prompt handler yields — the shape of another package doing async
 * work in that handler. A slow `ui_prompt_start` handler delays pi-notify's own
 * start handler, which is how two announcements can be pending at once.
 */
function createHarness(opts?: {
	slowEndHandler?: () => Promise<void>;
	slowStartHandler?: () => Promise<void>;
}): Harness {
	const bus = createBus();
	const handlers: Record<string, Handler[]> = {};
	const notify = vi.fn();
	let resolveSelect: (value: string | undefined) => void = () => {};

	const pi = {
		on: (event: string, handler: Handler) => {
			(handlers[event] ??= []).push(handler);
			return () => {};
		},
		registerCommand: () => {},
		getSessionName: () => undefined,
		events: bus,
	};
	extension(pi as any, {
		env: {},
		createNotifier: (() => ({ notify, degraded: false })) as any,
		now: () => 0,
		pid: 4242,
		platform: "linux",
	});

	const notifyExtension = { path: "pi-notify", handlers: new Map(Object.entries(handlers)), tools: new Map() } as any;
	const extensions = [notifyExtension];
	const slowHandlers = new Map<string, Handler[]>();
	if (opts?.slowEndHandler) slowHandlers.set("ui_prompt_end", [async () => await opts.slowEndHandler?.()]);
	if (opts?.slowStartHandler) slowHandlers.set("ui_prompt_start", [async () => await opts.slowStartHandler?.()]);
	if (slowHandlers.size > 0) {
		extensions.unshift({ path: "slow-extension", handlers: slowHandlers, tools: new Map() } as any);
	}

	const rawUI = {
		select: () => new Promise<string | undefined>((resolve) => (resolveSelect = resolve)),
		confirm: async () => false,
		input: async () => undefined,
		editor: async () => undefined,
		custom: async () => new Promise<never>(() => {}),
		notify: vi.fn(),
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
	};
	const runner = new ExtensionRunner(
		extensions,
		{ invalidate: () => {} } as any,
		"/work/proj",
		{ getEntries: () => [] } as any,
		{} as any,
	);
	runner.setUIContext(rawUI as any, "tui");
	const ui = runner.getUIContext() as any;

	return {
		ui,
		bus,
		notify,
		resolveSelect: (value) => resolveSelect(value),
		// The command continuation: resume after the picker resolved, announce, mount.
		mountAnnouncedViewer: async () => {
			bus.emit(NON_BLOCKING_PROMPT_CHANNEL, {});
			return ui.custom(async () => ({ render: () => [], invalidate: () => {} }), { overlay: true });
		},
		mountToolPrompt: () => {
			void ui.custom(async () => ({ render: () => [], invalidate: () => {} }), { overlay: true });
		},
		runner: { emit: (event) => runner.emit(event as any) },
	};
}

/**
 * Drive the `/subagents:sessions` shape exactly as the command does it: announce, picker,
 * announce, viewer. Both prompts are declared non-blocking, so neither may alert.
 */
async function openViewerAfterPicker(h: Harness): Promise<void> {
	h.bus.emit(NON_BLOCKING_PROMPT_CHANNEL, {});
	const pick = h.ui.select("Subagent sessions", ["agent"]);
	await flush();
	h.resolveSelect("agent");
	await pick; // resolves only after the host queued `ui_prompt_end(select)`
	// The viewer stays open (the command handler is still awaiting it), so the mount
	// promise is deliberately not awaited — same shape as the real command.
	void h.mountAnnouncedViewer();
	await flush();
}

describe("host scheduling: picker then announced viewer", () => {
	it("delivers no alert for either prompt", async () => {
		const h = createHarness();
		await openViewerAfterPicker(h);
		await vi.advanceTimersByTimeAsync(PROMPT_NOTIFY_DELAY_MS + 1000);
		expect(h.notify).not.toHaveBeenCalled();
	});

	it("delivers no alert when another extension delays the picker's end handler", async () => {
		// `emit()` awaits handlers one by one, so a slow `ui_prompt_end` lets the
		// announced `custom` start overtake it. Neither prompt may alert.
		const h = createHarness({ slowEndHandler: async () => await new Promise((r) => setTimeout(r, 50)) });
		await openViewerAfterPicker(h);
		await vi.advanceTimersByTimeAsync(PROMPT_NOTIFY_DELAY_MS + 1000);
		expect(h.notify).not.toHaveBeenCalled();
	});

	it("cancels the picker's pending alert when its end handler is delayed past the delay", async () => {
		// `emit()` awaits handlers, so another extension can hold the picker's
		// `ui_prompt_end` for longer than the 4 s delay. The non-blocking mount must drop the
		// picker's pending alert by itself instead of waiting for that end.
		const h = createHarness({ slowEndHandler: async () => await new Promise((r) => setTimeout(r, 5000)) });
		await openViewerAfterPicker(h);
		await vi.advanceTimersByTimeAsync(PROMPT_NOTIFY_DELAY_MS + 1000);
		expect(h.notify).not.toHaveBeenCalled();
	});

	it("keeps the announcement when an unrelated prompt end is delivered first", async () => {
		// A prompt end carries no identity: it may belong to a prompt that closed earlier.
		// Clearing the announcement on any end would let that stale end cancel a viewer alert.
		const h = createHarness();
		h.bus.emit(NON_BLOCKING_PROMPT_CHANNEL, {});
		await h.runner.emit({ type: "ui_prompt_end", reason: "ui_prompt", kind: "select", title: "Subagent sessions" });
		await flush();
		const viewer = h.ui.custom(async () => ({ render: () => [], invalidate: () => {} }), { overlay: true });
		void viewer;
		await flush();
		await vi.advanceTimersByTimeAsync(PROMPT_NOTIFY_DELAY_MS + 1000);
		expect(h.notify).not.toHaveBeenCalled();
	});

	it("keeps both announcements when a slow start handler delays the first one", async () => {
		// The picker's `ui_prompt_start` can still be waiting in another extension's handler when
		// the command announces the viewer. Two announcements must stay two — a single flag would
		// let the picker's start consume both and leak an alert for the viewer.
		const h = createHarness({ slowStartHandler: async () => await new Promise((r) => setTimeout(r, 50)) });
		await openViewerAfterPicker(h);
		await vi.advanceTimersByTimeAsync(PROMPT_NOTIFY_DELAY_MS + 1000);
		expect(h.notify).not.toHaveBeenCalled();
	});

	it("does not alert for a declared picker left open past the delay", async () => {
		// `/subagents:sessions` can sit on its picker for a minute while the operator reads the
		// labels; it blocks nothing, so it must stay silent. This is what pins the picker's own
		// announcement — without it the viewer's later start would still cancel the timer.
		const h = createHarness();
		h.bus.emit(NON_BLOCKING_PROMPT_CHANNEL, {});
		const pick = h.ui.select("Subagent sessions", ["agent"]);
		await flush();
		await vi.advanceTimersByTimeAsync(PROMPT_NOTIFY_DELAY_MS + 1000);
		expect(h.notify).not.toHaveBeenCalled();
		h.resolveSelect(undefined);
		await pick;
		await flush();
		expect(h.notify).not.toHaveBeenCalled();
	});

	it("still alerts for an unannounced custom prompt (interactive tool shape)", async () => {
		const h = createHarness();
		h.mountToolPrompt();
		await flush();
		await vi.advanceTimersByTimeAsync(PROMPT_NOTIFY_DELAY_MS);
		expect(h.notify).toHaveBeenCalledTimes(1);
		expect(h.notify.mock.calls[0][0].body).toContain("Interactive prompt");
	});
});
