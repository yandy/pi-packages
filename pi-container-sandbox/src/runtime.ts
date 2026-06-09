import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

export interface MountSpec {
	source: string;
	target: string;
}

export interface RunArgs {
	name: string;
	image: string;
	hostCwd: string;
	allowNetwork: boolean;
	extraMounts?: MountSpec[];
	resources?: {
		memory?: string;
		cpus?: string;
		pidsLimit?: number;
		swap?: string;
	};
	cacheVolume?: string;
}

export interface Runtime {
	kind: string;
	bin: string;
	run(args: RunArgs): Promise<string>;
	stop(name: string): void;
	remove(name: string): void;
	exists(image: string): Promise<boolean>;
	isRunning(name: string): Promise<boolean>;
	start(name: string): Promise<boolean>;
	createVolume(name: string): Promise<boolean>;
}

export function randomSuffix(): string {
	return randomBytes(4).toString("hex");
}

export function deriveContainerName(hostCwd: string): string {
	const normalized = hostCwd.replace(/\/+$/, "");
	const basename = normalized.split("/").filter(Boolean).pop() || "project";
	const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 6);
	return `pi-sbx-${basename}-${hash}`;
}

function which(bin: string): boolean {
	const r = spawnSync("which", [bin], { stdio: "ignore" });
	return r.status === 0;
}

export function spawnWithTimeout(
	bin: string,
	args: string[],
	timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
	return new Promise((resolve) => {
		const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let timedOut = false;

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);

		child.stdout.on("data", (d: Buffer) => out.push(d));
		child.stderr.on("data", (d: Buffer) => err.push(d));
		child.on("error", () => {
			clearTimeout(timer);
			resolve({ code: -1, stdout: "", stderr: "spawn error", timedOut: false });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({
				code,
				stdout: Buffer.concat(out).toString(),
				stderr: Buffer.concat(err).toString(),
				timedOut,
			});
		});
	});
}

function parseBytesToBytes(s: string): number {
	const match = s.match(/^(\d+(?:\.\d+)?)\s*(b|k|m|g|t)?$/i);
	if (!match) return 0;
	const val = parseFloat(match[1]);
	const unit = (match[2] ?? "b").toLowerCase();
	const multipliers: Record<string, number> = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
	return Math.round(val * (multipliers[unit] ?? 1));
}

function formatBytes(bytes: number): string {
	if (bytes >= 1024 ** 3 && bytes % (1024 ** 3) === 0) return `${bytes / (1024 ** 3)}g`;
	if (bytes >= 1024 ** 2 && bytes % (1024 ** 2) === 0) return `${bytes / (1024 ** 2)}m`;
	if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024}k`;
	return `${bytes}b`;
}

export function dockerRuntime(): Runtime {
	const bin = "docker";
	return {
		kind: "docker",
		bin,
		exists: async (image) => {
			const r = await spawnWithTimeout(bin, ["image", "inspect", image], 10000);
			return r.code === 0 && !r.timedOut;
		},
		stop: (name) => {
			spawnSync(bin, ["stop", name], { stdio: "ignore" });
		},
		remove: (name) => {
			spawnSync(bin, ["rm", "-f", name], { stdio: "ignore" });
		},
		isRunning: async (name: string) => {
			const r = await spawnWithTimeout(bin, ["inspect", "--format", "{{.State.Running}}", name], 5000);
			return r.code === 0 && r.stdout.trim() === "true";
		},
		start: async (name: string) => {
			const r = await spawnWithTimeout(bin, ["start", name], 10000);
			return r.code === 0 && !r.timedOut;
		},
		createVolume: async (name: string) => {
			const r = await spawnWithTimeout(bin, ["volume", "create", name], 10000);
			return r.code === 0 && !r.timedOut;
		},
		run: async ({ name, image, hostCwd, allowNetwork, extraMounts, resources, cacheVolume }) => {
			const memory = resources?.memory ?? "4g";
			const cpus = resources?.cpus ?? "2";
			const pidsLimit = resources?.pidsLimit ?? 512;

			const args: string[] = [
				"run",
				"-d",
				"--name", name,
				"--user", "1000:1000",
				"--memory", memory,
				"--cpus", cpus,
				"--cap-drop", "ALL",
				"--security-opt", "no-new-privileges",
				"--pids-limit", String(pidsLimit),
				"-v", `${hostCwd}:/workspace`,
				"-w", "/workspace",
			];

			if (extraMounts) {
				for (const m of extraMounts) {
					args.push("-v", `${m.source}:${m.target}:ro`);
				}
			}

			if (cacheVolume) {
				args.push("-v", `${cacheVolume}:/cache`);
			}

			const swap = resources?.swap;
			if (swap !== undefined) {
				if (swap === "0") {
					args.push("--memory-swap", memory);
				} else {
					const totalSwap = parseBytesToBytes(memory) + parseBytesToBytes(swap);
					args.push("--memory-swap", formatBytes(totalSwap));
				}
			}

			if (!allowNetwork) args.push("--network", "none");
			args.push(image, "sleep", "infinity");

			const r = await spawnWithTimeout(bin, args, 60000);
			if (r.timedOut) {
				throw new Error(`docker run timed out after 60s (command: docker run ${name})`);
			}
			if (r.code !== 0) {
				throw new Error(`docker run failed: ${r.stderr || r.stdout}`);
			}
			return name;
		},
	};
}

export async function detectRuntime(ctx?: { ui?: { notify: (msg: string, level?: "info" | "warning" | "error") => void } }): Promise<Runtime | null> {
	if (!which("docker")) {
		return null;
	}

	const runtime = dockerRuntime();

	const testName = `pi-test-${randomSuffix()}`;
	try {
		const r = await spawnWithTimeout(
			runtime.bin,
			["run", "-d", "--rm", "--name", testName, "debian:12-slim", "sleep", "infinity"],
			3000,
		);
		if (r.code === 0 && !r.timedOut) {
			runtime.stop(testName);
			return runtime;
		}
		if (r.timedOut) {
			ctx?.ui?.notify("docker runtime timed out (3s smoke test)", "warning");
		}
	} catch {
		// Fall through
	}

	return null;
}
