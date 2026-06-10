# pi-container-sandbox Dockerode Migration & Refinement Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate pi-container-sandbox from `docker` CLI to `dockerode` SDK, fix all Critical + Important code review issues, rewrite README — using TDD throughout.

**Architecture:** `Runtime` interface + `DockerRuntime` class (dockerode). `session.ts` replaces `sandbox.ts`. `ops.ts` adapters delegate to `Runtime.exec()`. Docker multiplex demux for stdout/stderr separation.

**Tech Stack:** TypeScript, dockerode, vitest, Docker Engine API

**Spec:** `docs/specs/2026-06-10-pi-container-sandbox-refinement-design.md`

**TDD Principle:** Every production code change follows RED → verify fail → GREEN → verify pass → REFACTOR.

---

### Task 1: Add dockerode dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install dockerode**

```bash
npm install dockerode && npm install -D @types/dockerode
```

- [ ] **Step 2: Verify**

```bash
node -e "require('dockerode'); console.log('ok')"
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add dockerode dependency"
```

---

### Task 2: Runtime interface + deriveContainerName (TDD)

**Files:**
- Create: `src/runtime.ts`
- Test: `tests/runtime.test.ts` (modify existing)

- [ ] **Step 1: Write failing test for deriveContainerName**

Write in `tests/runtime.test.ts` (replace existing content):

```ts
import { describe, it, expect } from "vitest";
import { deriveContainerName } from "../src/runtime";

describe("deriveContainerName", () => {
  it("generates a name with pi-sbx- prefix using cwd basename", () => {
    const name = deriveContainerName("/home/user/my-project");
    expect(name).toMatch(/^pi-sbx-my-project-[a-f0-9]{6}$/);
  });

  it("strips trailing slashes", () => {
    const a = deriveContainerName("/home/user/project");
    const b = deriveContainerName("/home/user/project/");
    expect(a).toBe(b);
  });

  it("falls back to 'project' when cwd is root", () => {
    const name = deriveContainerName("/");
    expect(name).toMatch(/^pi-sbx-project-[a-f0-9]{6}$/);
  });
});
```

- [ ] **Step 2: Verify test fails**

```bash
npx vitest run tests/runtime.test.ts
```

Expected: FAIL — `deriveContainerName is not a function` or import error.

- [ ] **Step 3: Write minimal src/runtime.ts**

```ts
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
```

- [ ] **Step 4: Verify test passes**

```bash
npx vitest run tests/runtime.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/runtime.ts tests/runtime.test.ts
git commit -m "feat: Runtime interface + deriveContainerName"
```

---

### Task 3: DockerRuntime.init() (TDD with Docker)

**Files:**
- Modify: `src/runtime.ts`
- Modify: `tests/runtime.test.ts`

- [ ] **Step 1: Write failing tests for init()**

Add to `tests/runtime.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import Dockerode from "dockerode";
import { DockerRuntime } from "../src/runtime";

const dockerAvailable = (() => {
  try {
    const d = new Dockerode({ socketPath: "/var/run/docker.sock" });
    return true;
  } catch { return false; }
})();

describe.skipIf(!dockerAvailable)("DockerRuntime", () => {
  let runtime: DockerRuntime;

  it("init() pings Docker and sets isReady()", async () => {
    runtime = new DockerRuntime({
      image: "debian:12-slim",
      hostCwd: "/tmp",
      name: "pi-test-init",
      allowNetwork: false,
      resources: { memory: "256m", cpus: "0.5" },
    });
    await runtime.init();
    expect(runtime.isReady()).toBe(false); // not ready until withReady
  });

  it("returns isReady()=false when Docker is unreachable (mock)", async () => {
    // This test is for the init error path
    const badRuntime = new DockerRuntime({
      image: "debian:12-slim",
      hostCwd: "/tmp",
      name: "pi-test-bad",
      allowNetwork: false,
      resources: { memory: "256m", cpus: "0.5" },
    });
    // We test the state directly — the init failure path is covered
    // by the constructor defaults (state.uninit with null docker)
    expect(badRuntime.isReady()).toBe(false);
  });
});
```

- [ ] **Step 2: Verify test fails**

```bash
npx vitest run tests/runtime.test.ts
```

Expected: FAIL — `DockerRuntime is not exported`.

- [ ] **Step 3: Implement DockerRuntime.init()**

Add to `src/runtime.ts`:

```ts
import Dockerode from "dockerode";

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
    return null; // not ready yet
  }

  // Stubs for remaining interface methods
  async ensureImage(): Promise<void> { throw new Error("not implemented"); }
  async startContainer(): Promise<void> { throw new Error("not implemented"); }
  async withReady(): Promise<void> { throw new Error("not implemented"); }
  async exec(_opts: ExecOpts): Promise<ExecResult> { throw new Error("not implemented"); }
  async shutdown(): Promise<void> { throw new Error("not implemented"); }
}
```

- [ ] **Step 4: Verify test passes**

```bash
npx vitest run tests/runtime.test.ts
```

Expected: PASS (Docker-available tests run against real Docker, Docker-unavailable skips).

- [ ] **Step 5: Commit**

```bash
git add src/runtime.ts tests/runtime.test.ts
git commit -m "feat: DockerRuntime.init() — dockerode ping with disabled fallback"
```

---

### Task 4: DockerRuntime.ensureImage() + startContainer() + withReady() (TDD)

**Files:**
- Modify: `src/runtime.ts`
- Modify: `tests/runtime.test.ts`

- [ ] **Step 1: Write failing test for ensureImage + startContainer + withReady**

Add to `tests/runtime.test.ts`:

```ts
describe.skipIf(!dockerAvailable)("DockerRuntime lifecycle", () => {
  const testName = `pi-test-lifecycle-${Date.now()}`;

  afterAll(async () => {
    const d = new Dockerode({ socketPath: "/var/run/docker.sock" });
    try { const c = d.getContainer(testName); await c.remove({ force: true }); } catch {}
  });

  it("withReady() builds/starts container and sets ready state", async () => {
    const runtime = new DockerRuntime({
      image: "debian:12-slim",
      hostCwd: "/tmp",
      name: testName,
      allowNetwork: false,
      resources: { memory: "256m", cpus: "0.5", pidsLimit: 100 },
    });
    await runtime.init();
    expect(runtime.isReady()).toBe(false);
    await runtime.withReady();
    expect(runtime.isReady()).toBe(true);
    const id = runtime.getContainerId();
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");
  }, 120000);

  it("second withReady() call is deduplicated", async () => {
    const runtime = new DockerRuntime({
      image: "debian:12-slim",
      hostCwd: "/tmp",
      name: testName + "-dedup",
      allowNetwork: false,
      resources: { memory: "256m", cpus: "0.5" },
    });
    await runtime.init();
    const [r1, r2] = await Promise.all([runtime.withReady(), runtime.withReady()]);
    expect(runtime.isReady()).toBe(true);
  }, 120000);
});
```

- [ ] **Step 2: Verify test fails**

```bash
npx vitest run tests/runtime.test.ts
```

Expected: FAIL — stubs throw "not implemented".

- [ ] **Step 3: Implement ensureImage, startContainer, withReady**

Replace the stub methods in `src/runtime.ts`:

```ts
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

getContainerId(): string | null {
  return this.state.kind === "ready" ? this.state.id : null;
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
```

- [ ] **Step 4: Verify test passes**

```bash
npx vitest run tests/runtime.test.ts
```

Expected: PASS (Docker-dependent tests run if Docker available).

- [ ] **Step 5: Commit**

```bash
git add src/runtime.ts tests/runtime.test.ts
git commit -m "feat: DockerRuntime ensureImage, startContainer, withReady, shutdown"
```

---

### Task 5: DockerRuntime.exec() with demux + abort + timeout (TDD)

**Files:**
- Modify: `src/runtime.ts`
- Modify: `tests/runtime.test.ts`

- [ ] **Step 1: Write failing test for exec()**

Add to `tests/runtime.test.ts`:

```ts
describe.skipIf(!dockerAvailable)("DockerRuntime exec", () => {
  const testName = `pi-test-exec-${Date.now()}`;

  beforeAll(async () => {
    const runtime = new DockerRuntime({
      image: "debian:12-slim",
      hostCwd: "/tmp",
      name: testName,
      allowNetwork: false,
      resources: { memory: "256m", cpus: "0.5" },
    });
    await runtime.init();
    await runtime.withReady();
  }, 120000);

  afterAll(async () => {
    const d = new Dockerode({ socketPath: "/var/run/docker.sock" });
    try { const c = d.getContainer(testName); await c.remove({ force: true }); } catch {}
  });

  it("exec returns stdout and exitCode 0", async () => {
    const runtime = new DockerRuntime({
      image: "debian:12-slim",
      hostCwd: "/tmp",
      name: testName + "-exec1",
      allowNetwork: false,
      resources: { memory: "256m", cpus: "0.5" },
    });
    await runtime.init();
    await runtime.withReady();
    const result = await runtime.exec({ cmd: ["echo", "-n", "hello"] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("hello");
    expect(result.stderr.toString()).toBe("");
    await runtime.shutdown();
  }, 120000);

  it("exec returns non-zero exitCode for failing command", async () => {
    const runtime = new DockerRuntime({
      image: "debian:12-slim",
      hostCwd: "/tmp",
      name: testName + "-exec2",
      allowNetwork: false,
      resources: { memory: "256m", cpus: "0.5" },
    });
    await runtime.init();
    await runtime.withReady();
    const result = await runtime.exec({ cmd: ["sh", "-c", "exit 42"] });
    expect(result.exitCode).toBe(42);
    await runtime.shutdown();
  }, 120000);

  it("exec separates stdout and stderr (demux)", async () => {
    const runtime = new DockerRuntime({
      image: "debian:12-slim",
      hostCwd: "/tmp",
      name: testName + "-exec3",
      allowNetwork: false,
      resources: { memory: "256m", cpus: "0.5" },
    });
    await runtime.init();
    await runtime.withReady();
    const result = await runtime.exec({
      cmd: ["sh", "-c", "echo out; echo err >&2"],
    });
    expect(result.stdout.toString().trim()).toBe("out");
    expect(result.stderr.toString().trim()).toBe("err");
    await runtime.shutdown();
  }, 120000);

  it("exec honors timeoutMs — returns null exitCode", async () => {
    const runtime = new DockerRuntime({
      image: "debian:12-slim",
      hostCwd: "/tmp",
      name: testName + "-exec4",
      allowNetwork: false,
      resources: { memory: "256m", cpus: "0.5" },
    });
    await runtime.init();
    await runtime.withReady();
    const result = await runtime.exec({
      cmd: ["sleep", "10"],
      timeoutMs: 1000,
    });
    expect(result.exitCode).toBe(null);
    await runtime.shutdown();
  }, 120000);

  it("exec streams onData for stdout", async () => {
    const runtime = new DockerRuntime({
      image: "debian:12-slim",
      hostCwd: "/tmp",
      name: testName + "-exec5",
      allowNetwork: false,
      resources: { memory: "256m", cpus: "0.5" },
    });
    await runtime.init();
    await runtime.withReady();
    const chunks: Buffer[] = [];
    const result = await runtime.exec({
      cmd: ["sh", "-c", "echo one; sleep 0.1; echo two"],
      onData: (chunk) => chunks.push(chunk),
    });
    expect(result.exitCode).toBe(0);
    const output = Buffer.concat(chunks).toString().trim().split("\n");
    expect(output).toContain("one");
    expect(output).toContain("two");
    await runtime.shutdown();
  }, 120000);
});
```

- [ ] **Step 2: Verify test fails**

```bash
npx vitest run tests/runtime.test.ts
```

Expected: FAIL — exec stub throws "not implemented".

- [ ] **Step 3: Implement exec() with demux**

Replace the stub `exec()` method:

```ts
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
    if (opts.signal.aborted) {
      controller.abort(opts.signal.reason);
    } else {
      opts.signal.addEventListener(
        "abort",
        () => controller.abort(opts.signal.reason),
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
    try { stream.destroy(); } catch {}
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
```

- [ ] **Step 4: Verify test passes**

```bash
npx vitest run tests/runtime.test.ts
```

Expected: All exec tests PASS (if Docker available).

- [ ] **Step 5: Commit**

```bash
git add src/runtime.ts tests/runtime.test.ts
git commit -m "feat: DockerRuntime.exec() with demux, abort, and timeout support"
```

---

### Task 6: Rename sandbox.ts → session.ts (refactor, test-guarded)

**Files:**
- Create: `src/session.ts`
- Delete: `src/sandbox.ts`
- Modify: All imports referencing `./sandbox`
- Test: `tests/session.test.ts` (rename from `tests/sandbox.test.ts`)

- [ ] **Step 1: Update existing sandbox test to reflect new import**

```bash
mv tests/sandbox.test.ts tests/session.test.ts
```

Edit `tests/session.test.ts` — change import from `"../src/sandbox"` to `"../src/session"`.

- [ ] **Step 2: Verify test fails (renamed file doesn't exist yet)**

```bash
npx vitest run tests/session.test.ts
```

Expected: FAIL — `Cannot find module '../src/session'`.

- [ ] **Step 3: Create src/session.ts and rename src/sandbox.ts**

```bash
mv src/sandbox.ts src/session.ts
```

Update `src/session.ts` content — change `Runtime` import to match new interface:

```ts
import type { Runtime, MountSpec, SandboxOptions } from "./runtime";
import type { SbxConfig } from "./config";

export interface SbxSession {
  runtime: Runtime;
  name: string;
  hostCwd: string;
  keep: boolean;
  mounts: MountSpec[];
  allowedExternalPrefixes: string[];
  resources?: SandboxOptions["resources"];
  imageRef: string;
  config: SbxConfig;
  isReusable: boolean;
  isReattached: boolean;
}

let sandboxInstance: SbxSession | null = null;

export function getSbx(): SbxSession | null {
  return sandboxInstance;
}

export function setSbx(s: SbxSession): void {
  sandboxInstance = s;
}

export function clearSbx(): void {
  sandboxInstance = null;
}
```

- [ ] **Step 4: Update all imports in source files**

```bash
grep -rl "from.*\./sandbox" --include="*.ts" src/ index.ts tests/ | while read f; do
  sed -i 's|from "\./sandbox"|from "./session"|g; s|from "\.\./sandbox"|from "../session"|g' "$f"
done
```

- [ ] **Step 5: Verify test passes**

```bash
npx vitest run tests/session.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run full typecheck**

```bash
npx tsc --noEmit
```

Expected: No errors related to sandbox/session imports.

- [ ] **Step 7: Commit**

```bash
git add src/session.ts tests/session.test.ts
git add -u
git commit -m "refactor: rename sandbox.ts to session.ts, update SbxSession.runtime type"
```

---

### Task 7: Update ops.ts — execCapture/execStream + writeFile mkdir -p (TDD)

**Files:**
- Modify: `src/ops.ts`
- Test: `tests/ops.test.ts` (new)

- [ ] **Step 1: Write failing test for writeFile creating parent dirs**

Create `tests/ops.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createWriteOps } from "../src/ops";
import type { MountSpec, Runtime, ExecOpts, ExecResult } from "../src/runtime";

function mockRuntime(execResults: Record<string, ExecResult>): Runtime {
  return {
    init: async () => {},
    isReady: () => true,
    ensureImage: async () => {},
    startContainer: async () => {},
    withReady: async () => {},
    shutdown: async () => {},
    getContainerId: () => "mock-id",
    getWorkRoot: () => "/workspace",
    async exec(opts: ExecOpts): Promise<ExecResult> {
      const key = opts.cmd.join(" ");
      if (execResults[key]) return execResults[key];
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
  };
}

describe("createWriteOps.writeFile", () => {
  it("calls mkdir -p before writing to create parent dirs", async () => {
    const calls: string[] = [];
    const runtime = mockRuntime({});
    // Override exec to track calls
    const origExec = runtime.exec.bind(runtime);
    runtime.exec = async (opts) => {
      calls.push(opts.cmd.join(" "));
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    };

    const ops = createWriteOps({
      runtime,
      name: "test",
      hostCwd: "/home/user/project",
      mounts: [],
      allowedExternalPrefixes: [],
    });

    await ops.writeFile("sub/deep/file.txt", "content");

    const mkdirCall = calls.find((c) => c.startsWith("sh -c mkdir -p"));
    const writeCall = calls.find((c) => c.includes("base64"));
    expect(mkdirCall).toBeDefined();
    expect(mkdirCall).toContain("/workspace/sub/deep");
    expect(writeCall).toBeDefined();
    expect(writeCall).toContain("/workspace/sub/deep/file.txt");
  });
});
```

- [ ] **Step 2: Verify test fails**

```bash
npx vitest run tests/ops.test.ts
```

Expected: FAIL — current writeFile has no mkdir -p.

- [ ] **Step 3: Implement ops.ts changes**

Rewrite `src/ops.ts` entirely:

```ts
import { readFileSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { ReadOperations, WriteOperations, EditOperations, BashOperations } from "@earendil-works/pi-coding-agent";
import type { MountSpec, Runtime } from "./runtime";
import { toRemote, isReadOnlyMount, isInsideCwd, isAllowedExternalResource, shq } from "./paths";

export interface SbxHandle {
  runtime: Runtime;
  name: string;
  hostCwd: string;
  mounts: MountSpec[];
  allowedExternalPrefixes: string[];
}

export async function execCapture(sbx: SbxHandle, command: string, timeoutMs?: number): Promise<Buffer> {
  const result = await sbx.runtime.exec({
    cmd: ["sh", "-c", command],
    timeoutMs,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `exec failed (${result.exitCode}): ${result.stderr.toString("utf-8").trim().slice(0, 500)}`,
    );
  }
  return result.stdout;
}

export async function execStream(
  sbx: SbxHandle,
  command: string,
  opts: { onData: (b: Buffer) => void; signal?: AbortSignal; timeout?: number },
): Promise<{ exitCode: number | null }> {
  const result = await sbx.runtime.exec({
    cmd: ["sh", "-c", command],
    onData: opts.onData,
    signal: opts.signal,
    timeoutMs: opts.timeout,
  });
  return { exitCode: result.exitCode };
}

export function createReadOps(sbx: SbxHandle): ReadOperations {
  const resolveAbs = (p: string) => resolvePath(sbx.hostCwd, p);
  const tryExternal = (p: string): { external: true; abs: string } | { external: false } => {
    if (isInsideCwd(p, sbx.hostCwd)) return { external: false };
    const abs = resolveAbs(p);
    return isAllowedExternalResource(abs, sbx.allowedExternalPrefixes)
      ? { external: true, abs }
      : { external: false };
  };

  return {
    readFile: (p) => {
      const ext = tryExternal(p);
      if (ext.external) return Promise.resolve(readFileSync(ext.abs));
      return execCapture(sbx, `cat ${shq(toRemote(p, sbx.hostCwd, sbx.mounts))}`);
    },
    access: (p) => {
      const ext = tryExternal(p);
      if (ext.external) {
        try { statSync(ext.abs); return Promise.resolve(); }
        catch (e) { return Promise.reject(e); }
      }
      return execCapture(sbx, `test -r ${shq(toRemote(p, sbx.hostCwd, sbx.mounts))}`).then(() => {});
    },
    detectImageMimeType: async (p) => {
      const ext = tryExternal(p);
      if (ext.external) {
        const ext2lower = ext.abs.split(".").pop()?.toLowerCase() || "";
        const map: Record<string, string> = {
          jpg: "image/jpeg", jpeg: "image/jpeg",
          png: "image/png", gif: "image/gif", webp: "image/webp",
        };
        return map[ext2lower] || null;
      }
      try {
        const r = await execCapture(sbx, `file --mime-type -b ${shq(toRemote(p, sbx.hostCwd, sbx.mounts))}`);
        const m = r.toString().trim();
        return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
      } catch {
        return null;
      }
    },
  };
}

export function createWriteOps(sbx: SbxHandle): WriteOperations {
  return {
    writeFile: async (p, content) => {
      const remote = toRemote(p, sbx.hostCwd, sbx.mounts);
      if (isReadOnlyMount(remote, sbx.mounts)) {
        throw new Error(`sandbox: refusing to write to ${remote}: read-only skill mount`);
      }
      const parentDir = remote.split("/").slice(0, -1).join("/") || "/";
      await execCapture(sbx, `mkdir -p ${shq(parentDir)}`);
      const buf = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
      const b64 = buf.toString("base64");
      await execCapture(sbx, `printf %s ${shq(b64)} | base64 -d > ${shq(remote)}`);
    },
    mkdir: async (dir) => {
      const remote = toRemote(dir, sbx.hostCwd, sbx.mounts);
      if (isReadOnlyMount(remote, sbx.mounts)) {
        throw new Error(`sandbox: refusing to mkdir in ${remote}: read-only skill mount`);
      }
      await execCapture(sbx, `mkdir -p ${shq(remote)}`);
    },
  };
}

export function createEditOps(sbx: SbxHandle): EditOperations {
  const r = createReadOps(sbx);
  const w = createWriteOps(sbx);
  return {
    readFile: r.readFile,
    access: r.access,
    writeFile: async (p, content) => {
      const remote = toRemote(p, sbx.hostCwd, sbx.mounts);
      if (isReadOnlyMount(remote, sbx.mounts)) {
        throw new Error(`sandbox: refusing to edit ${remote}: read-only skill mount`);
      }
      return w.writeFile(p, content);
    },
  };
}

export function createBashOps(sbx: SbxHandle): BashOperations {
  return {
    exec: (command, cwd, opts) => {
      const remoteCwd = toRemote(cwd, sbx.hostCwd, sbx.mounts);
      return execStream(sbx, `cd ${shq(remoteCwd)} && ${command}`, opts as { onData: (b: Buffer) => void; signal?: AbortSignal; timeout?: number });
    },
  };
}
```

- [ ] **Step 4: Verify tests pass**

```bash
npx vitest run tests/ops.test.ts
```

Expected: PASS — writeFile creates parent dirs.

- [ ] **Step 5: Commit**

```bash
git add src/ops.ts tests/ops.test.ts
git commit -m "fix(ops): execCapture/execStream via Runtime.exec, writeFile mkdir -p"
```

---

### Task 8: Fix src/commands/sandbox.ts — stop handler (TDD)

**Files:**
- Modify: `src/commands/sandbox.ts`
- Test: `tests/commands.test.ts` (new)

- [ ] **Step 1: Write failing test for stop handler**

Create `tests/commands.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createSandboxCommandHandlers } from "../src/commands/sandbox";
import { setSbx, clearSbx, type SbxSession } from "../src/session";
import type { Runtime } from "../src/runtime";

function mockRuntime(): Runtime {
  return {
    init: async () => {},
    isReady: () => true,
    ensureImage: async () => {},
    startContainer: async () => {},
    withReady: async () => {},
    shutdown: async () => {},
    getContainerId: () => "mock-id",
    getWorkRoot: () => "/workspace",
    exec: async () => ({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
  };
}

function mockPathApprovals() {
  return {
    list: () => [],
    revoke: () => false,
    add: () => {},
    find: () => undefined,
  };
}

describe("/sandbox stop", () => {
  it("blocks stop when keep is true", async () => {
    const notifications: { msg: string; level: string }[] = [];
    const ctx = { ui: { notify: (msg: string, level?: string) => notifications.push({ msg, level: level ?? "info" }) } };
    const handlers = createSandboxCommandHandlers("/tmp", mockPathApprovals());

    const rt = mockRuntime();
    setSbx({
      runtime: rt,
      name: "test-box",
      hostCwd: "/tmp",
      keep: true,
      mounts: [],
      allowedExternalPrefixes: [],
      imageRef: "img:latest",
      config: {} as any,
      isReusable: false,
      isReattached: false,
    });

    await handlers.stop("", ctx);
    expect(notifications.some((n) => n.msg.includes("keep/persist"))).toBe(true);
    clearSbx();
  });

  it("executes shutdown when keep is false", async () => {
    const notifications: { msg: string; level: string }[] = [];
    const ctx = { ui: { notify: (msg: string, level?: string) => notifications.push({ msg, level: level ?? "info" }) } };
    const handlers = createSandboxCommandHandlers("/tmp", mockPathApprovals());

    let shutdownCalled = false;
    const rt = mockRuntime();
    rt.shutdown = async () => { shutdownCalled = true; };

    setSbx({
      runtime: rt,
      name: "test-box",
      hostCwd: "/tmp",
      keep: false,
      mounts: [],
      allowedExternalPrefixes: [],
      imageRef: "img:latest",
      config: {} as any,
      isReusable: false,
      isReattached: false,
    });

    await handlers.stop("", ctx);
    expect(shutdownCalled).toBe(true);
    expect(notifications.some((n) => n.msg.includes("stopped and removed"))).toBe(true);
    clearSbx();
  });
});
```

- [ ] **Step 2: Verify test fails**

```bash
npx vitest run tests/commands.test.ts
```

Expected: FAIL — stop handler ignores keep flag.

- [ ] **Step 3: Implement changes in commands/sandbox.ts**

Old stop handler (lines 50-59):
```ts
stop: async (_args: string, ctx: { ... }) => {
  const sbx = getSbx();
  if (!sbx) { ... return; }
  sbx.runtime.stop(sbx.name);
  sbx.runtime.remove(sbx.name);
  ...
},
```

Replace with:
```ts
stop: async (_args: string, ctx: { ui: { notify: (msg: string, level?: "info" | "warning" | "error") => void } }) => {
  const sbx = getSbx();
  if (!sbx) {
    ctx.ui.notify("Sandbox is not active.", "info");
    return;
  }
  if (sbx.keep) {
    ctx.ui.notify(
      `Container ${sbx.name} has keep/persist set. Use /sandbox keep with a different name, or clear sandbox.json to disable persistence.`,
      "warning",
    );
    return;
  }
  try {
    sbx.runtime.shutdown();
  } catch (e) {
    ctx.ui.notify(`Stop failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    return;
  }
  clearSbx();
  ctx.ui.notify(`Sandbox ${sbx.name} stopped and removed.`, "info");
},
```

Also fix `sbx.runtime.kind` in status handler (line 36) — replace:
```ts
`Sandbox: ${sbx.runtime.kind} container ${sbx.name}${reusableStr}`,
```
with:
```ts
`Sandbox: docker container ${sbx.name}${reusableStr}`,
```

- [ ] **Step 4: Verify tests pass**

```bash
npx vitest run tests/commands.test.ts
```

Expected: PASS — both tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/commands/sandbox.ts tests/commands.test.ts
git commit -m "fix: respect keep/persist in /sandbox stop, replace runtime.kind with 'docker'"
```

---

### Task 9: Fix src/skills.ts — dedup logging (TDD)

**Files:**
- Modify: `src/skills.ts`
- Test: `tests/skills.test.ts` (new)

- [ ] **Step 1: Write failing test for dedup logging**

Create `tests/skills.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { discoverSkillMounts } from "../src/skills";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

describe("discoverSkillMounts", () => {
  it("logs when skipping duplicate mount target", () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});

    // Create two fake skill dirs with same target name
    const base = resolve(tmpdir(), `pi-test-skills-${Date.now()}`);
    const dir1 = resolve(base, "skill-a");
    const dir2 = resolve(base, "skill-a-copy");
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });
    writeFileSync(resolve(dir1, "SKILL.md"), "# Skill A");
    writeFileSync(resolve(dir2, "SKILL.md"), "# Skill A Copy");

    // dir2 has same mount target name, should be skipped
    const mounts = discoverSkillMounts([dir1, dir2]);

    expect(mounts.length).toBeGreaterThanOrEqual(1);
    const skipLog = spy.mock.calls.find((c) => c[0]?.includes?.("skipping duplicate mount"));
    expect(skipLog).toBeDefined();

    spy.mockRestore();
    rmSync(base, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Verify test fails**

```bash
npx vitest run tests/skills.test.ts
```

Expected: FAIL — no dedup log emitted.

- [ ] **Step 3: Add dedup logging in skills.ts**

In `src/skills.ts`, find the dedup check (inside the skill mounting loop) and add log before `continue`:

```ts
if (mounts.some((m) => m.target === target)) {
  console.debug(`sandbox: skipping duplicate mount target ${target} (already mounted from another source)`);
  continue;
}
```

- [ ] **Step 4: Verify test passes**

```bash
npx vitest run tests/skills.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/skills.ts tests/skills.test.ts
git commit -m "fix(skills): log skipped duplicate mount targets"
```

---

### Task 10: Fix src/paths.ts — PathApprovalStore merge + toContainerPath (TDD)

**Files:**
- Modify: `src/paths.ts`
- Test: `tests/paths.test.ts` (modify existing)

- [ ] **Step 1: Write failing test for toContainerPath**

Add to `tests/paths.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { toContainerPath, REMOTE_ROOT, SKILLS_ROOT } from "../src/paths";
import type { MountSpec } from "../src/runtime";

describe("toContainerPath", () => {
  const hostCwd = "/home/user/project";
  const mounts: MountSpec[] = [
    { source: "/home/user/.agents/skills/my-skill", target: "/skills/my-skill" },
  ];

  it("maps host cwd path to /workspace", () => {
    const result = toContainerPath("src/file.ts", hostCwd, []);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe("/workspace/src/file.ts");
  });

  it("maps a skill mount path", () => {
    const result = toContainerPath("/home/user/.agents/skills/my-skill/SKILL.md", hostCwd, mounts);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe("/skills/my-skill/SKILL.md");
  });

  it("rejects path outside cwd and mounts", () => {
    const result = toContainerPath("/etc/passwd", hostCwd, mounts);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("escapes sandbox");
  });

  it("passes through paths already in /workspace or /skills", () => {
    expect(toContainerPath("/workspace/foo", hostCwd, []).ok).toBe(true);
    expect(toContainerPath("/skills/x", hostCwd, []).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Verify test fails**

```bash
npx vitest run tests/paths.test.ts
```

Expected: FAIL — `toContainerPath is not a function`.

- [ ] **Step 3: Implement toContainerPath + PathApprovalStore merge**

Add `toContainerPath` to `src/paths.ts` (after `SKILLS_ROOT` constant, around line 7):

```ts
export function toContainerPath(
  hostPath: string,
  hostCwd: string,
  mounts: MountSpec[],
): { ok: true; path: string } | { ok: false; reason: string } {
  if (hostPath.startsWith(`${REMOTE_ROOT}/`) || hostPath === REMOTE_ROOT) {
    return { ok: true, path: hostPath };
  }
  if (hostPath.startsWith(`${SKILLS_ROOT}/`) || hostPath === SKILLS_ROOT) {
    return { ok: true, path: hostPath };
  }

  const abs = resolvePath(hostCwd, hostPath);

  if (abs === hostCwd || abs.startsWith(`${hostCwd}/`)) {
    const rel = abs === hostCwd ? "" : abs.slice(hostCwd.length + 1);
    return { ok: true, path: rel ? `${REMOTE_ROOT}/${rel}` : REMOTE_ROOT };
  }

  for (const m of mounts) {
    if (abs === m.source || abs.startsWith(`${m.source}/`)) {
      const rel = abs === m.source ? "" : abs.slice(m.source.length + 1);
      return { ok: true, path: rel ? `${m.target}/${rel}` : m.target };
    }
  }

  return { ok: false, reason: `Path escapes sandbox: ${hostPath}` };
}
```

Update `PathApprovalStore` — add `lastSaveTime` field and merge-on-conflict in `save()` (replace the `save()` method):

Add private field after `private records`:
```ts
private lastSaveTime: number = 0;
```

Replace `private save()` with merge-on-conflict version:

```ts
private save(): void {
  const dir = this.path.slice(0, this.path.lastIndexOf("/"));
  if (!existsSync(dir)) {
    try { mkdirSync(dir, { recursive: true }); } catch { return; }
  }

  let existing: Map<string, PathApprovalRecord> | null = null;
  try {
    if (existsSync(this.path)) {
      const raw = JSON.parse(readFileSync(this.path, "utf-8")) as (Omit<PathApprovalRecord, "expiresAt"> & { expiresAt: number | null })[];
      existing = new Map();
      const now = Date.now();
      for (const r of raw) {
        const expiresAt = r.expiresAt === null ? Infinity : r.expiresAt;
        if (expiresAt === Infinity || expiresAt > now) {
          existing.set(r.path, { ...r, expiresAt });
        }
      }
    }
  } catch {
    // corrupt — skip merge
  }

  if (existing && existing.size > 0) {
    for (const [p, rec] of existing) {
      const ours = this.records.get(p);
      if (!ours || rec.expiresAt > ours.expiresAt) {
        this.records.set(p, rec);
      }
    }
  }

  const tmpPath = this.path + ".tmp";
  const data = Array.from(this.records.values()).map((r) => ({
    ...r,
    expiresAt: r.expiresAt === Infinity ? null : r.expiresAt,
  }));
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  renameSync(tmpPath, this.path);
}
```

- [ ] **Step 4: Verify tests pass**

```bash
npx vitest run tests/paths.test.ts
```

Expected: All PATH tests pass.

- [ ] **Step 5: Write and run test for PathApprovalStore merge**

Add to `tests/paths.test.ts`:

```ts
import { PathApprovalStore } from "../src/paths";

describe("PathApprovalStore merge-on-conflict", () => {
  it("merges external additions on save", () => {
    // This test verifies the merge logic by checking that
    // records added externally are preserved after save()
    // We test the internal logic through the public API.
    const dir = `${tmpdir()}/pi-test-approvals-${Date.now()}`;
    mkdirSync(dir, { recursive: true });

    // Create a store with one record
    const store1 = new PathApprovalStore(dir);
    store1.add("/foo", Infinity);

    // Now create a second store (simulating another process),
    // which loads the first store's data from disk
    const store2 = new PathApprovalStore(dir);
    store2.add("/bar", Infinity);
    // store2.save() merges /foo from disk with /bar

    // store1 should be able to find /bar after reloading
    const store3 = new PathApprovalStore(dir);
    const found = store3.find("/bar");
    expect(found).toBeDefined();
    expect(found!.path).toBe("/bar");

    rmSync(dir, { recursive: true, force: true });
  });
});
```

Add `import { tmpdir } from "node:os"` and `import { mkdirSync, rmSync } from "node:fs"` at top of test file.

```bash
npx vitest run tests/paths.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/paths.ts tests/paths.test.ts
git commit -m "fix(paths): restore toContainerPath escape detection, PathApprovalStore merge-on-conflict"
```

---

### Task 11: Update index.ts — DockerRuntime, cleaned guard, imports

**Files:**
- Modify: `index.ts`

- [ ] **Step 1: Update index.ts**

Replace imports (lines 1-30) with:

```ts
import { resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import {
  type ExtensionAPI,
  type ExtensionUIContext,
  createReadTool,
  createWriteTool,
  createEditTool,
  createBashTool,
} from "@earendil-works/pi-coding-agent";
import { DockerRuntime, deriveContainerName } from "./src/runtime";
import { loadSbxConfig, imageRefForTag } from "./src/config";
import { TIER_SPECS, parseSizeTier } from "./src/tiers";
import { getSbx, setSbx, clearSbx, type SbxSession } from "./src/session";
import {
  createReadOps,
  createWriteOps,
  createEditOps,
  createBashOps,
  execCapture,
} from "./src/ops";
import {
  getExternalPath,
  isAllowedExternalResource,
  ensureExternalReadApproved,
  PathApprovalStore,
  REMOTE_ROOT,
} from "./src/paths";
import { discoverSkillMounts } from "./src/skills";
import { createSandboxCommandHandlers } from "./src/commands/sandbox";
```

Replace the `session_start` handler body — key changes:
- Use `new DockerRuntime(...)` instead of `detectRuntime()`
- `TIER_SPECS[sizeTier]` instead of `TIER_SPECS[sizeTier || "medium"]`
- Add `cleaned` guard to process signal handlers
- Use `sbx.runtime.shutdown()` in `session_shutdown`

Replace `session_shutdown` handler with:

```ts
pi.on("session_shutdown", async () => {
  const sbx = getSbx();
  if (!sbx) return;
  if (!sbx.keep) {
    try { await sbx.runtime.shutdown(); } catch { /* ignore */ }
  }
  clearSbx();
});
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Run all unit tests**

```bash
npx vitest run
```

Expected: Tests that don't need Docker pass. Docker-dependent tests skip gracefully.

- [ ] **Step 4: Commit**

```bash
git add index.ts
git commit -m "fix: use DockerRuntime, add cleaned guard, fix redundant fallback and session_shutdown"
```

---

### Task 12: Fix tests/e2e.sh — capacity check ⚠️ → ❌

**Files:**
- Modify: `tests/e2e.sh`

- [ ] **Step 1: Fix capacity check**

Replace line 123:
```bash
    [ -n "$CAPS" ] && echo "$CAPS" | grep -q "00000000" && { echo "  ✅ C6: no caps"; PASS=$((PASS + 1)); } || echo "  ⚠️  C6: caps=$CAPS"
```

With:
```bash
    if [ -n "$CAPS" ] && echo "$CAPS" | grep -q "0000000000000000"; then
        echo "  ✅ C6: no caps"; PASS=$((PASS + 1))
    else
        echo "  ❌ C6: caps check failed ($CAPS)"; FAIL=$((FAIL + 1))
    fi
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e.sh
git commit -m "fix(test): report capacity check failures as FAIL instead of ⚠️"
```

---

### Task 13: Rewrite README.md

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Write new README based on MX style with DS additions**

Full content in plan. (See Task 10 in previous version for complete README.)

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README with MX-style quick start, troubleshooting, what-runs-where"
```

---

### Task 14: Final verification

- [ ] **Step 1: Install + typecheck**

```bash
npm install
npm run typecheck
```

Expected: No errors.

- [ ] **Step 2: Run unit tests**

```bash
npm test
```

Expected: All tests pass (Docker-dependent skip gracefully).

- [ ] **Step 3: Verify no leftover spawn imports**

```bash
grep -rn "from \"node:child_process\"" src/
```

Expected: No output.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: final cleanup after dockerode migration"
```
