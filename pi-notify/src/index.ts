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
 */
export const PROMPT_NOTIFY_DELAY_MS = 4000;

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
		cancelPendingPrompt();
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
		cancelPendingPrompt();
	});

	pi.on("ui_prompt_start", async (event, ctx) => {
		if (isActiveAgentSession(ctx)) return;
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
		// the notification describing the prompt that opened, not whatever state arrives later.
		cancelPendingPrompt();
		const timer = setTimeout(() => {
			pendingPromptTimer = undefined;
			if (!enabled) return;
			notifier?.notify(notification);
		}, PROMPT_NOTIFY_DELAY_MS);
		timer.unref?.();
		pendingPromptTimer = timer;
	});

	pi.on("ui_prompt_end", async () => {
		// The operator answered before the delay elapsed: nothing to deliver.
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
