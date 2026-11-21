import { beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";

const ASSISTANT_ENTRIES = [
	{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "All done." }] } },
];

function createHarness(opts?: {
	env?: NodeJS.ProcessEnv;
	sessionName?: string;
	entries?: unknown[];
	platform?: NodeJS.Platform;
}) {
	const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
	const commands: Record<string, { handler: (args: string, ctx: any) => any }> = {};
	const fakeNotifier = { notify: vi.fn(), degraded: false };
	const notifierOpts: Array<{ command: string; onError?: (message: string) => void }> = [];
	let current = 0;
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
	return { handlers, commands, fakeNotifier, notifierOpts, ctx, fire, setNow: (t: number) => (current = t) };
}

describe("ui_prompt_start", () => {
	it("notifies with instance name, prompt title, and prompt urgency", async () => {
		const h = createHarness();
		await h.fire("session_start", { reason: "startup" });
		await h.fire("ui_prompt_start", { kind: "confirm", title: "Dangerous?" });
		expect(h.fakeNotifier.notify).toHaveBeenCalledWith({
			title: "proj · Waiting for input",
			body: "Dangerous?\nconfirm · pid 4242",
			urgency: "critical",
		});
	});

	it("falls back to the prompt kind when title is missing or empty", async () => {
		const h = createHarness();
		await h.fire("ui_prompt_start", { kind: "confirm" });
		await h.fire("ui_prompt_start", { kind: "select", title: "" });
		expect(h.fakeNotifier.notify.mock.calls.map((c) => c[0].body)).toEqual([
			"confirm\npid 4242",
			"select\npid 4242",
		]);
	});

	it("never leaks the protocol word for custom prompts, which carry no title", async () => {
		const h = createHarness();
		await h.fire("ui_prompt_start", { kind: "custom" });
		expect(h.fakeNotifier.notify.mock.calls[0][0].body).toBe("Interactive prompt\npid 4242");
	});

	it("notifies even before session_start (lazy init)", async () => {
		const h = createHarness();
		await h.fire("ui_prompt_start", { kind: "input", title: "Trust?" });
		expect(h.fakeNotifier.notify).toHaveBeenCalledTimes(1);
	});

	it("uses the session name when present", async () => {
		const h = createHarness({ sessionName: "review" });
		await h.fire("ui_prompt_start", { kind: "confirm", title: "OK?" });
		expect(h.fakeNotifier.notify.mock.calls[0][0]).toMatchObject({
			title: "review · Waiting for input",
			body: "OK?\nproj · confirm · pid 4242",
		});
	});

	it("does not repeat the prompt kind when it is already the title", async () => {
		const h = createHarness();
		await h.fire("ui_prompt_start", { kind: "confirm", title: "confirm" });
		expect(h.fakeNotifier.notify.mock.calls[0][0].body).toBe("confirm\npid 4242");
	});

	it("uses the Windows default backend and command", async () => {
		const h = createHarness({ platform: "win32" });
		await h.fire("session_start", { reason: "startup" });
		await h.fire("ui_prompt_start", { kind: "confirm", title: "OK?" });
		expect(h.notifierOpts[0]).toMatchObject({ command: "powershell.exe", backend: "windows-toast" });
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

describe("/notify command", () => {
	it("stays silent when disabled by env, and the command overrides it", async () => {
		const h = createHarness({ env: { PI_NOTIFY: "0", PI_NOTIFY_MIN_DURATION_MS: "0" } });
		await h.fire("session_start", { reason: "startup" });
		await h.fire("ui_prompt_start", { kind: "confirm", title: "Q" });
		await h.fire("agent_settled", { aborted: false });
		expect(h.fakeNotifier.notify).not.toHaveBeenCalled();

		await h.commands.notify.handler("", h.ctx);
		expect(h.ctx.ui.notify).toHaveBeenCalledWith("Notifications enabled", "info");
		await h.fire("ui_prompt_start", { kind: "confirm", title: "Q" });
		expect(h.fakeNotifier.notify).toHaveBeenCalledTimes(1);

		await h.commands.notify.handler("", h.ctx);
		expect(h.ctx.ui.notify).toHaveBeenCalledWith("Notifications disabled", "info");
		await h.fire("ui_prompt_start", { kind: "confirm", title: "Q" });
		expect(h.fakeNotifier.notify).toHaveBeenCalledTimes(1);
	});

	it("session_start resets the toggle to the env default", async () => {
		const h = createHarness();
		await h.fire("session_start", { reason: "startup" });
		await h.commands.notify.handler("", h.ctx);
		await h.fire("ui_prompt_start", { kind: "confirm", title: "Q" });
		expect(h.fakeNotifier.notify).not.toHaveBeenCalled();
		await h.fire("session_start", { reason: "reload" });
		await h.fire("ui_prompt_start", { kind: "confirm", title: "Q" });
		expect(h.fakeNotifier.notify).toHaveBeenCalledTimes(1);
	});
});

describe("degradation", () => {
	it("reports notifier failure via ctx.ui.notify as a warning", async () => {
		const h = createHarness();
		await h.fire("ui_prompt_start", { kind: "confirm", title: "Q" });
		h.notifierOpts[0].onError?.("spawn ENOENT");
		expect(h.ctx.ui.notify).toHaveBeenCalledWith("spawn ENOENT", "warning");
	});
});
