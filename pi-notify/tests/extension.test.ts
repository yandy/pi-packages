import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension, { PROMPT_NOTIFY_DELAY_MS } from "../src/index.js";

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

const ASSISTANT_ENTRIES = [
	{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "All done." }] } },
];

function createHarness(opts?: {
	env?: NodeJS.ProcessEnv;
	sessionName?: string;
	systemPrompt?: string;
	entries?: unknown[];
	platform?: NodeJS.Platform;
}) {
	const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
	const commands: Record<string, { handler: (args: string, ctx: any) => any }> = {};
	const fakeNotifier = { notify: vi.fn(), degraded: false };
	const notifierOpts: Array<{ command: string; onError?: (message: string) => void }> = [];
	let current = 0;
	let systemPrompt = opts?.systemPrompt ?? "";
	const pi = {
		on: (event: string, handler: any) => {
			(handlers[event] ??= []).push(handler);
			return () => {};
		},
		registerCommand: (name: string, def: any) => {
			commands[name] = def;
		},
		getSessionName: () => opts?.sessionName,
	};
	const ctx = {
		cwd: "/work/proj",
		sessionManager: { getEntries: () => opts?.entries ?? ASSISTANT_ENTRIES },
		getSystemPrompt: () => systemPrompt,
		ui: { notify: vi.fn() },
	};
	extension(pi as any, {
		env: opts?.env ?? {},
		createNotifier: ((o: any) => {
			notifierOpts.push(o);
			return fakeNotifier;
		}) as any,
		now: () => current,
		pid: 4242,
		platform: opts?.platform ?? "linux",
	});
	const fire = async (event: string, payload: any = {}) => {
		for (const handler of handlers[event] ?? []) await handler({ type: event, ...payload }, ctx);
	};
	// Prompt notifications are deferred: open the prompt, then let the delay elapse as
	// an operator who never touches it would. Tests that cancel the prompt use `fire`.
	const firePrompt = async (payload: any = {}) => {
		await fire("ui_prompt_start", payload);
		await vi.advanceTimersByTimeAsync(PROMPT_NOTIFY_DELAY_MS);
	};
	return {
		handlers,
		commands,
		fakeNotifier,
		notifierOpts,
		ctx,
		fire,
		firePrompt,
		setNow: (t: number) => (current = t),
		setSystemPrompt: (value: string) => (systemPrompt = value),
	};
}

describe("ui_prompt_start", () => {
	it("notifies with instance name, prompt title, and prompt urgency", async () => {
		const h = createHarness();
		await h.fire("session_start", { reason: "startup" });
		await h.firePrompt({ kind: "confirm", title: "Dangerous?" });
		expect(h.fakeNotifier.notify).toHaveBeenCalledWith({
			title: "proj · Waiting for input",
			body: "Dangerous?\nconfirm · pid 4242",
			urgency: "critical",
		});
	});

	it("falls back to the prompt kind when title is missing or empty", async () => {
		const h = createHarness();
		await h.firePrompt({ kind: "confirm" });
		expect(h.fakeNotifier.notify).toHaveBeenCalledTimes(1);
		await h.firePrompt({ kind: "select", title: "" });
		expect(h.fakeNotifier.notify.mock.calls.map((c) => c[0].body)).toEqual([
			"confirm\npid 4242",
			"select\npid 4242",
		]);
	});

	it("never leaks the protocol word for custom prompts, which carry no title", async () => {
		// A custom prompt raised mid-run is the blocking-tool shape (ask_user and friends).
		const h = createHarness();
		await h.fire("agent_start");
		await h.firePrompt({ kind: "custom" });
		expect(h.fakeNotifier.notify.mock.calls[0][0].body).toBe("Interactive prompt\npid 4242");
	});

	it("stays silent for a read-only overlay the operator opened while idle", async () => {
		// `/todos` or `/subagents:sessions` mount their viewer through `ui.custom` and the operator
		// reads it for minutes: an open viewer is not a request for attention.
		const h = createHarness();
		await h.fire("session_start", { reason: "startup" });
		await h.firePrompt({ kind: "custom" });
		expect(h.fakeNotifier.notify).not.toHaveBeenCalled();
	});

	it("stays silent for a custom prompt after a finished run settles", async () => {
		const h = createHarness();
		await h.fire("session_start", { reason: "startup" });
		await h.fire("agent_start");
		await h.fire("agent_settled", { aborted: false });
		await h.firePrompt({ kind: "custom" });
		expect(h.fakeNotifier.notify).not.toHaveBeenCalled();
	});

	it("keeps notifying for titled dialogs while idle", async () => {
		// The idle gate is for `custom` only: a picker left open still means a stuck instance.
		const h = createHarness();
		await h.fire("session_start", { reason: "startup" });
		await h.firePrompt({ kind: "select", title: "Subagent sessions" });
		expect(h.fakeNotifier.notify).toHaveBeenCalledTimes(1);
	});

	it("notifies even before session_start (lazy init)", async () => {
		const h = createHarness();
		await h.firePrompt({ kind: "input", title: "Trust?" });
		expect(h.fakeNotifier.notify).toHaveBeenCalledTimes(1);
	});

	it("uses the session name when present", async () => {
		const h = createHarness({ sessionName: "review" });
		await h.firePrompt({ kind: "confirm", title: "OK?" });
		expect(h.fakeNotifier.notify.mock.calls[0][0]).toMatchObject({
			title: "review · Waiting for input",
			body: "OK?\nproj · confirm · pid 4242",
		});
	});

	it("does not repeat the prompt kind when it is already the title", async () => {
		const h = createHarness();
		await h.firePrompt({ kind: "confirm", title: "confirm" });
		expect(h.fakeNotifier.notify.mock.calls[0][0].body).toBe("confirm\npid 4242");
	});

	it("uses the Windows default backend and command", async () => {
		const h = createHarness({ platform: "win32" });
		await h.fire("session_start", { reason: "startup" });
		await h.firePrompt({ kind: "confirm", title: "OK?" });
		expect(h.notifierOpts[0]).toMatchObject({ command: "powershell.exe", backend: "windows-toast" });
	});
});

describe("prompt notification deferral", () => {
	it("delivers only after the delay, not when the prompt opens", async () => {
		const h = createHarness();
		await h.fire("session_start", { reason: "startup" });
		await h.fire("ui_prompt_start", { kind: "confirm", title: "Dangerous?" });
		expect(h.fakeNotifier.notify).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(PROMPT_NOTIFY_DELAY_MS - 1);
		expect(h.fakeNotifier.notify).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(h.fakeNotifier.notify).toHaveBeenCalledWith({
			title: "proj · Waiting for input",
			body: "Dangerous?\nconfirm · pid 4242",
			urgency: "critical",
		});
	});

	it("drops the notification when the prompt settles first", async () => {
		// An extension command that opens its own picker (`/subagents:sessions`) and an
		// operator who answers it right away must never produce a desktop alert.
		const h = createHarness();
		await h.fire("session_start", { reason: "startup" });
		await h.fire("ui_prompt_start", { kind: "select", title: "Subagent sessions" });
		await vi.advanceTimersByTimeAsync(200);
		await h.fire("ui_prompt_end", { kind: "select", title: "Subagent sessions" });
		await vi.advanceTimersByTimeAsync(PROMPT_NOTIFY_DELAY_MS * 2);
		expect(h.fakeNotifier.notify).not.toHaveBeenCalled();
	});

	it("keeps a single pending notification when prompts replace each other", async () => {
		const h = createHarness();
		await h.fire("session_start", { reason: "startup" });
		await h.fire("ui_prompt_start", { kind: "select", title: "First" });
		await vi.advanceTimersByTimeAsync(1000);
		await h.fire("ui_prompt_start", { kind: "select", title: "Second" });
		await vi.advanceTimersByTimeAsync(1000);
		expect(h.fakeNotifier.notify).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(PROMPT_NOTIFY_DELAY_MS);
		expect(h.fakeNotifier.notify).toHaveBeenCalledTimes(1);
		expect(h.fakeNotifier.notify.mock.calls[0][0].body).toBe("Second\nselect · pid 4242");
	});

	it("re-checks the toggle before delivery", async () => {
		const h = createHarness();
		await h.fire("session_start", { reason: "startup" });
		await h.fire("ui_prompt_start", { kind: "confirm", title: "Q" });
		await h.commands.notify.handler("", h.ctx);
		await vi.advanceTimersByTimeAsync(PROMPT_NOTIFY_DELAY_MS);
		expect(h.fakeNotifier.notify).not.toHaveBeenCalled();
	});

	it("delivers when notifications are re-enabled before the timer fires", async () => {
		const h = createHarness({ env: { PI_NOTIFY: "0" } });
		await h.fire("session_start", { reason: "startup" });
		await h.commands.notify.handler("", h.ctx);
		await h.fire("ui_prompt_start", { kind: "confirm", title: "Q" });
		await h.commands.notify.handler("", h.ctx);
		await h.commands.notify.handler("", h.ctx);
		await vi.advanceTimersByTimeAsync(PROMPT_NOTIFY_DELAY_MS);
		expect(h.fakeNotifier.notify).toHaveBeenCalledTimes(1);
	});

	it("keeps the alert for a prompt still open when the session starts underneath it", async () => {
		// Pi emits the startup prompt (project trust) before session_start. session_start must not
		// cancel or unmount the alert: nothing about a session starting means the prompt was answered.
		const h = createHarness();
		await h.fire("ui_prompt_start", { kind: "input", title: "Trust?" });
		await vi.advanceTimersByTimeAsync(1000);
		await h.fire("session_start", { reason: "startup" });
		await vi.advanceTimersByTimeAsync(PROMPT_NOTIFY_DELAY_MS);
		expect(h.fakeNotifier.notify).toHaveBeenCalledTimes(1);
		expect(h.fakeNotifier.notify.mock.calls[0][0].body).toBe("Trust?\ninput · pid 4242");
	});

	it("discards a pending prompt on session replacement", async () => {
		const h = createHarness();
		await h.fire("session_start", { reason: "startup" });
		await h.fire("ui_prompt_start", { kind: "confirm", title: "Q" });
		// The host emits session_shutdown on the outgoing runner before a replacement starts.
		await h.fire("session_shutdown", { reason: "resume" });
		await h.fire("session_start", { reason: "resume" });
		await vi.advanceTimersByTimeAsync(PROMPT_NOTIFY_DELAY_MS);
		expect(h.fakeNotifier.notify).not.toHaveBeenCalled();
	});

	it("discards a pending prompt on session shutdown", async () => {
		const h = createHarness();
		await h.fire("session_start", { reason: "startup" });
		await h.fire("ui_prompt_start", { kind: "confirm", title: "Q" });
		await h.fire("session_shutdown", { reason: "quit" });
		await vi.advanceTimersByTimeAsync(PROMPT_NOTIFY_DELAY_MS);
		expect(h.fakeNotifier.notify).not.toHaveBeenCalled();
	});
});

describe("agent_settled", () => {
	it("skips runs shorter than the threshold", async () => {
		const h = createHarness();
		h.setNow(0);
		await h.fire("agent_start");
		h.setNow(9999);
		await h.fire("agent_settled", { aborted: false });
		expect(h.fakeNotifier.notify).not.toHaveBeenCalled();
	});

	it("notifies at exactly the threshold, timed from the first agent_start", async () => {
		const h = createHarness();
		h.setNow(10000);
		await h.fire("agent_start");
		h.setNow(15000);
		await h.fire("agent_start");
		h.setNow(20000);
		await h.fire("agent_settled", { aborted: false });
		expect(h.fakeNotifier.notify).toHaveBeenCalledTimes(1);
		expect(h.fakeNotifier.notify).toHaveBeenCalledWith({
			title: "proj · Finished · 10s",
			body: "All done.\npid 4242",
			urgency: "normal",
		});
	});

	it("skips aborted runs and resets the timer", async () => {
		const h = createHarness();
		h.setNow(0);
		await h.fire("agent_start");
		h.setNow(20000);
		await h.fire("agent_settled", { aborted: true });
		expect(h.fakeNotifier.notify).not.toHaveBeenCalled();
		h.setNow(30000);
		await h.fire("agent_settled", { aborted: false });
		expect(h.fakeNotifier.notify).not.toHaveBeenCalled();
	});

	it("notifies without agent_start when the threshold is 0", async () => {
		const h = createHarness({ env: { PI_NOTIFY_MIN_DURATION_MS: "0" } });
		await h.fire("agent_settled", { aborted: false });
		expect(h.fakeNotifier.notify).toHaveBeenCalledTimes(1);
	});

	it("uses context as the body when there is no assistant text", async () => {
		const h = createHarness({ env: { PI_NOTIFY_MIN_DURATION_MS: "0" }, entries: [] });
		await h.fire("agent_settled", { aborted: false });
		expect(h.fakeNotifier.notify.mock.calls[0][0].body).toBe("pid 4242");
	});
});

describe("active-agent session suppression", () => {
	const markedPrompts = [
		[
			"append-style",
			'<sub_agent_context>\nYou are operating as a sub-agent.\n</sub_agent_context>\n\n<active_agent name="general-purpose"/>\n\n# Environment',
		],
		["replace-style", '<active_agent name="Explore"/>\n\n# Environment\n\nRead only.'],
	] as const;

	it.each(markedPrompts)("suppresses prompt and completion notifications for %s prompts", async (_kind, systemPrompt) => {
		const h = createHarness({ env: { PI_NOTIFY_MIN_DURATION_MS: "0" }, systemPrompt });
		await h.fire("session_start", { reason: "startup" });
		await h.firePrompt({ kind: "confirm", title: "Q" });
		await h.fire("agent_settled", { aborted: false });
		expect(h.fakeNotifier.notify).not.toHaveBeenCalled();
		expect(h.notifierOpts).toHaveLength(0);
	});

	it("suppresses marked prompts before session_start without constructing a notifier", async () => {
		const h = createHarness({ systemPrompt: '<active_agent name="Explore"/>\n\n# Environment' });
		await h.firePrompt({ kind: "confirm", title: "Q" });
		expect(h.fakeNotifier.notify).not.toHaveBeenCalled();
		expect(h.notifierOpts).toHaveLength(0);
	});

	it("does not suppress natural-language subagent text without the marker", async () => {
		const h = createHarness({
			env: { PI_NOTIFY_MIN_DURATION_MS: "0" },
			systemPrompt: "You are operating as a sub-agent invoked to handle a specific task.",
		});
		await h.fire("session_start", { reason: "startup" });
		await h.firePrompt({ kind: "confirm", title: "Q" });
		await h.fire("agent_settled", { aborted: false });
		expect(h.fakeNotifier.notify).toHaveBeenCalledTimes(2);
	});

	it("recomputes suppression on session_start", async () => {
		const h = createHarness({ systemPrompt: '<active_agent name="Explore"/>' });
		await h.fire("session_start", { reason: "startup" });
		await h.firePrompt({ kind: "confirm", title: "Q" });
		expect(h.fakeNotifier.notify).not.toHaveBeenCalled();

		h.setSystemPrompt("");
		await h.fire("session_start", { reason: "reload" });
		await h.firePrompt({ kind: "confirm", title: "Q" });
		expect(h.fakeNotifier.notify).toHaveBeenCalledTimes(1);
	});

	it("does not let /notify override suppression", async () => {
		const h = createHarness({
			env: { PI_NOTIFY: "0", PI_NOTIFY_MIN_DURATION_MS: "0" },
			systemPrompt: '<active_agent name="Explore"/>',
		});
		await h.fire("session_start", { reason: "startup" });
		await h.commands.notify.handler("", h.ctx);
		expect(h.ctx.ui.notify).toHaveBeenCalledWith("Notifications enabled", "info");

		await h.firePrompt({ kind: "confirm", title: "Q" });
		await h.fire("agent_settled", { aborted: false });
		expect(h.fakeNotifier.notify).not.toHaveBeenCalled();
	});
});

describe("custom-message run suppression", () => {
	it("suppresses completion for an idle custom-message run", async () => {
		const h = createHarness({ env: { PI_NOTIFY_MIN_DURATION_MS: "0" } });
		await h.fire("session_start", { reason: "startup" });
		await h.fire("before_agent_start", { messageType: "custom" });
		await h.fire("agent_settled", { aborted: false });
		expect(h.fakeNotifier.notify).not.toHaveBeenCalled();
		expect(h.notifierOpts).toHaveLength(0);
	});

	it("resets custom origin and timing before the next user run", async () => {
		const h = createHarness();
		h.setNow(0);
		await h.fire("session_start", { reason: "startup" });
		await h.fire("before_agent_start", { messageType: "custom" });
		await h.fire("agent_start");
		h.setNow(20000);
		await h.fire("agent_settled", { aborted: false });
		expect(h.fakeNotifier.notify).not.toHaveBeenCalled();

		h.setNow(30000);
		await h.fire("before_agent_start", { messageType: "user" });
		await h.fire("agent_start");
		h.setNow(40000);
		await h.fire("agent_settled", { aborted: false });
		expect(h.fakeNotifier.notify).toHaveBeenCalledTimes(1);
		expect(h.fakeNotifier.notify).toHaveBeenCalledWith({
			title: "proj · Finished · 10s",
			body: "All done.\npid 4242",
			urgency: "normal",
		});
	});

	it("preserves user origin across queued follow-ups and low-level continuations", async () => {
		const h = createHarness();
		h.setNow(0);
		await h.fire("session_start", { reason: "startup" });
		await h.fire("before_agent_start", { messageType: "user" });
		await h.fire("agent_start");
		h.setNow(10000);
		await h.fire("agent_start");
		h.setNow(20000);
		await h.fire("agent_settled", { aborted: false });
		expect(h.fakeNotifier.notify).toHaveBeenCalledTimes(1);
		expect(h.fakeNotifier.notify).toHaveBeenCalledWith({
			title: "proj · Finished · 20s",
			body: "All done.\npid 4242",
			urgency: "normal",
		});
	});
});

describe("/notify command", () => {
	it("stays silent when disabled by env, and the command overrides it", async () => {
		const h = createHarness({ env: { PI_NOTIFY: "0", PI_NOTIFY_MIN_DURATION_MS: "0" } });
		await h.fire("session_start", { reason: "startup" });
		await h.firePrompt({ kind: "confirm", title: "Q" });
		await h.fire("agent_settled", { aborted: false });
		expect(h.fakeNotifier.notify).not.toHaveBeenCalled();

		await h.commands.notify.handler("", h.ctx);
		expect(h.ctx.ui.notify).toHaveBeenCalledWith("Notifications enabled", "info");
		await h.firePrompt({ kind: "confirm", title: "Q" });
		expect(h.fakeNotifier.notify).toHaveBeenCalledTimes(1);

		await h.commands.notify.handler("", h.ctx);
		expect(h.ctx.ui.notify).toHaveBeenCalledWith("Notifications disabled", "info");
		await h.firePrompt({ kind: "confirm", title: "Q" });
		expect(h.fakeNotifier.notify).toHaveBeenCalledTimes(1);
	});

	it("session_start resets the toggle to the env default", async () => {
		const h = createHarness();
		await h.fire("session_start", { reason: "startup" });
		await h.commands.notify.handler("", h.ctx);
		await h.firePrompt({ kind: "confirm", title: "Q" });
		expect(h.fakeNotifier.notify).not.toHaveBeenCalled();
		await h.fire("session_start", { reason: "reload" });
		await h.firePrompt({ kind: "confirm", title: "Q" });
		expect(h.fakeNotifier.notify).toHaveBeenCalledTimes(1);
	});
});

describe("degradation", () => {
	it("reports notifier failure via ctx.ui.notify as a warning", async () => {
		const h = createHarness();
		await h.firePrompt({ kind: "confirm", title: "Q" });
		h.notifierOpts[0].onError?.("spawn ENOENT");
		expect(h.ctx.ui.notify).toHaveBeenCalledWith("spawn ENOENT", "warning");
	});
});
