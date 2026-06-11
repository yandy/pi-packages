import { createHash } from "node:crypto";
import Dockerode from "dockerode";
import { PACKAGE_DOCKER_DIR } from "./config";

export interface MountSpec {
  source: string;
  target: string;
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
	dockerfile?: string;
	buildContext?: string;
	buildArgs?: Record<string, string>;
	forceBuild?: boolean;
	onProgress?: (msg: string) => void;
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
  ensureImage(): Promise<void>;
  rebuildImage(onProgress?: (msg: string) => void): Promise<void>;
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
  return `pi-sbx-${basename}-${hash}`;
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
      const docker = new Dockerode({ socketPath: "/var/run/docker.sock" });
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

  async ensureImage(): Promise<void> {
    const docker = this._requireDocker();
    const image = this.opts.image;

    if (!this.opts.forceBuild) {
      try {
        await docker.getImage(image).inspect();
        return;
      } catch (err: any) {
        if (err?.statusCode !== 404) throw err;
      }
    }

    const buildContext = this.opts.buildContext ?? PACKAGE_DOCKER_DIR;
    const dockerfile = this.opts.dockerfile ?? "Dockerfile";
    const buildArgs = this.opts.buildArgs;

    const report = (msg: string) => this.opts.onProgress?.(msg);
    report(`Building image ${image}...`);

    const buildStream = await docker.buildImage(
      { context: buildContext, src: ["."] },
      { t: image, dockerfile, buildargs: buildArgs },
    );

    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(
        buildStream,
        (err) => {
          if (err) reject(err);
          else resolve();
        },
        (event: any) => {
          if (event.stream) report(event.stream.trim());
          else if (event.error) report(`ERROR: ${event.error}`);
          else if (event.status) report(event.status);
        },
      );
    });

    report(`Image ${image} built successfully.`);
  }

  async rebuildImage(onProgress?: (msg: string) => void): Promise<void> {
    const prevForceBuild = this.opts.forceBuild;
    const prevOnProgress = this.opts.onProgress;
    this.opts.forceBuild = true;
    this.opts.onProgress = onProgress;
    try {
      await this.ensureImage();
    } finally {
      this.opts.forceBuild = prevForceBuild;
      this.opts.onProgress = prevOnProgress;
    }
  }

  async startContainer(): Promise<void> {
    const docker = this._requireDocker();
    const { hostCwd, name, allowNetwork, extraMounts, resources, cacheVolume, image } = this.opts;
    const memory = resources?.memory ?? "4g";
    const cpus = resources?.cpus ?? "2";
    const pidsLimit = resources?.pidsLimit ?? 512;

    const binds: string[] = [`${hostCwd}:${this.workRoot}`];
    if (extraMounts) {
      for (const m of extraMounts) binds.push(`${m.source}:${m.target}:ro`);
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
      Env: ["DEBIAN_FRONTEND=noninteractive"],
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
        const docker = this.state.kind === "ready"
          ? (await this._getDocker())
          : null;
        this.state = { kind: "uninit", docker };
      }
    }
    if (this.state.kind === "disabled" || this.state.kind === "broken") return;
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInit();
    try { await this._initPromise; }
    finally { this._initPromise = null; }
  }

  async shutdown(): Promise<void> {
    if (this.state.kind !== "ready") return;
    try { await this.state.container.stop({ t: 5 }); } catch {}
    try { await this.state.container.remove({ force: true }); } catch {}
    this.state = { kind: "uninit", docker: null };
  }

  async exec(opts: ExecOpts): Promise<ExecResult> {
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
        externalSignal.addEventListener(
          "abort",
          () => controller.abort(externalSignal.reason),
          { once: true },
        );
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

    controller.signal.addEventListener("abort", () => {
      try { (stream as any).destroy(); } catch {}
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
    try { await this.ensureImage(); }
    catch (err) {
      this.state = {
        kind: "broken",
        reason: `Image build failed: ${err instanceof Error ? err.message : String(err)}`,
      };
      return;
    }
    try { await this.startContainer(); }
    catch (err) {
      this.state = {
        kind: "broken",
        reason: `Container start failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private _requireDocker(): Dockerode {
    if (this.state.kind === "uninit" && this.state.docker) return this.state.docker;
    if (this.state.kind === "ready") {
      return new Dockerode({ socketPath: "/var/run/docker.sock" });
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
    if (!match) return 0;
    const val = parseFloat(match[1]);
    const unit = (match[2] ?? "b").toLowerCase();
    const multipliers: Record<string, number> = {
      b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4,
    };
    return Math.round(val * (multipliers[unit] ?? 1));
  }
}
