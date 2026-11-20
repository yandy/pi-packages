import { spawn } from "node:child_process";

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
	spawnFn?: typeof spawn;
	onError?: (message: string) => void;
}): Notifier {
	const spawnFn = opts.spawnFn ?? spawn;
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
				opts.command === "notify-send"
					? ["-a", "pi", "-u", req.urgency, req.title, req.body]
					: [req.title, req.body];
			try {
				const child = spawnFn(opts.command, args, { stdio: "ignore" });
				child.on("error", degrade);
				child.unref();
			} catch (error) {
				degrade(error);
			}
		},
	};
}
