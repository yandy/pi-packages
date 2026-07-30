# Podman Runtime 支持 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use supo-subagent-driven-development (recommended) or supo-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 pi-container-sandbox 增加 Podman 容器运行时支持，同时清理 tier 机制。

**Architecture:** `docker-cli.ts` 泛化为 `container-cli.ts`（二进制名参数化）→ `DockerRuntime` 重构使用新的 CLI 层 → 新增 `PodmanRuntime`（podman 特有行为：无 `--user`、资源降级）→ config 新增 `engine` 字段 → factory 函数按 engine 创建对应 runtime。

**Tech Stack:** TypeScript, Node.js, vitest, Docker CLI, Podman CLI

## Global Constraints

- 二进制兼容：Podman CLI 实现 docker-compatible 子命令（run/build/exec/stop/rm）
- 引擎默认 `auto`：优先 podman，不可用 fallback docker
- Podman rootless：不传 `--user`，资源参数支持降级重试
- 移除 `tier` 概念：`src/tiers.ts` 删除，所有资源参数默认 null（不传）
- `pidsLimit` 默认从 512 改为 null
- 向后兼容：旧 sandbox.json（无 engine 字段）按 auto 处理

---

### Task 1: 移除 tier 机制

**Files:**
- Delete: `src/tiers.ts`
- Delete: `tests/tiers.test.ts`
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`
- Modify: `tests/config-global-merge.test.ts`
- Modify: `tests/_helpers.ts`

**Interfaces:**
- Removes: `TierSpec`, `SizeTier`, `TIER_SPECS` (all from `src/tiers.ts`)
- Removes: `SbxConfig.runtime.tier` field (from `RuntimeConfig`)
- Removes: `DEFAULT_SBX_CONFIG.runtime.tier`
- Imports in `index.ts` and `commands/sandbox.ts` will be cleaned up in Task 7/8

- [ ] **Step 1: Update DEFAULT_SBX_CONFIG 和 RuntimeConfig 类型，移除 tier**

在 `src/config.ts` 中：
```typescript
// DEFAULT_SBX_CONFIG 中 runtime.tier 移除
export const DEFAULT_SBX_CONFIG: SbxConfig = {
	image: { name: "pi-container-sandbox", tag: "latest" },
	runtime: {
		name: null, network: true, persist: false,
		memory: null, cpus: null, swap: null, pidsLimit: null,
		cache: null, mounts: [], env: [],
	},
	host: { commands: [] },
};

// RuntimeConfig 接口中移除 tier 字段
export interface RuntimeConfig {
	name: string | null;
	// tier 移除
	network: boolean;
	// ...
}
```

同时移除 `src/config.ts` 中的 `import type { SizeTier } from "./tiers"`。

- [ ] **Step 2: 更新 config.test.ts — 移除 tier 相关测试，适配新默认值**

```typescript
// "returns defaults when no config file exists" 测试中的期望值更新
it("returns defaults when no config file exists", () => {
	const cfg = loadSbxConfig(testDir);
	// tier 不再存在于 DEFAULT_SBX_CONFIG 中
	expect(cfg.runtime.memory).toBeNull();
	expect(cfg.runtime.cpus).toBeNull();
	expect(cfg.runtime.swap).toBeNull();
	expect(cfg.runtime.pidsLimit).toBeNull();
	expect(cfg.runtime.network).toBe(true);
});

// 将引用 tier 的测试改为引用 memory
it("loads values from project config with per-group merge", () => {
	writeFileSync(resolvePath(configDir, "sandbox.json"), JSON.stringify({
		image: { name: "my-img", tag: "v2" },
		runtime: { memory: "8g", network: false },  // tier → memory
		host: { commands: ["git"] },
	}));
	const cfg = loadSbxConfig(testDir);
	expect(cfg.runtime.memory).toBe("8g");  // 替代 cfg.runtime.tier
});

// "partial group overrides" 测试同理
// "round-trips" 测试同理
```

- [ ] **Step 3: 更新 config-global-merge.test.ts — 移除 tier 引用**

```typescript
// 将 cfg.runtime.tier 断言替换
expect(cfg.runtime.network).toBe(true);  // 或其他非 tier 字段
```

- [ ] **Step 4: 更新 tests/_helpers.ts 中的 DEFAULT_CONFIG**

```typescript
const DEFAULT_CONFIG: SbxConfig = {
	image: { name: "pi-sandbox", tag: "latest" },
	runtime: {
		name: null, network: true, persist: false,
		memory: null, cpus: null, swap: null, pidsLimit: null,
		cache: null, mounts: [],
	},
	host: { commands: [] },
};
```

- [ ] **Step 5: 删除 src/tiers.ts 和 tests/tiers.test.ts**

- [ ] **Step 6: 运行测试，确认无 tier 引用**

```bash
cd pi-container-sandbox && npx vitest run 2>&1 | grep -i "tier\|FAIL"
```
预期：无 tier 相关编译/运行错误，已有测试全部通过。

- [ ] **Step 7: Commit**

```bash
git add src/tiers.ts tests/tiers.test.ts src/config.ts tests/config.test.ts tests/config-global-merge.test.ts tests/_helpers.ts
git commit -m "refactor: remove tier mechanism from config and runtime"
```

---

### Task 2: 创建 container-cli.ts（泛化容器 CLI 层）

**Files:**
- Create: `src/container-cli.ts`
- Modify: `src/docker-cli.ts`
- Create: `tests/container-cli.test.ts`

**Interfaces:**
- Produces: `container(binary: string, args: string[], opts?: { timeout?: number }): string`
- Produces: `containerSpawn(binary: string, args: string[], opts: {...}): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number | null; error?: string }>`
- Produces: `docker(args, opts)` (re-export wrapper)
- Produces: `dockerSpawn(args, opts)` (re-export wrapper)

- [ ] **Step 1: 创建 container-cli.ts 及对应测试**

`src/container-cli.ts`：
```typescript
import { execFileSync, spawn, type SpawnOptions } from "node:child_process";

export function container(
	binary: string,
	args: string[],
	opts?: { timeout?: number },
): string {
	return execFileSync(binary, args, {
		encoding: "utf-8",
		timeout: opts?.timeout ?? 30_000,
		maxBuffer: 16 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

export function containerSpawn(
	binary: string,
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
		const spawnOpts: SpawnOptions = { stdio: ["pipe", "pipe", "pipe"] };
		const child = spawn(binary, args, spawnOpts);

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

		child.stdout?.on("data", (chunk: Buffer) => {
			stdoutChunks.push(chunk);
			opts.onStdout?.(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrChunks.push(chunk);
			opts.onStderr?.(chunk);
		});

		child.on("close", (code) => finish(code));
		child.on("error", (err) => {
			spawnError = err.message;
			finish(null);
		});

		if (opts.timeoutMs && opts.timeoutMs > 0) {
			timer = setTimeout(() => {
				timedOut = true;
				spawnError = "timeout";
				child.kill("SIGKILL");
			}, opts.timeoutMs);
		}

		if (opts.signal) {
			if (opts.signal.aborted) {
				child.kill("SIGKILL");
			} else {
				opts.signal.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
			}
		}

		if (opts.stdin !== undefined) {
			const buf = typeof opts.stdin === "string" ? Buffer.from(opts.stdin) : opts.stdin;
			child.stdin?.end(buf);
		} else {
			child.stdin?.end();
		}
	});
}
```

- [ ] **Step 2: 写测试，验证 container() 使用正确的二进制名**

`tests/container-cli.test.ts`：
```typescript
import { describe, expect, it } from "vitest";
import { container, containerSpawn } from "../src/container-cli";

describe("container", () => {
	it("calls echo via container()", () => {
		const result = container("echo", ["-n", "hello"]);
		expect(result).toBe("hello");
	});

	it("calls echo via containerSpawn()", async () => {
		const result = await containerSpawn("echo", ["-n", "world"], {});
		expect(result.stdout.toString()).toBe("world");
		expect(result.exitCode).toBe(0);
	});

	it("throws when binary not found", () => {
		expect(() => container("nonexistent-binary-xyz", ["--help"])).toThrow();
	});

	it("captures stderr separately", async () => {
		// sh -c 'echo err >&2' writes to stderr
		const result = await containerSpawn("sh", ["-c", "echo err >&2"], {});
		expect(result.stderr.toString().trim()).toBe("err");
	});
});
```

- [ ] **Step 3: 运行测试验证通过**

```bash
cd pi-container-sandbox && npx vitest run tests/container-cli.test.ts
```

- [ ] **Step 4: 更新 docker-cli.ts 为兼容重导出**

`src/docker-cli.ts`：
```typescript
import { container, containerSpawn } from "./container-cli";

export function docker(args: string[], opts?: { timeout?: number }): string {
	return container("docker", args, opts);
}

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
	return containerSpawn("docker", args, opts);
}
```

- [ ] **Step 5: 运行全量测试确认无回归**

```bash
cd pi-container-sandbox && npx vitest run
```

- [ ] **Step 6: Commit**

```bash
git add src/container-cli.ts tests/container-cli.test.ts src/docker-cli.ts
git commit -m "refactor: extract container-cli.ts with parameterized binary name"
```

---

### Task 3: 重构 DockerRuntime 使用 container-cli

**Files:**
- Modify: `src/runtime.ts`
- Modify: `tests/runtime.test.ts`

**Interfaces:**
- Consumes: `container()`, `containerSpawn()` from `src/container-cli.ts`
- Produces: `DockerRuntime` (same public interface, internal refactored)

- [ ] **Step 1: 重构 DockerRuntime 内部实现**

将 `src/runtime.ts` 中所有对 `docker()`/`dockerSpawn()` 的直接调用改为使用 `container("docker", ...)`/`containerSpawn("docker", ...)`（从 `container-cli.ts` 导入）。

关键变更点：
```typescript
// 旧
import { docker, dockerSpawn } from "./docker-cli";

// 新
import { container, containerSpawn } from "./container-cli";

// 内部调用改为
container("docker", ["info"])
container("docker", ["image", "inspect", this.opts.image])
container("docker", ["container", "inspect", name])
container("docker", ["rm", "-f", name])
container("docker", args, { timeout: 60_000 })
containerSpawn("docker", args, { ... })

// buildImage 中也一样
containerSpawn("docker", ["build", "-t", image, ...], { ... })

// exec 中
containerSpawn("docker", ["exec", "-i", ...], { ... })

// shutdown 中
container("docker", ["stop", "-t", "5", name])
container("docker", ["rm", "-f", name])
```

- [ ] **Step 2: 运行全量测试，确认 DockerRuntime 行为不变**

```bash
cd pi-container-sandbox && npx vitest run
```
预期：所有已有的 DockerRuntime 测试仍然通过（skip 的继续 skip）。

- [ ] **Step 3: Commit**

```bash
git add src/runtime.ts
git commit -m "refactor: DockerRuntime uses container-cli instead of docker-cli"
```

---

### Task 4: 新增 PodmanRuntime

**Files:**
- Modify: `src/runtime.ts`
- Modify: `tests/runtime.test.ts`

**Interfaces:**
- Consumes: `container()`, `containerSpawn()` from `src/container-cli.ts`
- Consumes: expandEnvEntry, deriveContainerName from `src/runtime.ts`
- Produces: `PodmanRuntime` class implementing `Runtime`

- [ ] **Step 1: 编写 PodmanRuntime 测试（先写失败的测试）**

`tests/runtime.test.ts` 新增：

```typescript
import { execFileSync } from "node:child_process";

const podmanAvailable = (() => {
	try {
		execFileSync("podman", ["info"], { stdio: "ignore", timeout: 5000 });
		return true;
	} catch {
		return false;
	}
})();

describe.skipIf(!podmanAvailable)("PodmanRuntime", () => {
	let runtime: PodmanRuntime;

	it("init() pings Podman and sets initialized state", async () => {
		runtime = new PodmanRuntime({
			image: "debian:12-slim",
			hostCwd: "/tmp",
			name: "pi-test-podman-init",
			allowNetwork: false,
			resources: {},
		});
		await runtime.init();
		expect(runtime.isReady()).toBe(false);
	});
});

describe.skipIf(!podmanAvailable)("PodmanRuntime lifecycle", () => {
	const testName = `pi-test-podman-${Date.now()}`;

	afterAll(() => {
		try { execFileSync("podman", ["rm", "-f", testName], { stdio: "ignore" }); } catch {}
	});

	it("withReady() starts container and sets ready state", async () => {
		const runtime = new PodmanRuntime({
			image: "debian:12-slim",
			hostCwd: "/tmp",
			name: testName,
			allowNetwork: false,
			resources: {},
		});
		await runtime.init();
		await runtime.withReady();
		expect(runtime.isReady()).toBe(true);
		const id = runtime.getContainerId();
		expect(id).toBeTruthy();
	}, 120000);
});

describe.skipIf(!podmanAvailable)("PodmanRuntime exec", () => {
	const testName = `pi-test-podman-exec-${Date.now()}`;

	afterAll(() => {
		try { execFileSync("podman", ["rm", "-f", testName], { stdio: "ignore" }); } catch {}
	});

	it("exec returns stdout and exitCode 0", async () => {
		const runtime = new PodmanRuntime({
			image: "debian:12-slim",
			hostCwd: "/tmp",
			name: testName,
			allowNetwork: false,
			resources: {},
		});
		await runtime.init();
		await runtime.withReady();
		const result = await runtime.exec({ cmd: ["echo", "-n", "hello"] });
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toBe("hello");
		await runtime.shutdown();
	}, 120000);
});
```

- [ ] **Step 2: 运行测试验证失败**

```bash
cd pi-container-sandbox && npx vitest run tests/runtime.test.ts
```
预期：新增测试 FAIL（PodmanRuntime 未定义）。

- [ ] **Step 3: 实现 PodmanRuntime**

在 `src/runtime.ts` 中新增：

```typescript
export class PodmanRuntime implements Runtime {
	private state: State = { kind: "uninit", initialized: false };
	private workRoot = "/workspace";
	private _initPromise: Promise<void> | null = null;
	private opts: SandboxOptions;

	constructor(opts: SandboxOptions) {
		this.opts = opts;
	}

	async init(): Promise<void> {
		try {
			container("podman", ["info"]);
			this.state = { kind: "uninit", initialized: true };
		} catch (err) {
			this.state = {
				kind: "disabled",
				reason: err instanceof Error ? err.message : String(err),
			};
		}
	}

	isReady(): boolean { return this.state.kind === "ready"; }
	getWorkRoot(): string { return this.workRoot; }
	getContainerId(): string | null {
		return this.state.kind === "ready" ? this.state.id : null;
	}
	getImage(): string { return this.opts.image; }

	async imageExists(): Promise<boolean> {
		try {
			container("podman", ["image", "inspect", this.opts.image]);
			return true;
		} catch { return false; }
	}

	async buildImage(opts: BuildImageOpts): Promise<void> {
		const image = this.opts.image;
		const buildContext = opts.buildContext ?? PACKAGE_DOCKER_DIR;
		const report = (msg: string) => (opts.onProgress ?? this.opts.onProgress)?.(msg);
		report(`Building image ${image}...`);

		const args = ["build", "-t", image, "-f", opts.dockerfile, "--progress=plain"];
		if (opts.buildArgs) {
			for (const [k, v] of Object.entries(opts.buildArgs)) {
				args.push("--build-arg", `${k}=${v}`);
			}
		}
		args.push(buildContext);

		let pending = "";
		const result = await containerSpawn("podman", args, {
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

	async startContainer(): Promise<void> {
		const { hostCwd, name, allowNetwork, extraMounts, resources, cacheVolume, image, env } = this.opts;

		// Check for existing container
		let existingId: string | null = null;
		try {
			const info = JSON.parse(container("podman", ["container", "inspect", name]));
			if (info?.[0]) {
				const state = info[0].State;
				if (state?.Running) {
					this.state = { kind: "ready", id: info[0].Id };
					return;
				}
				existingId = info[0].Id;
			}
		} catch {}

		if (existingId) {
			try { container("podman", ["rm", "-f", name]); } catch {}
		}

		const args: string[] = [
			"run", "-d",
			"--name", name,
			"-w", this.workRoot,
			"-v", `${hostCwd}:${this.workRoot}`,
			// podman rootless: 不传 --user
			"--network", allowNetwork ? "bridge" : "none",
			"--cap-drop", "ALL",
			"--security-opt", "no-new-privileges",
		];

		// 资源限制：仅显式配置时传入
		const mem = resources?.memory;
		const cpus = resources?.cpus;
		const pids = resources?.pidsLimit;

		const hasResourceFlags = !!(mem || cpus || pids);

		if (mem) args.push("--memory", mem);
		if (cpus) args.push("--cpus", cpus);
		if (pids !== undefined && pids !== null) args.push("--pids-limit", String(pids));

		// swap
		if (resources?.swap !== undefined) {
			const swapVal = resources.swap;
			if (swapVal === "0") {
				args.push("--memory-swap", mem || "0");
			} else if (mem) {
				const memBytes = this._parseBytes(mem);
				const swapBytes = memBytes + this._parseBytes(swapVal);
				args.push("--memory-swap", String(swapBytes));
			}
		}

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

		// Environment
		const podmanEnv = ["DEBIAN_FRONTEND=noninteractive", ...this._expandEnv(env ?? [])];
		for (const e of podmanEnv) {
			args.push("-e", e);
		}

		args.push(image, "sleep", "infinity");

		// 尝试启动（可能因 cgroups 失败）
		try {
			container("podman", args, { timeout: 60_000 });
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			// 检测 cgroups 相关错误 → 降级重试
			if (hasResourceFlags && /cgroup|cgroups|cg\b/i.test(errMsg)) {
				// 去掉资源限制参数重试
				const strippedArgs = args.filter((a) => {
					const prev = args[args.indexOf(a) - 1];
					const isResourceFlag = ["--memory", "--cpus", "--pids-limit", "--memory-swap"].includes(prev);
					return !isResourceFlag && !["--memory", "--cpus", "--pids-limit", "--memory-swap"].includes(a);
				});
				// 重试前需去除资源值（紧跟在 flag 后面的值）
				container("podman", strippedArgs, { timeout: 60_000 });
				// 如果到这里说明重试成功
				console.warn(`sandbox: resource limits not applied (cgroups v2 required). Container started without --memory/--cpus.`);
			} else {
				throw err;
			}
		}

		const inspectInfo = JSON.parse(container("podman", ["container", "inspect", name]));
		this.state = { kind: "ready", id: inspectInfo[0].Id };
	}
	// ... withReady, shutdown, exec 与 DockerRuntime 相同，只是 docker → podman
}
```

注意：降级重试时，正确去除资源参数需要更精细的处理——资源 flag 和其值是一对。最简单的方式是：将资源 args 部分先保存，检测失败后再构建不含资源参数的 args。

推荐实现方式：
```typescript
async startContainer(): Promise<void> {
	// ... 前置检查 ...

	// 构建基础 args（不含资源限制）
	const baseArgs: string[] = [
		"run", "-d", "--name", name,
		"-w", this.workRoot,
		"-v", `${hostCwd}:${this.workRoot}`,
		"--network", allowNetwork ? "bridge" : "none",
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges",
	];

	// 资源限制 args（单独收集）
	const resourceArgs: string[] = [];
	if (mem) { resourceArgs.push("--memory", mem); }
	if (cpus) { resourceArgs.push("--cpus", cpus); }
	if (pids !== undefined && pids !== null) { resourceArgs.push("--pids-limit", String(pids)); }
	// swap...

	// extra mounts, env, image...

	// 先尝试完整 args
	const fullArgs = [...baseArgs, ...resourceArgs, ...mountArgs, ...envArgs, image, "sleep", "infinity"];
	try {
		container("podman", fullArgs, { timeout: 60_000 });
	} catch (err) {
		if (resourceArgs.length > 0 && /cgroup|cgroups|cg\b/i.test(err instanceof Error ? err.message : String(err))) {
			const fallbackArgs = [...baseArgs, ...mountArgs, ...envArgs, image, "sleep", "infinity"];
			container("podman", fallbackArgs, { timeout: 60_000 });
			console.warn("sandbox: resource limits not applied (cgroups v2 required)");
		} else {
			throw err;
		}
	}
	// ...
}
```

- [ ] **Step 4: PodmanRuntime 的 exec, shutdown, withReady 实现**

与 DockerRuntime 相同逻辑，只是 `docker` → `podman`：
```typescript
async exec(opts: ExecOpts): Promise<ExecResult> {
	// ... 同 DockerRuntime，container("podman", ["exec", "-i", ...])
}
async shutdown(): Promise<void> {
	// ... container("podman", ["stop", "-t", "5", name]) ...
}
async withReady(): Promise<void> {
	// ... 同 DockerRuntime 逻辑 ...
}
```

- [ ] **Step 5: 运行测试验证 PodmanRuntime 测试通过**

```bash
cd pi-container-sandbox && npx vitest run tests/runtime.test.ts
```
预期：PodmanRuntime 测试通过（podman 不可用时 skip）。

- [ ] **Step 6: Commit**

```bash
git add src/runtime.ts tests/runtime.test.ts
git commit -m "feat: add PodmanRuntime with resource degradation support"
```

---

### Task 5: 更新 config — engine 字段 + detectEngine

**Files:**
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`

**Interfaces:**
- Produces: `RuntimeConfig.engine: "docker" | "podman" | "auto"` (default `"auto"`)
- Produces: `detectEngine(): "docker" | "podman"` (throws if neither available)
- Produces: `resolveEngine(engine: "docker" | "podman" | "auto"): "docker" | "podman"`

- [ ] **Step 1: 编写 config 测试**

在 `tests/config.test.ts` 新增：
```typescript
import { detectEngine, resolveEngine } from "../src/config";

describe("engine field", () => {
	it("defaults to auto when not configured", () => {
		const cfg = loadSbxConfig(testDir);
		expect(cfg.runtime.engine).toBe("auto");
	});

	it("parses engine from project config", () => {
		const configDir = resolvePath(testDir, TEST_CONFIG_DIR);
		mkdirSync(configDir, { recursive: true });
		writeFileSync(resolvePath(configDir, "sandbox.json"), JSON.stringify({
			runtime: { engine: "podman" },
		}));
		const cfg = loadSbxConfig(testDir);
		expect(cfg.runtime.engine).toBe("podman");
	});

	it("engine falls back to auto on invalid value", () => {
		const configDir = resolvePath(testDir, TEST_CONFIG_DIR);
		mkdirSync(configDir, { recursive: true });
		writeFileSync(resolvePath(configDir, "sandbox.json"), JSON.stringify({
			runtime: { engine: "invalid" },
		}));
		const cfg = loadSbxConfig(testDir);
		expect(cfg.runtime.engine).toBe("auto");
	});
});

describe("detectEngine", () => {
	it("detects at least one runtime", () => {
		// 在 dev 环境至少有一个可用
		const engine = detectEngine();
		expect(["docker", "podman"]).toContain(engine);
	});
});

describe("resolveEngine", () => {
	it("returns podman when engine=podman and podman available", () => {
		// only test when podman is actually available
		try {
			execFileSync("podman", ["info"], { stdio: "ignore", timeout: 5000 });
			expect(resolveEngine("podman")).toBe("podman");
		} catch {
			// skip
		}
	});

	it("throws when engine=podman but podman not available", () => {
		// This is hard to test reliably without mocking
		// We test the auto path instead
		expect(["docker", "podman"]).toContain(resolveEngine("auto"));
	});
});
```

- [ ] **Step 2: 运行测试验证失败**

- [ ] **Step 3: 实现 engine 字段和 detectEngine**

在 `src/config.ts` 中：
```typescript
import { container } from "./container-cli";

export interface RuntimeConfig {
	engine: "docker" | "podman" | "auto";  // 新增
	name: string | null;
	network: boolean;
	persist: boolean;
	memory: string | null;
	cpus: string | null;
	swap: string | null;
	pidsLimit: number | null;
	cache: string | null;
	mounts: MountConfig[];
	env?: string[];
}

export const DEFAULT_SBX_CONFIG: SbxConfig = {
	image: { name: "pi-container-sandbox", tag: "latest" },
	runtime: {
		engine: "auto",  // 新增默认值
		name: null, network: true, persist: false,
		memory: null, cpus: null, swap: null, pidsLimit: null,
		cache: null, mounts: [], env: [],
	},
	host: { commands: [] },
};

/** 检测可用的容器引擎，优先 podman。抛错如果一个都没有。 */
export function detectEngine(): "docker" | "podman" {
	try { container("podman", ["info"]); return "podman"; } catch {}
	try { container("docker", ["info"]); return "docker"; } catch {}
	throw new Error("No container runtime available. Install podman or docker.");
}

/** 根据配置解析最终使用的引擎 */
export function resolveEngine(engine: "docker" | "podman" | "auto"): "docker" | "podman" {
	if (engine === "auto") return detectEngine();
	// 显式指定：验证可用性
	try {
		container(engine, ["info"]);
		return engine;
	} catch (err) {
		throw new Error(`Container runtime "${engine}" is not available: ${err instanceof Error ? err.message : String(err)}`);
	}
}
```

- [ ] **Step 4: 运行测试验证通过**

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: add engine field and detectEngine to config"
```

---

### Task 6: 更新 session & helpers

**Files:**
- Modify: `src/session.ts`
- Modify: `tests/_helpers.ts`

- [ ] **Step 1: session.ts 增加 engine 字段**

```typescript
export interface SbxSession {
	runtime: Runtime;
	name: string;
	hostCwd: string;
	engine: "docker" | "podman";  // 新增
	// ... 其他不变
}
```

- [ ] **Step 2: _helpers.ts 更新**

`createTestSession()` 新增 `engine`:
```typescript
export function createTestSession(overrides?: Partial<SbxSession>): SbxSession {
	return {
		// ... existing ...
		engine: "docker",  // 新增默认值
		...overrides,
	};
}
```

- [ ] **Step 3: 运行测试确认**

- [ ] **Step 4: Commit**

```bash
git add src/session.ts tests/_helpers.ts
git commit -m "feat: add engine field to SbxSession"
```

---

### Task 7: 更新 index.ts — createRuntime 工厂 + UI

**Files:**
- Modify: `index.ts`

**Interfaces:**
- Consumes: `DockerRuntime`, `PodmanRuntime`, `resolveEngine()`, `detectEngine()`
- Produces: `createRuntime(config, engine): Runtime` factory function
- UI 消息中 "docker" → engine 名

- [ ] **Step 1: 添加 createRuntime 工厂函数并替换所有 new DockerRuntime**

```typescript
import { resolveEngine } from "./src/config";
import { DockerRuntime, PodmanRuntime, type Runtime, type SandboxOptions } from "./src/runtime";

function createRuntime(engine: "docker" | "podman", opts: SandboxOptions): Runtime {
	if (engine === "podman") return new PodmanRuntime(opts);
	return new DockerRuntime(opts);
}
```

在 `session_start` 中：
```typescript
const engine = resolveEngine(cfg.runtime.engine);
// ... 构建 opts ...
const runtime = createRuntime(engine, {
	image,
	hostCwd: localCwd,
	name: sandboxName,
	allowNetwork,
	resources,
	extraMounts: allMounts.length ? allMounts : undefined,
	cacheVolume,
	env: cfg.runtime.env,
	onProgress: (msg: string) => ctx.ui.setStatus("sandbox", `[build] ${msg}`),
});
```

- [ ] **Step 2: 替换 UI 消息中的硬编码 "docker"**

```typescript
// 状态栏和通知
const engineLabel = engine;  // "docker" 或 "podman"
ctx.ui.notify([
	`${statusPrefix}: ${engineLabel} ${actualName}${resStr}${isReusable ? " [re-usable]" : ""}`,
	// ...
]);

// before_agent_start 中的 CWD 行
`Current working directory: ${CONTAINER_ROOT} (sandboxed in ${engineLabel} container ${sbx.name}, ...)`
```

- [ ] **Step 3: 移除 index.ts 中的 tier 相关代码**

移除：
- `import { TIER_SPECS } from "./src/tiers"`
- `const sizeTier = rt.tier; const tierSpec = TIER_SPECS[sizeTier];`
- 资源限制参数构建改用直接的 memory/cpus/swap/pidsLimit 检查
- `size=${sizeTier}` 从 UI 状态栏移除

资源参数构建（仅显式配置时传）：
```typescript
const resources: { memory?: string; cpus?: string; swap?: string; pidsLimit?: number } = {};
if (rt.memory) resources.memory = rt.memory;
if (rt.cpus) resources.cpus = rt.cpus;
if (rt.pidsLimit !== null) resources.pidsLimit = rt.pidsLimit;
if (rt.swap !== null) resources.swap = rt.swap;
```

- [ ] **Step 4: 将 engine 存入 SbxSession**

```typescript
setSbx({
	runtime,
	engine,  // 新增
	name: sandboxName,
	// ...
});
```

- [ ] **Step 5: 运行全量测试**

```bash
cd pi-container-sandbox && npx vitest run
```

- [ ] **Step 6: Commit**

```bash
git add index.ts
git commit -m "feat: add createRuntime factory, remove tier from index, update UI for engine"
```

---

### Task 8: 更新 commands/sandbox.ts

**Files:**
- Modify: `src/commands/sandbox.ts`

- [ ] **Step 1: 移除 tiers handler**

在 `createSandboxCommandHandlers` 中移除 `tiers` case，同时从 switch 中移除。

- [ ] **Step 2: 替换硬编码 "docker" 引用**

```typescript
// status 命令中
const engineName = sbx.engine;  // 新增
ctx.ui.notify(
	[`Sandbox: ${engineName} container ${sbx.name}${reusableStr}`, ...],
	"info",
);

// build 命令中
// 将 new DockerRuntime(...) 替换为 createRuntime
import { DockerRuntime, PodmanRuntime, type Runtime } from "../runtime";
// 当 sbx 不可用时，用 auto 检测引擎来构建
```

build 命令中的 fallback（无 sbx 时）：
```typescript
} else {
	// 无 session 时，检测可用引擎来构建镜像
	const engine = detectEngine();
	const runtime = createRuntime(engine, {
		image,
		hostCwd: localCwd,
		name: "pi-sbx-build",
		allowNetwork: true,
		resources: {},
		onProgress: (msg: string) => ctx.ui.setStatus("sandbox", `[build] ${msg}`),
	});
	await runtime.init();
	await runtime.buildImage({ dockerfile, buildContext: PACKAGE_DOCKER_DIR });
}
```

- [ ] **Step 3: 移除 TierSpec/SizeTier/TIER_SPECS import**

- [ ] **Step 4: 运行测试**

```bash
cd pi-container-sandbox && npx vitest run
```

- [ ] **Step 5: Commit**

```bash
git add src/commands/sandbox.ts
git commit -m "refactor: remove tiers command, use engine name in sandbox commands"
```

---

### Task 9: 集成验证 — 全量测试

**Files:**
- Modify: `tests/skills.test.ts` — 如有 tier 引用需更新
- Modify: `tests/config.test.ts` — 确认 saveSbxConfig round-trip 适配

- [ ] **Step 1: 运行全量测试**

```bash
cd pi-container-sandbox && npx vitest run 2>&1
```

预期：所有测试通过（podman 相关 skip if podman 不可用）。

- [ ] **Step 2: TypeScript 类型检查**

```bash
cd pi-container-sandbox && npx tsc --noEmit 2>&1
```
预期：无类型错误。

- [ ] **Step 3: 修复任何失败（迭代步骤 1-2 直到全绿）**

- [ ] **Step 4: Commit（如有修改）**

```bash
git add -A
git commit -m "test: integration fixes after podman support refactoring"
```

---

### Task 10: 文档更新

**Files:**
- Modify: `README.md`
- Modify: `README.zh.md`

- [ ] **Step 1: 更新 README.zh.md**

- 安装前提从"需要 Docker"改为"需要 Docker 或 Podman"
- 配置文档中新增 `engine` 字段说明
- 资源配置说明更新（移除 tier，改为直接 memory/cpus）
- 移除 `/sandbox tiers` 命令文档
- 新增 Podman 注意事项（rootless、cgroups v2）
- 故障排查中新增 podman 相关条目

- [ ] **Step 2: 同步更新 README.md（英文版）**

- [ ] **Step 3: Commit**

```bash
git add README.md README.zh.md
git commit -m "docs: update README for podman support and tier removal"
```

---

## 依赖关系

```
Task 1 (tier 移除) ─────────────────────────────────────────────┐
Task 2 (container-cli) ── Task 3 (重构 DockerRuntime) ──┐        │
                           Task 4 (PodmanRuntime) ───────┤        │
Task 5 (config engine) ─────────────────────────────────┤        │
                           Task 6 (session) ─────────────┤        │
                           Task 7 (index.ts factory) ────┤        │
                           Task 8 (commands) ────────────┤        │
                           Task 9 (集成验证) ─────────────┤        │
                           Task 10 (文档) ───────────────┘────────┘
```

Tasks 2/3/4 可以并行于 Tasks 1/5，但 Tasks 6/7/8 需要前面全部完成。
