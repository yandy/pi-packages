# pi-container-sandbox Implementation Plan (TDD)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a pi extension that routes read/write/edit/bash tool calls into a per-session Docker container.

**Architecture:** Single entry point `index.ts` registers flags, tools, events, and commands. Logic split across `src/` modules: runtime (Docker CLI), config (sandbox.json), tiers (resource presets), paths (translation + safety), skills (mount discovery), ops (tool adapters), sandbox (session lifecycle), commands (/sandbox handlers).

**Tech Stack:** TypeScript (jiti loader, no build step), Node.js built-in modules, Docker CLI. `@earendil-works/pi-coding-agent` 作为 `peerDependency`（pi 自身已提供）。Test framework: `vitest`（仅测纯函数，pi 生态无官方测试框架，标准做法是 `tsc --noEmit` + 集成测试 `pi -e`）。

---

### Task 1: Project Setup + Test Framework

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Write package.json**

```json
{
  "name": "pi-container-sandbox",
  "version": "0.1.0",
  "description": "pi coding-agent extension that runs every read/write/edit/bash op inside a per-session Docker container",
  "license": "MIT",
  "type": "module",
  "files": [
    "index.ts",
    "src/",
    "docker/"
  ],
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "build-image": "docker build -t pi-container-sandbox:latest -f docker/Dockerfile docker",
    "clean": "rm -rf dist"
  },
  "pi": {
    "extensions": [
      "./index.ts"
    ]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": ">=0.74.0"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "^0.74.0",
    "@types/node": "^22.0.0",
    "typescript": "~5.7.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "lib": ["ES2022"]
  },
  "include": ["index.ts", "src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 3: Write vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Install dependencies**

```bash
npm install
```

- [ ] **Step 5: Verify test runner works (empty suite)**

```bash
npx vitest run
```
Expected: "No test files found" or PASS (0 tests)

- [ ] **Step 6: Verify typecheck**

```bash
npx tsc --noEmit
```
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts
git commit -m "chore: initial project setup with vitest"
```

---

### Task 2: Tiers — TDD

**Files:**
- Create: `tests/tiers.test.ts`
- Create: `src/tiers.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from "vitest";
// import - will fail until module exists
// import { parseSizeTier, TIER_SPECS, type SizeTier } from "../src/tiers";

describe("parseSizeTier", () => {
  it.todo("returns the tier for valid tier names");
  it.todo("returns null for unknown tier names");
  it.todo("is case-sensitive");
});

describe("TIER_SPECS", () => {
  it.todo("has small, medium, large entries");
  it.todo("small tier has expected values");
  it.todo("medium tier has expected values");
  it.todo("large tier has expected values");
});
```

- [ ] **Step 2: Run test — verify fail**

```bash
npx vitest run
```
Expected: all tests show as TODO (no real failures yet, but test file exists)

- [ ] **Step 3: Write src/tiers.ts (minimal implementation)**

```typescript
export interface TierSpec {
	memory: string;
	swap: string;
	cpus: string;
}

export type SizeTier = "small" | "medium" | "large";

export const TIER_SPECS: Record<SizeTier, TierSpec> = {
	small: { memory: "1g", swap: "512m", cpus: "1" },
	medium: { memory: "4g", swap: "2g", cpus: "2" },
	large: { memory: "8g", swap: "4g", cpus: "4" },
};

export function parseSizeTier(tier: string): SizeTier | null {
	if (tier in TIER_SPECS) return tier as SizeTier;
	return null;
}
```

- [ ] **Step 4: Replace todos with real tests in tests/tiers.test.ts**

```typescript
import { describe, it, expect } from "vitest";
import { parseSizeTier, TIER_SPECS } from "../src/tiers";

describe("parseSizeTier", () => {
  it("returns the tier for valid tier names", () => {
    expect(parseSizeTier("small")).toBe("small");
    expect(parseSizeTier("medium")).toBe("medium");
    expect(parseSizeTier("large")).toBe("large");
  });

  it("returns null for unknown tier names", () => {
    expect(parseSizeTier("xlarge")).toBeNull();
    expect(parseSizeTier("")).toBeNull();
    expect(parseSizeTier("SMALL")).toBeNull();
  });
});

describe("TIER_SPECS", () => {
  it("has small, medium, large entries", () => {
    expect(Object.keys(TIER_SPECS).sort()).toEqual(["large", "medium", "small"].sort());
  });

  it("small tier has expected values", () => {
    expect(TIER_SPECS.small).toEqual({ memory: "1g", swap: "512m", cpus: "1" });
  });

  it("medium tier has expected values", () => {
    expect(TIER_SPECS.medium).toEqual({ memory: "4g", swap: "2g", cpus: "2" });
  });

  it("large tier has expected values", () => {
    expect(TIER_SPECS.large).toEqual({ memory: "8g", swap: "4g", cpus: "4" });
  });
});
```

- [ ] **Step 5: Run tests — verify pass**

```bash
npx vitest run
```
Expected: 7 tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/tiers.ts tests/tiers.test.ts
git commit -m "feat: add tier definitions with tests"
```

---

### Task 3: Configuration — TDD

**Files:**
- Create: `tests/config.test.ts`
- Create: `src/config.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
// import - will fail until module exists
// import { getSbxConfigPath, loadSbxConfig, saveSbxConfig, imageRefForTag, DEFAULT_SBX_CONFIG } from "../src/config";

const testDir = resolvePath(tmpdir(), "pi-sandbox-test-" + Date.now());

describe("getSbxConfigPath", () => {
  it.todo("returns path under .pi/agent/sandbox.json");
});

describe("imageRefForTag", () => {
  it.todo("combines image and tag");
  it.todo("handles images with slashes");
});

describe("loadSbxConfig", () => {
  it.todo("returns defaults when no config file exists");
  it.todo("loads values from existing config file");
  it.todo("falls back to defaults on corrupt JSON");
});

describe("saveSbxConfig", () => {
  it.todo("writes config to disk");
  it.todo("round-trips: save then load returns same values");
});
```

- [ ] **Step 2: Run test — verify TODO**

```bash
npx vitest run
```
Expected: all tasks marked TODO

- [ ] **Step 3: Write src/config.ts**

```typescript
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { SizeTier } from "./tiers";

export interface SbxConfig {
	image: string;
	tag: string;
	containerName: string | null;
	tier: SizeTier;
	persist: boolean;
	cacheVolume: string | null;
}

export const DEFAULT_SBX_CONFIG: SbxConfig = {
	image: "pi-container-sandbox",
	tag: "latest",
	containerName: null,
	tier: "medium",
	persist: false,
	cacheVolume: null,
};

export function getSbxConfigPath(hostCwd: string): string {
	return resolvePath(hostCwd, ".pi", "agent", "sandbox.json");
}

export function loadSbxConfig(hostCwd: string): SbxConfig {
	const configPath = getSbxConfigPath(hostCwd);
	if (!existsSync(configPath)) {
		return { ...DEFAULT_SBX_CONFIG };
	}
	try {
		const raw = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw);
		return {
			image: parsed.image ?? DEFAULT_SBX_CONFIG.image,
			tag: parsed.tag ?? DEFAULT_SBX_CONFIG.tag,
			containerName: parsed.containerName ?? DEFAULT_SBX_CONFIG.containerName,
			tier: parsed.tier ?? DEFAULT_SBX_CONFIG.tier,
			persist: parsed.persist ?? DEFAULT_SBX_CONFIG.persist,
			cacheVolume: parsed.cacheVolume ?? DEFAULT_SBX_CONFIG.cacheVolume,
		};
	} catch {
		return { ...DEFAULT_SBX_CONFIG };
	}
}

export function saveSbxConfig(hostCwd: string, config: SbxConfig): void {
	const configPath = getSbxConfigPath(hostCwd);
	const dir = resolvePath(configPath, "..");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const tmpPath = configPath + ".tmp";
	writeFileSync(tmpPath, JSON.stringify(config, null, 2));
	renameSync(tmpPath, configPath);
}

export function imageRefForTag(image: string, tag: string): string {
	return `${image}:${tag}`;
}
```

- [ ] **Step 4: Replace todos with real tests**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { getSbxConfigPath, loadSbxConfig, saveSbxConfig, imageRefForTag, DEFAULT_SBX_CONFIG } from "../src/config";

const testDir = resolvePath(tmpdir(), "pi-sandbox-test-" + Date.now());

beforeEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("getSbxConfigPath", () => {
  it("returns path under .pi/agent/sandbox.json", () => {
    const path = getSbxConfigPath(testDir);
    expect(path).toBe(resolvePath(testDir, ".pi", "agent", "sandbox.json"));
  });
});

describe("imageRefForTag", () => {
  it("combines image and tag", () => {
    expect(imageRefForTag("pi-sandbox", "latest")).toBe("pi-sandbox:latest");
  });

  it("handles images with slashes", () => {
    expect(imageRefForTag("org/pi-sandbox", "v1.0")).toBe("org/pi-sandbox:v1.0");
  });
});

describe("loadSbxConfig", () => {
  it("returns defaults when no config file exists", () => {
    const cfg = loadSbxConfig(testDir);
    expect(cfg).toEqual(DEFAULT_SBX_CONFIG);
  });

  it("loads values from existing config file", () => {
    const configDir = resolvePath(testDir, ".pi", "agent");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(resolvePath(configDir, "sandbox.json"), JSON.stringify({ image: "my-img", tag: "v2", tier: "large" }));

    const cfg = loadSbxConfig(testDir);
    expect(cfg.image).toBe("my-img");
    expect(cfg.tag).toBe("v2");
    expect(cfg.tier).toBe("large");
    // defaults for unspecified fields
    expect(cfg.containerName).toBe(DEFAULT_SBX_CONFIG.containerName);
    expect(cfg.persist).toBe(DEFAULT_SBX_CONFIG.persist);
  });

  it("falls back to defaults on corrupt JSON", () => {
    const configDir = resolvePath(testDir, ".pi", "agent");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(resolvePath(configDir, "sandbox.json"), "not json {{{");

    const cfg = loadSbxConfig(testDir);
    expect(cfg).toEqual(DEFAULT_SBX_CONFIG);
  });
});

describe("saveSbxConfig", () => {
  it("writes config to disk", () => {
    saveSbxConfig(testDir, { image: "x", tag: "y", containerName: "z", tier: "small", persist: true, cacheVolume: "v" });
    const cfg = loadSbxConfig(testDir);
    expect(cfg.image).toBe("x");
    expect(cfg.tag).toBe("y");
    expect(cfg.containerName).toBe("z");
    expect(cfg.tier).toBe("small");
    expect(cfg.persist).toBe(true);
    expect(cfg.cacheVolume).toBe("v");
  });

  it("round-trips: save then load returns same values", () => {
    const input = { ...DEFAULT_SBX_CONFIG, tier: "large" as const, containerName: "my-container" };
    saveSbxConfig(testDir, input);
    const output = loadSbxConfig(testDir);
    expect(output).toEqual(input);
  });
});
```

- [ ] **Step 5: Run tests — verify pass**

```bash
npx vitest run
```
Expected: all tests PASS (8 tests across both files)

- [ ] **Step 6: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: add config module with tests"
```

---

### Task 4: Runtime — TDD (Pure Functions)

**Files:**
- Create: `tests/runtime.test.ts`
- Create: `src/runtime.ts`

- [ ] **Step 1: Write failing test (todos)**

```typescript
import { describe, it, expect } from "vitest";
// import { deriveContainerName, randomSuffix } from "../src/runtime";

describe("deriveContainerName", () => {
  it.todo("generates deterministic name from path");
  it.todo("same path produces same name");
  it.todo("different paths produce different names");
  it.todo("handles trailing slash");
});

describe("randomSuffix", () => {
  it.todo("returns 8-character hex string");
  it.todo("returns different values on subsequent calls");
});
```

- [ ] **Step 2: Run test — verify TODO**

```bash
npx vitest run
```

- [ ] **Step 3: Write src/runtime.ts (full implementation)**

```typescript
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

export interface MountSpec {
	source: string;
	target: string;
}

export interface RunArgs {
	name: string;
	image: string;
	hostCwd: string;
	allowNetwork: boolean;
	extraMounts?: MountSpec[];
	resources?: {
		memory?: string;
		cpus?: string;
		pidsLimit?: number;
		swap?: string;
	};
	cacheVolume?: string;
}

export interface Runtime {
	kind: string;
	bin: string;
	run(args: RunArgs): Promise<string>;
	stop(name: string): void;
	remove(name: string): void;
	exists(image: string): Promise<boolean>;
	isRunning(name: string): Promise<boolean>;
	start(name: string): Promise<boolean>;
	createVolume(name: string): Promise<boolean>;
}

export function randomSuffix(): string {
	return randomBytes(4).toString("hex");
}

export function deriveContainerName(hostCwd: string): string {
	const basename = hostCwd.split("/").filter(Boolean).pop() || "project";
	const hash = createHash("sha256").update(hostCwd).digest("hex").slice(0, 6);
	return `pi-sbx-${basename}-${hash}`;
}

function which(bin: string): boolean {
	const r = spawnSync("which", [bin], { stdio: "ignore" });
	return r.status === 0;
}

export function spawnWithTimeout(
	bin: string,
	args: string[],
	timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
	return new Promise((resolve) => {
		const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let timedOut = false;

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);

		child.stdout.on("data", (d: Buffer) => out.push(d));
		child.stderr.on("data", (d: Buffer) => err.push(d));
		child.on("error", () => {
			clearTimeout(timer);
			resolve({ code: -1, stdout: "", stderr: "spawn error", timedOut: false });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({
				code,
				stdout: Buffer.concat(out).toString(),
				stderr: Buffer.concat(err).toString(),
				timedOut,
			});
		});
	});
}

function parseBytesToBytes(s: string): number {
	const match = s.match(/^(\d+(?:\.\d+)?)\s*(b|k|m|g|t)?$/i);
	if (!match) return 0;
	const val = parseFloat(match[1]);
	const unit = (match[2] ?? "b").toLowerCase();
	const multipliers: Record<string, number> = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
	return Math.round(val * (multipliers[unit] ?? 1));
}

function formatBytes(bytes: number): string {
	if (bytes >= 1024 ** 3 && bytes % (1024 ** 3) === 0) return `${bytes / (1024 ** 3)}g`;
	if (bytes >= 1024 ** 2 && bytes % (1024 ** 2) === 0) return `${bytes / (1024 ** 2)}m`;
	if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024}k`;
	return `${bytes}b`;
}

export function dockerRuntime(): Runtime {
	const bin = "docker";
	return {
		kind: "docker",
		bin,
		exists: async (image) => {
			const r = await spawnWithTimeout(bin, ["image", "inspect", image], 10000);
			return r.code === 0 && !r.timedOut;
		},
		stop: (name) => {
			spawnSync(bin, ["stop", name], { stdio: "ignore" });
		},
		remove: (name) => {
			spawnSync(bin, ["rm", "-f", name], { stdio: "ignore" });
		},
		isRunning: async (name: string) => {
			const r = await spawnWithTimeout(bin, ["inspect", "--format", "{{.State.Running}}", name], 5000);
			return r.code === 0 && r.stdout.trim() === "true";
		},
		start: async (name: string) => {
			const r = await spawnWithTimeout(bin, ["start", name], 10000);
			return r.code === 0 && !r.timedOut;
		},
		createVolume: async (name: string) => {
			const r = await spawnWithTimeout(bin, ["volume", "create", name], 10000);
			return r.code === 0 && !r.timedOut;
		},
		run: async ({ name, image, hostCwd, allowNetwork, extraMounts, resources, cacheVolume }) => {
			const memory = resources?.memory ?? "4g";
			const cpus = resources?.cpus ?? "2";
			const pidsLimit = resources?.pidsLimit ?? 512;

			const args: string[] = [
				"run",
				"-d",
				"--name", name,
				"--user", "1000:1000",
				"--memory", memory,
				"--cpus", cpus,
				"--cap-drop", "ALL",
				"--security-opt", "no-new-privileges",
				"--pids-limit", String(pidsLimit),
				"-v", `${hostCwd}:/workspace`,
				"-w", "/workspace",
			];

			if (extraMounts) {
				for (const m of extraMounts) {
					args.push("-v", `${m.source}:${m.target}:ro`);
				}
			}

			if (cacheVolume) {
				args.push("-v", `${cacheVolume}:/cache`);
			}

			const swap = resources?.swap;
			if (swap !== undefined) {
				if (swap === "0") {
					args.push("--memory-swap", memory);
				} else {
					const totalSwap = parseBytesToBytes(memory) + parseBytesToBytes(swap);
					args.push("--memory-swap", formatBytes(totalSwap));
				}
			}

			if (!allowNetwork) args.push("--network", "none");
			args.push(image, "sleep", "infinity");

			const r = await spawnWithTimeout(bin, args, 60000);
			if (r.timedOut) {
				throw new Error(`docker run timed out after 60s (command: docker run ${name})`);
			}
			if (r.code !== 0) {
				throw new Error(`docker run failed: ${r.stderr || r.stdout}`);
			}
			return name;
		},
	};
}

export async function detectRuntime(ctx?: { ui?: { notify: (msg: string, level: string) => void } }): Promise<Runtime | null> {
	if (!which("docker")) {
		return null;
	}

	const runtime = dockerRuntime();

	const testName = `pi-test-${randomSuffix()}`;
	try {
		const r = await spawnWithTimeout(
			runtime.bin,
			["run", "-d", "--rm", "--name", testName, "debian:12-slim", "sleep", "infinity"],
			3000,
		);
		if (r.code === 0 && !r.timedOut) {
			runtime.stop(testName);
			return runtime;
		}
		if (r.timedOut) {
			ctx?.ui?.notify("docker runtime timed out (3s smoke test)", "warning");
		}
	} catch {
		// Fall through
	}

	return null;
}
```

- [ ] **Step 4: Replace todos with real tests**

```typescript
import { describe, it, expect } from "vitest";
import { deriveContainerName, randomSuffix } from "../src/runtime";

describe("deriveContainerName", () => {
  it("generates deterministic name from path", () => {
    const name = deriveContainerName("/home/user/projects/my-app");
    expect(name).toMatch(/^pi-sbx-my-app-[a-f0-9]{6}$/);
  });

  it("same path produces same name", () => {
    const a = deriveContainerName("/home/user/projects/my-app");
    const b = deriveContainerName("/home/user/projects/my-app");
    expect(a).toBe(b);
  });

  it("different paths produce different names", () => {
    const a = deriveContainerName("/home/user/projects/app-a");
    const b = deriveContainerName("/home/user/projects/app-b");
    expect(a).not.toBe(b);
  });

  it("handles trailing slash", () => {
    const a = deriveContainerName("/home/user/projects/my-app/");
    const b = deriveContainerName("/home/user/projects/my-app");
    expect(a).toBe(b);
  });
});

describe("randomSuffix", () => {
  it("returns 8-character hex string", () => {
    const s = randomSuffix();
    expect(s).toMatch(/^[a-f0-9]{8}$/);
  });

  it("returns different values on subsequent calls", () => {
    const a = randomSuffix();
    const b = randomSuffix();
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 5: Run tests — verify pass**

```bash
npx vitest run
```
Expected: all tests PASS (13 total: 7 tiers + 8 config + 6 runtime = 21 previously, now +6)

- [ ] **Step 6: Commit**

```bash
git add src/runtime.ts tests/runtime.test.ts
git commit -m "feat: add runtime module with tests for pure functions"
```

---

### Task 5: Path Translation and Safety — TDD

**Files:**
- Create: `tests/paths.test.ts`
- Create: `src/paths.ts`

- [ ] **Step 1: Write failing test (todos)**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
// import { toRemote, shq, isInsideCwd, isReadOnlyMount, resolveExtraMountPath,
//          getExternalPath, isAllowedExternalResource, REMOTE_ROOT, SKILLS_ROOT,
//          PathApprovalStore } from "../src/paths";

const testDir = resolvePath(tmpdir(), "pi-paths-test-" + Date.now());

describe("shq", () => {
  it.todo("wraps string in single quotes");
  it.todo("escapes embedded single quotes");
});

describe("toRemote", () => {
  it.todo("converts relative path inside cwd to /workspace path");
  it.todo("returns /workspace for cwd itself");
  it.todo("passes through paths already under /workspace");
  it.todo("throws for paths outside cwd");
  it.todo("passes through paths under a mount target");
});

describe("isInsideCwd", () => {
  it.todo("returns true for relative path inside cwd");
  it.todo("returns true for /workspace paths");
  it.todo("returns false for paths outside cwd");
});

describe("isReadOnlyMount", () => {
  it.todo("returns true for exact mount target match");
  it.todo("returns true for path under mount target");
  it.todo("returns false for unrelated path");
});

describe("resolveExtraMountPath", () => {
  it.todo("returns path if it matches a mount target");
  it.todo("returns null for unrelated path");
});

describe("getExternalPath", () => {
  it.todo("returns null for paths inside cwd");
  it.todo("returns absolute path for paths outside cwd");
  it.todo("returns null for paths under mount targets");
});

describe("isAllowedExternalResource", () => {
  it.todo("allows pi-clipboard files");
  it.todo("allows paths matching a prefix");
  it.todo("denies unrelated paths");
});

describe("PathApprovalStore", () => {
  it.todo("starts with no records");
  it.todo("adds and finds records");
  it.todo("revokes records");
  it.todo("lists active records");
  it.todo("prefix matching finds child paths");
  it.todo("expired records are not returned");
  it.todo("persists and reloads from disk");
});
```

- [ ] **Step 2: Run test — verify TODO**

```bash
npx vitest run
```

- [ ] **Step 3: Write src/paths.ts (full implementation)**

```typescript
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { MountSpec } from "./runtime";

export const REMOTE_ROOT = "/workspace";
export const SKILLS_ROOT = "/skills";

export function shq(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function resolveExtraMountPath(containerPath: string, mounts: MountSpec[]): string | null {
	for (const m of mounts) {
		if (containerPath === m.target || containerPath.startsWith(`${m.target}/`)) {
			return containerPath;
		}
	}
	return null;
}

export function toRemote(hostPath: string, hostCwd: string, mounts?: MountSpec[]): string {
	if (hostPath === REMOTE_ROOT || hostPath.startsWith(`${REMOTE_ROOT}/`)) {
		return hostPath;
	}
	if (mounts) {
		const resolved = resolveExtraMountPath(hostPath, mounts);
		if (resolved) return resolved;
	}
	const abs = resolvePath(hostCwd, hostPath);
	if (abs !== hostCwd && !abs.startsWith(`${hostCwd}/`)) {
		throw new Error(
			`sandbox: refusing to access ${abs}: outside of project cwd ${hostCwd}`,
		);
	}
	const rel = abs === hostCwd ? "" : abs.slice(hostCwd.length + 1);
	return rel ? `${REMOTE_ROOT}/${rel}` : REMOTE_ROOT;
}

export function isReadOnlyMount(containerPath: string, mounts: MountSpec[]): boolean {
	for (const m of mounts) {
		if (containerPath === m.target || containerPath.startsWith(`${m.target}/`)) {
			return true;
		}
	}
	return false;
}

export function isAllowedExternalResource(hostPath: string, allowedPrefixes: string[]): boolean {
	const abs = resolvePath(hostPath);
	const basename = abs.split("/").pop() || "";
	if (basename.startsWith("pi-clipboard-")) return true;
	for (const prefix of allowedPrefixes) {
		if (abs === prefix || abs.startsWith(`${prefix}/`)) return true;
	}
	return false;
}

export function isInsideCwd(hostPath: string, hostCwd: string): boolean {
	if (hostPath === REMOTE_ROOT || hostPath.startsWith(`${REMOTE_ROOT}/`)) return true;
	const abs = resolvePath(hostCwd, hostPath);
	return abs === hostCwd || abs.startsWith(`${hostCwd}/`);
}

export function getExternalPath(hostPath: string, hostCwd: string, mounts: MountSpec[]): string | null {
	if (isInsideCwd(hostPath, hostCwd)) return null;
	const abs = resolvePath(hostCwd, hostPath);
	const containerPath = hostPath.startsWith("/") ? hostPath : abs;
	if (resolveExtraMountPath(containerPath, mounts)) return null;
	return abs;
}

interface PathApprovalRecord {
	path: string;
	approvedAt: number;
	expiresAt: number;
}

export class PathApprovalStore {
	private path: string;
	private records: Map<string, PathApprovalRecord> = new Map();

	constructor(hostCwd: string) {
		this.path = resolvePath(hostCwd, ".pi", "agent", "path-approvals.json");
		this.load();
	}

	private load(): void {
		if (!existsSync(this.path)) return;
		try {
			const raw = JSON.parse(readFileSync(this.path, "utf-8")) as PathApprovalRecord[];
			const now = Date.now();
			for (const r of raw) {
				if (r.expiresAt === Infinity || r.expiresAt > now) {
					this.records.set(r.path, r);
				}
			}
		} catch {
			// corrupt file - start fresh
		}
	}

	private save(): void {
		const dir = this.path.slice(0, this.path.lastIndexOf("/"));
		if (!existsSync(dir)) {
			try { mkdirSync(dir, { recursive: true }); } catch { return; }
		}
		const tmpPath = this.path + ".tmp";
		const data = Array.from(this.records.values());
		writeFileSync(tmpPath, JSON.stringify(data, null, 2));
		renameSync(tmpPath, this.path);
	}

	find(absPath: string): PathApprovalRecord | undefined {
		const exact = this.records.get(absPath);
		if (exact && (exact.expiresAt === Infinity || exact.expiresAt > Date.now())) return exact;

		for (const [, record] of this.records) {
			if (
				(absPath === record.path || absPath.startsWith(record.path + "/")) &&
				(record.expiresAt === Infinity || record.expiresAt > Date.now())
			) {
				return record;
			}
		}

		return undefined;
	}

	add(absPath: string, days: number | typeof Infinity): void {
		const now = Date.now();
		const record: PathApprovalRecord = {
			path: absPath,
			approvedAt: now,
			expiresAt: days === Infinity ? Infinity : now + days * 24 * 60 * 60 * 1000,
		};
		this.records.set(absPath, record);
		this.save();
	}

	revoke(absPath: string): boolean {
		if (this.records.delete(absPath)) {
			this.save();
			return true;
		}
		return false;
	}

	list(): PathApprovalRecord[] {
		return Array.from(this.records.values()).filter(
			(r) => r.expiresAt === Infinity || r.expiresAt > Date.now(),
		);
	}
}

export async function requestPathApproval(
	absPath: string,
	sessionPrefixes: string[],
	store: PathApprovalStore,
	ui: { select: (title: string, options: string[]) => Promise<string | undefined>; notify: (msg: string, level: string) => void },
): Promise<boolean> {
	for (const prefix of sessionPrefixes) {
		if (absPath === prefix || absPath.startsWith(prefix + "/")) return true;
	}

	const existing = store.find(absPath);
	if (existing) return true;

	const basename = absPath.split("/").pop() || "";
	if (basename.startsWith("pi-clipboard-")) return true;

	const options = [
		"Approve once",
		"Approve always",
		"Approve for 7 days",
		"Approve for 30 days",
		"Deny",
	];

	let choice: string | undefined;
	try {
		choice = await ui.select("Sandbox: External File Access", options);
	} catch {
		return false;
	}

	if (!choice || choice.includes("Deny")) return false;

	if (choice.includes("once")) {
		sessionPrefixes.push(absPath);
		return true;
	}

	if (choice.includes("always")) {
		store.add(absPath, Infinity);
		sessionPrefixes.push(absPath);
		ui.notify(`Approved read access (always): ${absPath}`, "info");
		return true;
	}

	const days = choice.includes("30") ? 30 : 7;
	store.add(absPath, days);
	sessionPrefixes.push(absPath);
	ui.notify(`Approved read access (${days} days): ${absPath}`, "info");
	return true;
}

export async function ensureExternalReadApproved(
	absPath: string,
	sessionPrefixes: string[],
	store: PathApprovalStore,
	ui: { select: (title: string, options: string[]) => Promise<string | undefined>; notify: (msg: string, level: string) => void },
): Promise<void> {
	const approved = await requestPathApproval(absPath, sessionPrefixes, store, ui);
	if (!approved) {
		throw new Error(`sandbox: access denied to ${absPath}`);
	}
}
```

- [ ] **Step 4: Replace todos with real tests**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync, mkdirSync as mkdir } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { toRemote, shq, isInsideCwd, isReadOnlyMount, resolveExtraMountPath,
         getExternalPath, isAllowedExternalResource, REMOTE_ROOT, SKILLS_ROOT,
         PathApprovalStore } from "../src/paths";

const testDir = resolvePath(tmpdir(), "pi-paths-test-" + Date.now());

beforeEach(() => {
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
});
afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("shq", () => {
  it("wraps string in single quotes", () => {
    expect(shq("hello")).toBe("'hello'");
  });

  it("escapes embedded single quotes", () => {
    expect(shq("it's")).toBe("'it'\\''s'");
  });
});

describe("toRemote", () => {
  it("converts relative path inside cwd to /workspace path", () => {
    expect(toRemote("src/index.ts", testDir)).toBe("/workspace/src/index.ts");
  });

  it("returns /workspace for cwd itself", () => {
    expect(toRemote(".", testDir)).toBe("/workspace");
  });

  it("passes through paths already under /workspace", () => {
    expect(toRemote("/workspace/src/file.ts", testDir)).toBe("/workspace/src/file.ts");
  });

  it("throws for paths outside cwd", () => {
    expect(() => toRemote("/etc/passwd", testDir)).toThrow("outside of project cwd");
  });

  it("passes through paths under a mount target", () => {
    const mounts = [{ source: "/host/skills", target: "/skills/my-skill" }];
    expect(toRemote("/skills/my-skill/SKILL.md", testDir, mounts)).toBe("/skills/my-skill/SKILL.md");
  });
});

describe("isInsideCwd", () => {
  it("returns true for relative path inside cwd", () => {
    expect(isInsideCwd("src/file.ts", testDir)).toBe(true);
  });

  it("returns true for /workspace paths", () => {
    expect(isInsideCwd("/workspace/src/file.ts", testDir)).toBe(true);
  });

  it("returns false for paths outside cwd", () => {
    expect(isInsideCwd("/etc/passwd", testDir)).toBe(false);
  });
});

describe("isReadOnlyMount", () => {
  const mounts = [{ source: "/host/skills", target: "/skills/my-skill" }];

  it("returns true for exact mount target match", () => {
    expect(isReadOnlyMount("/skills/my-skill", mounts)).toBe(true);
  });

  it("returns true for path under mount target", () => {
    expect(isReadOnlyMount("/skills/my-skill/SKILL.md", mounts)).toBe(true);
  });

  it("returns false for unrelated path", () => {
    expect(isReadOnlyMount("/workspace/src/file.ts", mounts)).toBe(false);
  });
});

describe("resolveExtraMountPath", () => {
  const mounts = [{ source: "/h/a", target: "/mnt/a" }];

  it("returns path if it matches a mount target", () => {
    expect(resolveExtraMountPath("/mnt/a", mounts)).toBe("/mnt/a");
    expect(resolveExtraMountPath("/mnt/a/file.txt", mounts)).toBe("/mnt/a/file.txt");
  });

  it("returns null for unrelated path", () => {
    expect(resolveExtraMountPath("/other/path", mounts)).toBeNull();
  });
});

describe("getExternalPath", () => {
  const mounts = [{ source: "/host/skills", target: "/skills/my-skill" }];

  it("returns null for paths inside cwd", () => {
    expect(getExternalPath("src/file.ts", testDir, [])).toBeNull();
  });

  it("returns absolute path for paths outside cwd", () => {
    const ext = getExternalPath("/etc/hosts", testDir, []);
    expect(ext).toBe("/etc/hosts");
  });

  it("returns null for /workspace paths", () => {
    expect(getExternalPath("/workspace/src/file.ts", testDir, [])).toBeNull();
  });
});

describe("isAllowedExternalResource", () => {
  it("allows pi-clipboard files", () => {
    expect(isAllowedExternalResource("/tmp/pi-clipboard-12345.txt", [])).toBe(true);
  });

  it("allows paths matching a prefix", () => {
    expect(isAllowedExternalResource("/home/user/downloads/file.txt", ["/home/user/downloads"])).toBe(true);
  });

  it("denies unrelated paths", () => {
    expect(isAllowedExternalResource("/etc/passwd", [])).toBe(false);
  });
});

describe("PathApprovalStore", () => {
  it("starts with no records", () => {
    const store = new PathApprovalStore(testDir);
    expect(store.list()).toEqual([]);
  });

  it("adds and finds records", () => {
    const store = new PathApprovalStore(testDir);
    store.add("/tmp/foo", Infinity);
    const found = store.find("/tmp/foo");
    expect(found).toBeDefined();
    expect(found!.path).toBe("/tmp/foo");
  });

  it("revokes records", () => {
    const store = new PathApprovalStore(testDir);
    store.add("/tmp/foo", Infinity);
    expect(store.revoke("/tmp/foo")).toBe(true);
    expect(store.find("/tmp/foo")).toBeUndefined();
  });

  it("lists active records", () => {
    const store = new PathApprovalStore(testDir);
    store.add("/tmp/a", Infinity);
    store.add("/tmp/b", 30);
    const list = store.list();
    expect(list.length).toBe(2);
  });

  it("prefix matching finds child paths", () => {
    const store = new PathApprovalStore(testDir);
    store.add("/tmp/approved-dir", Infinity);
    const found = store.find("/tmp/approved-dir/sub/file.txt");
    expect(found).toBeDefined();
    expect(found!.path).toBe("/tmp/approved-dir");
  });

  it("expired records are not returned", () => {
    const store = new PathApprovalStore(testDir);
    store.add("/tmp/expired", -1); // negative days = expired
    expect(store.find("/tmp/expired")).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it("persists and reloads from disk", () => {
    const store1 = new PathApprovalStore(testDir);
    store1.add("/tmp/persisted", Infinity);
    const store2 = new PathApprovalStore(testDir);
    const found = store2.find("/tmp/persisted");
    expect(found).toBeDefined();
  });
});
```

- [ ] **Step 5: Run tests — verify pass**

```bash
npx vitest run
```
Expected: all tests PASS (~36 tests total)

- [ ] **Step 6: Commit**

```bash
git add src/paths.ts tests/paths.test.ts
git commit -m "feat: add paths module with comprehensive tests"
```

---

### Task 6: Skill Directory Discovery

**Files:**
- Create: `src/skills.ts`

- [ ] **Step 1: Write src/skills.ts (no easily unit-testable pure logic, verify via typecheck)**

```typescript
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import type { MountSpec } from "./runtime";

export function discoverSkillMounts(additionalPaths?: string[]): MountSpec[] {
	const home = homedir();
	const skillRoots = [
		...(additionalPaths ?? []),
		resolvePath(home, ".agents", "skills"),
		resolvePath(home, ".pi", "agent", "skills"),
	];

	const mounts: MountSpec[] = [];

	for (const root of skillRoots) {
		if (!existsSync(root)) continue;
		try {
			const entries = readdirSync(root);
			for (const entry of entries) {
				const full = resolvePath(root, entry);
				try {
					const st = statSync(full);
					if (!st.isDirectory()) continue;
				} catch {
					continue;
				}
				const target = `/skills/${entry}`;
				if (mounts.some((m) => m.target === target)) continue;
				mounts.push({ source: full, target });
			}
		} catch {
			// Permission or I/O error - skip silently
		}
	}

	return mounts;
}
```

- [ ] **Step 2: Verify typecheck**

```bash
npx tsc --noEmit
```
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/skills.ts
git commit -m "feat: add skills module (mount discovery)"
```

---

### Task 7: Operations Adapters

**Files:**
- Create: `src/ops.ts`

- [ ] **Step 1: Write src/ops.ts (docker-dependent logic, verify via typecheck)**

```typescript
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { ReadOperations, WriteOperations, EditOperations, BashOperations } from "@earendil-works/pi-coding-agent";
import type { Runtime, MountSpec } from "./runtime";
import { toRemote, isReadOnlyMount, isInsideCwd, isAllowedExternalResource, shq } from "./paths";

export interface SbxHandle {
	runtime: Runtime;
	name: string;
	hostCwd: string;
	mounts: MountSpec[];
	allowedExternalPrefixes: string[];
}

export function execCapture(sbx: SbxHandle, command: string, timeoutMs?: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn(sbx.runtime.bin, ["exec", sbx.name, "sh", "-c", command], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let timedOut = false;

		const timer = timeoutMs
			? setTimeout(() => {
					timedOut = true;
					child.kill("SIGKILL");
				}, timeoutMs)
			: undefined;

		child.stdout.on("data", (d: Buffer) => out.push(d));
		child.stderr.on("data", (d: Buffer) => err.push(d));
		child.on("error", (e) => {
			if (timer) clearTimeout(timer);
			reject(e);
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			if (timedOut) {
				reject(new Error(`exec timed out after ${timeoutMs}ms: ${command}`));
			} else if (code !== 0) {
				reject(new Error(`exec failed (${code}): ${Buffer.concat(err).toString()}`));
			} else {
				resolve(Buffer.concat(out));
			}
		});
	});
}

export function execStream(
	sbx: SbxHandle,
	command: string,
	{ onData, signal, timeout }: { onData: (b: Buffer) => void; signal?: AbortSignal; timeout?: number },
): Promise<{ exitCode: number | null }> {
	return new Promise((resolve, reject) => {
		const child = spawn(sbx.runtime.bin, ["exec", sbx.name, "sh", "-c", command], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let timedOut = false;
		const timer = timeout
			? setTimeout(() => {
					timedOut = true;
					child.kill("SIGKILL");
				}, timeout * 1000)
			: undefined;
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.on("error", (e) => {
			if (timer) clearTimeout(timer);
			reject(e);
		});
		const onAbort = () => child.kill("SIGKILL");
		signal?.addEventListener("abort", onAbort, { once: true });
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (signal?.aborted) reject(new Error("aborted"));
			else if (timedOut) reject(new Error(`timeout:${timeout}`));
			else resolve({ exitCode: code });
		});
	});
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

- [ ] **Step 2: Verify typecheck**

```bash
npx tsc --noEmit
```
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/ops.ts
git commit -m "feat: add ops module (tool adapters for container exec)"
```

---

### Task 8: Sandbox Session Management

**Files:**
- Create: `tests/sandbox.test.ts`
- Create: `src/sandbox.ts`

- [ ] **Step 1: Write failing test (todos)**

```typescript
import { describe, it, expect } from "vitest";
// import { getSbx, setSbx, clearSbx, type SbxSession } from "../src/sandbox";

describe("session state", () => {
  it.todo("starts with null session");
  it.todo("set and get round-trip");
  it.todo("clear resets to null");
});
```

- [ ] **Step 2: Run test — verify TODO**

```bash
npx vitest run
```

- [ ] **Step 3: Write src/sandbox.ts**

```typescript
import type { Runtime, MountSpec, RunArgs } from "./runtime";
import type { SbxConfig } from "./config";

export interface SbxSession {
	runtime: Runtime;
	name: string;
	hostCwd: string;
	keep: boolean;
	mounts: MountSpec[];
	allowedExternalPrefixes: string[];
	resources?: RunArgs["resources"];
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

- [ ] **Step 4: Write real tests**

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { getSbx, setSbx, clearSbx, type SbxSession } from "../src/sandbox";

const mockSession: SbxSession = {
	runtime: { kind: "docker", bin: "docker", run: async () => "", stop: () => {}, remove: () => {}, exists: async () => false, isRunning: async () => false, start: async () => false, createVolume: async () => false },
	name: "test-container",
	hostCwd: "/tmp/test",
	keep: false,
	mounts: [],
	allowedExternalPrefixes: [],
	imageRef: "pi-sandbox:latest",
	config: { image: "pi-sandbox", tag: "latest", containerName: null, tier: "medium", persist: false, cacheVolume: null },
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

- [ ] **Step 5: Run tests — verify pass**

```bash
npx vitest run
```
Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/sandbox.ts tests/sandbox.test.ts
git commit -m "feat: add sandbox session module with tests"
```

---

### Task 9: Command Handlers

**Files:**
- Create: `src/commands/sandbox.ts`

- [ ] **Step 1: Write src/commands/sandbox.ts (UI-dependent, verify via typecheck)**

```typescript
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { TIER_SPECS, type SizeTier } from "../tiers";
import { loadSbxConfig, saveSbxConfig, imageRefForTag, getSbxConfigPath } from "../config";
import { execCapture } from "../ops";
import { getSbx } from "../sandbox";

export function createSandboxCommandHandlers(localCwd: string, pathApprovals: {
	list(): { path: string; approvedAt: number; expiresAt: number }[];
	revoke(p: string): boolean;
	add(p: string, days: number | typeof Infinity): void;
	find(p: string): { path: string; approvedAt: number; expiresAt: number } | undefined;
}) {
	return {
		status: async (_args: string, ctx: { ui: { notify: (msg: string, level: string) => void } }) => {
			const sbx = getSbx();
			if (!sbx) {
				const cfg = loadSbxConfig(localCwd);
				ctx.ui.notify(
					`Sandbox is not active. Start pi with --container.\nconfigured image: ${imageRefForTag(cfg.image, cfg.tag)}`,
					"info",
				);
				return;
			}
			const info = (await execCapture(sbx, "id; uname -a; df -h /workspace | tail -1")).toString();
			const resParts: string[] = [];
			if (sbx.resources?.memory) resParts.push(`memory: ${sbx.resources.memory}`);
			if (sbx.resources?.cpus) resParts.push(`cpus: ${sbx.resources.cpus}`);
			if (sbx.resources?.swap !== undefined) resParts.push(`swap: ${sbx.resources.swap}`);
			if (sbx.resources?.pidsLimit !== undefined) resParts.push(`pids-limit: ${sbx.resources.pidsLimit}`);
			const resStr = resParts.length ? `\nresources: ${resParts.join(", ")}` : "";
			const reusableStr = sbx.isReusable ? ` [re-usable${sbx.isReattached ? ", reattached" : ""}]` : "";
			ctx.ui.notify(
				[
					`Sandbox: ${sbx.runtime.kind} container ${sbx.name}${reusableStr}`,
					`host cwd: ${sbx.hostCwd}`,
					`image: ${sbx.imageRef}`,
					resStr.trim(),
					info.trimEnd(),
				].filter(Boolean).join("\n"),
				"info",
			);
		},

		start: async (_args: string, ctx: { ui: { notify: (msg: string, level: string) => void } }) => {
			ctx.ui.notify("/sandbox start requires sandbox initialization via session start. Restart pi with --container.", "info");
		},

		stop: async (_args: string, ctx: { ui: { notify: (msg: string, level: string) => void } }) => {
			const sbx = getSbx();
			if (!sbx) {
				ctx.ui.notify("Sandbox is not active.", "info");
				return;
			}
			sbx.runtime.stop(sbx.name);
			sbx.runtime.remove(sbx.name);
			ctx.ui.notify(`Sandbox ${sbx.name} stopped and removed.`, "info");
		},

		keep: async (args: string, ctx: { ui: { notify: (msg: string, level: string) => void } }) => {
			const sbx = getSbx();
			if (!sbx) {
				ctx.ui.notify("Sandbox is not active.", "info");
				return;
			}
			const name = args.trim() || sbx.name;
			const cfg = loadSbxConfig(sbx.hostCwd);
			cfg.containerName = name;
			saveSbxConfig(sbx.hostCwd, cfg);
			ctx.ui.notify(`Sandbox container "${name}" saved to sandbox.json. It will be reused next session.`, "info");
		},

		exec: async (args: string, ctx: { ui: { notify: (msg: string, level: string) => void } }) => {
			const sbx = getSbx();
			if (!sbx) {
				ctx.ui.notify("Sandbox is not active.", "info");
				return;
			}
			if (!args.trim()) {
				ctx.ui.notify("Usage: /sandbox exec <command>", "info");
				return;
			}
			try {
				const stdout = (await execCapture(sbx, args.trim(), 30000)).toString();
				ctx.ui.notify(`$ ${args.trim()}\n${stdout}`, "info");
			} catch (e) {
				ctx.ui.notify(`exec failed: ${e instanceof Error ? e.message : String(e)}`, "error");
			}
		},

		doctor: async (_args: string, ctx: { ui: { notify: (msg: string, level: string) => void } }) => {
			const sbx = getSbx();
			if (!sbx) {
				ctx.ui.notify("Sandbox is not active. Start pi with --container.", "info");
				return;
			}
			const script = [
				"set -u",
				'for cmd in sh bash git rg fd bat eza jq yq ast-grep uv python python3 bun bunx node npm chromium; do',
				'  if command -v $cmd >/dev/null 2>&1; then printf "ok   %s -> %s\\n" $cmd $(command -v $cmd); else printf "MISS %s\\n" $cmd; fi',
				"done",
				"echo",
				'bun --version 2>&1 | sed "s/^/bun: /"',
				'node --version 2>&1 | sed "s/^/node: /"',
				'npm --version 2>&1 | sed "s/^/npm: /"',
				'python --version 2>&1 | sed "s/^/python: /"',
				'uv --version 2>&1 | sed "s/^/uv: /"',
				'chromium --version 2>&1 | sed "s/^/chromium: /"',
				"echo",
				'ldd $(command -v node) | sed "s/^/node ldd: /"',
			].join("\n");
			const out = (await execCapture(sbx, script, 20000)).toString();
			ctx.ui.notify(`Sandbox doctor:\n${out}`, "info");
		},

		config: async (_args: string, ctx: { ui: { notify: (msg: string, level: string) => void } }) => {
			const sbx = getSbx();
			const hostCwd = sbx?.hostCwd ?? localCwd;
			const cfg = loadSbxConfig(hostCwd);
			const imageRef = imageRefForTag(cfg.image, cfg.tag);
			const configPath = getSbxConfigPath(hostCwd);
			const lines: string[] = [
				"Sandbox project config (.pi/agent/sandbox.json):",
				`  Image:   ${imageRef}`,
				`  Tier:    ${cfg.tier}`,
				`  Name:    ${cfg.containerName ?? "(auto)"}`,
				`  Persist: ${cfg.persist ? "yes" : "no"}`,
				`  Cache:   ${cfg.cacheVolume ?? "(none)"}`,
				"",
				`Config file: ${existsSync(configPath) ? configPath : "(not yet created)"}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},

		allow: async (raw: string, ctx: { ui: { notify: (msg: string, level: string) => void } }) => {
			const sbx = getSbx();
			if (!sbx) {
				ctx.ui.notify("Sandbox is not active.", "info");
				return;
			}
			if (!raw) {
				ctx.ui.notify("Usage: /sandbox allow <host-path>\nAdds a host path prefix for read access from the sandbox.", "info");
				return;
			}
			const abs = raw.startsWith("~") ? resolvePath(homedir(), raw.slice(1)) : resolvePath(raw);
			if (sbx.allowedExternalPrefixes.includes(abs)) {
				ctx.ui.notify(`Path ${abs} is already allowed.`, "info");
				return;
			}
			if (!existsSync(abs)) {
				ctx.ui.notify(`Path ${abs} does not exist on host.`, "warning");
				return;
			}
			sbx.allowedExternalPrefixes.push(abs);
			ctx.ui.notify(`Sandbox: read access now allowed for ${abs}`, "info");
		},

		paths: async (args: string, ctx: { ui: { notify: (msg: string, level: string) => void } }) => {
			const parts = args.trim().split(/\s+/);
			if (parts[0] === "revoke" && parts[1]) {
				const target = parts.slice(1).join(" ");
				const abs = target.startsWith("~") ? resolvePath(homedir(), target.slice(1)) : resolvePath(target);
				if (pathApprovals.revoke(abs)) {
					ctx.ui.notify(`Revoked path approval: ${abs}`, "info");
				} else {
					ctx.ui.notify(`No approval found for: ${abs}`, "warning");
				}
				return;
			}
			const records = pathApprovals.list();
			if (records.length === 0) {
				ctx.ui.notify("No persisted path approvals. External reads will prompt interactively.", "info");
				return;
			}
			const lines = records.map((r) => {
				const expiry = r.expiresAt === Infinity ? "always" : `expires ${new Date(r.expiresAt).toISOString()}`;
				return `  ${r.path} (${expiry})`;
			});
			ctx.ui.notify(
				[`Persisted path approvals (${records.length}):`, ...lines, "", "Use /sandbox paths revoke <path> to revoke an approval."].join("\n"),
				"info",
			);
		},

		tiers: async (args: string, ctx: { ui: { notify: (msg: string, level: string) => void } }) => {
			const parts = args.trim().split(/\s+/);
			if (parts[0] === "set" && parts[1]) {
				const tier = parts[1] as SizeTier;
				if (!(tier in TIER_SPECS)) {
					ctx.ui.notify(`Unknown tier: ${tier}. Use: small, medium, large`, "warning");
					return;
				}
				const sbx = getSbx();
				const hostCwd = sbx?.hostCwd ?? localCwd;
				const cfg = loadSbxConfig(hostCwd);
				cfg.tier = tier;
				saveSbxConfig(hostCwd, cfg);
				ctx.ui.notify(`Tier set to ${tier} (mem=${TIER_SPECS[tier].memory}, cpu=${TIER_SPECS[tier].cpus}). Restart pi to apply.`, "info");
				return;
			}
			const lines = ["Available tiers:", ""];
			for (const [name, spec] of Object.entries(TIER_SPECS)) {
				lines.push(`  ${name}: mem=${spec.memory}, cpu=${spec.cpus}, swap=${spec.swap}`);
			}
			lines.push("", "Use /sandbox tiers set <name> to switch.");
			ctx.ui.notify(lines.join("\n"), "info");
		},
	};
}
```

- [ ] **Step 2: Verify typecheck**

```bash
npx tsc --noEmit
```
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/commands/sandbox.ts
git commit -m "feat: add sandbox command handlers"
```

---

### Task 10: Extension Entry Point

**Files:**
- Create: `index.ts`

- [ ] **Step 1: Write index.ts**

```typescript
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
import { detectRuntime, deriveContainerName, spawnWithTimeout } from "./src/runtime";
import { loadSbxConfig, imageRefForTag } from "./src/config";
import { TIER_SPECS, parseSizeTier } from "./src/tiers";
import { getSbx, setSbx, clearSbx, type SbxSession } from "./src/sandbox";
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

export default function (pi: ExtensionAPI) {
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
	pi.registerFlag("container-size", {
		description: "Sandbox size tier: small, medium, large (default: medium)",
		type: "string",
		default: "medium",
	});
	pi.registerFlag("sandbox-name", {
		description: "Re-usable sandbox name. If container exists, reattaches; otherwise creates new.",
		type: "string",
	});
	pi.registerFlag("sandbox-persist", {
		description: "Keep sandbox container running after pi exits",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("sandbox-cache", {
		description: "Docker volume name for persistent cache at /cache",
		type: "string",
	});
	pi.registerFlag("container-image", {
		description: "Image to use for the sandbox (default: pi-container-sandbox:latest)",
		type: "string",
	});
	pi.registerFlag("container-net", {
		description: "Allow outbound network from the sandbox (default: on)",
		type: "boolean",
		default: true,
	});
	pi.registerFlag("no-container-net", {
		description: "Disable container networking",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("container-keep", {
		description: "Don't stop the sandbox container when pi exits",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("container-mount-skills", {
		description: "Mount agent skill directories read-only into the container at /skills (default: on)",
		type: "boolean",
		default: true,
	});
	pi.registerFlag("container-mount-paths", {
		description: "Comma-separated list of additional host directories to mount read-only",
		type: "string",
	});
	pi.registerFlag("container-allow-paths", {
		description: "Comma-separated list of host path prefixes to allow for read access from outside the sandbox",
		type: "string",
	});
	pi.registerFlag("container-memory", {
		description: "Memory limit for the container (e.g., 2g, 512m)",
		type: "string",
	});
	pi.registerFlag("container-cpus", {
		description: "CPU limit for the container (e.g., 2, 0.5)",
		type: "string",
	});
	pi.registerFlag("container-swap", {
		description: "Swap limit for the container (e.g., 1g, 0 to disable)",
		type: "string",
	});
	pi.registerFlag("container-pids-limit", {
		description: "Maximum number of PIDs the container can create. Default: 512",
		type: "string",
	});

	const localCwd = process.cwd();
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd);

	const pathApprovals = new PathApprovalStore(localCwd);
	const handlers = createSandboxCommandHandlers(localCwd, pathApprovals);

	async function guardExternalRead(
		paramsPath: string,
		sbx: SbxSession,
		ctx: { ui: ExtensionUIContext; hasUI: boolean },
	): Promise<void> {
		const external = getExternalPath(paramsPath, sbx.hostCwd, sbx.mounts);
		if (!external) return;
		if (isAllowedExternalResource(external, sbx.allowedExternalPrefixes)) return;
		if (!ctx.hasUI) {
			throw new Error(
				`sandbox: refusing to access ${external}: outside of project cwd ${sbx.hostCwd}. ` +
				`Use --container-allow-paths or /sandbox allow to grant access.`,
			);
		}
		await ensureExternalReadApproved(external, sbx.allowedExternalPrefixes, pathApprovals, ctx.ui);
	}

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, _ctx) {
			const sbx = getSbx();
			if (!sbx) return localRead.execute(id, params, signal, onUpdate);
			await guardExternalRead(params.path, sbx, _ctx);
			const tool = createReadTool(localCwd, { operations: createReadOps(sbx) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, _ctx) {
			const sbx = getSbx();
			if (!sbx) return localWrite.execute(id, params, signal, onUpdate);
			const tool = createWriteTool(localCwd, { operations: createWriteOps(sbx) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, _ctx) {
			const sbx = getSbx();
			if (!sbx) return localEdit.execute(id, params, signal, onUpdate);
			const tool = createEditTool(localCwd, { operations: createEditOps(sbx) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localBash,
		label: "bash (sandboxed)",
		async execute(id, params, signal, onUpdate, _ctx) {
			const sbx = getSbx();
			if (!sbx) return localBash.execute(id, params, signal, onUpdate);
			const tool = createBashTool(localCwd, { operations: createBashOps(sbx) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.on("user_bash", () => {
		const sbx = getSbx();
		if (!sbx) return;
		return { operations: createBashOps(sbx) };
	});

	pi.on("before_agent_start", async (event) => {
		const sbx = getSbx();
		if (!sbx) return;

		const skillInfo = sbx.mounts.length
			? `Agent skills are mounted read-only at /skills/ (e.g. ${sbx.mounts.map((m) => m.target).join(", ")}). Read skill files via /skills/<name>/SKILL.md. Writing to /skills/ is forbidden.`
			: "No skill directories are mounted.";

		return {
			systemPrompt: event.systemPrompt.replace(
				`Current working directory: ${localCwd}`,
				[
					`Current working directory: ${REMOTE_ROOT} (sandboxed in ${sbx.runtime.kind} container ${sbx.name}, host cwd ${localCwd} mounted read-write)`,
					skillInfo,
				].join("\n"),
			),
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		if ((pi.getFlag("no-container") as boolean) || (pi.getFlag("noc") as boolean)) return;
		if (!(pi.getFlag("container") as boolean)) return;

		try {
			const runtime = await detectRuntime(ctx);
			if (!runtime) {
				ctx.ui.notify("Docker not available or timed out. Running without sandbox.", "warning");
				return;
			}

			const cfg = loadSbxConfig(localCwd);

			const sizeFlag = pi.getFlag("container-size") as string | undefined;
			const sizeTier = parseSizeTier(sizeFlag || cfg.tier) || "medium";
			const tierSpec = TIER_SPECS[sizeTier];

			const flagImage = pi.getFlag("container-image") as string | undefined;
			const configImageRef = imageRefForTag(cfg.image, cfg.tag);
			const image = flagImage || configImageRef || "pi-container-sandbox:latest";

			const allowNetwork = (pi.getFlag("container-net") as boolean) && !(pi.getFlag("no-container-net") as boolean);
			const keep = pi.getFlag("container-keep") as boolean;
			const persist = pi.getFlag("sandbox-persist") as boolean || cfg.persist;
			const mountSkills = pi.getFlag("container-mount-skills") as boolean;
			const extraPathsRaw = pi.getFlag("container-mount-paths") as string | undefined;
			const extraPaths = extraPathsRaw ? extraPathsRaw.split(",").map((p: string) => p.trim()).filter(Boolean) : undefined;

			const nameFlag = pi.getFlag("sandbox-name") as string | undefined;
			const sandboxName = nameFlag || cfg.containerName || deriveContainerName(localCwd);
			const isReusable = !!(nameFlag || cfg.containerName);

			const cacheFlag = pi.getFlag("sandbox-cache") as string | undefined;
			const cacheVolume = cacheFlag || cfg.cacheVolume;

			if (cacheVolume) {
				await runtime.createVolume(cacheVolume);
			}

			const skillMounts = mountSkills ? discoverSkillMounts(extraPaths) : [];

			let isReattached = false;
			{
				const running = await runtime.isRunning(sandboxName);
				if (running) {
					isReattached = true;
					ctx.ui.notify(`Reattaching to existing sandbox: ${sandboxName}`, "info");
				} else {
					const inspect = await spawnWithTimeout(
						runtime.bin, ["inspect", "--format", "exists", sandboxName], 5000,
					);
					if (inspect.code === 0 && !inspect.timedOut) {
						if (isReusable || persist) {
							const started = await runtime.start(sandboxName);
							if (started) {
								isReattached = true;
								ctx.ui.notify(`Restarted existing sandbox: ${sandboxName}`, "info");
							} else {
								ctx.ui.notify(`Removing broken container ${sandboxName}, creating fresh...`, "warning");
								runtime.remove(sandboxName);
							}
						} else {
							ctx.ui.notify(`Cleaning up stale container ${sandboxName} for fresh sandbox`, "info");
							runtime.remove(sandboxName);
						}
					}
				}
			}

			if (!(await runtime.exists(image))) {
				ctx.ui.notify(
					`Sandbox image "${image}" not found locally.\nBuild it with: npm run build-image`,
					"error",
				);
				return;
			}

			const allowPathsRaw = pi.getFlag("container-allow-paths") as string | undefined;
			const allowedExternalPrefixes = allowPathsRaw
				? allowPathsRaw.split(",").map((p: string) => p.trim()).filter(Boolean).map((p: string) =>
					p.startsWith("~") ? resolvePath(homedir(), p.slice(1)) : resolvePath(p)
				)
				: [];

			const resources = {
				memory: tierSpec.memory,
				cpus: tierSpec.cpus,
				swap: tierSpec.swap,
			};

			const memFlag = pi.getFlag("container-memory") as string | undefined;
			const cpusFlag = pi.getFlag("container-cpus") as string | undefined;
			const pidsFlagRaw = pi.getFlag("container-pids-limit") as string | undefined;
			const pidsFlag = pidsFlagRaw ? parseInt(pidsFlagRaw, 10) : undefined;
			const swapFlag = pi.getFlag("container-swap") as string | undefined;
			if (memFlag) resources.memory = memFlag;
			if (cpusFlag) resources.cpus = cpusFlag;
			if (pidsFlag !== undefined) resources.pidsLimit = pidsFlag;
			if (swapFlag !== undefined) resources.swap = swapFlag;

			let actualName = sandboxName;
			if (!isReattached) {
				actualName = await runtime.run({
					name: sandboxName,
					image,
					hostCwd: localCwd,
					allowNetwork,
					extraMounts: skillMounts.length ? skillMounts : undefined,
					resources,
					cacheVolume,
				});
			}

			setSbx({
				runtime,
				name: actualName,
				hostCwd: localCwd,
				keep: keep || persist,
				mounts: skillMounts,
				allowedExternalPrefixes,
				resources,
				imageRef: image,
				config: cfg,
				isReusable,
				isReattached,
			});

			const cleanup = () => {
				const s = getSbx();
				if (!s || s.keep) return;
				try {
					s.runtime.stop(s.name);
					s.runtime.remove(s.name);
				} catch { /* ignore */ }
				clearSbx();
			};
			process.once("exit", cleanup);
			process.once("SIGINT", () => { cleanup(); process.exit(130); });
			process.once("SIGTERM", () => { cleanup(); process.exit(143); });

			const ok = (await execCapture(getSbx()!, "id -un && pwd", 10000)).toString().trim();

			const resParts: string[] = [
				`size=${sizeTier}`,
				`mem=${resources.memory}`,
				`cpu=${resources.cpus}`,
				`swap=${resources.swap}`,
			];
			if (resources.pidsLimit !== undefined) resParts.push(`pids=${resources.pidsLimit}`);
			const resStr = ` (${resParts.join(", ")})`;

			const statusPrefix = isReattached ? "Reattached" : "Sandbox up";
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
				].filter(Boolean).join("\n"),
				"info",
			);
		} catch (e) {
			clearSbx();
			ctx.ui.notify(`Sandbox init failed: ${e instanceof Error ? e.message : String(e)}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		const sbx = getSbx();
		if (!sbx) return;
		if (!sbx.keep) {
			sbx.runtime.stop(sbx.name);
			sbx.runtime.remove(sbx.name);
		}
		clearSbx();
	});

	pi.registerCommand("sandbox", {
		description: "Sandbox management. Subcommands: status, start, stop, keep, exec, doctor, config, allow, paths, tiers",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0]?.toLowerCase() || "status";
			const rest = parts.slice(1).join(" ");

			switch (sub) {
				case "status":
				case "info":
					return handlers.status(rest, ctx);
				case "start":
					return handlers.start(rest, ctx);
				case "stop":
					return handlers.stop(rest, ctx);
				case "keep":
					return handlers.keep(rest, ctx);
				case "exec":
					return handlers.exec(rest, ctx);
				case "doctor":
				case "check":
					return handlers.doctor(rest, ctx);
				case "config":
				case "settings":
					return handlers.config(rest, ctx);
				case "allow":
					return handlers.allow(rest, ctx);
				case "paths":
					return handlers.paths(rest, ctx);
				case "tiers":
					return handlers.tiers(rest, ctx);
				default:
					ctx.ui.notify(
						[
							`Unknown subcommand: ${sub}`,
							"Available: status, start, stop, keep, exec, doctor, config, allow, paths, tiers",
						].join("\n"),
						"info",
					);
			}
		},
	});
}
```

- [ ] **Step 2: Verify typecheck**

```bash
npx tsc --noEmit
```
Expected: PASS

- [ ] **Step 3: Run full test suite**

```bash
npx vitest run
```
Expected: all tests PASS

- [ ] **Step 4: Commit**

```bash
git add index.ts
git commit -m "feat: add extension entry point"
```

---

### Task 11: Dockerfile Update

**Files:**
- Modify: `docker/Dockerfile`

- [ ] **Step 1: Update build comment at top of Dockerfile**

Replace lines 10-12 in `docker/Dockerfile`:
```
# Built with either:
#   docker build -t pi-container-sandbox:latest -f docker/Dockerfile docker
#   container build -t pi-container-sandbox:latest -f docker/Dockerfile docker
```
With:
```dockerfile
# Built with:
#   npm run build-image
#   docker build -t pi-container-sandbox:latest -f docker/Dockerfile docker
```

- [ ] **Step 2: Commit**

```bash
git add docker/Dockerfile
git commit -m "chore: update Dockerfile build comment"
```

---

### Task 12: Final Verification

- [ ] **Step 1: Run full test suite**

```bash
npx vitest run
```
Expected: all tests PASS

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```
Expected: PASS, no errors

- [ ] **Step 3: Verify file structure**

```bash
find . -name "*.ts" -not -path "./node_modules/*" | sort
```
Expected:
```
./index.ts
./src/commands/sandbox.ts
./src/config.ts
./src/ops.ts
./src/paths.ts
./src/runtime.ts
./src/sandbox.ts
./src/skills.ts
./src/tiers.ts
./tests/config.test.ts
./tests/paths.test.ts
./tests/runtime.test.ts
./tests/sandbox.test.ts
./tests/tiers.test.ts
./vitest.config.ts
```

- [ ] **Step 4: Build image**

```bash
npm run build-image
```
Expected: Image builds successfully

- [ ] **Step 5: Final commit**

```bash
git status
git add -A
git commit -m "chore: final verification - all tests pass, typecheck clean"
```
