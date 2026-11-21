import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { NotifyBackend } from "./config.js";

export interface NotifyRequest {
	title: string;
	body: string;
	urgency: string;
}

export interface Notifier {
	notify(req: NotifyRequest): void;
	readonly degraded: boolean;
}

/** How much helper stderr is buffered per run. */
const MAX_STDERR_CHARS = 400;
/** How much of that buffer reaches the user in the warning. */
const MAX_REPORTED_CHARS = 300;

type UnreffableStream = { unref?: () => void };

export function createNotifier(opts: {
	command: string;
	backend: NotifyBackend;
	windowsScriptPath?: string;
	spawnFn?: typeof spawn;
	onError?: (message: string) => void;
}): Notifier {
	const spawnFn = opts.spawnFn ?? spawn;
	const backend = opts.backend;
	const windowsScriptPath = opts.windowsScriptPath ?? fileURLToPath(new URL("./windows-toast.ps1", import.meta.url));
	// `degraded` means the helper cannot be started at all (e.g. ENOENT), which is
	// permanent for this session. A helper that starts and then fails is reported
	// once but not latched: the next notification gets its own attempt.
	let degraded = false;
	let reportedExitFailure = false;

	const degrade = (error: unknown) => {
		if (degraded) return;
		degraded = true;
		const message = error instanceof Error ? error.message : String(error);
		opts.onError?.(`pi-notify: desktop notifications disabled after spawn failure: ${message}`);
	};

	const reportExitFailure = (command: string, code: number, stderr: string) => {
		if (reportedExitFailure) return;
		reportedExitFailure = true;
		const detail = stderr.replace(/\s+/g, " ").trim().slice(0, MAX_REPORTED_CHARS);
		const suffix = detail ? `: ${detail}` : "";
		opts.onError?.(`pi-notify: notification helper ${command} exited with code ${code}${suffix}`);
	};

	return {
		get degraded() {
			return degraded;
		},
		notify(req: NotifyRequest): void {
			if (degraded) return;
			const args =
				backend === "notify-send"
					? ["-a", "pi", "-u", req.urgency, req.title, req.body]
					: backend === "windows-toast"
						? [
								"-NoLogo",
								"-NoProfile",
								"-NonInteractive",
								"-ExecutionPolicy",
								"Bypass",
								"-File",
								windowsScriptPath,
								"-Title",
								req.title,
								"-Body",
								req.body,
								"-Urgency",
								req.urgency,
							]
						: [req.title, req.body];
			try {
				const child = spawnFn(opts.command, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
				const stderr = child.stderr as unknown as UnreffableStream | null;
				let captured = "";
				child.stderr?.setEncoding("utf8");
				child.stderr?.on("data", (chunk: string) => {
					if (captured.length < MAX_STDERR_CHARS) captured += chunk;
				});
				child.on("error", degrade);
				child.on("close", (code) => {
					// A failed spawn reports through `error` first and then closes with a
					// null code; only a real exit status is an actionable failure.
					if (code !== null && code !== 0) reportExitFailure(opts.command, code, captured);
				});
				// Fire and forget: a notification must never keep pi alive or block it.
				// The stderr pipe is unreffed too, so a helper still running when pi exits
				// is simply abandoned along with its diagnostic.
				child.unref();
				stderr?.unref?.();
			} catch (error) {
				degrade(error);
			}
		},
	};
}
