# sandbox.json v2 配置重构 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `sandbox.json` 从扁平结构重构为四分组嵌套结构（image/runtime/build/host），新增 6 个配置项，CLI flags 精简为 3 个。

**Architecture:** 重写 `src/config.ts` 的类型定义和加载逻辑（按分组浅合并）。`index.ts` 删除 18 个 flag 注册，`session_start` 全部从 `cfg` 分组读取。内部 `DockerRuntime` 不变——在 `session_start` 中做一次 cfg → SandboxOptions 转换。所有测试和命令适配新字段路径。

**Tech Stack:** TypeScript, Vitest, Node.js fs

## Global Constraints

- 不兼容旧版扁平 `sandbox.json`，硬切换
- `mountSkills` 始终为 `true`，不暴露为配置项
- `DockerRuntime` 和 `SandboxOptions` 内部接口不变
- `--container` / `--no-container` / `--noc` 是仅存的 CLI flags

---

### Task 1: 重写 config.ts 类型和加载逻辑

**Files:**
- Modify: `pi-container-sandbox/src/config.ts`

**Interfaces:**
- Produces: `SbxConfig`（新嵌套接口）、`ImageConfig`、`RuntimeConfig`、`BuildConfig`、`HostConfig`、`DEFAULT_SBX_CONFIG`（新默认值）、`loadSbxConfig`（按分组浅合并）
- Consumes: `SizeTier` from `./tiers`（不变）

- [ ] **Step 1: 重写 config.ts**

完整替换 `src/config.ts` 为：

```typescript
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SizeTier } from "./tiers";

export interface ImageConfig {
	name: string;
	tag: string;
}

export interface RuntimeConfig {
	name: string | null;
	tier: SizeTier;
	network: boolean;
	persist: boolean;
	memory: string | null;
	cpus: string | null;
	swap: string | null;
	pidsLimit: number | null;
	cache: string | null;
	mounts: string[];
}

export interface BuildConfig {
	dockerfile: string | null;
	context: string | null;
	args: Record<string, string>;
}

export interface HostConfig {
	commands: string[];
}

export interface SbxConfig {
	image: ImageConfig;
	runtime: RuntimeConfig;
	build: BuildConfig;
	host: HostConfig;
}

export const DEFAULT_SBX_CONFIG: SbxConfig = {
	image: { name: "pi-container-sandbox", tag: "latest" },
	runtime: {
		name: null,
		tier: "medium",
		network: true,
		persist: false,
		memory: null,
		cpus: null,
		swap: null,
		pidsLimit: null,
		cache: null,
		mounts: [],
	},
	build: { dockerfile: null, context: null, args: {} },
	host: { commands: [] },
};

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_DOCKER_DIR = resolvePath(__dirname, "..", "docker");

function readJsonFile(path: string): Record<string, unknown> | null {
	try {
		const raw = readFileSync(path, "utf-8");
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/** 按分组浅合并两个配置对象。b 中的 null 和空值会覆盖 a。 */
function mergeGroup<G extends Record<string, unknown>>(a: G, b: Partial<G>): G {
	const result = { ...a };
	for (const key of Object.keys(b) as (keyof G)[]) {
		if (b[key] !== undefined) {
			result[key] = b[key] as G[keyof G];
		}
	}
	return result;
}

function extractGroup(raw: Record<string, unknown>, group: string): Record<string, unknown> {
	const g = raw[group];
	return (g && typeof g === "object" && !Array.isArray(g) ? g : {}) as Record<string, unknown>;
}

export function loadSbxConfig(hostCwd: string): SbxConfig {
	const agentDir = getAgentDir();
	const globalRaw = readJsonFile(resolvePath(agentDir, "sandbox.json")) || {};
	const projectRaw = readJsonFile(getSbxConfigPath(hostCwd)) || {};

	return {
		image: mergeGroup(
			mergeGroup(DEFAULT_SBX_CONFIG.image, extractGroup(globalRaw, "image") as Partial<ImageConfig>),
			extractGroup(projectRaw, "image") as Partial<ImageConfig>,
		),
		runtime: mergeGroup(
			mergeGroup(DEFAULT_SBX_CONFIG.runtime, extractGroup(globalRaw, "runtime") as Partial<RuntimeConfig>),
			extractGroup(projectRaw, "runtime") as Partial<RuntimeConfig>,
		),
		build: mergeGroup(
			mergeGroup(DEFAULT_SBX_CONFIG.build, extractGroup(globalRaw, "build") as Partial<BuildConfig>),
			extractGroup(projectRaw, "build") as Partial<BuildConfig>,
		),
		host: mergeGroup(
			mergeGroup(DEFAULT_SBX_CONFIG.host, extractGroup(globalRaw, "host") as Partial<HostConfig>),
			extractGroup(projectRaw, "host") as Partial<HostConfig>,
		),
	};
}

export function getSbxConfigPath(hostCwd: string): string {
	return resolvePath(hostCwd, CONFIG_DIR_NAME, "sandbox.json");
}

export function saveSbxConfig(hostCwd: string, config: SbxConfig): void {
	const configPath = getSbxConfigPath(hostCwd);
	const dir = resolvePath(configPath, "..");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const tmpPath = `${configPath}.tmp`;
	writeFileSync(tmpPath, JSON.stringify(config, null, 2));
	renameSync(tmpPath, configPath);
}

export function imageRef(im: ImageConfig): string {
	return `${im.name}:${im.tag}`;
}

export function discoverDockerfiles(): string[] {
	if (!existsSync(PACKAGE_DOCKER_DIR)) return [];
	return readdirSync(PACKAGE_DOCKER_DIR)
		.filter((f) => f.endsWith(".Dockerfile"))
		.map((f) => basename(f, extname(f)));
}
```

- [ ] **Step 2: 运行 TypeScript 检查确认编译通过**

```bash
cd pi-container-sandbox && uv run npx tsc --noEmit
```

预期：仅 `config.ts` 相关的类型错误（其余引用旧接口的文件会报错，后续 Task 修复）。

- [ ] **Step 3: 提交**

```bash
git add pi-container-sandbox/src/config.ts
git commit -m "feat: rewrite SbxConfig as grouped structure (image/runtime/build/host)"
```

---

### Task 2: 更新 _helpers.ts 和所有测试文件类型引用

**Files:**
- Modify: `pi-container-sandbox/tests/_helpers.ts`
- Modify: `pi-container-sandbox/tests/session.test.ts`
- Modify: `pi-container-sandbox/tests/commands.test.ts`（仅类型适配）

**Interfaces:**
- Consumes: `SbxConfig` new interface from Task 1
- Produces: Updated mocks compatible with new types

- [ ] **Step 1: 更新 tests/_helpers.ts 中的 DEFAULT_CONFIG**

将 `DEFAULT_CONFIG` 替换为新的分组结构：

```typescript
import type { SbxConfig } from "../src/config";
import type { ExecOpts, ExecResult, Runtime } from "../src/runtime";
import { type SbxSession, setSbx } from "../src/session";

const DEFAULT_CONFIG: SbxConfig = {
	image: { name: "pi-sandbox", tag: "latest" },
	runtime: {
		name: null, tier: "medium", network: true, persist: false,
		memory: null, cpus: null, swap: null, pidsLimit: null,
		cache: null, mounts: [],
	},
	build: { dockerfile: null, context: null, args: {} },
	host: { commands: [] },
};

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

export function createTestSession(overrides?: Partial<SbxSession>): SbxSession {
	return {
		runtime: mockRuntime(),
		name: "test-box",
		hostCwd: "/tmp",
		keep: false,
		mounts: [],
		allowedExternalPrefixes: [],
		imageRef: "img:latest",
		config: { ...DEFAULT_CONFIG, ...overrides?.config },
		isReusable: false,
		isReattached: false,
		...overrides,
	};
}

export function mockSbx(overrides?: Partial<SbxSession>): SbxSession {
	const session = createTestSession(overrides);
	setSbx(session);
	return session;
}
```

- [ ] **Step 2: 更新 tests/session.test.ts 中的 mockSession.config**

将 `config` 字段改为新分组结构：

```typescript
import { beforeEach, describe, expect, it } from "vitest";
import { clearSbx, getSbx, type SbxSession, setSbx } from "../src/session";

const mockSession: SbxSession = {
	runtime: { exec: async () => ({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }) } as any,
	name: "test-container",
	hostCwd: "/tmp/test",
	keep: false,
	mounts: [],
	allowedExternalPrefixes: [],
	imageRef: "pi-sandbox:latest",
	config: {
		image: { name: "pi-sandbox", tag: "latest" },
		runtime: {
			name: null, tier: "medium", network: true, persist: false,
			memory: null, cpus: null, swap: null, pidsLimit: null,
			cache: null, mounts: [],
		},
		build: { dockerfile: null, context: null, args: {} },
		host: { commands: [] },
	},
	isReusable: false,
	isReattached: false,
};

beforeEach(() => {
	clearSbx();
});

describe("session state", () => {
	it("starts with null session", () => {
		expect(getSbx()).toBeNull();
	});
	it("set and get round-trip", () => {
		setSbx(mockSession);
		expect(getSbx()).toBe(mockSession);
	});
	it("clear resets to null", () => {
		setSbx(mockSession);
		clearSbx();
		expect(getSbx()).toBeNull();
	});
});
```

- [ ] **Step 3: 运行测试验证类型正确**

```bash
cd pi-container-sandbox && npx vitest run tests/session.test.ts
```

预期：PASS

- [ ] **Step 4: 提交**

```bash
git add pi-container-sandbox/tests/_helpers.ts pi-container-sandbox/tests/session.test.ts
git commit -m "test: adapt mock helpers and session test to new SbxConfig types"
```

---

### Task 3: 重写 config.test.ts

**Files:**
- Modify: `pi-container-sandbox/tests/config.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_SBX_CONFIG`, `getSbxConfigPath`, `imageRef`, `loadSbxConfig`, `saveSbxConfig`, `discoverDockerfiles` from Task 1
- Tests: grouped config loading, per-group merge, save round-trip, corrupt JSON fallback

- [ ] **Step 1: 重写 config.test.ts**

```typescript
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => "/home/user/.test-cfg/agent",
	CONFIG_DIR_NAME: ".test-cfg",
}));

import { DEFAULT_SBX_CONFIG, getSbxConfigPath, imageRef, loadSbxConfig, saveSbxConfig } from "../src/config";

const TEST_CONFIG_DIR = ".test-cfg";

const testDir = resolvePath(tmpdir(), `pi-sandbox-test-${Date.now()}`);

beforeEach(() => {
	if (existsSync(testDir)) rmSync(testDir, { recursive: true });
	mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
	if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("getSbxConfigPath", () => {
	it("returns path under CONFIG_DIR_NAME/sandbox.json", () => {
		const path = getSbxConfigPath(testDir);
		expect(path).toBe(resolvePath(testDir, TEST_CONFIG_DIR, "sandbox.json"));
	});
});

describe("imageRef", () => {
	it("combines image name and tag", () => {
		expect(imageRef({ name: "pi-sandbox", tag: "latest" })).toBe("pi-sandbox:latest");
		expect(imageRef({ name: "org/pi-sandbox", tag: "v1.0" })).toBe("org/pi-sandbox:v1.0");
	});
});

describe("loadSbxConfig", () => {
	it("returns defaults when no config file exists", () => {
		const cfg = loadSbxConfig(testDir);
		expect(cfg).toEqual(DEFAULT_SBX_CONFIG);
	});

	it("loads values from project config with per-group merge", () => {
		const configDir = resolvePath(testDir, TEST_CONFIG_DIR);
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			resolvePath(configDir, "sandbox.json"),
			JSON.stringify({
				image: { name: "my-img", tag: "v2" },
				runtime: { tier: "large", network: false },
				host: { commands: ["git"] },
			}),
		);

		const cfg = loadSbxConfig(testDir);
		expect(cfg.image.name).toBe("my-img");
		expect(cfg.image.tag).toBe("v2");
		expect(cfg.runtime.tier).toBe("large");
		expect(cfg.runtime.network).toBe(false);
		expect(cfg.runtime.name).toBe(DEFAULT_SBX_CONFIG.runtime.name);
		expect(cfg.runtime.persist).toBe(DEFAULT_SBX_CONFIG.runtime.persist);
		expect(cfg.host.commands).toEqual(["git"]);
	});

	it("falls back to defaults on corrupt JSON", () => {
		const configDir = resolvePath(testDir, TEST_CONFIG_DIR);
		mkdirSync(configDir, { recursive: true });
		writeFileSync(resolvePath(configDir, "sandbox.json"), "not json {{{");

		const cfg = loadSbxConfig(testDir);
		expect(cfg).toEqual(DEFAULT_SBX_CONFIG);
	});

	it("partial group overrides do not reset other group fields", () => {
		const configDir = resolvePath(testDir, TEST_CONFIG_DIR);
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			resolvePath(configDir, "sandbox.json"),
			JSON.stringify({
				runtime: { tier: "small" },
			}),
		);

		const cfg = loadSbxConfig(testDir);
		expect(cfg.runtime.tier).toBe("small");
		expect(cfg.runtime.network).toBe(DEFAULT_SBX_CONFIG.runtime.network);
		expect(cfg.runtime.persist).toBe(DEFAULT_SBX_CONFIG.runtime.persist);
		expect(cfg.image).toEqual(DEFAULT_SBX_CONFIG.image);
	});
});

describe("saveSbxConfig", () => {
	it("writes config to disk", () => {
		const cfg: typeof DEFAULT_SBX_CONFIG = {
			...DEFAULT_SBX_CONFIG,
			image: { name: "x", tag: "y" },
			runtime: { ...DEFAULT_SBX_CONFIG.runtime, name: "z", tier: "small", persist: true, cache: "v" },
		};
		saveSbxConfig(testDir, cfg);
		const loaded = loadSbxConfig(testDir);
		expect(loaded.image).toEqual({ name: "x", tag: "y" });
		expect(loaded.runtime.name).toBe("z");
		expect(loaded.runtime.tier).toBe("small");
		expect(loaded.runtime.persist).toBe(true);
		expect(loaded.runtime.cache).toBe("v");
	});

	it("round-trips: save then load returns same values", () => {
		const input: typeof DEFAULT_SBX_CONFIG = {
			...DEFAULT_SBX_CONFIG,
			runtime: { ...DEFAULT_SBX_CONFIG.runtime, tier: "large", name: "my-container" },
		};
		saveSbxConfig(testDir, input);
		const output = loadSbxConfig(testDir);
		expect(output).toEqual(input);
	});
});

describe("loadSbxConfig new runtime fields", () => {
	it("parses memory, cpus, swap, pidsLimit from runtime group", () => {
		const configDir = resolvePath(testDir, TEST_CONFIG_DIR);
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			resolvePath(configDir, "sandbox.json"),
			JSON.stringify({
				runtime: {
					memory: "8g",
					cpus: "4",
					swap: "0",
					pidsLimit: 1024,
					mounts: ["/extra/tools"],
				},
			}),
		);

		const cfg = loadSbxConfig(testDir);
		expect(cfg.runtime.memory).toBe("8g");
		expect(cfg.runtime.cpus).toBe("4");
		expect(cfg.runtime.swap).toBe("0");
		expect(cfg.runtime.pidsLimit).toBe(1024);
		expect(cfg.runtime.mounts).toEqual(["/extra/tools"]);
	});

	it("new fields default to null/empty when not configured", () => {
		const cfg = loadSbxConfig(testDir);
		expect(cfg.runtime.memory).toBeNull();
		expect(cfg.runtime.cpus).toBeNull();
		expect(cfg.runtime.swap).toBeNull();
		expect(cfg.runtime.pidsLimit).toBeNull();
		expect(cfg.runtime.mounts).toEqual([]);
	});
});

describe("loadSbxConfig build group", () => {
	it("parses dockerfile, context, args from build group", () => {
		const configDir = resolvePath(testDir, TEST_CONFIG_DIR);
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			resolvePath(configDir, "sandbox.json"),
			JSON.stringify({
				build: {
					dockerfile: "./Dockerfile.custom",
					context: ".",
					args: { FOO: "bar", BAZ: "1" },
				},
			}),
		);

		const cfg = loadSbxConfig(testDir);
		expect(cfg.build.dockerfile).toBe("./Dockerfile.custom");
		expect(cfg.build.context).toBe(".");
		expect(cfg.build.args).toEqual({ FOO: "bar", BAZ: "1" });
	});

	it("build group defaults to null/empty when not configured", () => {
		const cfg = loadSbxConfig(testDir);
		expect(cfg.build.dockerfile).toBeNull();
		expect(cfg.build.context).toBeNull();
		expect(cfg.build.args).toEqual({});
	});
});

describe("loadSbxConfig host group", () => {
	it("parses commands from host group", () => {
		const configDir = resolvePath(testDir, TEST_CONFIG_DIR);
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			resolvePath(configDir, "sandbox.json"),
			JSON.stringify({
				host: { commands: ["git", "docker", "npm"] },
			}),
		);

		const cfg = loadSbxConfig(testDir);
		expect(cfg.host.commands).toEqual(["git", "docker", "npm"]);
	});

	it("host commands default to empty array", () => {
		const cfg = loadSbxConfig(testDir);
		expect(cfg.host.commands).toEqual([]);
	});
});

import { discoverDockerfiles } from "../src/config";

describe("discoverDockerfiles", () => {
	it("discovers Dockerfile names from docker/ directory", () => {
		const files = discoverDockerfiles();
		expect(files).toContain("cn");
		expect(files).toContain("gh");
	});
});
```

- [ ] **Step 2: 运行测试**

```bash
cd pi-container-sandbox && npx vitest run tests/config.test.ts
```

预期：全部 PASS（~14 tests）

- [ ] **Step 3: 提交**

```bash
git add pi-container-sandbox/tests/config.test.ts
git commit -m "test: rewrite config tests for grouped SbxConfig structure"
```

---

### Task 4: 适配 commands/sandbox.ts 字段引用

**Files:**
- Modify: `pi-container-sandbox/src/commands/sandbox.ts`

**Interfaces:**
- Consumes: `imageRef` (renamed from `imageRefForTag`) from Task 1, `SbxConfig` new structure
- Changes: `cfg.image` → `cfg.image.name`, `cfg.tag` → `cfg.image.tag`, `cfg.tier` → `cfg.runtime.tier`, `cfg.containerName` → `cfg.runtime.name`, `cfg.persist` → `cfg.runtime.persist`, `cfg.cacheVolume` → `cfg.runtime.cache`

- [ ] **Step 1: 更新 import 和字段引用**

修改 `src/commands/sandbox.ts`：

1. `import` 中将 `imageRefForTag` 改为 `imageRef`
2. `status` handler 中：`imageRefForTag(cfg.image, cfg.tag)` → `imageRef(cfg.image)`
3. `keep` handler 中：`cfg.containerName = name` → `cfg.runtime.name = name`
4. `config` handler 中：
   - `imageRefForTag(cfg.image, cfg.tag)` → `imageRef(cfg.image)`
   - `cfg.tier` → `cfg.runtime.tier`
   - `cfg.containerName` → `cfg.runtime.name`
   - `cfg.persist` → `cfg.runtime.persist`
   - `cfg.cacheVolume` → `cfg.runtime.cache`
5. `tiers` handler 中：`cfg.tier = tier` → `cfg.runtime.tier = tier`

- [ ] **Step 2: 运行 TypeScript 检查**

```bash
cd pi-container-sandbox && uv run npx tsc --noEmit
```

预期：仅 `index.ts` 报错（还未适配），`commands/sandbox.ts` 无错误。

- [ ] **Step 3: 提交**

```bash
git add pi-container-sandbox/src/commands/sandbox.ts
git commit -m "refactor: adapt sandbox commands to new grouped SbxConfig fields"
```

---

### Task 5: 适配 commands.test.ts

**Files:**
- Modify: `pi-container-sandbox/tests/commands.test.ts`

**Interfaces:**
- Consumes: `imageRef` from Task 1, new field paths
- Changes: tests that assert against old field names

- [ ] **Step 1: 更新 commands.test.ts 中引用旧字段的断言**

commands.test.ts 的测试都是通过 mockSbx() + notifyCtx() 验证通知内容，不需要改 mock 本身（_helpers.ts 已在 Task 2 更新）。仅需确认无编译错误。若 `imageRef` 重命名有影响，更新 `config` handler 测试中对 `imageRef` 的调用。

- [ ] **Step 2: 运行命令相关测试**

```bash
cd pi-container-sandbox && npx vitest run tests/commands.test.ts
```

预期：全部 PASS

- [ ] **Step 3: 提交**

```bash
git add pi-container-sandbox/tests/commands.test.ts
git commit -m "test: adapt commands test to new SbxConfig fields"
```

---

### Task 6: 重写 index.ts —— 删除 flags、session_start 改用 cfg 分组

**Files:**
- Modify: `pi-container-sandbox/index.ts`

**Interfaces:**
- Consumes: `SbxConfig` new structure from Task 1, `imageRef` from Task 1
- Produces: `session_start` handler reads from cfg groups instead of flags

- [ ] **Step 1: 删除所有 flag 注册，只保留 3 个**

移除 `index.ts` 中 `registerFlag` 调用的以下行（保留前 11 行即 `container`/`no-container`/`noc`）：

保留：
```typescript
pi.registerFlag("container", {
	description: "Sandbox all bash/read/write/edit ops inside a Linux container (default: on)",
	type: "boolean",
	default: true,
});
pi.registerFlag("no-container", {
	description: "Force-disable container sandboxing",
	type: "boolean",
	default: false,
});
pi.registerFlag("noc", {
	description: "Alias for --no-container",
	type: "boolean",
	default: false,
});
```

删除所有其他 `pi.registerFlag(...)` 调用（`container-size` 到 `container-pids-limit`）。

- [ ] **Step 2: 更新 import 和重写 session_start 配置读取**

1. Import 中将 `imageRefForTag` 改为 `imageRef`
2. 重写 `session_start` handler 中从 flags 读取配置的部分。

完整重写 `session_start` 的事件处理函数（从 `pi.on("session_start", ...)` 开始），用以下逻辑替换：

```typescript
pi.on("session_start", async (_event, ctx) => {
	if ((pi.getFlag("no-container") as boolean) || (pi.getFlag("noc") as boolean)) return;
	if (!(pi.getFlag("container") as boolean)) return;

	try {
		const cfg = loadSbxConfig(localCwd);
		const rt = cfg.runtime;

		const sizeTier = rt.tier;
		const tierSpec = TIER_SPECS[sizeTier];

		const image = imageRef(cfg.image);

		const allowNetwork = rt.network;
		const keep = rt.persist;
		const persist = rt.persist;

		// mountSkills always true
		const mountSkills = true;

		const extraPaths = rt.mounts.length ? rt.mounts : undefined;

		const sandboxName = rt.name ?? deriveContainerName(localCwd);
		const isReusable = !!(rt.name);

		const cacheVolume = rt.cache ?? undefined;

		const skillMounts = mountSkills ? discoverSkillMounts(extraPaths) : [];

		const allowedExternalPrefixes: string[] = [];

		const resources: { memory: string; cpus: string; swap: string; pidsLimit?: number } = {
			memory: tierSpec.memory,
			cpus: tierSpec.cpus,
			swap: tierSpec.swap,
		};

		if (rt.memory) resources.memory = rt.memory;
		if (rt.cpus) resources.cpus = rt.cpus;
		if (rt.pidsLimit !== null) resources.pidsLimit = rt.pidsLimit;
		if (rt.swap !== null) resources.swap = rt.swap;

		const runtime = new DockerRuntime({
			image,
			hostCwd: localCwd,
			name: sandboxName,
			allowNetwork,
			resources,
			extraMounts: skillMounts.length ? skillMounts : undefined,
			cacheVolume,
			dockerfile: cfg.build.dockerfile ?? undefined,
			buildContext: cfg.build.context ?? undefined,
			buildArgs: Object.keys(cfg.build.args).length ? cfg.build.args : undefined,
			onProgress: (msg: string) => {
				ctx.ui.setStatus("sandbox", `[build] ${msg}`);
			},
		});

		await runtime.init();

		const hasImage = await runtime.imageExists();
		if (!hasImage) {
			if (!ctx.hasUI) {
				ctx.ui.notify(`镜像 ${image} 不存在。请运行 docker build 手动构建，或使用 /sandbox build 命令。`, "error");
				return;
			}

			const dockerfiles = discoverDockerfiles();
			if (dockerfiles.length === 0) {
				ctx.ui.notify("没有找到内置 Dockerfile（docker/ 目录为空）。请自行构建镜像。", "warning");
				return;
			}

			const skipLabel = "跳过 - 我自己构建";
			const labelMap = new Map<string, string>();
			const options: string[] = [];
			for (const f of dockerfiles) {
				const label = `${f} (内置)`;
				labelMap.set(label, f);
				options.push(label);
			}
			options.push(skipLabel);

			const selected = await ctx.ui.select("Docker 镜像不存在，选择 Dockerfile 构建", options);
			if (!selected || selected === skipLabel) {
				ctx.ui.notify(
					`镜像 ${image} 不存在。请手动构建，例如：\n  docker build -t ${image} -f docker/cn.Dockerfile docker`,
					"warning",
				);
				return;
			}

			const dockerfile = `${labelMap.get(selected!)}.Dockerfile`;
			const buildCtx = PACKAGE_DOCKER_DIR;

			try {
				await runtime.buildImage({
					dockerfile,
					buildContext: buildCtx,
					buildArgs: cfg.build.args,
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

		setSbx({
			runtime,
			name: sandboxName,
			hostCwd: localCwd,
			keep: keep || persist,
			mounts: skillMounts,
			allowedExternalPrefixes,
			resources,
			imageRef: image,
			config: cfg,
			isReusable,
			isReattached: false,
		});

		let cleaned = false;
		const cleanup = async () => {
			if (cleaned) return;
			cleaned = true;
			const s = getSbx();
			if (s && !s.keep) {
				try {
					await s.runtime.shutdown();
				} catch {
					/* ignore */
				}
				clearSbx();
			}
		};
		process.on("beforeExit", async () => {
			await cleanup();
		});
		process.once("SIGINT", async () => {
			await cleanup();
			process.exit(130);
		});
		process.once("SIGTERM", async () => {
			await cleanup();
			process.exit(143);
		});

		const ok = (await execCapture(getSbx()!, "id -un && pwd", 10000)).toString().trim();

		const resParts: string[] = [
			`size=${sizeTier}`,
			`mem=${resources.memory}`,
			`cpu=${resources.cpus}`,
			`swap=${resources.swap}`,
		];
		if (resources.pidsLimit !== undefined) resParts.push(`pids=${resources.pidsLimit}`);
		const resStr = ` (${resParts.join(", ")})`;

		const actualName = runtime.getContainerId()?.slice(0, 12) ?? sandboxName;
		const statusPrefix = "Sandbox up";
		ctx.ui.setStatus(
			"sandbox",
			ctx.ui.theme.fg("accent", `${statusPrefix}: ${actualName} (net=${allowNetwork ? "on" : "off"})${resStr}`),
		);
		ctx.ui.notify(
			[
				`${statusPrefix}: docker ${actualName}${resStr}${isReusable ? " [re-usable]" : ""}`,
				ok,
				skillMounts.length ? `Skills mounted: ${skillMounts.map((m) => m.target).join(", ")}` : "",
				cacheVolume ? `Cache volume: ${cacheVolume} at /cache` : "",
			]
				.filter(Boolean)
				.join("\n"),
			"info",
		);
	} catch (e) {
		clearSbx();
		ctx.ui.notify(`Sandbox init failed: ${e instanceof Error ? e.message : String(e)}`, "error");
	}
});
```

- [ ] **Step 3: 更新 before_agent_start 和 bash tool 中的 hostCommands 引用**

1. `before_agent_start` 中：`sbx.config.hostCommands` → `sbx.config.host.commands`
2. `bash` tool 中：`sbx.config.hostCommands` → `sbx.config.host.commands`

- [ ] **Step 4: 运行 TypeScript 检查**

```bash
cd pi-container-sandbox && uv run npx tsc --noEmit
```

预期：零错误

- [ ] **Step 5: 运行全部测试**

```bash
cd pi-container-sandbox && npx vitest run
```

预期：全部 PASS

- [ ] **Step 6: 提交**

```bash
git add pi-container-sandbox/index.ts
git commit -m "feat: strip CLI flags to 3, read all config from grouped sandbox.json"
```

---

### Task 7: 更新文档

**Files:**
- Modify: `pi-container-sandbox/README.md`
- Modify: `pi-container-sandbox/README.zh.md`

- [ ] **Step 1: 更新 README.zh.md**

1. 删除"CLI 参数"表格
2. 更新"配置"章节中的 `sandbox.json` 示例为四分组格式
3. 在"配置"章节补充新字段说明

更新后的"配置"章节（替换原有内容）：

```markdown
## 配置

配置从两个位置读取，项目配置覆盖全局配置。

### 全局配置

`~/.pi/agent/sandbox.json`：

```json
{
  "runtime": {
    "tier": "medium"
  }
}
```

### 项目配置

`.pi/sandbox.json`（完整示例）：

```json
{
  "image": {
    "name": "pi-container-sandbox",
    "tag": "latest"
  },
  "runtime": {
    "name": null,
    "tier": "medium",
    "network": true,
    "persist": false,
    "memory": null,
    "cpus": null,
    "swap": null,
    "pidsLimit": null,
    "cache": null,
    "mounts": []
  },
  "build": {
    "dockerfile": null,
    "context": null,
    "args": {}
  },
  "host": {
    "commands": []
  }
}
```

#### image 组

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `name` | string | `"pi-container-sandbox"` | 镜像名 |
| `tag` | string | `"latest"` | 镜像标签 |

#### runtime 组

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `name` | string \| null | `null` | 容器复用名 |
| `tier` | `"small"` \| `"medium"` \| `"large"` | `"medium"` | 资源规格 |
| `network` | boolean | `true` | 容器网络 |
| `persist` | boolean | `false` | 退出后保留容器 |
| `memory` | string \| null | `null` | 内存覆盖（如 `"8g"`） |
| `cpus` | string \| null | `null` | CPU 覆盖（如 `"4"`） |
| `swap` | string \| null | `null` | swap 覆盖（`"0"` 禁用） |
| `pidsLimit` | number \| null | `null` | PID 限制 |
| `cache` | string \| null | `null` | 缓存卷名 |
| `mounts` | string[] | `[]` | 额外挂载路径 |

#### build 组

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `dockerfile` | string \| null | `null` | Dockerfile 路径 |
| `context` | string \| null | `null` | 构建上下文目录 |
| `args` | Record<string, string> | `{}` | 构建参数 |

#### host 组

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `commands` | string[] | `[]` | 宿主机直接执行的命令白名单 |
```

删除 CLI 参数表格，替换为：

```markdown
### CLI 参数

| 参数 | 默认值 | 描述 |
|------|--------|------|
| `--container` | `true` | 启用 sandbox |
| `--no-container` / `--noc` | `false` | 禁用 sandbox |

其他所有配置项（镜像、资源、构建、挂载、网络等）均通过 `sandbox.json` 配置。
```

- [ ] **Step 2: 同步更新 README.md（英文版）**

同样删除 CLI flags 表格，更新配置示例和字段说明。

- [ ] **Step 3: 提交**

```bash
git add pi-container-sandbox/README.md pi-container-sandbox/README.zh.md
git commit -m "docs: update README for grouped sandbox.json and stripped CLI flags"
```

---

### Task 8: 最终验证和提交

- [ ] **Step 1: 运行完整类型检查**

```bash
cd pi-container-sandbox && uv run npx tsc --noEmit
```

预期：零错误

- [ ] **Step 2: 运行全部测试**

```bash
cd pi-container-sandbox && npx vitest run
```

预期：全部 PASS

- [ ] **Step 3: 确认未改动的文件无 regressions**

```bash
cd pi-container-sandbox && npx vitest run tests/tiers.test.ts tests/ops.test.ts tests/paths.test.ts tests/runtime.test.ts
```

预期：全部 PASS

- [ ] **Step 4: 提交**

```bash
git commit -m "chore: final verification - all tests pass"
```
