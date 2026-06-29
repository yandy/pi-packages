# sandbox.json v2 配置重构 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `sandbox.json` 从扁平结构重构为四分组嵌套结构（image/runtime/build/host），新增 6 个配置项，CLI flags 精简为 3 个，移除 mountSkills 条件判断简化代码。

**Architecture:** 重写 `src/config.ts` 的类型定义和加载逻辑（按分组浅合并）。`index.ts` 删除 18 个 flag 注册，`session_start` 全部从 `cfg` 分组读取，mountSkills 简化为无条件启用。内部 `DockerRuntime` 不变——在 `session_start` 中做一次 cfg → SandboxOptions 转换。

**Tech Stack:** TypeScript, Vitest, Node.js fs, git worktree

## Global Constraints

- 不兼容旧版扁平 `sandbox.json`，硬切换
- `mountSkills` 始终为 `true`，移除相关条件分支
- `DockerRuntime` 和 `SandboxOptions` 内部接口不变
- `--container` / `--no-container` / `--noc` 是仅存的 CLI flags
- 严格 TDD：每个 Task 先写测试（RED），验证失败，再写实现（GREEN）

---

### Task 1: Git worktree 隔离工作区

- [ ] **Step 1: 检测当前是否已在 worktree 中**

```bash
GIT_DIR=$(cd "$(git rev-parse --git-dir)" 2>/dev/null && pwd -P)
GIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd -P)
echo "GIT_DIR=$GIT_DIR"
echo "GIT_COMMON=$GIT_COMMON"
```

检查是否在 submodule：
```bash
git rev-parse --show-superproject-working-tree 2>/dev/null
```

- [ ] **Step 2: 若不在 worktree 中，创建 worktree**

检查是否存在 `.worktrees/` 或 `worktrees/` 目录：
```bash
ls -d .worktrees 2>/dev/null || ls -d worktrees 2>/dev/null || echo "not found"
```

若不存在，创建 `.worktrees/` 并确保已 gitignore：
```bash
git check-ignore -q .worktrees 2>/dev/null || { echo ".worktrees/" >> .gitignore && git add .gitignore && git commit -m "chore: add .worktrees to gitignore"; }
```

创建 worktree：
```bash
BRANCH="feat/sandbox-config-v2"
git worktree add .worktrees/$BRANCH -b $BRANCH
cd .worktrees/$BRANCH
```

- [ ] **Step 3: 安装依赖并验证基线**

```bash
cd pi-container-sandbox && npm install
npx vitest run
```

预期：全部 PASS（确认基线干净）

- [ ] **Step 4: 提交（worktree 设置）**

```bash
# 在 worktree 中
git add -A
git commit -m "chore: initial worktree setup for sandbox-config-v2"
```

---

### Task 2: config.test.ts 先写测试（RED 阶段）

> **TDD RED**: 先写下所有期望新分组结构的测试，验证它们因旧 config.ts 类型不兼容而编译失败。

**Files:**
- Modify: `pi-container-sandbox/tests/config.test.ts`

- [ ] **Step 1: 重写 config.test.ts，使用新的分组类型**

用完整新测试替换 `tests/config.test.ts`：

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
		writeFileSync(resolvePath(configDir, "sandbox.json"), JSON.stringify({
			image: { name: "my-img", tag: "v2" },
			runtime: { tier: "large", network: false },
			host: { commands: ["git"] },
		}));

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
		writeFileSync(resolvePath(configDir, "sandbox.json"), JSON.stringify({
			runtime: { tier: "small" },
		}));
		const cfg = loadSbxConfig(testDir);
		expect(cfg.runtime.tier).toBe("small");
		expect(cfg.runtime.network).toBe(DEFAULT_SBX_CONFIG.runtime.network);
		expect(cfg.runtime.persist).toBe(DEFAULT_SBX_CONFIG.runtime.persist);
		expect(cfg.image).toEqual(DEFAULT_SBX_CONFIG.image);
	});
});

describe("saveSbxConfig", () => {
	it("writes config to disk", () => {
		const cfg = {
			...DEFAULT_SBX_CONFIG,
			image: { name: "x", tag: "y" },
			runtime: { ...DEFAULT_SBX_CONFIG.runtime, name: "z", tier: "small" as const, persist: true, cache: "v" },
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
		const input = {
			...DEFAULT_SBX_CONFIG,
			runtime: { ...DEFAULT_SBX_CONFIG.runtime, tier: "large" as const, name: "my-container" },
		};
		saveSbxConfig(testDir, input);
		const output = loadSbxConfig(testDir);
		expect(output).toEqual(input);
	});
});

describe("new runtime fields", () => {
	it("parses memory, cpus, swap, pidsLimit, mounts from runtime group", () => {
		const configDir = resolvePath(testDir, TEST_CONFIG_DIR);
		mkdirSync(configDir, { recursive: true });
		writeFileSync(resolvePath(configDir, "sandbox.json"), JSON.stringify({
			runtime: { memory: "8g", cpus: "4", swap: "0", pidsLimit: 1024, mounts: ["/extra/tools"] },
		}));
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

describe("build group", () => {
	it("parses dockerfile, context, args from build group", () => {
		const configDir = resolvePath(testDir, TEST_CONFIG_DIR);
		mkdirSync(configDir, { recursive: true });
		writeFileSync(resolvePath(configDir, "sandbox.json"), JSON.stringify({
			build: { dockerfile: "./Dockerfile.custom", context: ".", args: { FOO: "bar", BAZ: "1" } },
		}));
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

describe("host group", () => {
	it("parses commands from host group", () => {
		const configDir = resolvePath(testDir, TEST_CONFIG_DIR);
		mkdirSync(configDir, { recursive: true });
		writeFileSync(resolvePath(configDir, "sandbox.json"), JSON.stringify({
			host: { commands: ["git", "docker", "npm"] },
		}));
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

- [ ] **Step 2: 验证测试编译失败（RED）**

```bash
cd pi-container-sandbox && npx vitest run tests/config.test.ts 2>&1 | head -20
```

预期：编译错误——`imageRef` 未从 `../src/config` 导出、`DEFAULT_SBX_CONFIG.image` 不存在（旧类型是字符串）、`loadSbxConfig` 返回类型不匹配等。

- [ ] **Step 3: 提交（RED）**

```bash
git add pi-container-sandbox/tests/config.test.ts
git commit -m "test: failing config tests for grouped SbxConfig structure (RED)"
```

---

### Task 3: 实现 config.ts（GREEN 阶段）

> **TDD GREEN**: 实现最小代码让 Task 2 的测试通过。

**Files:**
- Modify: `pi-container-sandbox/src/config.ts`

- [ ] **Step 1: 重写 config.ts**

完整替换 `src/config.ts`：

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
		name: null, tier: "medium", network: true, persist: false,
		memory: null, cpus: null, swap: null, pidsLimit: null,
		cache: null, mounts: [],
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
	} catch { return null; }
}

function mergeGroup<G extends Record<string, unknown>>(a: G, b: Partial<G>): G {
	const result = { ...a };
	for (const key of Object.keys(b) as (keyof G)[]) {
		if (b[key] !== undefined) result[key] = b[key] as G[keyof G];
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
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
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

- [ ] **Step 2: 运行测试验证通过（GREEN）**

```bash
cd pi-container-sandbox && npx vitest run tests/config.test.ts
```

预期：全部 PASS（~16 tests）

- [ ] **Step 3: 提交（GREEN）**

```bash
git add pi-container-sandbox/src/config.ts
git commit -m "feat: rewrite SbxConfig as grouped structure (image/runtime/build/host)"
```

---

### Task 4: 更新 _helpers.ts 和 session.test.ts 适配新类型

> **TDD RED/GREEN**: 类型适配——旧类型已删除，这些文件需更新才能编译。

**Files:**
- Modify: `pi-container-sandbox/tests/_helpers.ts`
- Modify: `pi-container-sandbox/tests/session.test.ts`

- [ ] **Step 1: 更新 tests/_helpers.ts 中的 DEFAULT_CONFIG**

将扁平 `DEFAULT_CONFIG` 替换为分组结构（其余 `mockRuntime`、`createTestSession`、`mockSbx` 函数不变）：

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
// ... 其余不变
```

- [ ] **Step 2: 更新 tests/session.test.ts 中的 mockSession.config**

```typescript
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
```

- [ ] **Step 3: 运行测试验证**

```bash
cd pi-container-sandbox && npx vitest run tests/session.test.ts tests/commands.test.ts
```

预期：session.test.ts PASS；commands.test.ts 可能因 `imageRefForTag` 重命名而报编译错误（Task 5 修复）。

- [ ] **Step 4: 提交**

```bash
git add pi-container-sandbox/tests/_helpers.ts pi-container-sandbox/tests/session.test.ts
git commit -m "test: adapt mocks and session test to new SbxConfig types"
```

---

### Task 5: commands/sandbox.ts —— TDD 适配

> **TDD RED/GREEN**: 先确保测试引用新结构，再适配实现。

**Files:**
- Modify: `pi-container-sandbox/src/commands/sandbox.ts`

- [ ] **Step 1: 运行 commands 测试确认编译失败（RED）**

```bash
cd pi-container-sandbox && npx vitest run tests/commands.test.ts 2>&1 | head -20
```

预期：编译错误——`imageRefForTag` 不存在、`cfg.image` 是 `ImageConfig` 不是 `string`、`cfg.containerName` 不存在等。

- [ ] **Step 2: 适配 commands/sandbox.ts（GREEN）**

修改 `src/commands/sandbox.ts`：

1. `import`：`imageRefForTag` → `imageRef`
2. `status` handler 第 1 个 notify：`imageRefForTag(cfg.image, cfg.tag)` → `imageRef(cfg.image)`
3. `keep` handler：`cfg.containerName = name` → `cfg.runtime.name = name`
4. `config` handler：
   - `imageRefForTag(cfg.image, cfg.tag)` → `imageRef(cfg.image)`
   - `cfg.tier` → `cfg.runtime.tier`
   - `cfg.containerName` → `cfg.runtime.name`
   - `cfg.persist` → `cfg.runtime.persist`
   - `cfg.cacheVolume` → `cfg.runtime.cache`
5. `tiers` handler：`cfg.tier = tier` → `cfg.runtime.tier = tier`

- [ ] **Step 3: 运行测试验证（GREEN）**

```bash
cd pi-container-sandbox && npx vitest run tests/commands.test.ts
```

预期：全部 PASS

- [ ] **Step 4: 提交**

```bash
git add pi-container-sandbox/src/commands/sandbox.ts
git commit -m "refactor: adapt sandbox commands to grouped SbxConfig"
```

---

### Task 6: 重写 index.ts —— 删除 flags、简化 mountSkills、session_start 全部读 cfg

> 此 Task 涉及 `index.ts` 的事件处理逻辑变更，采用验证驱动：先确保现有测试仍可通过，再实现变更。`tsc --noEmit` 充当编译期测试。

**Files:**
- Modify: `pi-container-sandbox/index.ts`

- [ ] **Step 1: 删除所有 flag 注册，只保留 3 个**

删除 `index.ts` 中除 `container`、`no-container`、`noc` 外的所有 `pi.registerFlag(...)` 调用（共删除 18 个 flag 注册行及其相邻空行）。

保留的 3 个：
```typescript
pi.registerFlag("container", {
	description: "Sandbox all bash/read/write/edit ops inside a Linux container (default: on)",
	type: "boolean", default: true,
});
pi.registerFlag("no-container", {
	description: "Force-disable container sandboxing",
	type: "boolean", default: false,
});
pi.registerFlag("noc", {
	description: "Alias for --no-container",
	type: "boolean", default: false,
});
```

- [ ] **Step 2: 重写 session_start 事件处理**

将 `pi.on("session_start", ...)` 的回调体完整替换，所有 `pi.getFlag(...)` 替换为从 `cfg` 分组读取，同时简化 mountSkills：

替换前（需定位的行）：
```typescript
	const mountSkills = pi.getFlag("container-mount-skills") as boolean;
```
→ 删除此行。

```typescript
	const skillMounts = mountSkills ? discoverSkillMounts(extraPaths) : [];
```
→ 替换为：
```typescript
	const skillMounts = discoverSkillMounts(extraPaths);
```

完整重写后的 `session_start` handler 核心逻辑：

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

		const extraPaths = rt.mounts.length ? rt.mounts : undefined;
		const sandboxName = rt.name ?? deriveContainerName(localCwd);
		const isReusable = !!(rt.name);
		const cacheVolume = rt.cache ?? undefined;

		const skillMounts = discoverSkillMounts(extraPaths);

		const allowedExternalPrefixes: string[] = [];

		const resources: { memory: string; cpus: string; swap: string; pidsLimit?: number } = {
			memory: tierSpec.memory, cpus: tierSpec.cpus, swap: tierSpec.swap,
		};
		if (rt.memory) resources.memory = rt.memory;
		if (rt.cpus) resources.cpus = rt.cpus;
		if (rt.pidsLimit !== null) resources.pidsLimit = rt.pidsLimit;
		if (rt.swap !== null) resources.swap = rt.swap;

		const runtime = new DockerRuntime({
			image, hostCwd: localCwd, name: sandboxName, allowNetwork,
			resources,
			extraMounts: skillMounts.length ? skillMounts : undefined,
			cacheVolume,
			dockerfile: cfg.build.dockerfile ?? undefined,
			buildContext: cfg.build.context ?? undefined,
			buildArgs: Object.keys(cfg.build.args).length ? cfg.build.args : undefined,
			onProgress: (msg: string) => ctx.ui.setStatus("sandbox", `[build] ${msg}`),
		});

		await runtime.init();
		// ... 镜像构建逻辑（不变） ...
		if (!runtime.isReady()) await runtime.withReady();

		setSbx({
			runtime, name: sandboxName, hostCwd: localCwd,
			keep, mounts: skillMounts, allowedExternalPrefixes,
			resources, imageRef: image, config: cfg,
			isReusable, isReattached: false,
		});

		// ... 清理逻辑（不变） ...
	} catch (e) {
		clearSbx();
		ctx.ui.notify(`Sandbox init failed: ${e instanceof Error ? e.message : String(e)}`, "error");
	}
});
```

- [ ] **Step 3: 更新 before_agent_start 和 bash tool 中的 hostCommands 引用**

1. `before_agent_start` 中：`sbx.config.hostCommands` → `sbx.config.host.commands`
2. bash tool 中：`sbx.config.hostCommands` → `sbx.config.host.commands`

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
git commit -m "feat: strip CLI flags to 3, simplify mountSkills, read all config from sandbox.json"
```

---

### Task 7: 更新文档

**Files:**
- Modify: `pi-container-sandbox/README.zh.md`
- Modify: `pi-container-sandbox/README.md`

- [ ] **Step 1: 更新 README.zh.md**

更新"配置"章节，替换 `sandbox.json` 示例和 CLI 参数表格：

````markdown
## 配置

配置从两个位置读取，项目配置覆盖全局配置。

### 全局配置

`~/.pi/agent/sandbox.json`：

```json
{
  "runtime": { "tier": "medium" }
}
```

### 项目配置

`.pi/sandbox.json`（完整示例）：

```json
{
  "image": { "name": "pi-container-sandbox", "tag": "latest" },
  "runtime": {
    "name": null, "tier": "medium", "network": true, "persist": false,
    "memory": null, "cpus": null, "swap": null, "pidsLimit": null,
    "cache": null, "mounts": []
  },
  "build": { "dockerfile": null, "context": null, "args": {} },
  "host": { "commands": [] }
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
| `memory` | string \| null | `null` | 内存覆盖 |
| `cpus` | string \| null | `null` | CPU 覆盖 |
| `swap` | string \| null | `null` | swap 覆盖 |
| `pidsLimit` | number \| null | `null` | PID 限制 |
| `cache` | string \| null | `null` | 缓存卷名 |
| `mounts` | string[] | `[]` | 额外挂载路径 |

#### build 组
| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `dockerfile` | string \| null | `null` | Dockerfile 路径 |
| `context` | string \| null | `null` | 构建上下文 |
| `args` | Record<string, string> | `{}` | 构建参数 |

#### host 组
| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `commands` | string[] | `[]` | 宿主机命令白名单 |

### CLI 参数

| 参数 | 默认值 | 描述 |
|------|--------|------|
| `--container` | `true` | 启用 sandbox |
| `--no-container` / `--noc` | `false` | 禁用 sandbox |

其他所有配置项均通过 `sandbox.json` 配置。
````

- [ ] **Step 2: 同步更新 README.md（英文版）**

- [ ] **Step 3: 提交**

```bash
git add pi-container-sandbox/README.md pi-container-sandbox/README.zh.md
git commit -m "docs: update README for grouped sandbox.json and stripped CLI flags"
```

---

### Task 8: 最终验证

- [ ] **Step 1: 类型检查**

```bash
cd pi-container-sandbox && uv run npx tsc --noEmit
```
预期：零错误

- [ ] **Step 2: 全部测试**

```bash
cd pi-container-sandbox && npx vitest run
```
预期：全部 PASS

- [ ] **Step 3: 确认无影响的模块测试仍通过**

```bash
cd pi-container-sandbox && npx vitest run tests/tiers.test.ts tests/ops.test.ts tests/paths.test.ts tests/runtime.test.ts
```
预期：全部 PASS

- [ ] **Step 4: 提交**

```bash
git commit --allow-empty -m "chore: final verification - all tests pass"
```

---

## 变更文件总览

| 文件 | 操作 | Task |
|------|------|------|
| `tests/config.test.ts` | 重写（TDD RED） | Task 2 |
| `src/config.ts` | 重写（TDD GREEN） | Task 3 |
| `tests/_helpers.ts` | 修改 DEFAULT_CONFIG | Task 4 |
| `tests/session.test.ts` | 修改 mockSession.config | Task 4 |
| `src/commands/sandbox.ts` | 字段路径适配 | Task 5 |
| `index.ts` | 删 flags、简 mountSkills、重写 session_start | Task 6 |
| `README.md` | 更新配置文档 | Task 7 |
| `README.zh.md` | 更新配置文档 | Task 7 |
