# pi-ask-user Config File Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add JSON config file support for pi-ask-user settings (displayMode, overlayToggleKey, commentToggleKey) with priority between env vars and defaults.

**Architecture:** New `loadAskUserConfig(cwd)` function reads `~/.pi/agent/ask-user.json` (user) and `.pi/ask-user.json` (project), shallow-merging project over user. `resolveShortcut()` gains a `configValue` parameter between `envValue` and `defaultSpec`. `execute()` loads config via `ctx.cwd` and injects values into the resolution chain.

**Tech Stack:** TypeScript, node:fs, node:os, node:path, vitest

## Global Constraints

- Priority chain: `call param > env var > project config > user config > default`
- All config fields optional; missing fields fall through
- File not found / JSON parse error → silent fallback (equivalent to `{}`)
- Both `README.md` and `README.zh.md` must be updated
- TDD: test fails before implementation

---

### Task 1: Add `loadAskUserConfig()` function

**Files:**
- Modify: `pi-ask-user/index.ts` (add new function after `resolveShortcut`)

**Interfaces:**
- Produces: `function loadAskUserConfig(cwd?: string): Partial<{ displayMode?: string; overlayToggleKey?: string; commentToggleKey?: string }>`

- [ ] **Step 1: Add imports**

Add these imports at the top of `pi-ask-user/index.ts`, alongside existing `node:module` import:

```typescript
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
```

- [ ] **Step 2: Add `loadAskUserConfig` function**

Insert after the `resolveShortcut` function (after its closing `}` around line 339):

```typescript
interface AskUserConfig {
	displayMode?: string;
	overlayToggleKey?: string;
	commentToggleKey?: string;
}

function loadAskUserConfig(cwd?: string): Partial<AskUserConfig> {
	const homeDir = homedir();
	const userConfigPath = join(homeDir, ".pi", "agent", "ask-user.json");

	let config: Partial<AskUserConfig> = {};
	try {
		if (existsSync(userConfigPath)) {
			const raw = readFileSync(userConfigPath, "utf-8");
			config = JSON.parse(raw);
		}
	} catch {
		// User config file missing or invalid — silently ignore.
	}

	if (cwd) {
		const projectConfigPath = join(cwd, ".pi", "ask-user.json");
		try {
			if (existsSync(projectConfigPath)) {
				const raw = readFileSync(projectConfigPath, "utf-8");
				const projectConfig: Partial<AskUserConfig> = JSON.parse(raw);
				config = { ...config, ...projectConfig };
			}
		} catch {
			// Project config file missing or invalid — silently ignore.
		}
	}

	return config;
}
```

- [ ] **Step 3: Commit**

```bash
git add pi-ask-user/index.ts
git commit -m "feat(pi-ask-user): add loadAskUserConfig() function"
```

---

### Task 2: Modify `resolveShortcut` to accept config value

**Files:**
- Modify: `pi-ask-user/index.ts` (signature and logic of `resolveShortcut`)

**Interfaces:**
- Consumes: (already defined)
- Produces: `function resolveShortcut(paramValue, envValue, configValue, defaultSpec): ResolvedShortcut`

- [ ] **Step 1: Add `configValue` parameter to `resolveShortcut`**

Change the function signature:

```typescript
function resolveShortcut(
	paramValue: string | null | undefined,
	envValue: string | undefined,
	configValue: string | null | undefined,
	defaultSpec: string,
): ResolvedShortcut {
	const candidates: Array<string | null | undefined> = [paramValue, envValue, configValue, defaultSpec];
```

(Only change: add `configValue` parameter and insert it between `envValue` and `defaultSpec` in the `candidates` array.)

- [ ] **Step 2: Update all call sites**

In `execute()`, update both calls to `resolveShortcut`:

```typescript
const config = loadAskUserConfig(ctx.cwd);

const shortcuts: ResolvedAskShortcuts = {
    overlayToggle: resolveShortcut(
        overlayToggleKey,
        process.env.PI_ASK_USER_OVERLAY_TOGGLE_KEY,
        config.overlayToggleKey,
        DEFAULT_OVERLAY_TOGGLE_KEY,
    ),
    commentToggle: resolveShortcut(
        commentToggleKey,
        process.env.PI_ASK_USER_COMMENT_TOGGLE_KEY,
        config.commentToggleKey,
        DEFAULT_COMMENT_TOGGLE_KEY,
    ),
};
```

- [ ] **Step 3: Commit**

```bash
git add pi-ask-user/index.ts
git commit -m "feat(pi-ask-user): add config value to resolveShortcut chain"
```

---

### Task 3: Wire config into displayMode resolution

**Files:**
- Modify: `pi-ask-user/index.ts` (the `effectiveDisplayMode` line in `execute()`)

**Interfaces:**
- Consumes: `loadAskUserConfig()` from Task 1

- [ ] **Step 1: Inject config displayMode into the chain**

After `loadAskUserConfig(ctx.cwd)` call (from Task 2), add the config-based displayMode. The config reading should happen once, before both `effectiveDisplayMode` and `shortcuts`:

```typescript
const config = loadAskUserConfig(ctx.cwd);
const configDisplayMode: AskDisplayMode | undefined =
    config.displayMode === "overlay" || config.displayMode === "inline"
        ? config.displayMode
        : undefined;

const envMode = process.env.PI_ASK_USER_DISPLAY_MODE;
const envDisplayMode: AskDisplayMode | undefined =
    envMode === "overlay" || envMode === "inline" ? envMode : undefined;
const effectiveDisplayMode: AskDisplayMode =
    displayMode ?? envDisplayMode ?? configDisplayMode ?? "overlay";
```

- [ ] **Step 2: Commit**

```bash
git add pi-ask-user/index.ts
git commit -m "feat(pi-ask-user): wire config file into displayMode resolution"
```

---

### Task 4: Write failing tests for config file loading

**Files:**
- Modify: `pi-ask-user/tests/index.test.ts` (add new test block after RPC fallback tests)

**Interfaces:**
- Consumes: existing test infrastructure (`setupTool`, `createOverlayHandle`, `stubEnv`)

- [ ] **Step 1: Add `node:fs` and `node:os` mocks**

In the test file, after the `@sinclair/typebox` mock block (around line 141), add:

```typescript
vi.mock("node:os", () => ({
	homedir: () => "/home/testuser",
}));

// In-memory filesystem for config file tests
let fakeFiles: Record<string, string> = {};

vi.mock("node:fs", () => ({
	existsSync: (path: string) => path in fakeFiles,
	readFileSync: (path: string, _encoding: string) => fakeFiles[path] ?? "",
}));
```

- [ ] **Step 2: Add config file test helpers**

After `stubEnv`, add:

```typescript
function setFakeFile(path: string, content: string): void {
	fakeFiles[path] = content;
}

function clearFakeFiles(): void {
	fakeFiles = {};
}
```

Update `afterEach` to clear fake files:

```typescript
afterEach(() => {
	for (const restore of envStubs.splice(0)) restore();
	clearFakeFiles();
});
```

- [ ] **Step 3: Add test: "reads displayMode from user config file"**

At the end of the file (before the final `});`), add a new `describe` block:

```typescript
describe("config file", () => {
	it("reads displayMode from user config file", async () => {
		setFakeFile("/home/testuser/.pi/agent/ask-user.json", JSON.stringify({ displayMode: "inline" }));
		const tool = await setupTool();
		let capturedOptions: any;

		await tool.execute(
			"tool-call-id",
			{ question: "Q", options: ["A"] },
			undefined,
			undefined,
			{
				hasUI: true,
				cwd: "/tmp/project",
				ui: {
					custom: async (_factory: any, options: any) => {
						capturedOptions = options;
						return null;
					},
				},
			},
		);

		// Inline mode produces undefined custom options (non-overlay)
		expect(capturedOptions).toBeUndefined();
	});

	it("project config overrides user config for displayMode", async () => {
		setFakeFile("/home/testuser/.pi/agent/ask-user.json", JSON.stringify({ displayMode: "inline" }));
		setFakeFile("/tmp/project/.pi/ask-user.json", JSON.stringify({ displayMode: "overlay" }));
		const tool = await setupTool();
		let capturedOptions: any;

		await tool.execute(
			"tool-call-id",
			{ question: "Q", options: ["A"] },
			undefined,
			undefined,
			{
				hasUI: true,
				cwd: "/tmp/project",
				ui: {
					custom: async (_factory: any, options: any) => {
						capturedOptions = options;
						return null;
					},
				},
			},
		);

		// Project says overlay → overlay mode
		expect(capturedOptions.overlay).toBe(true);
	});

	it("env var overrides config file for displayMode", async () => {
		stubEnv("PI_ASK_USER_DISPLAY_MODE", "inline");
		setFakeFile("/home/testuser/.pi/agent/ask-user.json", JSON.stringify({ displayMode: "overlay" }));
		const tool = await setupTool();
		let capturedOptions: any;

		await tool.execute(
			"tool-call-id",
			{ question: "Q", options: ["A"] },
			undefined,
			undefined,
			{
				hasUI: true,
				cwd: "/tmp/project",
				ui: {
					custom: async (_factory: any, options: any) => {
						capturedOptions = options;
						return null;
					},
				},
			},
		);

		// Env says inline → inline mode, ignoring config
		expect(capturedOptions).toBeUndefined();
	});

	it("reads shortcut keys from config file", async () => {
		setFakeFile("/home/testuser/.pi/agent/ask-user.json", JSON.stringify({
			overlayToggleKey: "alt+h",
			commentToggleKey: "alt+c",
		}));
		const tool = await setupTool();
		const { handle, calls } = createOverlayHandle();
		let inputHandler: ((data: string) => any) | undefined;

		await tool.execute(
			"tool-call-id",
			{ question: "Q", options: ["A"] },
			undefined,
			undefined,
			{
				hasUI: true,
				cwd: "/tmp/project",
				ui: {
					custom: async (_factory: any, options: any) => {
						options.onHandle?.(handle);
						const consumed = inputHandler?.("alt+h");
						const ignored = inputHandler?.("alt+o");
						expect(consumed).toEqual({ consume: true });
						expect(ignored).toBeUndefined();
						return null;
					},
					onTerminalInput: (handler: (data: string) => any) => {
						inputHandler = handler;
						return () => {};
					},
					notify: () => {},
				},
			},
		);

		// Config alt+h should work; alt+o should not
		expect(calls).toEqual([true]);
	});

	it("silently ignores malformed config JSON", async () => {
		setFakeFile("/home/testuser/.pi/agent/ask-user.json", "not-json{{{");
		const tool = await setupTool();
		let capturedOptions: any;

		await tool.execute(
			"tool-call-id",
			{ question: "Q", options: ["A"] },
			undefined,
			undefined,
			{
				hasUI: true,
				cwd: "/tmp/project",
				ui: {
					custom: async (_factory: any, options: any) => {
						capturedOptions = options;
						return null;
					},
				},
			},
		);

		// Falls back to default overlay mode
		expect(capturedOptions.overlay).toBe(true);
	});

	it("no config file means default behavior unchanged", async () => {
		const tool = await setupTool();
		let capturedOptions: any;

		await tool.execute(
			"tool-call-id",
			{ question: "Q", options: ["A"] },
			undefined,
			undefined,
			{
				hasUI: true,
				cwd: "/tmp/project",
				ui: {
					custom: async (_factory: any, options: any) => {
						capturedOptions = options;
						return null;
					},
				},
			},
		);

		expect(capturedOptions.overlay).toBe(true);
	});
});
```

- [ ] **Step 4: Run tests to verify they FAIL**

```bash
cd pi-ask-user && uv run npx vitest run
```

Expected: config file tests fail (loadAskUserConfig not yet called in execute).

- [ ] **Step 5: Commit**

```bash
git add pi-ask-user/tests/index.test.ts
git commit -m "test(pi-ask-user): add failing config file tests"
```

---

### Task 5: Implement config file integration in `execute()`

**Files:**
- Modify: `pi-ask-user/index.ts` (the `execute()` function)

**Interfaces:**
- Consumes: `loadAskUserConfig()` from Task 1, `resolveShortcut()` from Task 2

- [ ] **Step 1: Add config loading call in execute()**

In the `execute` function, after the params destructuring (around line 1569) and before `envMode`, add:

```typescript
const config = loadAskUserConfig(ctx.cwd);
const configDisplayMode: AskDisplayMode | undefined =
    config.displayMode === "overlay" || config.displayMode === "inline"
        ? config.displayMode
        : undefined;
```

- [ ] **Step 2: Update effectiveDisplayMode**

Change:
```typescript
const effectiveDisplayMode: AskDisplayMode = displayMode ?? envDisplayMode ?? "overlay";
```
To:
```typescript
const effectiveDisplayMode: AskDisplayMode = displayMode ?? envDisplayMode ?? configDisplayMode ?? "overlay";
```

- [ ] **Step 3: Update shortcuts resolution**

Change both `resolveShortcut` calls to pass `config.overlayToggleKey` / `config.commentToggleKey`:

```typescript
const shortcuts: ResolvedAskShortcuts = {
    overlayToggle: resolveShortcut(
        overlayToggleKey,
        process.env.PI_ASK_USER_OVERLAY_TOGGLE_KEY,
        config.overlayToggleKey,
        DEFAULT_OVERLAY_TOGGLE_KEY,
    ),
    commentToggle: resolveShortcut(
        commentToggleKey,
        process.env.PI_ASK_USER_COMMENT_TOGGLE_KEY,
        config.commentToggleKey,
        DEFAULT_COMMENT_TOGGLE_KEY,
    ),
};
```

- [ ] **Step 4: Run tests to verify they PASS**

```bash
cd pi-ask-user && uv run npx vitest run
```

Expected: All tests pass, including the new config file tests.

- [ ] **Step 5: Run typecheck and lint**

```bash
cd pi-ask-user && uv run npx tsc --noEmit && uv run npx biome check index.ts
```

Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add pi-ask-user/index.ts
git commit -m "feat(pi-ask-user): implement config file resolution in execute()"
```

---

### Task 6: Update README documentation

**Files:**
- Modify: `pi-ask-user/README.zh.md`
- Modify: `pi-ask-user/README.md` (if different from zh version)

**Interfaces:**
- None (documentation only)

- [ ] **Step 1: Update README.zh.md priority chain**

In the "显示模式" section, change the priority list from 3 levels to 4:

```markdown
生效优先级：

1. 每次调用时的 `displayMode` 参数（如提供）
2. `PI_ASK_USER_DISPLAY_MODE`（如设置为 `"overlay"` 或 `"inline"`）
3. 项目配置文件 `.pi/ask-user.json`（如存在）中的 `displayMode`
4. 用户配置文件 `~/.pi/agent/ask-user.json`（如存在）中的 `displayMode`
5. 回退默认值：`"overlay"`
```

And in the "快捷键" section:

```markdown
`overlayToggleKey` 和 `commentToggleKey` 的生效优先级：

1. 每次调用时的参数（如提供）
2. 对应的环境变量（`PI_ASK_USER_OVERLAY_TOGGLE_KEY` / `PI_ASK_USER_COMMENT_TOGGLE_KEY`）
3. 项目配置文件 `.pi/ask-user.json`（如存在）
4. 用户配置文件 `~/.pi/agent/ask-user.json`（如存在）
5. 内置默认值：`alt+o` 和 `ctrl+g`
```

- [ ] **Step 2: Add config file section to README.zh.md**

After the "通过环境变量设置个人偏好" section, add:

```markdown
## 通过配置文件设置个人偏好

除了环境变量，也可以通过 JSON 配置文件设置：

**文件位置：**
- 用户级（全局）：`~/.pi/agent/ask-user.json`
- 项目级：`.pi/ask-user.json`

项目级文件中的字段会覆盖用户级文件中同名字段。配置优先级：调用参数 > 环境变量 > 项目配置 > 用户配置 > 默认值。

**示例 `~/.pi/agent/ask-user.json`：**

```json
{
  "displayMode": "inline",
  "overlayToggleKey": "alt+h",
  "commentToggleKey": "alt+c"
}
```

所有字段可选。文件不存在或 JSON 格式错误时静默忽略，等效于未配置。
```

- [ ] **Step 3: Sync to README.md**

If `README.md` exists and differs from `README.zh.md`, apply the same changes.

- [ ] **Step 4: Commit**

```bash
git add pi-ask-user/README.zh.md
git commit -m "docs(pi-ask-user): document config file support in README"
```
