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
	let degraded = false;

	const degrade = (error: unknown) => {
		if (degraded) return;
		degraded = true;
		const message = error instanceof Error ? error.message : String(error);
		opts.onError?.(`pi-notify: desktop notifications disabled after spawn failure: ${message}`);
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
				const child = spawnFn(opts.command, args, { stdio: "ignore", windowsHide: true });
				child.on("error", degrade);
				child.unref();
			} catch (error) {
				degrade(error);
			}
		},
	};
}
