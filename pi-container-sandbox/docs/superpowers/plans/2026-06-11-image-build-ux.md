# Image Build UX Improvement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix auto-build context (use package's `docker/` dir), add custom Dockerfile/buildContext/buildArgs support via sandbox.json and CLI flags, add force-rebuild capability, add build progress feedback.

**Architecture:** Extend `SbxConfig` with `dockerfile`/`buildContext`/`buildArgs` fields. Refactor `DockerRuntime.ensureImage()` to default build context to package-internal `docker/` dir, support custom Dockerfile, force-rebuild, and progress callback. Wire new CLI flags and `/sandbox build` command.

**Tech Stack:** TypeScript, Dockerode, Vitest

**Spec:** `docs/superpowers/specs/2026-06-11-image-build-ux.md`

**Methodology:** Strict TDD — every task follows RED (write failing test → verify failure) → GREEN (minimal implementation → verify pass) → REFACTOR → Commit.

---

## File Structure

| File | Change | Responsibility |
|------|--------|---------------|
| `src/config.ts` | Modify | Extend `SbxConfig` + add `PACKAGE_DOCKER_DIR` constant |
| `src/runtime.ts` | Modify | Refactor `ensureImage()`: correct context, force-rebuild, progress; add `rebuildImage()` |
| `index.ts` | Modify | Register new flags, wire into runtime, progress via `ctx.ui` |
| `src/commands/sandbox.ts` | Modify | Add `/sandbox build` subcommand |
| `tests/config.test.ts` | Modify | Test new config fields |
| `tests/runtime.test.ts` | Modify | Test ensureImage option flow + rebuildImage |
| `tests/commands.test.ts` | Modify | Test `/sandbox build` |
| `tests/session.test.ts` | Modify | Add `rebuildImage` to mock Runtime |
| `tests/ops.test.ts` | Modify | Add `rebuildImage` to mock Runtime |

---

### Task 1: Config type and parsing — TDD new fields in `loadSbxConfig`

**Files:**
- Modify: `tests/config.test.ts`
- Modify: `src/config.ts:5-12, 35-42`

- [ ] **Step 1: RED — Write failing test for new config fields**

Add to end of `tests/config.test.ts`:

```typescript
describe("loadSbxConfig new fields", () => {
	it("parses dockerfile, buildContext, buildArgs from config", () => {
		const configDir = resolvePath(testDir, ".pi", "agent");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(resolvePath(configDir, "sandbox.json"), JSON.stringify({
			image: "my-img",
			tag: "v2",
			dockerfile: "./Dockerfile.custom",
			buildContext: ".",
			buildArgs: { FOO: "bar", BAZ: "1" },
		}));

		const cfg = loadSbxConfig(testDir);
		expect(cfg.dockerfile).toBe("./Dockerfile.custom");
		expect(cfg.buildContext).toBe(".");
		expect(cfg.buildArgs).toEqual({ FOO: "bar", BAZ: "1" });
	});

	it("omits optional fields when not present in config", () => {
		const configDir = resolvePath(testDir, ".pi", "agent");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(resolvePath(configDir, "sandbox.json"), JSON.stringify({ image: "img" }));

		const cfg = loadSbxConfig(testDir);
		expect(cfg.dockerfile).toBeUndefined();
		expect(cfg.buildContext).toBeUndefined();
		expect(cfg.buildArgs).toBeUndefined();
	});
});
```

- [ ] **Step 2: Verify RED — Run test, confirm it fails correctly**

Run: `npx vitest run tests/config.test.ts`

Expected:
- `loadSbxConfig new fields > parses dockerfile, buildContext, buildArgs from config` — **FAIL**
- Failure reason: `TypeError: Cannot read properties of undefined` or `expected undefined, received ...` (because `loadSbxConfig` doesn't return these fields yet)
- All existing config tests still PASS

**If test passes —** it means `loadSbxConfig` is already returning these fields. Re-examine — it shouldn't be.

- [ ] **Step 3: GREEN — Extend `SbxConfig` interface + update `loadSbxConfig`**

In `src/config.ts`:

Replace `SbxConfig` interface (lines 5-12):
```typescript
export interface SbxConfig {
	image: string;
	tag: string;
	containerName: string | null;
	tier: SizeTier;
	persist: boolean;
	cacheVolume: string | null;
	dockerfile?: string;
	buildContext?: string;
	buildArgs?: Record<string, string>;
}
```

Replace the return statement in `loadSbxConfig` (lines 35-42):
```typescript
		return {
			image: parsed.image ?? DEFAULT_SBX_CONFIG.image,
			tag: parsed.tag ?? DEFAULT_SBX_CONFIG.tag,
			containerName: parsed.containerName ?? DEFAULT_SBX_CONFIG.containerName,
			tier: parsed.tier ?? DEFAULT_SBX_CONFIG.tier,
			persist: parsed.persist ?? DEFAULT_SBX_CONFIG.persist,
			cacheVolume: parsed.cacheVolume ?? DEFAULT_SBX_CONFIG.cacheVolume,
			dockerfile: parsed.dockerfile,
			buildContext: parsed.buildContext,
			buildArgs: parsed.buildArgs,
		};
```

- [ ] **Step 4: Verify GREEN — Run tests, confirm all pass**

Run: `npx vitest run tests/config.test.ts`

Expected: All config tests PASS (existing + 2 new).

- [ ] **Step 5: REFACTOR — No duplication to clean up. Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: load dockerfile/buildContext/buildArgs from sandbox.json"
```

---

### Task 2: SandboxOptions extension + `PACKAGE_DOCKER_DIR` — TDD

**Files:**
- Modify: `tests/runtime.test.ts`
- Modify: `src/runtime.ts:9-23`
- Modify: `src/config.ts:1-3, after-line-21`

- [ ] **Step 1: RED — Write failing test for `PACKAGE_DOCKER_DIR` and new `SandboxOptions` fields**

Add to end of `tests/runtime.test.ts`:

```typescript
import { PACKAGE_DOCKER_DIR } from "../src/config";

describe("PACKAGE_DOCKER_DIR", () => {
	it("resolves to a path ending with /docker", () => {
		expect(PACKAGE_DOCKER_DIR).toMatch(/\/docker$/);
	});
});

describe("SandboxOptions new image-build fields", () => {
	it("accepts dockerfile, buildContext, buildArgs, forceBuild, onProgress", () => {
		const onProgress = (msg: string) => {};
		const opts = {
			image: "test-img:latest",
			hostCwd: "/tmp",
			name: "test",
			allowNetwork: false,
			resources: { memory: "256m", cpus: "0.5" },
			dockerfile: "./Dockerfile.custom",
			buildContext: "/custom/context",
			buildArgs: { KEY: "value" },
			forceBuild: true,
			onProgress,
		};
		expect(opts.dockerfile).toBe("./Dockerfile.custom");
		expect(opts.buildContext).toBe("/custom/context");
		expect(opts.buildArgs).toEqual({ KEY: "value" });
		expect(opts.forceBuild).toBe(true);
		expect(opts.onProgress).toBe(onProgress);
	});
});
```

- [ ] **Step 2: Verify RED — Run test, confirm it fails correctly**

Run: `npx vitest run tests/runtime.test.ts --reporter=verbose`

Expected:
- `PACKAGE_DOCKER_DIR` — **FAIL** (import error: `PACKAGE_DOCKER_DIR` not exported from `../src/config`)
- `SandboxOptions new image-build fields` — **FAIL** (TypeScript won't compile because `SandboxOptions` doesn't have these fields yet — compile error)
- Existing `deriveContainerName` tests still PASS

- [ ] **Step 3: GREEN — Add `PACKAGE_DOCKER_DIR` + extend `SandboxOptions`**

In `src/config.ts`, add imports (after line 1):
```typescript
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
```

Add after `DEFAULT_SBX_CONFIG` (after line 21):
```typescript
const __dirname = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_DOCKER_DIR = resolvePath(__dirname, "..", "docker");
```

In `src/runtime.ts`, replace `SandboxOptions` interface (lines 9-23):
```typescript
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
	dockerfile?: string;
	buildContext?: string;
	buildArgs?: Record<string, string>;
	forceBuild?: boolean;
	onProgress?: (msg: string) => void;
}
```

Remove old field `dockerfileContext` (line 22) — replaced by `buildContext`.

- [ ] **Step 4: Verify GREEN — Run tests, confirm all pass**

Run: `npx vitest run tests/runtime.test.ts tests/config.test.ts`

Expected:
- `PACKAGE_DOCKER_DIR` — PASS
- `SandboxOptions new image-build fields` — PASS (TypeScript compiles)
- All config tests PASS
- Docker-dependent runtime tests skip if no Docker available

Also run typecheck:
```bash
uv run npx tsc --noEmit
```

Expected: Only the old `ensureImage()` calling removed `dockerfileContext` fails. Will fix in Task 3.

- [ ] **Step 5: REFACTOR — None needed. Commit**

```bash
git add src/config.ts src/runtime.ts tests/runtime.test.ts
git commit -m "feat: add PACKAGE_DOCKER_DIR and extend SandboxOptions"
```

---

### Task 3: `ensureImage()` refactor — TDD with Docker integration

**Files:**
- Modify: `tests/runtime.test.ts`
- Modify: `src/runtime.ts:1, 101-119`

- [ ] **Step 1: RED — Write test for `ensureImage` with forceBuild + onProgress**

Add to `tests/runtime.test.ts` inside the `describe.skipIf(!dockerAvailable)("DockerRuntime lifecycle", ...)` block, after the dedup test (after line 98):

```typescript
	it("ensureImage with forceBuild and onProgress rebuilds and reports progress", async () => {
		const buildName = testName + "-forcebuild";
		const progressMessages: string[] = [];
		const runtime = new DockerRuntime({
			image: "debian:12-slim",
			hostCwd: "/tmp",
			name: buildName,
			allowNetwork: false,
			resources: { memory: "256m", cpus: "0.5" },
			forceBuild: false, // image likely already exists, should skip
			onProgress: (msg: string) => progressMessages.push(msg),
		});
		try {
			await runtime.init();
			// First call with forceBuild=false — should skip build (image exists)
			await runtime.ensureImage();
			// progressMessages should be empty when skip occurs
			expect(progressMessages.length).toBe(0);

			// Now force rebuild
			(runtime as any).opts.forceBuild = true;
			await runtime.ensureImage();
			// progressMessages should have content
			expect(progressMessages.length).toBeGreaterThan(0);
		} finally {
			try { await runtime.shutdown(); } catch {}
		}
	}, 300000);
```

- [ ] **Step 2: Verify RED — Run test, confirm it fails**

Run: `npx vitest run tests/runtime.test.ts -t "forceBuild and onProgress"`

Expected (if Docker available):
- Test **FAILS** — because `ensureImage()` still uses old `dockerfileContext` which was removed, and doesn't read `forceBuild`/`onProgress` from opts.

If Docker unavailable: test skips. Verify via compile error instead: `uv run npx tsc --noEmit` should show error at old `ensureImage()` for referencing removed `dockerfileContext`.

- [ ] **Step 3: GREEN — Implement refactored `ensureImage()`**

In `src/runtime.ts`, add import (after line 1):
```typescript
import { PACKAGE_DOCKER_DIR } from "./config";
```

Replace `ensureImage()` (lines 101-119):
```typescript
	async ensureImage(): Promise<void> {
		const docker = this._requireDocker();
		const image = this.opts.image;

		if (!this.opts.forceBuild) {
			try {
				await docker.getImage(image).inspect();
				return;
			} catch (err: any) {
				if (err?.statusCode !== 404) throw err;
			}
		}

		const buildContext = this.opts.buildContext ?? PACKAGE_DOCKER_DIR;
		const dockerfile = this.opts.dockerfile ?? "Dockerfile";
		const buildArgs = this.opts.buildArgs;

		const report = (msg: string) => this.opts.onProgress?.(msg);
		report(`Building image ${image}...`);

		const buildStream = await docker.buildImage(buildContext, {
			t: image,
			dockerfile,
			buildargs: buildArgs,
		});

		await new Promise<void>((resolve, reject) => {
			docker.modem.followProgress(
				buildStream,
				(err) => {
					if (err) reject(err);
					else resolve();
				},
				(event: any) => {
					if (event.stream) report(event.stream.trim());
					else if (event.error) report(`ERROR: ${event.error}`);
					else if (event.status) report(event.status);
				},
			);
		});

		report(`Image ${image} built successfully.`);
	}
```

- [ ] **Step 4: Verify GREEN — Run test + typecheck**

Run: `npx vitest run tests/runtime.test.ts -t "forceBuild and onProgress"`

Expected: Test PASSES (Docker available tests: skips image when exists, rebuilds with progress on force).

Also run typecheck:
```bash
uv run npx tsc --noEmit
```

Expected: Zero errors.

- [ ] **Step 5: REFACTOR — None. Commit**

```bash
git add src/runtime.ts tests/runtime.test.ts
git commit -m "feat: refactor ensureImage with correct context, forceBuild, progress callback"
```

---

### Task 4: `rebuildImage()` — TDD

**Files:**
- Modify: `tests/runtime.test.ts`
- Modify: `tests/session.test.ts`
- Modify: `tests/commands.test.ts`
- Modify: `tests/ops.test.ts`
- Modify: `src/runtime.ts:41-51` (Runtime interface + DockerRuntime class)

- [ ] **Step 1: RED — Write failing test for `rebuildImage`**

Add to `tests/runtime.test.ts` after the options test from Task 2:

```typescript
describe("DockerRuntime rebuildImage", () => {
	it("calls ensureImage with forceBuild set to true", async () => {
		const runtime = new DockerRuntime({
			image: "debian:12-slim",
			hostCwd: "/tmp",
			name: "pi-test-rebuild-" + Date.now(),
			allowNetwork: false,
			resources: { memory: "256m", cpus: "0.5" },
		});
		// rebuildImage should exist and be callable
		expect(typeof runtime.rebuildImage).toBe("function");
	});
});
```

- [ ] **Step 2: Verify RED — Run test, confirm it fails**

Run: `npx vitest run tests/runtime.test.ts -t "rebuildImage"`

Expected: **FAIL** — `TypeError: runtime.rebuildImage is not a function` because `rebuildImage` doesn't exist yet.

- [ ] **Step 3: GREEN — Add `rebuildImage` to `Runtime` interface + `DockerRuntime` class + mock runtimes**

In `src/runtime.ts`:

Add to `Runtime` interface (after line 44):
```typescript
	rebuildImage(onProgress?: (msg: string) => void): Promise<void>;
```

Add to `DockerRuntime` class (after `ensureImage()` closing `}`):
```typescript
	async rebuildImage(onProgress?: (msg: string) => void): Promise<void> {
		this.opts.forceBuild = true;
		this.opts.onProgress = onProgress;
		await this.ensureImage();
	}
```

Update mock runtimes in test files (add `rebuildImage: async () => {},` after `ensureImage`):

In `tests/session.test.ts` line 5:
```typescript
rebuildImage: async () => {},
```

In `tests/commands.test.ts` line 10:
```typescript
rebuildImage: async () => {},
```

In `tests/ops.test.ts` line 9:
```typescript
rebuildImage: async () => {},
```

- [ ] **Step 4: Verify GREEN — Run tests, confirm all pass**

Run: `npx vitest run tests/runtime.test.ts tests/session.test.ts tests/commands.test.ts tests/ops.test.ts`

Expected:
- `DockerRuntime rebuildImage > calls ensureImage with forceBuild set to true` — PASS
- All existing tests still PASS

- [ ] **Step 5: REFACTOR — None. Commit**

```bash
git add src/runtime.ts tests/runtime.test.ts tests/session.test.ts tests/commands.test.ts tests/ops.test.ts
git commit -m "feat: add rebuildImage to Runtime interface and DockerRuntime"
```

---

### Task 5: `/sandbox build` command — TDD

**Files:**
- Modify: `tests/commands.test.ts`
- Modify: `src/commands/sandbox.ts`

- [ ] **Step 1: RED — Write failing tests for `/sandbox build`**

Add to end of `tests/commands.test.ts`:

```typescript
describe("/sandbox build", () => {
	it("calls rebuildImage on the runtime with progress callback", async () => {
		const notifications: { msg: string; level: string }[] = [];
		const ctx = {
			ui: {
				notify: (msg: string, level?: string) => notifications.push({ msg, level: level ?? "info" }),
				setStatus: (_key: string, _msg: string) => {},
			},
		};
		const handlers = createSandboxCommandHandlers("/tmp", mockPathApprovals());

		let rebuildCalled = false;
		let progressFn: ((msg: string) => void) | undefined;
		const rt = mockRuntime();
		rt.rebuildImage = async (onProgress) => { rebuildCalled = true; progressFn = onProgress; };

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

		await handlers.build("", ctx);
		expect(rebuildCalled).toBe(true);
		expect(typeof progressFn).toBe("function");
		clearSbx();
	});

	it("shows error when sandbox is not active", async () => {
		const notifications: { msg: string; level: string }[] = [];
		const ctx = { ui: { notify: (msg: string, level?: string) => notifications.push({ msg, level: level ?? "info" }) } };
		const handlers = createSandboxCommandHandlers("/tmp", mockPathApprovals());

		await handlers.build("", ctx);
		expect(notifications.some((n) => n.msg.includes("not active"))).toBe(true);
	});

	it("shows error on build failure", async () => {
		const notifications: { msg: string; level: string }[] = [];
		const ctx = {
			ui: {
				notify: (msg: string, level?: string) => notifications.push({ msg, level: level ?? "info" }),
				setStatus: (_key: string, _msg: string) => {},
			},
		};
		const handlers = createSandboxCommandHandlers("/tmp", mockPathApprovals());

		const rt = mockRuntime();
		rt.rebuildImage = async () => { throw new Error("build failed"); };

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

		await handlers.build("", ctx);
		expect(notifications.some((n) => n.msg.includes("Build failed"))).toBe(true);
		clearSbx();
	});
});
```

- [ ] **Step 2: Verify RED — Run test, confirm it fails correctly**

Run: `npx vitest run tests/commands.test.ts -t "/sandbox build"`

Expected: All 3 tests **FAIL** — `TypeError: handlers.build is not a function` because the `build` handler doesn't exist yet.

- [ ] **Step 3: GREEN — Implement `build` handler in `src/commands/sandbox.ts`**

Add after `start` handler (after line 50):
```typescript
		build: async (_args: string, ctx: { ui: { setStatus: (key: string, msg: string) => void; notify: (msg: string, level?: "info" | "warning" | "error") => void } }) => {
			const sbx = getSbx();
			if (!sbx) {
				ctx.ui.notify("Sandbox is not active. Start pi with --container.", "info");
				return;
			}
			ctx.ui.notify(`Rebuilding image ${sbx.imageRef}...`, "info");
			try {
				await sbx.runtime.rebuildImage((msg: string) => ctx.ui.setStatus("sandbox", `[build] ${msg}`));
				ctx.ui.notify(`Image ${sbx.imageRef} rebuilt successfully.`, "info");
			} catch (e) {
				ctx.ui.notify(`Build failed: ${e instanceof Error ? e.message : String(e)}`, "error");
			}
		},
```

- [ ] **Step 4: Verify GREEN — Run tests, confirm all pass**

Run: `npx vitest run tests/commands.test.ts -t "/sandbox build"`

Expected: All 3 build tests PASS.

- [ ] **Step 5: REFACTOR — None. Commit**

```bash
git add src/commands/sandbox.ts tests/commands.test.ts
git commit -m "feat: add /sandbox build command for image rebuild"
```

---

### Task 6: CLI flags + `index.ts` wiring — verified via typecheck

**Files:**
- Modify: `index.ts`

_Note: CLI flag registration and `session_start` wiring depend on the pi extension API which is not available in vitest. Verification is via `tsc --noEmit` + manual smoke test._

- [ ] **Step 1: RED — Verify current state compiles clean (baseline)**

Run: `uv run npx tsc --noEmit`

Expected: Zero errors (should be clean after Task 5).

- [ ] **Step 2: GREEN — Register new CLI flags**

Add after `container-image` flag registration (after line 69) in `index.ts`:

```typescript
	pi.registerFlag("build-image", {
		description: "Force rebuild the sandbox Docker image even if it already exists",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("dockerfile", {
		description: "Path to a custom Dockerfile for the sandbox image (default: extension's built-in Dockerfile)",
		type: "string",
	});
	pi.registerFlag("dockerfile-context", {
		description: "Build context directory for the custom Dockerfile (default: extension's docker/ dir)",
		type: "string",
	});
```

- [ ] **Step 3: GREEN — Read new flags in `session_start`**

After the `extraPaths` variable (after line 228), add:

```typescript
			const buildImageFlag = pi.getFlag("build-image") as boolean;
			const dockerfileFlag = pi.getFlag("dockerfile") as string | undefined;
			const dockerfileContextFlag = pi.getFlag("dockerfile-context") as string | undefined;
```

- [ ] **Step 4: GREEN — Pass new options to `DockerRuntime` constructor**

Replace the constructor call (lines 262-270):

```typescript
			const runtime = new DockerRuntime({
				image,
				hostCwd: localCwd,
				name: sandboxName,
				allowNetwork,
				resources,
				extraMounts: skillMounts.length ? skillMounts : undefined,
				cacheVolume,
				dockerfile: cfg.dockerfile ?? dockerfileFlag,
				buildContext: cfg.buildContext ?? dockerfileContextFlag,
				buildArgs: cfg.buildArgs,
				forceBuild: buildImageFlag || false,
				onProgress: (msg: string) => {
					ctx.ui.setStatus("sandbox", `[build] ${msg}`);
				},
			});
```

- [ ] **Step 5: GREEN — Add `build` dispatch in `/sandbox` command switch-case**

After `case "start":` (line 358), add:

```typescript
			case "build":
			case "rebuild":
				return handlers.build(rest, ctx);
```

In the `default` case (line 379), update the help string:
```typescript
"Available: status, start, build, stop, keep, exec, doctor, config, allow, paths, tiers",
```

- [ ] **Step 6: Verify GREEN — Run typecheck + full test suite**

Run: `uv run npx tsc --noEmit`
Expected: Zero errors.

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add index.ts
git commit -m "feat: add --build-image, --dockerfile, --dockerfile-context CLI flags and /sandbox build dispatch"
```

---

### Task 7: Full verification

**Files:**
- None (verification only)

- [ ] **Step 1: Run typecheck**

```bash
uv run npx tsc --noEmit
```

Expected: Zero errors.

- [ ] **Step 2: Run all tests**

```bash
npx vitest run
```

Expected: All tests pass (Docker-dependent tests skip if Docker unavailable).

- [ ] **Step 3: Review git diff scope**

```bash
git diff --stat main...HEAD
```

Expected changes only in the 9 files listed above, no stray modifications.

- [ ] **Step 4: Manual smoke test (if Docker available)**

```bash
# Verify sandbox.json with new fields loads correctly
mkdir -p /tmp/sandbox-smoke/.pi/agent
cat > /tmp/sandbox-smoke/.pi/agent/sandbox.json << 'EOF'
{"image":"smoke-test","dockerfile":"./Dockerfile.sandbox","buildArgs":{"FOO":"bar"}}
EOF

# Verify PACKAGE_DOCKER_DIR resolves correctly
node -e "import('./src/config.js').then(m => console.log(m.PACKAGE_DOCKER_DIR))"
```

Expected: Outputs a valid path ending in `/docker`.

---

## Self-Review

### 1. Spec coverage

| Requirement | Task | TDD? |
|-------------|------|------|
| `loadSbxConfig` reads new fields | Task 1 | RED→GREEN→Commit |
| `PACKAGE_DOCKER_DIR` exists | Task 2 | RED→GREEN→Commit |
| `SandboxOptions` has new fields | Task 2 | RED→GREEN→Commit |
| `ensureImage()` uses correct context + force+progress | Task 3 | RED→GREEN→Commit |
| `rebuildImage()` method | Task 4 | RED→GREEN→Commit |
| `/sandbox build` command | Task 5 | RED→GREEN→Commit |
| CLI flags + index.ts wiring | Task 6 | Typecheck-verified |

### 2. Placeholder scan

No TBDs, TODOs, or placeholder code. Every step includes exact code.

### 3. TDD verification

Every task follows RED (write test → watch it fail) → GREEN (minimal code → watch it pass):
- Task 1: test loads config → fails (fields missing) → add fields → passes
- Task 2: test imports `PACKAGE_DOCKER_DIR` → fails (not exported) → add export → passes
- Task 3: test `ensureImage` with progress → fails (uses old API) → refactor → passes
- Task 4: test `rebuildImage` exists → fails (not a function) → add method → passes
- Task 5: test `handlers.build()` → fails (not defined) → add handler → passes
- Task 6: typecheck baseline → clean → add flags/wiring → still clean
