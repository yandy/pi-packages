export type NotifyBackend = "notify-send" | "windows-toast" | "custom";

export interface NotifyConfig {
	enabled: boolean;
	backend: NotifyBackend;
	minDurationMs: number;
	urgencyPrompt: string;
	urgencyDone: string;
	command: string;
}

const DEFAULT_MIN_DURATION_MS = 10000;

export function loadConfig(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): NotifyConfig {
	const rawMin = env.PI_NOTIFY_MIN_DURATION_MS;
	const parsed = rawMin === undefined || rawMin === "" ? Number.NaN : Number(rawMin);
	const customCommand = env.PI_NOTIFY_COMMAND;
	return {
		enabled: env.PI_NOTIFY?.toLowerCase() !== "0" && env.PI_NOTIFY?.toLowerCase() !== "false",
		backend: customCommand ? "custom" : platform === "win32" ? "windows-toast" : "notify-send",
		minDurationMs: Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MIN_DURATION_MS,
		urgencyPrompt: env.PI_NOTIFY_URGENCY_PROMPT || "critical",
		urgencyDone: env.PI_NOTIFY_URGENCY_DONE || "normal",
		command: customCommand || (platform === "win32" ? "powershell.exe" : "notify-send"),
	};
}
