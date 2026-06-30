import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import Dockerode from "dockerode";
import { PACKAGE_DOCKER_DIR } from "./config";

function getDockerSocket(): string {
	const host = process.env.DOCKER_HOST;
	if (host?.startsWith("unix://")) return host.slice(7);
	return process.env.DOCKER_SOCKET || "/var/run/docker.sock";
}

const BUILD_TIMEOUT_MS = parseInt(process.env.SBX_BUILD_TIMEOUT || "600000", 10);
const MAX_EXEC_BUFFER = 16 * 1024 * 1024; // 16MB

export interface MountSpec {
	source: string;
	target: string;
	mode?: "ro" | "rw";
}

export interface BuildImageOpts {
	dockerfile: string;
	buildContext?: string;
	buildArgs?: Record<string, string>;
	onProgress?: (msg: string) => void;
}

export interface SandboxOptions {
	image: string;
	hostCwd: string;
	name: string;
	allowNetwork: boolean;
	resources: {
		memory?: string;
		cpus?: string;
		swap?: string;
		pidsLimit?: number;
	};
	extraMounts?: MountSpec[];
	cacheVolume?: string;
	onProgress?: (msg: string) => void;
	env?: string[];
}

export interface ExecOpts {
	cmd: string[];
	workDir?: string;
	env?: string[];
	stdin?: string | Buffer;
	timeoutMs?: number;
	signal?: AbortSignal;
	onData?: (data: Buffer) => void;
}

export interface ExecResult {
	exitCode: number | null;
	stdout: Buffer;
	stderr: Buffer;
}

export interface Runtime {
	init(): Promise<void>;
	isReady(): boolean;
	imageExists(): Promise<boolean>;
	buildImage(opts: BuildImageOpts): Promise<void>;
	getImage(): string;
	startContainer(): Promise<void>;
	withReady(): Promise<void>;
	exec(opts: ExecOpts): Promise<ExecResult>;
	shutdown(): Promise<void>;
	getContainerId(): string | null;
	getWorkRoot(): string;
}

export function deriveContainerName(hostCwd: string): string {
	const normalized = hostCwd.replace(/\/+$/, "");
	const basename = normalized.split("/").filter(Boolean).pop() || "project";
	const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 6);
	const maxBasename = 128 - `pi-sbx--${hash}`.length;
	const truncated = basename.length > maxBasename ? basename.slice(0, maxBasename) : basename;
	return `pi-sbx-${truncated}-${hash}`;
}

export function expandEnvEntry(entry: string, hostCwd: string): string {
	const eqIdx = entry.indexOf("=");
	if (eqIdx === -1) return entry;
	const key = entry.slice(0, eqIdx);
	const value = entry.slice(eqIdx + 1);
	try {
		const expanded = execSync(`bash -c 'echo -n "${value.replace(/'/g, "'\"'\"'")}"'`, {
			encoding: "utf-8",
			timeout: 5000,
			cwd: hostCwd,
		});
		return `${key}=${expanded}`;
	} catch (err) {
		console.warn(
			`sandbox: failed to expand env entry "${key}", fallback to raw value: ${err instanceof Error ? err.message : String(err)}`,
		);
		return entry;
	}
}

type State =
	| { kind: "uninit"; docker: Dockerode | null }
	| { kind: "disabled"; reason: string }
	| { kind: "broken"; reason: string }
	| { kind: "ready"; container: Dockerode.Container; id: string };

export class DockerRuntime implements Runtime {
	private state: State = { kind: "uninit", docker: null };
	private workRoot = "/workspace";
	private _initPromise: Promise<void> | null = null;
	private opts: SandboxOptions;

	constructor(opts: SandboxOptions) {
		this.opts = opts;
	}

	async init(): Promise<void> {
		try {
			const docker = new Dockerode({ socketPath: getDockerSocket() });
			await docker.ping();
			this.state = { kind: "uninit", docker };
		} catch (err) {
			this.state = {
				kind: "disabled",
				reason: err instanceof Error ? err.message : String(err),
			};
		}
	}

	isReady(): boolean {
		return this.state.kind === "ready";
	}

	getWorkRoot(): string {
		return this.workRoot;
	}

	getContainerId(): string | null {
		return this.state.kind === "ready" ? this.state.id : null;
	}

	async imageExists(): Promise<boolean> {
		try {
			await this._requireDocker().getImage(this.opts.image).inspect();
			return true;
		} catch (err: any) {
			if (err?.statusCode === 404) return false;
			throw err;
		}
	}

	async buildImage(opts: BuildImageOpts): Promise<void> {
		const docker = this._requireDocker();
		const image = this.opts.image;
		const buildContext = opts.buildContext ?? PACKAGE_DOCKER_DIR;
		const dockerfile = opts.dockerfile;
		const buildArgs = opts.buildArgs;
		const onProgress = opts.onProgress ?? this.opts.onProgress;

		const report = (msg: string) => onProgress?.(msg);
		report(`Building image ${image}...`);

		const buildStream = await docker.buildImage(
			{ context: buildContext, src: ["."] },
			{ t: image, dockerfile, buildargs: buildArgs, version: "2" },
		);

		const buildPromise = new Promise<void>((resolve, reject) => {
			let settled = false;
			docker.modem.followProgress(
				buildStream,
				(err: any) => {
					if (settled) return;
					settled = true;
					if (err) reject(err instanceof Error ? err : new Error(String(err)));
					else resolve();
				},
				(event: any) => {
					if (event.stream) report(event.stream.trim());
					else if (event.errorDetail) {
						if (!settled) {
							settled = true;
							reject(new Error(event.errorDetail.message || event.error || "Build failed"));
						}
					} else if (event.error) {
						report(`ERROR: ${event.error}`);
						if (!settled) {
							settled = true;
							reject(new Error(event.error));
						}
					} else if (event.status) report(event.status);
				},
			);
		});

		const timeoutPromise = new Promise<void>((_, reject) =>
			setTimeout(() => reject(new Error(`sandbox: image build timed out after ${BUILD_TIMEOUT_MS}ms`)), BUILD_TIMEOUT_MS),
		);

		await Promise.race([buildPromise, timeoutPromise]);
		report(`Image ${image} built successfully.`);
	}

	getImage(): string {
		return this.opts.image;
	}

	private _expandEnv(entries: string[]): string[] {
		return entries.map((entry) => expandEnvEntry(entry, this.opts.hostCwd));
	}

	async startContainer(): Promise<void> {
		const docker = this._requireDocker();
		const { hostCwd, name, allowNetwork, extraMounts, resources, cacheVolume, image } = this.opts;

		const existing = docker.getContainer(name);
		try {
			const info = await existing.inspect();
			if (info.State.Running) {
				this.state = { kind: "ready", container: existing, id: info.Id };
				return;
			}
			try {
				await existing.remove({ force: true });
			} catch (err: any) {
				if (err?.statusCode !== 404 && err?.statusCode !== 409) throw err;
			}
		} catch (err: any) {
			if (err?.statusCode !== 404) throw err;
		}

		const memory = resources?.memory ?? "4g";
		const cpus = resources?.cpus ?? "2";
		const pidsLimit = resources?.pidsLimit ?? 512;

		const binds: string[] = [`${hostCwd}:${this.workRoot}`];
		if (extraMounts) {
			for (const m of extraMounts) {
				const mode = m.mode === "rw" ? "rw" : "ro";
				binds.push(`${m.source}:${m.target}:${mode}`);
			}
		}
		if (cacheVolume) binds.push(`${cacheVolume}:/cache`);

		const HostConfig: any = {
			Binds: binds,
			Memory: this._parseBytes(memory),
			NanoCpus: Math.round(parseFloat(cpus) * 1e9),
			PidsLimit: pidsLimit,
			AutoRemove: false,
			NetworkMode: allowNetwork ? "default" : "none",
			CapDrop: ["ALL"],
			SecurityOpt: ["no-new-privileges"],
		};

		if (resources?.swap !== undefined) {
			const swapVal = resources.swap;
			if (swapVal === "0") {
				HostConfig.MemorySwap = this._parseBytes(memory);
			} else {
				HostConfig.MemorySwap = this._parseBytes(memory) + this._parseBytes(swapVal);
			}
		}

		const container = await docker.createContainer({
			Image: image,
			Cmd: ["sleep", "infinity"],
			User: "1000:1000",
			WorkingDir: this.workRoot,
			Env: ["DEBIAN_FRONTEND=noninteractive", ...this._expandEnv(this.opts.env ?? [])],
			HostConfig,
			name,
		});
		await container.start();
		const inspect = await container.inspect();
		this.state = { kind: "ready", container, id: inspect.Id };
	}

	async withReady(): Promise<void> {
		if (this.state.kind === "ready") {
			try {
				await this.state.container.inspect();
				return;
			} catch {
				const docker = this.state.kind === "ready" ? await this._getDocker() : null;
				this.state = { kind: "uninit", docker };
			}
		}
		if (this.state.kind === "disabled" || this.state.kind === "broken") return;
		if (this._initPromise) return this._initPromise;
		this._initPromise = this._doInit();
		try {
			await this._initPromise;
		} finally {
			this._initPromise = null;
		}
	}

	async shutdown(): Promise<void> {
		if (this.state.kind !== "ready") return;
		try {
			await this.state.container.stop({ t: 5 });
		} catch {}
		try {
			await this.state.container.remove({ force: true });
		} catch {}
		this.state = { kind: "uninit", docker: null };
	}

	async exec(opts: ExecOpts): Promise<ExecResult> {
		if (this.state.kind === "broken") throw new Error(this.state.reason);
		if (this.state.kind !== "ready") throw new Error("Sandbox not ready");
		const container = this.state.container;

		const exec = await container.exec({
			Cmd: opts.cmd,
			AttachStdout: true,
			AttachStderr: true,
			AttachStdin: opts.stdin !== undefined,
			WorkingDir: opts.workDir ?? this.workRoot,
			Env: opts.env,
		});

		const controller = new AbortController();
		let timedOut = false;
		let timer: NodeJS.Timeout | null = null;
		if (opts.timeoutMs && opts.timeoutMs > 0) {
			timer = setTimeout(() => {
				timedOut = true;
				controller.abort(new Error("timeout"));
			}, opts.timeoutMs);
		}
		if (opts.signal) {
			const externalSignal = opts.signal;
			if (externalSignal.aborted) {
				controller.abort(externalSignal.reason);
			} else {
				externalSignal.addEventListener("abort", () => controller.abort(externalSignal.reason), { once: true });
			}
		}
		if (controller.signal.aborted) {
			if (timer) clearTimeout(timer);
			return { exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
		}

		let stream: NodeJS.ReadWriteStream;
		try {
			stream = (await exec.start({
				Detach: false,
				Tty: false,
				hijack: true,
				stdin: opts.stdin !== undefined,
				abortSignal: controller.signal,
			})) as NodeJS.ReadWriteStream;
		} catch {
			if (timer) clearTimeout(timer);
			return { exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
		}

		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];

		let pending = Buffer.alloc(0);
		stream.on("data", (chunk: Buffer) => {
			pending = Buffer.concat([pending, chunk]);
			if (pending.length > MAX_EXEC_BUFFER) {
				try {
					(stream as any).destroy(new Error("exec stream buffer exceeded 16MB limit"));
				} catch {}
				return;
			}
			while (pending.length >= 8) {
				const streamType = pending[0];
				const size = pending.readUInt32BE(4);
				if (pending.length < 8 + size) break;
				const payload = pending.subarray(8, 8 + size);
				pending = pending.subarray(8 + size);
				if (streamType === 1) {
					stdoutChunks.push(payload);
					opts.onData?.(payload);
				} else if (streamType === 2) {
					stderrChunks.push(payload);
				}
			}
		});

		controller.signal.addEventListener("abort", async () => {
			try {
				(stream as any).destroy();
			} catch {}
			try {
				const info = await exec.inspect();
				if (info.Pid) {
					const killExec = await container.exec({
						Cmd: ["sh", "-c", `kill -9 ${info.Pid} 2>/dev/null; exit 0`],
						AttachStdout: false,
						AttachStderr: false,
					});
					await killExec.start({ Detach: true }).catch(() => {});
				}
			} catch {
				/* best effort */
			}
		});

		return new Promise<ExecResult>((resolve) => {
			let settled = false;
			const finish = async () => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				try {
					const inspect = await exec.inspect();
					resolve({
						exitCode: timedOut ? null : (inspect.ExitCode ?? null),
						stdout: Buffer.concat(stdoutChunks),
						stderr: Buffer.concat(stderrChunks),
					});
				} catch {
					resolve({
						exitCode: null,
						stdout: Buffer.concat(stdoutChunks),
						stderr: Buffer.concat(stderrChunks),
					});
				}
			};
			stream.on("end", finish);
			stream.on("error", finish);
			stream.on("close", finish);
			if (opts.stdin !== undefined && !controller.signal.aborted) {
				const buf = typeof opts.stdin === "string" ? Buffer.from(opts.stdin) : opts.stdin;
				(stream as any).write(buf);
			}
			(stream as any).end();
		});
	}

	private async _doInit(): Promise<void> {
		const docker = await this._getDocker();
		if (!docker) return;
		try {
			await this.startContainer();
		} catch (err) {
			this.state = {
				kind: "broken",
				reason: `Container start failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	private _requireDocker(): Dockerode {
		if (this.state.kind === "uninit" && this.state.docker) return this.state.docker;
		if (this.state.kind === "ready") {
			return new Dockerode({ socketPath: getDockerSocket() });
		}
		throw new Error("Docker not initialized");
	}

	private async _getDocker(): Promise<Dockerode | null> {
		if (this.state.kind === "uninit") {
			if (!this.state.docker) await this.init();
			if (this.state.kind === "uninit") return this.state.docker;
		}
		return null;
	}

	private _parseBytes(s: string): number {
		const match = s.match(/^(\d+(?:\.\d+)?)\s*(b|k|m|g|t)?$/i);
		if (!match) throw new Error(`sandbox: invalid memory size "${s}" — expected format like "4g" or "512m"`);
		const val = parseFloat(match[1]);
		const unit = (match[2] ?? "b").toLowerCase();
		const multipliers: Record<string, number> = {
			b: 1,
			k: 1024,
			m: 1024 ** 2,
			g: 1024 ** 3,
			t: 1024 ** 4,
		};
		return Math.round(val * (multipliers[unit] ?? 1));
	}
}
