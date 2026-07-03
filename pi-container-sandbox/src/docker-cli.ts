import { execFileSync, spawn, type SpawnOptions } from "node:child_process";

export function getDockerSocket(): string {
	const host = process.env.DOCKER_HOST;
	if (host?.startsWith("unix://")) return host.slice(7);
	return process.env.DOCKER_SOCKET || "/var/run/docker.sock";
}

/**
 * 同步执行 docker 命令。适用于 inspect、stop、rm 等快速操作。
 * 失败时抛出 Error。
 */
export function docker(args: string[], opts?: { timeout?: number }): string {
	return execFileSync("docker", args, {
		encoding: "utf-8",
		timeout: opts?.timeout ?? 30_000,
		maxBuffer: 16 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

/**
 * 异步 spawn docker 命令，支持流式输出、超时、AbortSignal、stdin。
 */
export function dockerSpawn(
	args: string[],
	opts: {
		timeoutMs?: number;
		signal?: AbortSignal;
		stdin?: string | Buffer;
		onStdout?: (d: Buffer) => void;
		onStderr?: (d: Buffer) => void;
	},
): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number | null; error?: string }> {
	return new Promise((resolve) => {
		const spawnOpts: SpawnOptions = {
			stdio: ["pipe", "pipe", "pipe"],
		};
		const child = spawn("docker", args, spawnOpts);

		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let timedOut = false;
		let settled = false;
		let spawnError: string | undefined;

		let timer: NodeJS.Timeout | null = null;

		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve({
				exitCode: timedOut ? null : code,
				stdout: Buffer.concat(stdoutChunks),
				stderr: Buffer.concat(stderrChunks),
				...(spawnError ? { error: spawnError } : {}),
			});
		};

		child.stdout!.on("data", (chunk: Buffer) => {
			stdoutChunks.push(chunk);
			opts.onStdout?.(chunk);
		});
		child.stderr!.on("data", (chunk: Buffer) => {
			stderrChunks.push(chunk);
			opts.onStderr?.(chunk);
		});

		child.on("close", (code) => finish(code));
		child.on("error", (err) => {
			// spawn 自身的错误（如 docker 二进制找不到）
			spawnError = err.message;
			finish(null);
		});

		// 超时
		if (opts.timeoutMs && opts.timeoutMs > 0) {
			timer = setTimeout(() => {
				timedOut = true;
				spawnError = "timeout";
				child.kill("SIGKILL");
			}, opts.timeoutMs);
		}

		// 外部 signal
		if (opts.signal) {
			if (opts.signal.aborted) {
				child.kill("SIGKILL");
			} else {
				opts.signal.addEventListener(
					"abort",
					() => child.kill("SIGKILL"),
					{ once: true },
				);
			}
		}

		// stdin
		if (opts.stdin !== undefined) {
			const buf = typeof opts.stdin === "string" ? Buffer.from(opts.stdin) : opts.stdin;
			child.stdin!.end(buf);
		} else {
			child.stdin!.end();
		}
	});
}
