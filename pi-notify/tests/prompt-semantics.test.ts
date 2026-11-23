import {
	createEventBus,
	createExtensionRuntime,
	type EventBus,
	type Extension,
	type ExtensionAPI,
	ExtensionRunner,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import notifyExtension, { PROMPT_NOTIFY_DELAY_MS } from "../src/index.js";

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function extensionRecord(path: string) {
	return {
		path,
		resolvedPath: path,
		sourceInfo: { path },
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	} as unknown as Extension;
}

function createHarness(opts?: {
	env?: NodeJS.ProcessEnv;
	beforePromptStart?: () => Promise<void>;
	beforePromptEnd?: () => Promise<void>;
}) {
	const events = createEventBus();
	const runtime = createExtensionRuntime();
	const cwd = "/work/proj";
	const notifyExt = extensionRecord("pi-notify");
	const fakeNotifier = { notify: vi.fn(), degraded: false };
	const notifierOpts: unknown[] = [];
	const deferreds = new Set<Deferred<unknown>>();
	const promptDeferreds: Array<Deferred<unknown>> = [];
	const defer = <T,>(): Deferred<T> => {
		const d = deferred<T>();
		deferreds.add(d as Deferred<unknown>);
		return d;
	};
	const track = <T,>(d: Deferred<T>): Deferred<T> => {
		deferreds.add(d as Deferred<unknown>);
		return d;
	};
	const openPrompt = () => {
		const d = defer<unknown>();
		promptDeferreds.push(d);
		return d.promise;
	};
	const rawUI = {
		select: vi.fn(openPrompt),
		confirm: vi.fn(openPrompt),
		input: vi.fn(openPrompt),
		editor: vi.fn(openPrompt),
		custom: vi.fn(openPrompt),
		notify: vi.fn(),
	};
	const pi = {
		on: (event: string, handler: unknown) => {
			const handlers = notifyExt.handlers.get(event) ?? [];
			handlers.push(handler);
			notifyExt.handlers.set(event, handlers);
			return () => {};
		},
		registerCommand: (name: string, definition: Record<string, unknown>) => {
			notifyExt.commands.set(name, { name, sourceInfo: { path: "pi-notify" }, ...definition });
		},
		getSessionName: () => undefined,
		events,
	};
	notifyExtension(pi as unknown as ExtensionAPI, {
		env: opts?.env ?? {},
		createNotifier: ((options: unknown) => {
			notifierOpts.push(options);
			return fakeNotifier;
		}) as never,
		now: () => 0,
		pid: 4242,
		platform: "linux",
	});

	const extensions: Extension[] = [];
	if (opts?.beforePromptStart || opts?.beforePromptEnd) {
		const earlier = extensionRecord("earlier-extension");
		if (opts.beforePromptStart) earlier.handlers.set("ui_prompt_start", [opts.beforePromptStart]);
		if (opts.beforePromptEnd) earlier.handlers.set("ui_prompt_end", [opts.beforePromptEnd]);
		extensions.push(earlier);
	}
	extensions.push(notifyExt);
	const runner = new ExtensionRunner(
		extensions,
		runtime,
		cwd,
		SessionManager.inMemory(cwd),
		{} as ConstructorParameters<typeof ExtensionRunner>[4],
	);
	runner.bindCore(
		{
			sendMessage: vi.fn(),
			sendUserMessage: vi.fn(),
			appendEntry: vi.fn(),
			setSessionName: vi.fn(),
			getSessionName: () => undefined,
			setLabel: vi.fn(),
			getActiveTools: () => [],
			getAllTools: () => [],
			getSettings: () => ({}),
			setActiveTools: vi.fn(),
			refreshTools: vi.fn(),
			getCommands: () => [],
			setModel: vi.fn(),
			getThinkingLevel: () => "off",
			setThinkingLevel: vi.fn(),
		},
		{
			getModel: () => undefined,
			getScopedModels: () => [],
			isIdle: () => true,
			isProjectTrusted: () => true,
			getSignal: () => undefined,
			abort: vi.fn(),
			hasPendingMessages: () => false,
			shutdown: vi.fn(),
			getContextUsage: () => undefined,
			compact: vi.fn(),
			getSystemPrompt: () => "",
		},
	);
	runner.setUIContext(rawUI as never, "tui");
	const ui = runner.getUIContext();

	const flushPromptEvents = async () => {
		// Only host microtasks are pending here; no filesystem or other real I/O is involved.
		await vi.advanceTimersByTimeAsync(0);
		await Promise.resolve();
	};
	const resolvePrompt = async (index: number) => {
		promptDeferreds[index].resolve(undefined);
		await flushPromptEvents();
	};
	const releaseAll = async () => {
		for (const d of deferreds) d.resolve(undefined);
		await flushPromptEvents();
		events.clear();
	};

	return {
		events,
		runner,
		ui,
		rawUI,
		fakeNotifier,
		notifierOpts,
		defer,
		track,
		flushPromptEvents,
		resolvePrompt,
		releaseAll,
		declare: () => events.emit("notify:non-blocking-prompt", {}),
		openBlocking: () => ui.confirm("Dangerous?", "Continue?"),
		openNonBlocking: () => {
			events.emit("notify:non-blocking-prompt", {});
			return ui.custom(() => ({}) as never);
		},
	};
}

let harnesses: Array<ReturnType<typeof createHarness>> = [];
function harness(opts?: Parameters<typeof createHarness>[0]) {
	const h = createHarness(opts);
	harnesses.push(h);
	return h;
}

beforeEach(() => {
	vi.useFakeTimers();
	harnesses = [];
});

afterEach(async () => {
	for (const h of harnesses) await h.releaseAll();
	vi.useRealTimers();
});

describe("blocking prompt semantics through ExtensionRunner", () => {
	it("notifies for an undeclared blocking prompt after the delay", async () => {
		const h = harness();
		const prompt = h.openBlocking();
		await h.flushPromptEvents();
		await vi.advanceTimersByTimeAsync(PROMPT_NOTIFY_DELAY_MS - 1);
		expect(h.fakeNotifier.notify).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(h.fakeNotifier.notify).toHaveBeenCalledTimes(1);
		await h.resolvePrompt(0);
		await prompt;
	});

	it("suppresses a declared non-blocking prompt that remains open without constructing a notifier", async () => {
		const h = harness();
		const prompt = h.openNonBlocking();
		await h.flushPromptEvents();
		await vi.advanceTimersByTimeAsync(PROMPT_NOTIFY_DELAY_MS * 2);
		expect(h.fakeNotifier.notify).not.toHaveBeenCalled();
		expect(h.notifierOpts).toHaveLength(0);
		await h.resolvePrompt(0);
		await prompt;
	});

	it("ignores a declared prompt whose start is still queued at session_shutdown", async () => {
		const h = harness();
		const prompt = h.openNonBlocking();
		await h.runner.emit({ type: "session_shutdown", reason: "quit" });
		await vi.advanceTimersByTimeAsync(PROMPT_NOTIFY_DELAY_MS * 2);
		expect(h.fakeNotifier.notify).not.toHaveBeenCalled();
		expect(h.notifierOpts).toHaveLength(0);
		await h.resolvePrompt(0);
		await prompt;
	});

	it("consumes one declaration per start when an earlier prompt handler is delayed", async () => {
		const gate = deferred<void>();
		const h = harness({ beforePromptStart: () => gate.promise });
		h.track(gate);

		h.declare();
		const first = h.ui.select("First", ["one"]);
		await h.flushPromptEvents();
		await h.resolvePrompt(0);
		await first;
		h.declare();
		const second = h.ui.select("Second", ["two"]);
		await h.flushPromptEvents();
		gate.resolve(undefined);
		await vi.advanceTimersByTimeAsync(PROMPT_NOTIFY_DELAY_MS * 2);
		expect(h.fakeNotifier.notify).not.toHaveBeenCalled();
		await h.resolvePrompt(1);
		await second;
	});

	it("does not discard an unused declaration on an unrelated ui_prompt_end", async () => {
		const gate = deferred<void>();
		const h = harness({ beforePromptStart: () => gate.promise });
		h.track(gate);

		const prompt = h.openNonBlocking();
		await h.flushPromptEvents();
		await h.runner.emit({ type: "ui_prompt_end", reason: "ui_prompt", kind: "select", title: "Earlier" });
		gate.resolve(undefined);
		await vi.advanceTimersByTimeAsync(PROMPT_NOTIFY_DELAY_MS * 2);
		expect(h.fakeNotifier.notify).not.toHaveBeenCalled();
		await h.resolvePrompt(0);
		await prompt;
	});

	it("cancels an earlier pending alert when a declared prompt starts", async () => {
		const gate = deferred<void>();
		const h = harness({ beforePromptEnd: () => gate.promise });
		h.track(gate);

		const blocking = h.openBlocking();
		await h.flushPromptEvents();
		await h.resolvePrompt(0);
		await blocking;
		const nonBlocking = h.openNonBlocking();
		await h.flushPromptEvents();
		await vi.advanceTimersByTimeAsync(PROMPT_NOTIFY_DELAY_MS * 2);
		expect(h.fakeNotifier.notify).not.toHaveBeenCalled();
		await h.resolvePrompt(1);
		await nonBlocking;
		gate.resolve(undefined);
	});

	it("consumes declarations while notifications are disabled", async () => {
		const h = harness({ env: { PI_NOTIFY: "0" } });
		const nonBlocking = h.openNonBlocking();
		await h.flushPromptEvents();
		await h.resolvePrompt(0);
		await nonBlocking;
		await h.runner.getCommand("notify")?.handler("", h.runner.createCommandContext());

		const blocking = h.openBlocking();
		await h.flushPromptEvents();
		await vi.advanceTimersByTimeAsync(PROMPT_NOTIFY_DELAY_MS);
		expect(h.fakeNotifier.notify).toHaveBeenCalledTimes(1);
		await h.resolvePrompt(1);
		await blocking;
	});

	it("clears an unpaired declaration on session_shutdown", async () => {
		const h = harness();
		h.declare();
		await h.runner.emit({ type: "session_shutdown", reason: "quit" });
		await h.runner.emit({ type: "session_start", reason: "reload" });
		const blocking = h.openBlocking();
		await h.flushPromptEvents();
		await vi.advanceTimersByTimeAsync(PROMPT_NOTIFY_DELAY_MS);
		expect(h.fakeNotifier.notify).toHaveBeenCalledTimes(1);
		await h.resolvePrompt(0);
		await blocking;
	});
});
