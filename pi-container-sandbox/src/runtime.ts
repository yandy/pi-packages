import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { docker, dockerSpawn } from "./docker-cli";
import { PACKAGE_DOCKER_DIR } from "./config";

const BUILD_TIMEOUT_MS = parseInt(process.env.SBX_BUILD_TIMEOUT || "600000", 10);

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
	| { kind: "uninit"; initialized: boolean }
	| { kind: "disabled"; reason: string }
	| { kind: "broken"; reason: string }
	| { kind: "ready"; id: string };

export class DockerRuntime implements Runtime {
	private state: State = { kind: "uninit", initialized: false };
	private workRoot = "/workspace";
	private _initPromise: Promise<void> | null = null;
	private opts: SandboxOptions;

	constructor(opts: SandboxOptions) {
		this.opts = opts;
	}

	async init(): Promise<void> {
		try {
			docker(["info"]);
			this.state = { kind: "uninit", initialized: true };
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
			docker(["image", "inspect", this.opts.image]);
			return true;
		} catch {
			return false;
		}
	}

	async buildImage(opts: BuildImageOpts): Promise<void> {
		const image = this.opts.image;
		const buildContext = opts.buildContext ?? PACKAGE_DOCKER_DIR;
		const dockerfile = opts.dockerfile;
		const onProgress = opts.onProgress ?? this.opts.onProgress;

		const report = (msg: string) => onProgress?.(msg);
		report(`Building image ${image}...`);

		const args = [
			"build",
			"-t", image,
			"-f", dockerfile,
			"--progress=plain",
		];

		if (opts.buildArgs) {
			for (const [k, v] of Object.entries(opts.buildArgs)) {
				args.push("--build-arg", `${k}=${v}`);
			}
		}

		args.push(buildContext);

		let pending = "";
		const result = await dockerSpawn(args, {
			timeoutMs: BUILD_TIMEOUT_MS,
			onStdout: (chunk: Buffer) => {
				const text = chunk.toString("utf-8");
				pending += text;
				const lines = pending.split("\n");
				pending = lines.pop() ?? "";
				for (const line of lines) {
					const trimmed = line.trim();
					if (trimmed) report(trimmed);
				}
			},
			onStderr: (chunk: Buffer) => {
				const text = chunk.toString("utf-8").trim();
				if (text) report(`[stderr] ${text}`);
			},
		});

		if (pending.trim()) report(pending.trim());

		if (result.exitCode !== 0) {
			const errMsg = result.stderr.toString("utf-8").trim() || "Build failed";
			throw new Error(`sandbox: image build failed (exit ${result.exitCode}): ${errMsg}`);
		}

		report(`Image ${image} built successfully.`);
	}

	getImage(): string {
		return this.opts.image;
	}

	private _expandEnv(entries: string[]): string[] {
		return entries.map((entry) => expandEnvEntry(entry, this.opts.hostCwd));
	}

	async startContainer(): Promise<void> {
		const { hostCwd, name, allowNetwork, extraMounts, resources, cacheVolume, image, env } = this.opts;

		// 1. Check for existing container
		let existingId: string | null = null;
		try {
			const info = JSON.parse(docker(["container", "inspect", name]));
			if (info?.[0]) {
				const state = info[0].State;
				if (state?.Running) {
					this.state = { kind: "ready", id: info[0].Id };
					return;
				}
				existingId = info[0].Id;
			}
		} catch {}

		// 2. Clean up existing container if present but not running
		if (existingId) {
			try { docker(["rm", "-f", name]); } catch {}
		}

		// 3. Build docker run args
		const memory = resources?.memory ?? "4g";
		const cpus = resources?.cpus ?? "2";
		const pidsLimit = resources?.pidsLimit ?? 512;

		const args: string[] = [
			"run", "-d",
			"--name", name,
			"--user", "1000:1000",
			"-w", this.workRoot,
			"-v", `${hostCwd}:${this.workRoot}`,
			"--memory", memory,
			"--cpus", cpus,
			"--pids-limit", String(pidsLimit),
			"--network", allowNetwork ? "bridge" : "none",
			"--cap-drop", "ALL",
			"--security-opt", "no-new-privileges",
		];

		// Extra mounts
		if (extraMounts) {
			for (const m of extraMounts) {
				const mode = m.mode === "rw" ? "rw" : "ro";
				args.push("-v", `${m.source}:${m.target}:${mode}`);
			}
		}
		if (cacheVolume) {
			args.push("-v", `${cacheVolume}:/cache`);
		}

		// Swap
		if (resources?.swap !== undefined) {
			const swapVal = resources.swap;
			if (swapVal === "0") {
				args.push("--memory-swap", memory);
			} else {
				const memBytes = this._parseBytes(memory);
				const swapBytes = memBytes + this._parseBytes(swapVal);
				args.push("--memory-swap", String(swapBytes));
			}
		}

		// Environment variables
		const dockerEnv = ["DEBIAN_FRONTEND=noninteractive", ...this._expandEnv(env ?? [])];
		for (const e of dockerEnv) {
			args.push("-e", e);
		}

		args.push(image, "sleep", "infinity");

		// 4. Start container
		docker(args, { timeout: 60_000 });
		const inspectInfo = JSON.parse(docker(["container", "inspect", name]));
		this.state = { kind: "ready", id: inspectInfo[0].Id };
	}

	async withReady(): Promise<void> {
		if (this.state.kind === "ready") {
			try {
				docker(["container", "inspect", this.opts.name]);
				return;
			} catch {
				this.state = { kind: "uninit", initialized: true };
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
		const name = this.opts.name;
		try { docker(["stop", "-t", "5", name]); } catch {}
		try { docker(["rm", "-f", name]); } catch {}
		this.state = { kind: "uninit", initialized: false };
	}

	async exec(opts: ExecOpts): Promise<ExecResult> {
		if (this.state.kind === "broken") throw new Error(this.state.reason);
		if (this.state.kind !== "ready") throw new Error("Sandbox not ready");

		const args = ["exec", "-i"];
		if (opts.workDir) args.push("-w", opts.workDir);
		if (opts.env) {
			for (const e of opts.env) args.push("-e", e);
		}
		args.push(this.opts.name, ...opts.cmd);

		const controller = new AbortController();
		let abortHandler: (() => void) | undefined;
		if (opts.signal) {
			if (opts.signal.aborted) {
				return { exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
			}
			abortHandler = () => controller.abort(opts.signal?.reason);
			opts.signal.addEventListener("abort", abortHandler, { once: true });
		}

		try {
			const { exitCode, stdout, stderr } = await dockerSpawn(args, {
				timeoutMs: opts.timeoutMs,
				signal: controller.signal,
				stdin: opts.stdin,
				onStdout: opts.onData,
				onStderr: opts.onData,
			});
			return { exitCode, stdout, stderr };
		} finally {
			if (opts.signal && abortHandler) {
				opts.signal.removeEventListener("abort", abortHandler);
			}
		}
	}

	private async _doInit(): Promise<void> {
		if (this.state.kind === "uninit" && !this.state.initialized) {
			await this.init();
		}
		if (this.state.kind !== "uninit" || !this.state.initialized) return;
		try {
			await this.startContainer();
		} catch (err) {
			this.state = {
				kind: "broken",
				reason: `Container start failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
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
