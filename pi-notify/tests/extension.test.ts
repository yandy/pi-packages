import { basename } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";

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
	const events = createEventBus();
	const emitSpy = vi.spyOn(events, "emit");
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
		events,
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
	return {
		handlers,
		commands,
		fakeNotifier,
		notifierOpts,
		ctx,
		events,
		fire,
		emitRequest: (payload: unknown) => events.emit("notify:request", payload),
		emitSpy,
		setNow: (t: number) => (current = t),
		setSystemPrompt: (value: string) => (systemPrompt = value),
	};
}

describe("notify:request", () => {
	it("delivers a valid request immediately with instance context", async () => {
		const h = createHarness();
		await h.fire("session_start", { reason: "startup" });
		h.emitRequest({ title: "Approval required", body: "Dangerous?", urgency: "critical" });
		expect(h.fakeNotifier.notify).toHaveBeenCalledExactlyOnceWith({
			title: "proj · Approval required",
			body: "Dangerous?\npid 4242",
			urgency: "critical",
		});
	});

	it("defaults urgency to normal and an omitted body to context only", async () => {
		const h = createHarness();
		await h.fire("session_start", { reason: "startup" });
		h.emitRequest({ title: "Notice" });
		expect(h.fakeNotifier.notify).toHaveBeenCalledExactlyOnceWith({
			title: "proj · Notice",
			body: "pid 4242",
			urgency: "normal",
		});
	});

	it("adds a distinct project name to a named session", async () => {
		const h = createHarness({ sessionName: "review" });
		await h.fire("session_start", { reason: "startup" });
		h.emitRequest({ title: "Question", body: "Continue?" });
		expect(h.fakeNotifier.notify).toHaveBeenCalledExactlyOnceWith({
			title: "review · Question",
			body: "Continue?\nproj · pid 4242",
			urgency: "normal",
		});
	});

	it("preserves a multiline body and appends context exactly once", () => {
		const h = createHarness();
		h.emitRequest({ title: "Details", body: "First line\nSecond line\n" });
		expect(h.fakeNotifier.notify.mock.calls[0][0].body).toBe("First line\nSecond line\n\npid 4242");
	});

	it("drops invalid requests without constructing a notifier", () => {
		const h = createHarness();
		for (const payload of [null, [], {}, { title: " " }, { title: "Q", body: 1 }, { title: "Q", urgency: "urgent" }]) {
			h.emitRequest(payload);
		}
		expect(h.fakeNotifier.notify).not.toHaveBeenCalled();
		expect(h.notifierOpts).toHaveLength(0);
	});

	it("ignores host prompt events", async () => {
		const h = createHarness();
		await h.fire("ui_prompt_start", { kind: "confirm", title: "Dangerous?" });
		await h.fire("ui_prompt_end", { kind: "confirm", title: "Dangerous?" });
		expect(h.fakeNotifier.notify).not.toHaveBeenCalled();
		expect(h.notifierOpts).toHaveLength(0);
	});

	it("does not let a legacy declaration consume an explicit request", () => {
		const h = createHarness();
		h.events.emit("notify:non-blocking-prompt", {});
		h.emitRequest({ title: "Explicit" });
		expect(h.fakeNotifier.notify).toHaveBeenCalledTimes(1);
	});

	it("drops requests while disabled and after shutdown, then reopens on session start", async () => {
		const h = createHarness({ env: { PI_NOTIFY: "0" } });
		await h.fire("session_start", { reason: "startup" });
		h.emitRequest({ title: "Disabled" });
		expect(h.fakeNotifier.notify).not.toHaveBeenCalled();

		await h.commands.notify.handler("", h.ctx);
		h.emitRequest({ title: "Enabled" });
		expect(h.fakeNotifier.notify).toHaveBeenCalledTimes(1);

		await h.fire("session_shutdown", { reason: "quit" });
		h.emitRequest({ title: "Closed" });
		expect(h.fakeNotifier.notify).toHaveBeenCalledTimes(1);

		await h.fire("session_start", { reason: "startup" });
		await h.commands.notify.handler("", h.ctx);
		h.emitRequest({ title: "Reopened" });
		expect(h.fakeNotifier.notify).toHaveBeenCalledTimes(2);
	});

	it("uses process cwd for a request before session_start", () => {
		const h = createHarness();
		h.emitRequest({ title: "Startup" });
		const project = basename(process.cwd());
		expect(h.fakeNotifier.notify).toHaveBeenCalledExactlyOnceWith({
			title: `${project} · Startup`,
			body: "pid 4242",
			urgency: "normal",
		});
	});

	it("does not apply active-agent or custom-run suppression to explicit requests", async () => {
		const h = createHarness({ systemPrompt: '<active_agent name="Explore"/>' });
		await h.fire("session_start", { reason: "startup" });
		await h.fire("before_agent_start", { messageType: "custom" });
		h.emitRequest({ title: "Explicit" });
		expect(h.fakeNotifier.notify).toHaveBeenCalledTimes(1);
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
		expect(h.fakeNotifier.notify).toHaveBeenCalledExactlyOnceWith({
			title: "proj · Finished · 10s",
			body: "All done.\npid 4242",
			urgency: "normal",
		});
		expect(h.emitSpy).not.toHaveBeenCalledWith("notify:request", expect.anything());
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

describe("active-agent completion suppression", () => {
	const markedPrompts = [
		[
			"append-style",
			'<sub_agent_context>\nYou are operating as a sub-agent.\n</sub_agent_context>\n\n<active_agent name="general-purpose"/>\n\n# Environment',
		],
		["replace-style", '<active_agent name="Explore"/>\n\n# Environment\n\nRead only.'],
	] as const;

	it.each(markedPrompts)("suppresses completion notifications for %s prompts", async (_kind, systemPrompt) => {
		const h = createHarness({ env: { PI_NOTIFY_MIN_DURATION_MS: "0" }, systemPrompt });
		await h.fire("session_start", { reason: "startup" });
		await h.fire("agent_settled", { aborted: false });
		expect(h.fakeNotifier.notify).not.toHaveBeenCalled();
		expect(h.notifierOpts).toHaveLength(0);
	});

	it("does not suppress natural-language subagent text without the marker", async () => {
		const h = createHarness({
			env: { PI_NOTIFY_MIN_DURATION_MS: "0" },
			systemPrompt: "You are operating as a sub-agent invoked to handle a specific task.",
		});
		await h.fire("session_start", { reason: "startup" });
		await h.fire("agent_settled", { aborted: false });
		expect(h.fakeNotifier.notify).toHaveBeenCalledTimes(1);
	});

	it("recomputes suppression on session_start", async () => {
		const h = createHarness({ env: { PI_NOTIFY_MIN_DURATION_MS: "0" }, systemPrompt: '<active_agent name="Explore"/>' });
		await h.fire("session_start", { reason: "startup" });
		await h.fire("agent_settled", { aborted: false });
		expect(h.fakeNotifier.notify).not.toHaveBeenCalled();

		h.setSystemPrompt("");
		await h.fire("session_start", { reason: "reload" });
		await h.fire("agent_settled", { aborted: false });
		expect(h.fakeNotifier.notify).toHaveBeenCalledTimes(1);
	});

	it("does not let /notify override completion suppression", async () => {
		const h = createHarness({
			env: { PI_NOTIFY: "0", PI_NOTIFY_MIN_DURATION_MS: "0" },
			systemPrompt: '<active_agent name="Explore"/>',
		});
		await h.fire("session_start", { reason: "startup" });
		await h.commands.notify.handler("", h.ctx);
		expect(h.ctx.ui.notify).toHaveBeenCalledWith("Notifications enabled", "info");
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
		expect(h.fakeNotifier.notify).toHaveBeenCalledExactlyOnceWith({
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
		expect(h.fakeNotifier.notify).toHaveBeenCalledExactlyOnceWith({
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
		h.emitRequest({ title: "Q" });
		await h.fire("agent_settled", { aborted: false });
		expect(h.fakeNotifier.notify).not.toHaveBeenCalled();

		await h.commands.notify.handler("", h.ctx);
		expect(h.ctx.ui.notify).toHaveBeenCalledWith("Notifications enabled", "info");
		h.emitRequest({ title: "Q" });
		expect(h.fakeNotifier.notify).toHaveBeenCalledTimes(1);

		await h.commands.notify.handler("", h.ctx);
		expect(h.ctx.ui.notify).toHaveBeenCalledWith("Notifications disabled", "info");
		h.emitRequest({ title: "Q" });
		expect(h.fakeNotifier.notify).toHaveBeenCalledTimes(1);
	});

	it("session_start resets the toggle to the env default", async () => {
		const h = createHarness();
		await h.fire("session_start", { reason: "startup" });
		await h.commands.notify.handler("", h.ctx);
		h.emitRequest({ title: "Q" });
		expect(h.fakeNotifier.notify).not.toHaveBeenCalled();
		await h.fire("session_start", { reason: "reload" });
		h.emitRequest({ title: "Q" });
		expect(h.fakeNotifier.notify).toHaveBeenCalledTimes(1);
	});
});

describe("degradation", () => {
	it("reports notifier failure via ctx.ui.notify as a warning", async () => {
		const h = createHarness();
		await h.fire("session_start", { reason: "startup" });
		h.emitRequest({ title: "Q" });
		h.notifierOpts[0].onError?.("spawn ENOENT");
		expect(h.ctx.ui.notify).toHaveBeenCalledWith("spawn ENOENT", "warning");
	});
});
