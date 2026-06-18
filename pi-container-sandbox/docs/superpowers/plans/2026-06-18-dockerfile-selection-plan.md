# Dockerfile 选择构建 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将镜像自动构建改为交互式选择构建，镜像缺失时弹出 Dockerfile 选择 UI。

**Architecture:** 运行时层新增 `imageExists()` + `buildImage()` 替代旧的 `ensureImage()`；`session_start` 和 `/sandbox build` 共享选择流程，通过 `discoverDockerfiles()` 扫描 `docker/` 并调用 `ctx.ui.select()`；`package.json` 的 `build-image` 脚本通过 CLI 参数或 `node:readline` 交互选择。

**Tech Stack:** TypeScript, Dockerode, Node.js, Vitest

---

### Task 1: `src/config.ts` — discoverDockerfiles + DOCKERFILE_SKIP

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`（先写测试）

- [ ] **Step 1: 写失败测试**

在 `tests/config.test.ts` 末尾追加：

```typescript
import { discoverDockerfiles, DOCKERFILE_SKIP, PACKAGE_DOCKER_DIR } from "../src/config";

describe("discoverDockerfiles", () => {
	it("discovers Dockerfile names from docker/ directory", () => {
		const files = discoverDockerfiles();
		expect(files).toContain("cn");
		expect(files).toContain("gh");
		expect(files.length).toBe(2);
	});

	it("DOCKERFILE_SKIP constant is '__skip__'", () => {
		expect(DOCKERFILE_SKIP).toBe("__skip__");
	});
});
```

- [ ] **Step 2: 验证测试失败**

```bash
npx vitest run tests/config.test.ts -t discoverDockerfiles
```
Expected: FAIL — `discoverDockerfiles` not exported / DOCKERFILE_SKIP not defined

- [ ] **Step 3: 实现 discoverDockerfiles + DOCKERFILE_SKIP**

在 `src/config.ts` 顶部更新 import：

```typescript
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve as resolvePath } from "node:path";
```

在文件末尾 `imageRefForTag` 函数后面追加：

```typescript
export const DOCKERFILE_SKIP = "__skip__";

export function discoverDockerfiles(): string[] {
	if (!existsSync(PACKAGE_DOCKER_DIR)) return [];
	return readdirSync(PACKAGE_DOCKER_DIR)
		.filter((f) => f.endsWith(".Dockerfile"))
		.map((f) => basename(f, extname(f)));
}
```

- [ ] **Step 4: 验证测试通过**

```bash
npx vitest run tests/config.test.ts -t discoverDockerfiles
```
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: add discoverDockerfiles and DOCKERFILE_SKIP"
```

---

### Task 2: `src/runtime.ts` — imageExists / buildImage / getImage

**Files:**
- Modify: `src/runtime.ts`
- Test: `tests/runtime.test.ts`（先改测试）

- [ ] **Step 1: 更新 test helpers（interface 改动会破坏现有引用）**

编辑 `tests/_helpers.ts`，替换 `mockRuntime` 中的 `ensureImage`/`rebuildImage`：

```typescript
export function mockRuntime(overrides?: Partial<Runtime>): Runtime {
	return {
		init: async () => {},
		isReady: () => true,
		imageExists: async () => true,
		buildImage: async () => {},
		startContainer: async () => {},
		withReady: async () => {},
		shutdown: async () => {},
		getContainerId: () => "mock-id",
		getWorkRoot: () => "/workspace",
		getImage: () => "img:latest",
		exec: async (_opts: ExecOpts): Promise<ExecResult> => ({
			exitCode: 0,
			stdout: Buffer.alloc(0),
			stderr: Buffer.alloc(0),
		}),
		...overrides,
	};
}
```

- [ ] **Step 2: 写新的 runtime 测试（替换旧的）**

编辑 `tests/runtime.test.ts`。

a) 删除旧测试 "ensureImage with forceBuild and onProgress rebuilds and reports progress"（将失败）和 "DockerRuntime rebuildImage" describe。

b) 在 `describe("PACKAGE_DOCKER_DIR", ...)` 之前追加新测试：

```typescript
describe.skipIf(!dockerAvailable)("DockerRuntime imageExists", () => {
	it("returns false for non-existent image", async () => {
		const runtime = new DockerRuntime({
			image: "nonexistent-image-xyz",
			hostCwd: "/tmp",
			name: "pi-test-exists-" + Date.now(),
			allowNetwork: false,
			resources: { memory: "256m", cpus: "0.5" },
		});
		await runtime.init();
		const exists = await runtime.imageExists();
		expect(exists).toBe(false);
	}, 30000);

	it("returns true for existing image", async () => {
		const runtime = new DockerRuntime({
			image: "debian:12-slim",
			hostCwd: "/tmp",
			name: "pi-test-exists2-" + Date.now(),
			allowNetwork: false,
			resources: { memory: "256m", cpus: "0.5" },
		});
		await runtime.init();
		const exists = await runtime.imageExists();
		expect(exists).toBe(true);
	}, 30000);
});

describe("DockerRuntime buildImage / getImage", () => {
	it("has buildImage method", () => {
		const runtime = new DockerRuntime({
			image: "debian:12-slim",
			hostCwd: "/tmp",
			name: "pi-test-build-" + Date.now(),
			allowNetwork: false,
			resources: { memory: "256m", cpus: "0.5" },
		});
		expect(typeof runtime.buildImage).toBe("function");
	});

	it("getImage returns the configured image name", () => {
		const runtime = new DockerRuntime({
			image: "my-custom-image:v1",
			hostCwd: "/tmp",
			name: "pi-test-getimg-" + Date.now(),
			allowNetwork: false,
			resources: { memory: "256m", cpus: "0.5" },
		});
		expect(runtime.getImage()).toBe("my-custom-image:v1");
	});
});
```

- [ ] **Step 3: 验证测试失败**

```bash
npx vitest run tests/runtime.test.ts tests/_helpers.ts
```
Expected: FAIL — TS 编译错误：`imageExists`/`buildImage`/`getImage` 尚未定义，`ensureImage`/`rebuildImage`/`forceBuild` 已移除

- [ ] **Step 4: 实现 runtime.ts 改动**

编辑 `src/runtime.ts`：

a) 在 `SandboxOptions` 前添加 `BuildImageOpts`：

```typescript
export interface BuildImageOpts {
	dockerfile: string;
	buildContext?: string;
	buildArgs?: Record<string, string>;
	onProgress?: (msg: string) => void;
}
```

b) 从 `SandboxOptions` 中移除 `forceBuild` 字段。

c) 更新 `Runtime` 接口，替换 `ensureImage`/`rebuildImage` 为：

```typescript
imageExists(): Promise<boolean>;
buildImage(opts: BuildImageOpts): Promise<void>;
getImage(): string;
```

d) 删除旧 `ensureImage` 方法（:118-167）和 `rebuildImage` 方法（:169-171）。

e) 在 `getContainerId` 方法后添加：

```typescript
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
	const buildArgs = opts.buildArgs ?? this.opts.buildArgs;
	const onProgress = opts.onProgress ?? this.opts.onProgress;

	const report = (msg: string) => onProgress?.(msg);
	report(`Building image ${image}...`);

	const buildStream = await docker.buildImage(
		{ context: buildContext, src: ["."] },
		{ t: image, dockerfile, buildargs: buildArgs },
	);

	const buildPromise = new Promise<void>((resolve, reject) => {
		docker.modem.followProgress(
			buildStream,
			(err: any) => {
				if (err) reject(err instanceof Error ? err : new Error(String(err)));
				else resolve();
			},
			(event: any) => {
				if (event.stream) report(event.stream.trim());
				else if (event.error) report(`ERROR: ${event.error}`);
				else if (event.status) report(event.status);
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
```

f) 修改 `_doInit`，移除 `ensureImage` 调用，只保留 `startContainer`：

```typescript
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
```

- [ ] **Step 5: 验证测试通过**

```bash
npx vitest run tests/runtime.test.ts
```
Expected: 全部 PASS（`imageExists` 测试在 Docker 可用时通过，`buildImage`/`getImage` 方法检查通过）

- [ ] **Step 6: Commit**

```bash
git add src/runtime.ts tests/runtime.test.ts tests/_helpers.ts
git commit -m "feat: add imageExists/buildImage/getImage, remove forceBuild/ensureImage"
```

---

### Task 3: `tests/commands.test.ts` — 更新 build handler 测试

**Files:**
- Test: `tests/commands.test.ts`

- [ ] **Step 1: 更新 build 测试（先写测试，反映新的行为）**

编辑 `tests/commands.test.ts`。

a) 在 `notifyCtx` 函数后添加 `buildCtx` helper（带 `select` 方法）：

```typescript
function buildCtx(selectResult?: string) {
	const notifications: { msg: string; level: string }[] = [];
	return {
		notifications,
		ui: {
			notify: (msg: string, level?: string) => notifications.push({ msg, level: level ?? "info" }),
			setStatus: (_key: string, _msg: string) => {},
			select: async (_title: string, _options: string[]) => selectResult ?? "cn",
		},
	};
}
```

b) 替换 "/sandbox build" describe 块：

```typescript
describe("/sandbox build", () => {
	it("shows selection and builds with selected dockerfile", async () => {
		const ctx = buildCtx("cn");
		const handlers = createSandboxCommandHandlers("/tmp", mockPathApprovals());

		let buildDockerfile = "";
		const rt = mockRuntime({
			buildImage: async (opts) => {
				buildDockerfile = opts.dockerfile;
			},
		});
		mockSbx({ runtime: rt });

		await handlers.build("", ctx);
		expect(buildDockerfile).toBe("cn.Dockerfile");
	});

	it("shows message when user skips build", async () => {
		const ctx = buildCtx("跳过");
		const handlers = createSandboxCommandHandlers("/tmp", mockPathApprovals());
		mockSbx();

		await handlers.build("", ctx);
		expect(ctx.notifications.some((n) => n.msg.includes("跳过"))).toBe(true);
	});

	it("shows error on build failure", async () => {
		const ctx = buildCtx("cn");
		const handlers = createSandboxCommandHandlers("/tmp", mockPathApprovals());

		const rt = mockRuntime({
			buildImage: async () => {
				throw new Error("build error");
			},
		});
		mockSbx({ runtime: rt });

		await handlers.build("", ctx);
		expect(ctx.notifications.some((n) => n.msg.includes("失败"))).toBe(true);
	});
});
```

c) 在 import 中添加 `discoverDockerfiles` / `DOCKERFILE_SKIP`（供后续 Task 5 使用——测试在 handler 调用 `discoverDockerfiles` 前会先编译失败）：

```typescript
import { discoverDockerfiles, DOCKERFILE_SKIP } from "../config";
```

- [ ] **Step 2: 验证测试失败**

```bash
npx vitest run tests/commands.test.ts -t "sandbox build"
```
Expected: FAIL — `select` 不是 `ctx.ui` 的有效属性，或 `buildImage` 尚不存在于 `Runtime` 类型

（注意：Task 2 已完成 `Runtime` 接口改动，s 所以此步应该编译通过但 handler 签名不匹配导致失败）

- [ ] **Step 3: 提交待测代码（让 Task 5 的实现去满足）**

```bash
git add tests/commands.test.ts
git commit -m "test: update /sandbox build tests for selection flow"
```

---

### Task 4: `index.ts` — session_start 选择流程

**Files:**
- Modify: `index.ts`

- [ ] **Step 1: 移除 --build-image flag**

删除 `index.ts:72-76`：
```typescript
pi.registerFlag("build-image", {...});
```

- [ ] **Step 2: 移除 session_start 中 buildImageFlag 变量**

删除 `const buildImageFlag = ...` 行（:278）。

- [ ] **Step 3: 从 DockerRuntime 构造中移除 forceBuild**

删除传给 `new DockerRuntime(...)` 的 `forceBuild: buildImageFlag || false,` 行。

- [ ] **Step 4: 添加 import**

在 `index.ts` 顶部 import 中添加：
```typescript
import { discoverDockerfiles, DOCKERFILE_SKIP, imageRefForTag, loadSbxConfig, PACKAGE_DOCKER_DIR } from "./src/config";
```

- [ ] **Step 5: 替换 init/withReady 为选择+构建流程**

将：
```typescript
await runtime.init();
if (!runtime.isReady()) {
	await runtime.withReady();
}
```

替换为：

```typescript
await runtime.init();

const imageExists = await runtime.imageExists();
if (!imageExists) {
	if (!ctx.hasUI) {
		ctx.ui.notify(
			`镜像 ${image} 不存在。请运行 docker build 手动构建，或使用 /sandbox build 命令。`,
			"error",
		);
		return;
	}

	const dockerfiles = discoverDockerfiles();
	if (dockerfiles.length === 0) {
		ctx.ui.notify("没有找到内置 Dockerfile（docker/ 目录为空）。请自行构建镜像。", "warning");
		return;
	}

	const options = [...dockerfiles.map((f) => `${f} (内置)`), "跳过 - 我自己构建"];
	const selected = await ctx.ui.select("Docker 镜像不存在，选择 Dockerfile 构建", options);
	if (!selected || selected.startsWith("跳过")) {
		ctx.ui.notify(
			`镜像 ${image} 不存在。请手动构建，例如：\n  docker build -t ${image} -f docker/cn.Dockerfile docker`,
			"warning",
		);
		return;
	}

	const dockerfile = selected.split(" ")[0] + ".Dockerfile";
	const buildContext = dockerfileFlag ? (dockerfileContextFlag ?? localCwd) : PACKAGE_DOCKER_DIR;

	try {
		await runtime.buildImage({
			dockerfile,
			buildContext,
			buildArgs: cfg.buildArgs,
			onProgress: (msg: string) => ctx.ui.setStatus("sandbox", `[build] ${msg}`),
		});
	} catch (e) {
		ctx.ui.notify(`镜像构建失败: ${e instanceof Error ? e.message : String(e)}`, "error");
		return;
	}
}

if (!runtime.isReady()) {
	await runtime.withReady();
}
```

- [ ] **Step 6: typecheck**

```bash
npx tsc --noEmit
```
Expected: 无类型错误

- [ ] **Step 7: Commit**

```bash
git add index.ts
git commit -m "feat: add dockerfile selection in session_start"
```

---

### Task 5: `src/commands/sandbox.ts` — build handler 支持选择

**Files:**
- Modify: `src/commands/sandbox.ts`

- [ ] **Step 1: 添加 import**

在文件顶部添加：
```typescript
import { discoverDockerfiles, DOCKERFILE_SKIP, PACKAGE_DOCKER_DIR } from "../config";
import { DockerRuntime } from "../runtime";
```

- [ ] **Step 2: 重写 build handler（Task 3 的测试已准备好）**

替换 `build` handler（:64-85）：

```typescript
build: async (
	_args: string,
	ctx: {
		ui: {
			setStatus: (key: string, msg: string) => void;
			notify: (msg: string, level?: "info" | "warning" | "error") => void;
			select: (title: string, options: string[], opts?: any) => Promise<string | undefined>;
		};
	},
) => {
	const sbx = getSbx();

	const dockerfiles = discoverDockerfiles();
	if (dockerfiles.length === 0) {
		ctx.ui.notify("docker/ 目录中未找到 .Dockerfile 文件。", "warning");
		return;
	}

	const options = [...dockerfiles.map((f) => `${f} (内置)`), "跳过 - 我自己构建"];
	const selected = await ctx.ui.select("选择 Dockerfile 构建镜像", options);
	if (!selected || selected.startsWith("跳过")) {
		ctx.ui.notify("构建已跳过。请手动执行 docker build 构建镜像。", "info");
		return;
	}

	const dockerfile = selected.split(" ")[0] + ".Dockerfile";
	const image = sbx?.imageRef ?? "pi-container-sandbox:latest";

	try {
		if (sbx) {
			await sbx.runtime.buildImage({
				dockerfile,
				buildContext: PACKAGE_DOCKER_DIR,
				onProgress: (msg: string) => ctx.ui.setStatus("sandbox", `[build] ${msg}`),
			});
		} else {
			const runtime = new DockerRuntime({
				image,
				hostCwd: localCwd,
				name: "pi-sbx-build",
				allowNetwork: true,
				resources: { memory: "4g", cpus: "2" },
				onProgress: (msg: string) => ctx.ui.setStatus("sandbox", `[build] ${msg}`),
			});
			await runtime.init();
			await runtime.buildImage({
				dockerfile,
				buildContext: PACKAGE_DOCKER_DIR,
			});
		}
		ctx.ui.notify(`镜像 ${image} 构建成功。`, "info");
	} catch (e) {
		ctx.ui.notify(`构建失败: ${e instanceof Error ? e.message : String(e)}`, "error");
	}
},
```

- [ ] **Step 3: 运行 commands 测试**

```bash
npx vitest run tests/commands.test.ts -t "sandbox build"
```
Expected: 3 tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/commands/sandbox.ts
git commit -m "feat: rewrite /sandbox build with dockerfile selection"
```

---

### Task 6: `package.json` + `scripts/build-image.ts`

**Files:**
- Modify: `package.json`
- Create: `scripts/build-image.ts`

- [ ] **Step 1: 创建 `scripts/build-image.ts`**

```typescript
import { createInterface } from "node:readline";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, extname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dockerDir = resolvePath(__dirname, "..", "docker");
const image = "pi-container-sandbox:latest";

function discoverDockerfiles(): string[] {
	if (!existsSync(dockerDir)) return [];
	return readdirSync(dockerDir)
		.filter((f) => f.endsWith(".Dockerfile"))
		.map((f) => basename(f, extname(f)));
}

function build(name: string) {
	const dockerfilePath = `${name}.Dockerfile`;
	const cmd = `docker build -t ${image} -f "${resolvePath(dockerDir, dockerfilePath)}" "${dockerDir}"`;
	console.log(cmd);
	execSync(cmd, { stdio: "inherit" });
	console.log(`Image ${image} built successfully.`);
}

async function main() {
	const arg = process.argv[2];
	if (arg) {
		const dockerfilePath = resolvePath(dockerDir, `${arg}.Dockerfile`);
		if (!existsSync(dockerfilePath)) {
			console.error(`Dockerfile not found: ${arg}.Dockerfile`);
			process.exit(1);
		}
		build(arg);
		return;
	}

	const dockerfiles = discoverDockerfiles();
	if (dockerfiles.length === 0) {
		console.error("No .Dockerfile files found in docker/ directory.");
		process.exit(1);
	}

	const options = [...dockerfiles, "跳过"];
	console.log("Select a Dockerfile:");
	options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt}`));

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const answer = await new Promise<string>((resolve) => {
		rl.question(`Enter number (1-${options.length}): `, (a) => {
			rl.close();
			resolve(a.trim());
		});
	});

	const idx = parseInt(answer, 10) - 1;
	if (isNaN(idx) || idx < 0 || idx >= options.length) {
		console.error("Invalid selection.");
		process.exit(1);
	}

	if (options[idx] === "跳过") {
		console.log("Skipped. Build the image manually.");
		return;
	}

	build(options[idx]);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
```

- [ ] **Step 2: 更新 package.json build-image 脚本**

```json
"build-image": "node --experimental-strip-types scripts/build-image.ts"
```

- [ ] **Step 3: 验证脚本语法**

```bash
npx tsc --noEmit scripts/build-image.ts
```
Expected: 无语法错误（如果 TS 检查了 scripts 目录）；或直接运行：
```bash
node --experimental-strip-types --check scripts/build-image.ts
```

- [ ] **Step 4: Commit**

```bash
git add package.json scripts/build-image.ts
git commit -m "feat: add interactive build-image script"
```

---

### Task 7: 最终验证

- [ ] **Step 1: 运行全部测试**

```bash
npx vitest run
```
Expected: 全部测试 PASS（不含 Docker 测试 skip）

- [ ] **Step 2: typecheck + lint**

```bash
npx tsc --noEmit && npx biome lint .
```
Expected: 零错误
