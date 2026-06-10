import { createHash } from "node:crypto";
import Dockerode from "dockerode";

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
  dockerfileContext?: string;
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
    try {
      await docker.getImage(this.opts.image).inspect();
      return;
    } catch (err: any) {
      if (err?.statusCode !== 404) throw err;
    }
    const buildStream = await docker.buildImage(
      this.opts.dockerfileContext ?? this.opts.hostCwd,
      { t: this.opts.image, dockerfile: "Dockerfile" },
    );
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(buildStream, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
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

  async exec(_opts: ExecOpts): Promise<ExecResult> { throw new Error("not implemented"); }

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
