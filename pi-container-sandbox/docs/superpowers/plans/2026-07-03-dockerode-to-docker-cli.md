# Dockerode → Docker CLI 迁移实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `pi-container-sandbox` 的 Docker 交互从 `dockerode` Node.js SDK 迁移到 `docker` CLI，去除外部依赖。

**Architecture:** 新增 `src/docker-cli.ts` 模块封装所有 Docker CLI 调用（使用 `child_process.execSync`/`spawn`），重写 `src/runtime.ts` 的 `DockerRuntime` 类使用 CLI 替代 dockerode API，保持 `Runtime` 接口和 `ExecResult` 类型不变。移除 `dockerode` 和 `@types/dockerode` 依赖。

**Tech Stack:** Node.js `child_process` (execSync, spawn)，`docker` CLI

## Global Constraints

- 保持 `Runtime` 接口不变（`src/runtime.ts:73-82`）
- 保持 `ExecResult` 接口不变（`src/runtime.ts:68-72`）
- 保持 `ExecOpts` 接口不变（`src/runtime.ts:59-66`）
- 保持 `BuildImageOpts` 和 `SandboxOptions` 接口不变
- 测试通过 `npm test`（vitest），允许 skipIf(!dockerAvailable)
- 类型检查通过 `npm run typecheck`
- 不引入新的 npm 依赖

---

### Task 1: 创建 Docker CLI 封装模块

**Files:**
- Create: `pi-container-sandbox/src/docker-cli.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `docker(args: string[], opts?: { timeout?: number; signal?: AbortSignal }): string` — 同步 docker 命令（execFileSync），用于简单操作（info、inspect、stop、rm）
  - `dockerSpawn(args: string[], opts: { timeoutMs?: number; signal?: AbortSignal; stdin?: string | Buffer; onStdout?: (d: Buffer) => void; onStderr?: (d: Buffer) => void }): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number | null }>` — 异步 spawn docker 命令，用于需要流式输出/超时/信号/cancel 的操作
  - `getDockerSocket(): string` — 从 DOCKER_HOST/DOCKER_SOCKET 环境变量获取 socket 路径（保持与旧代码一致）

- [ ] **Step 1: 创建 `src/docker-cli.ts` 文件，实现 `docker` 和 `dockerSpawn` 两个函数，以及 `getDockerSocket`**

```typescript
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
): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number | null }> {
	return new Promise((resolve) => {
		const spawnOpts: SpawnOptions = {
			stdio: ["pipe", "pipe", "pipe"],
		};
		const child = spawn("docker", args, spawnOpts);

		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let timedOut = false;
		let settled = false;

		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve({
				exitCode: timedOut ? null : code,
				stdout: Buffer.concat(stdoutChunks),
				stderr: Buffer.concat(stderrChunks),
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
			finish(null);
		});

		// 超时
		let timer: NodeJS.Timeout | null = null;
		if (opts.timeoutMs && opts.timeoutMs > 0) {
			timer = setTimeout(() => {
				timedOut = true;
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
```

- [ ] **Step 2: 验证 TypeScript 编译**

```bash
cd pi-container-sandbox && npx tsc --noEmit src/docker-cli.ts
```
Expected: 无类型错误。

---

### Task 2: 重写 DockerRuntime.init()、imageExists()、getContainerId()、shutdown()、withReady()

**Files:**
- Modify: `pi-container-sandbox/src/runtime.ts`

**Interfaces:**
- Consumes: `docker` from `src/docker-cli.ts`
- Produces: 无新接口，修改 `DockerRuntime` 类内部实现

- [ ] **Step 1: 删除 dockerode 相关 import 和 `_requireDocker`/`_getDocker`，添加 `docker-cli` import**

```typescript
// 删除:
// import Dockerode from "dockerode";
// 新增:
import { docker, getDockerSocket } from "./docker-cli";
```

- [ ] **Step 2: 移除 `State` 类型中的 `docker` 和 `container` 字段，用容器名和 ID 替代**

修改 `State` 类型（runtime.ts 第 108-112 行）：

```typescript
// 旧:
type State =
	| { kind: "uninit"; docker: Dockerode | null }
	| { kind: "disabled"; reason: string }
	| { kind: "broken"; reason: string }
	| { kind: "ready"; container: Dockerode.Container; id: string };

// 新:
type State =
	| { kind: "uninit"; initialized: boolean }
	| { kind: "disabled"; reason: string }
	| { kind: "broken"; reason: string }
	| { kind: "ready"; id: string };
```

- [ ] **Step 3: 重写 `init()` 方法 — 用 `docker info` 替代 `docker.ping()`**

```typescript
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
```

- [ ] **Step 4: 重写 `imageExists()` 方法 — 用 `docker image inspect` 替代 `docker.getImage().inspect()`**

```typescript
async imageExists(): Promise<boolean> {
	try {
		docker(["image", "inspect", this.opts.image]);
		return true;
	} catch {
		return false;
	}
}
```

- [ ] **Step 5: 重写 `shutdown()` 方法 — 用 `docker stop` + `docker rm` 替代 `container.stop()` + `container.remove()`**

```typescript
async shutdown(): Promise<void> {
	if (this.state.kind !== "ready") return;
	const name = this.opts.name;
	try { docker(["stop", "-t", "5", name]); } catch {}
	try { docker(["rm", "-f", name]); } catch {}
	this.state = { kind: "uninit", initialized: false };
}
```

- [ ] **Step 6: 重写 `withReady()` 方法 — 用 `docker container inspect` 替代 `container.inspect()`**

```typescript
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
```

- [ ] **Step 7: 更新 `_doInit()` 方法 — 移除 dockerode 引用**

```typescript
private async _doInit(): Promise<void> {
	// init() 已在构造函数调用链中执行，这里确保 initialized
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
```

- [ ] **Step 8: 更新 `getContainerId()` — 不再需要 dockerode container object**

```typescript
getContainerId(): string | null {
	return this.state.kind === "ready" ? this.state.id : null;
}
```

- [ ] **Step 9: 删除 `_requireDocker()` 和 `_getDocker()` 方法**

删除 runtime.ts 中的这两个私有方法。同时删除 `getDockerSocket()` 函数（现在从 docker-cli.ts import）。

---

### Task 3: 重写 DockerRuntime.startContainer()

**Files:**
- Modify: `pi-container-sandbox/src/runtime.ts`

**Interfaces:**
- Consumes: `docker` from `src/docker-cli.ts`
- Produces: 无新接口

- [ ] **Step 1: 用 `docker container inspect` + `docker run` 替代 dockerode 的 `getContainer().inspect()` + `createContainer()` + `start()`**

```typescript
async startContainer(): Promise<void> {
	const { hostCwd, name, allowNetwork, extraMounts, resources, cacheVolume, image, env } = this.opts;

	// 1. 检查已存在的容器
	let existingId: string | null = null;
	try {
		const info = JSON.parse(docker(["container", "inspect", name]));
		if (info?.[0]) {
			const state = info[0].State;
			if (state?.Running) {
				// 容器正在运行，复用
				this.state = { kind: "ready", id: info[0].Id };
				return;
			}
			existingId = info[0].Id;
		}
	} catch {}

	// 2. 清理现有容器（如果存在但未运行）
	if (existingId) {
		try { docker(["rm", "-f", name]); } catch {}
	}

	// 3. 构建 docker run 参数
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
		"--network", allowNetwork ? "default" : "none",
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges",
	];

	// 额外挂载
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

	// 环境变量
	const dockerEnv = ["DEBIAN_FRONTEND=noninteractive", ...this._expandEnv(env ?? [])];
	for (const e of dockerEnv) {
		args.push("-e", e);
	}

	args.push(image, "sleep", "infinity");

	// 4. 启动容器
	const output = docker(args, { timeout: 60_000 });
	const inspectInfo = JSON.parse(docker(["container", "inspect", name]));
	this.state = { kind: "ready", id: inspectInfo[0].Id };
}
```

- [ ] **Step 2: 保留 `_expandEnv` 和 `_parseBytes` 方法（无需修改）**

这两个方法不依赖 dockerode，保持不变。

---

### Task 4: 重写 DockerRuntime.buildImage()

**Files:**
- Modify: `pi-container-sandbox/src/runtime.ts`

**Interfaces:**
- Consumes: `dockerSpawn` from `src/docker-cli.ts`
- Produces: 无新接口

- [ ] **Step 1: 用 `dockerSpawn(["build", ...])` 替代 `docker.buildImage()` + `modem.followProgress()`**

```typescript
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
```

- [ ] **Step 2: 移除 `docker` import 中不需要的 `getDockerSocket`**

`getDockerSocket` 在 docker-cli.ts 中已被 `docker()` 函数内部使用（通过环境变量自动生效），runtime.ts 不再需要它。但如果之前 import 了，检查并清理。

---

### Task 5: 重写 DockerRuntime.exec()

**Files:**
- Modify: `pi-container-sandbox/src/runtime.ts`

**Interfaces:**
- Consumes: `dockerSpawn` from `src/docker-cli.ts`
- Produces: 无新接口，保持 `ExecResult` 不变

- [ ] **Step 1: 用 `dockerSpawn(["exec", "-i", ...])` 替代 `container.exec()` + 多路复用流解析**

```typescript
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
	if (opts.signal) {
		if (opts.signal.aborted) {
			return { exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
		}
		opts.signal.addEventListener("abort", () => controller.abort(opts.signal!.reason), { once: true });
	}

	const result = await dockerSpawn(args, {
		timeoutMs: opts.timeoutMs,
		signal: controller.signal,
		stdin: opts.stdin,
		onStdout: opts.onData,
		onStderr: opts.onData,
	});

	return result;
}
```

---

### Task 6: 更新 package.json 和清理残留

**Files:**
- Modify: `pi-container-sandbox/package.json`

- [ ] **Step 1: 从 `package.json` 中移除 dockerode 依赖**

```json
// 删除 "dependencies" 中的:
"dockerode": "^5.0.0"

// 删除 "devDependencies" 中的:
"@types/dockerode": "^4.0.1"
```

- [ ] **Step 2: 运行 npm install 清理锁文件**

```bash
cd pi-container-sandbox && npm install
```
Expected: 成功，无 dockerode 包安装。

- [ ] **Step 3: 清理 runtime.ts 中残留的 dockerode 引用**

搜索 `dockerode`、`Dockerode`、`getDockerSocket`（runtime.ts 中重复定义的版本）、`_requireDocker`、`_getDocker`、`this.state.docker`、`this.state.container` — 确保全部移除。

---

### Task 7: 更新测试文件

**Files:**
- Modify: `pi-container-sandbox/tests/runtime.test.ts`
- Modify: `pi-container-sandbox/tests/runtime-container-reuse.test.ts`

- [ ] **Step 1: 更新 `tests/runtime.test.ts` — 移除 dockerode import，更新清理逻辑**

```typescript
// 删除:
// import Dockerode from "dockerode";
// 新增:
import { execFileSync } from "node:child_process";
```

移除 `dockerAvailable` 中的 dockerode 检查，改为检查 docker CLI 是否可用：

```typescript
const dockerAvailable = (() => {
	try {
		execFileSync("docker", ["info"], { stdio: "ignore", timeout: 5_000 });
		return true;
	} catch {
		return false;
	}
})();
```

`ensureTestImage` 函数 — 将 dockerode 操作改为 docker CLI：

```typescript
async function ensureTestImage(image: string) {
	if (!dockerAvailable) return;
	try {
		execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" });
	} catch {
		execFileSync("docker", ["pull", image], { stdio: "inherit", timeout: 120_000 });
	}
}
```

所有 `afterAll` 中的容器清理 — 将 `new Dockerode().getContainer().remove()` 改为：

```typescript
afterAll(async () => {
	try { execFileSync("docker", ["rm", "-f", testName], { stdio: "ignore" }); } catch {}
});
```

- [ ] **Step 2: 更新 `tests/runtime-container-reuse.test.ts` — 同样模式**

```typescript
// 删除:
// import Dockerode from "dockerode";
// 新增:
import { execFileSync } from "node:child_process";

const dockerAvailable = (() => {
	try {
		execFileSync("docker", ["info"], { stdio: "ignore", timeout: 5_000 });
		return true;
	} catch {
		return false;
	}
})();
```

`beforeAll` — 镜像拉取：

```typescript
beforeAll(async () => {
	try {
		execFileSync("docker", ["image", "inspect", "debian:12-slim"], { stdio: "ignore" });
	} catch {
		execFileSync("docker", ["pull", "debian:12-slim"], { stdio: "inherit", timeout: 120_000 });
	}
}, 120000);
```

`afterAll` — 容器清理：

```typescript
afterAll(async () => {
	try { execFileSync("docker", ["rm", "-f", testName], { stdio: "ignore" }); } catch {}
	try { execFileSync("docker", ["rm", "-f", `${testName}-stopped`], { stdio: "ignore" }); } catch {}
});
```

`"stopped container is removed"` 测试中的容器操作：

```typescript
// 将 await d.getContainer(stoppedName).stop({ t: 5 });
// 改为:
execFileSync("docker", ["stop", "-t", "5", stoppedName], { stdio: "ignore" });
```

- [ ] **Step 3: 检查 `tests/_helpers.ts` — 无需修改**

该文件的 `mockRuntime` 不依赖 dockerode，保持不动。

---

### Task 8: 验证

**Files:**
- 无新建/修改

- [ ] **Step 1: 运行类型检查**

```bash
cd pi-container-sandbox && npm run typecheck
```
Expected: 无类型错误。

- [ ] **Step 2: 运行单元测试**

```bash
cd pi-container-sandbox && npm test
```
Expected: 所有非 Docker 相关测试通过，dockerAvailable 测试在 Docker 环境下通过。

- [ ] **Step 3: 搜索残留的 dockerode 引用**

```bash
grep -r "dockerode\|Dockerode" pi-container-sandbox/src/ pi-container-sandbox/tests/ pi-container-sandbox/package.json pi-container-sandbox/index.ts
```
Expected: 无匹配。

- [ ] **Step 4: 确认 Runtime 接口导出不变**

```bash
grep -n "export interface Runtime\|export interface ExecResult\|export interface ExecOpts\|export interface BuildImageOpts\|export interface SandboxOptions\|export class DockerRuntime" pi-container-sandbox/src/runtime.ts
```
Expected: 所有接口和类仍然存在。

---

## Self-Review

**1. Spec coverage:** 覆盖所有 dockerode 使用点：
- ✅ `runtime.ts` — init, imageExists, buildImage, startContainer, exec, shutdown, withReady, getContainerId
- ✅ `tests/runtime.test.ts` — Dockerode import, image pull, container cleanup
- ✅ `tests/runtime-container-reuse.test.ts` — Dockerode import, image pull, container stop/remove
- ✅ `package.json` — dependency removal

**2. Placeholder scan:** 所有步骤都有具体代码，无 TBD/TODO。

**3. Type consistency:**
- `ExecResult` — Task 5 返回 `{ exitCode, stdout, stderr }`，与接口定义一致
- `dockerSpawn` 返回类型 — `{ stdout: Buffer, stderr: Buffer, exitCode: number | null }`，Task 5 exec 直接返回
- `State` 类型 — Task 2 更新为 `{ kind: "ready", id: string }`，使用 `this.state.id` 替代旧 `this.state.id`
- `docker` 函数 — Task 1 定义，Task 2-3-6-7 使用，签名一致
- `dockerSpawn` 函数 — Task 1 定义，Task 4-5 使用，签名一致
