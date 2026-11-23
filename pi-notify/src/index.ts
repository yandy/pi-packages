import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, type NotifyConfig } from "./config.js";
import { createNotifier, type Notifier } from "./notifier.js";
import { extractSummary, formatDuration, instanceContext, instanceName, withContext } from "./summary.js";

const ACTIVE_AGENT_RE = /<active_agent\s+name="[^"]+"\s*\/>/;

/**
 * How long a blocking prompt must stay open before it raises a desktop notification.
 *
 * A prompt the operator answers immediately — typically a picker their own slash
 * command opened — is not a request for attention, so it must not notify. A prompt
 * nobody answers is exactly the case the notification exists for.
 *
 * Exported for the test harness only; the delay is behavior, not a knob.
 */
export const PROMPT_NOTIFY_DELAY_MS = 4000;

/**
 * Channel another extension emits through `pi.events` immediately before mounting a passive
 * (`custom`) prompt — a read-only viewer such as `/subagents:sessions` or `/todos`.
 *
 * A prompt event carries only `kind` and `title`, so a viewer is otherwise indistinguishable
 * from an extension asking a question. The viewer's own package knows which one it is opening,
 * so it announces it; the prompt right after the announcement does not notify. Announcing is
 * opt-in: an extension that says nothing keeps the default (a custom prompt alerts once it has
 * been open for `PROMPT_NOTIFY_DELAY_MS`).
 */
export const PASSIVE_PROMPT_CHANNEL = "notify:passive-prompt";

export default function (
	pi: ExtensionAPI,
	deps?: {
		env?: NodeJS.ProcessEnv;
		createNotifier?: typeof createNotifier;
		now?: () => number;
		pid?: number;
		platform?: NodeJS.Platform;
	},
): void {
	const now = deps?.now ?? Date.now;
	const pid = deps?.pid ?? process.pid;
	const platform = deps?.platform ?? process.platform;
	const makeNotifier = deps?.createNotifier ?? createNotifier;
	let config: NotifyConfig = loadConfig(deps?.env, platform);
	let notifier: Notifier | undefined;
	let enabled = config.enabled;
	let runStartedAt: number | undefined;
	let activeAgentSession: boolean | undefined;
	let runOrigin: "user" | "custom" | undefined;
	let pendingPromptTimer: ReturnType<typeof setTimeout> | undefined;
	/** Set by `PASSIVE_PROMPT_CHANNEL`; consumed by the next `ui_prompt_start`. */
	let passivePromptPending = false;

	pi.events.on(PASSIVE_PROMPT_CHANNEL, () => {
		passivePromptPending = true;
	});

	const cancelPendingPrompt = (): void => {
		if (pendingPromptTimer === undefined) return;
		clearTimeout(pendingPromptTimer);
		pendingPromptTimer = undefined;
	};

	const isActiveAgentSession = (ctx: ExtensionContext): boolean => {
		activeAgentSession ??= ACTIVE_AGENT_RE.test(ctx.getSystemPrompt());
		return activeAgentSession;
	};

	// Lazily initialised so prompts fired before session_start (e.g. project trust) still notify.
	const ensure = (ctx: ExtensionContext) => {
		if (notifier) return;
		notifier = makeNotifier({
			command: config.command,
			backend: config.backend,
			onError: (message) => ctx.ui.notify(message, "warning"),
		});
	};

	pi.on("session_start", async (_event, ctx) => {
		activeAgentSession = ACTIVE_AGENT_RE.test(ctx.getSystemPrompt());
		// A pending prompt alert is deliberately left alone: every session replacement emits
		// session_shutdown on the outgoing runner first (and reload builds new extension instances),
		// so nothing stale can survive — while cancelling here would drop an alert for a prompt that
		// is still open (the startup prompt Pi emits before session_start).
		runOrigin = undefined;
		config = loadConfig(deps?.env, platform);
		notifier = undefined;
		enabled = config.enabled;
		runStartedAt = undefined;
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		runOrigin = event.messageType;
	});

	pi.on("session_shutdown", async () => {
		passivePromptPending = false;
		cancelPendingPrompt();
	});

	pi.on("ui_prompt_start", async (event, ctx) => {
		if (isActiveAgentSession(ctx)) return;
		// Announcements are one-shot and only meaningful for the prompt they precede: consume on
		// every prompt, whatever its kind, so a stale one cannot silence a later alert.
		const passive = passivePromptPending;
		passivePromptPending = false;
		if (passive && event.kind === "custom") {
			// A viewer replaces whatever prompt preceded it (typically the picker that opened it).
			// Its `ui_prompt_end` may still be in flight — `emit()` awaits every handler — so the
			// replaced prompt's pending alert must be dropped here, not left to that end event.
			cancelPendingPrompt();
			return;
		}
		ensure(ctx);
		if (!enabled) return;
		const sessionName = pi.getSessionName?.();
		// "custom" is the only kind Pi emits without a title by contract, so the protocol word
		// must not reach the notification body.
		const subject = event.title || (event.kind === "custom" ? "Interactive prompt" : event.kind);
		const notification = {
			title: `${instanceName(sessionName, ctx.cwd)} · Waiting for input`,
			body: withContext(
				subject,
				instanceContext(sessionName, ctx.cwd, pid, event.title && event.title !== event.kind ? event.kind : undefined),
			),
			urgency: config.urgencyPrompt,
		};
		// Deferred, not immediate: see PROMPT_NOTIFY_DELAY_MS. Building the payload here keeps
		// the notification describing the prompt that opened, not whatever state arrives later,
		// and the notifier instance is captured for the same reason: a later session_start resets
		// the module-level notifier, which must not swallow an alert already scheduled.
		const deliver = notifier;
		cancelPendingPrompt();
		const timer = setTimeout(() => {
			pendingPromptTimer = undefined;
			if (!enabled) return;
			deliver?.notify(notification);
		}, PROMPT_NOTIFY_DELAY_MS);
		timer.unref?.();
		pendingPromptTimer = timer;
	});

	pi.on("ui_prompt_end", async () => {
		// The operator answered before the delay elapsed: nothing to deliver.
		// A pending announcement is deliberately left alone: `ui_prompt_end` carries no identity,
		// so an end belonging to an earlier prompt (possibly delayed by another handler) could
		// arrive between a viewer's announcement and its own `ui_prompt_start` and wipe it.
		// The announcement is consumed by the next start and dropped on session shutdown instead.
		cancelPendingPrompt();
	});

	pi.on("agent_start", async (_event, _ctx) => {
		runStartedAt ??= now();
	});

	pi.on("agent_settled", async (event, ctx) => {
		const duration = runStartedAt === undefined ? 0 : now() - runStartedAt;
		const automaticRun = runOrigin === "custom";
		runStartedAt = undefined;
		runOrigin = undefined;
		if (automaticRun || isActiveAgentSession(ctx)) return;
		ensure(ctx);
		if (event.aborted || !enabled || duration < config.minDurationMs) return;
		const sessionName = pi.getSessionName?.();
		notifier?.notify({
			title: `${instanceName(sessionName, ctx.cwd)} · Finished · ${formatDuration(duration)}`,
			body: withContext(extractSummary(ctx.sessionManager.getEntries()), instanceContext(sessionName, ctx.cwd, pid)),
			urgency: config.urgencyDone,
		});
	});

	pi.registerCommand("notify", {
		description: "Toggle desktop notifications for this pi instance",
		handler: async (_args, ctx) => {
			ensure(ctx);
			enabled = !enabled;
			ctx.ui.notify(`Notifications ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});
}
