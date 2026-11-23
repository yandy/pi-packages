import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, type NotifyConfig } from "./config.js";
import { NOTIFY_REQUEST, type NotifyRequest, parseNotifyRequest } from "./contract.js";
import { createNotifier, type Notifier } from "./notifier.js";
import { extractSummary, formatDuration, instanceContext, instanceName, withContext } from "./summary.js";

const ACTIVE_AGENT_RE = /<active_agent\s+name="[^"]+"\s*\/>/;

type DeliveryRequest = Omit<NotifyRequest, "urgency"> & { urgency?: string };

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
	let currentCtx: ExtensionContext | undefined;
	let sessionClosed = false;

	const isActiveAgentSession = (ctx: ExtensionContext): boolean => {
		activeAgentSession ??= ACTIVE_AGENT_RE.test(ctx.getSystemPrompt());
		return activeAgentSession;
	};

	const ensure = (ctx: ExtensionContext | undefined) => {
		if (notifier) return;
		notifier = makeNotifier({
			command: config.command,
			backend: config.backend,
			onError: (message) => ctx?.ui.notify(message, "warning"),
		});
	};

	const deliver = (request: DeliveryRequest, eventCtx?: ExtensionContext): void => {
		if (sessionClosed || !enabled) return;
		const ctx = eventCtx ?? currentCtx;
		ensure(ctx);
		const sessionName = pi.getSessionName?.();
		const cwd = ctx?.cwd ?? process.cwd();
		notifier?.notify({
			title: `${instanceName(sessionName, cwd)} · ${request.title}`,
			body: withContext(request.body ?? "", instanceContext(sessionName, cwd, pid)),
			urgency: request.urgency ?? "normal",
		});
	};

	pi.events.on(NOTIFY_REQUEST, (data) => {
		const request = parseNotifyRequest(data);
		if (request) deliver(request);
	});

	pi.on("session_start", async (_event, ctx) => {
		sessionClosed = false;
		currentCtx = ctx;
		activeAgentSession = ACTIVE_AGENT_RE.test(ctx.getSystemPrompt());
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
		sessionClosed = true;
		currentCtx = undefined;
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
		if (event.aborted || duration < config.minDurationMs) return;
		deliver(
			{
				title: `Finished · ${formatDuration(duration)}`,
				body: extractSummary(ctx.sessionManager.getEntries()),
				urgency: config.urgencyDone,
			},
			ctx,
		);
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
