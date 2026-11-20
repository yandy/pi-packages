import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, type NotifyConfig } from "./config.js";
import { createNotifier, type Notifier } from "./notifier.js";
import { extractSummary, instanceName } from "./summary.js";

export default function (
	pi: ExtensionAPI,
	deps?: {
		env?: NodeJS.ProcessEnv;
		createNotifier?: typeof createNotifier;
		now?: () => number;
		pid?: number;
	},
): void {
	const now = deps?.now ?? Date.now;
	const pid = deps?.pid ?? process.pid;
	const makeNotifier = deps?.createNotifier ?? createNotifier;
	let config: NotifyConfig = loadConfig(deps?.env);
	let notifier: Notifier | undefined;
	let enabled = config.enabled;
	let runStartedAt: number | undefined;

	// Lazily initialised so prompts fired before session_start (e.g. project trust) still notify.
	const ensure = (ctx: ExtensionContext) => {
		if (notifier) return;
		notifier = makeNotifier({
			command: config.command,
			onError: (message) => ctx.ui.notify(message, "warning"),
		});
	};

	pi.on("session_start", async (_event, _ctx) => {
		config = loadConfig(deps?.env);
		notifier = undefined;
		enabled = config.enabled;
		runStartedAt = undefined;
	});

	pi.on("ui_prompt_start", async (event, ctx) => {
		ensure(ctx);
		if (!enabled) return;
		notifier?.notify({
			title: `Waiting for input — ${instanceName(pi.getSessionName?.(), ctx.cwd, pid)}`,
			body: event.title || event.kind,
			urgency: config.urgencyPrompt,
		});
	});

	pi.on("agent_start", async (_event, _ctx) => {
		runStartedAt ??= now();
	});

	pi.on("agent_settled", async (event, ctx) => {
		ensure(ctx);
		const duration = runStartedAt === undefined ? 0 : now() - runStartedAt;
		runStartedAt = undefined;
		if (event.aborted || !enabled || duration < config.minDurationMs) return;
		notifier?.notify({
			title: `Task finished — ${instanceName(pi.getSessionName?.(), ctx.cwd, pid)}`,
			body: extractSummary(ctx.sessionManager.getEntries()),
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
