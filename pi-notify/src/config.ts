export interface NotifyConfig {
	enabled: boolean;
	minDurationMs: number;
	urgencyPrompt: string;
	urgencyDone: string;
	command: string;
}

const DEFAULT_MIN_DURATION_MS = 10000;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): NotifyConfig {
	const rawMin = env.PI_NOTIFY_MIN_DURATION_MS;
	const parsed = rawMin === undefined || rawMin === "" ? Number.NaN : Number(rawMin);
	return {
		enabled: env.PI_NOTIFY?.toLowerCase() !== "0" && env.PI_NOTIFY?.toLowerCase() !== "false",
		minDurationMs: Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MIN_DURATION_MS,
		urgencyPrompt: env.PI_NOTIFY_URGENCY_PROMPT || "critical",
		urgencyDone: env.PI_NOTIFY_URGENCY_DONE || "normal",
		command: env.PI_NOTIFY_COMMAND || "notify-send",
	};
}
