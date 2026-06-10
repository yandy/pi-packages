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
    return null;
  }

  async ensureImage(): Promise<void> { throw new Error("not implemented"); }
  async startContainer(): Promise<void> { throw new Error("not implemented"); }
  async withReady(): Promise<void> { throw new Error("not implemented"); }
  async exec(_opts: ExecOpts): Promise<ExecResult> { throw new Error("not implemented"); }
  async shutdown(): Promise<void> { throw new Error("not implemented"); }
}
