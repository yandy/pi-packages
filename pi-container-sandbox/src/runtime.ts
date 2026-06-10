import { createHash } from "node:crypto";

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
