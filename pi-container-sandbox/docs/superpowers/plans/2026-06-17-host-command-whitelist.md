# Host Command Whitelist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当 bash 命令名命中 `sandbox.json` 的 `hostCommands` 白名单时，在 host 本地执行而非容器内。

**Architecture:** 在 `index.ts` 的 bash tool execute 中提取命令名，匹配白名单后路由到 `createHostBashOps`（host 执行，含 cwd 映射）或 `createRemoteBashOps`（容器执行）。同时更新 system prompt 告知 LLM 白名单命令应使用相对路径。为对称性重命名 `toRemote` → `hostToRemote`、`createBashOps` → `createRemoteBashOps`。

**Tech Stack:** TypeScript, vitest, Node.js child_process (via `createLocalBashOperations`)

---

### Task 0: Create feature branch

- [ ] **Step 1: Create and checkout feature branch**

```bash
git checkout -b feat/host-command-whitelist
```

Expected: Switched to a new branch 'feat/host-command-whitelist'.

---

### Task 1: Add `hostCommands` to SbxConfig

**Files:**
- Modify: `src/config.ts:7-17`
- Modify: `tests/config.test.ts`

- [ ] **Step 1: Write failing test for `hostCommands` in config**

Append to `tests/config.test.ts`:

```ts
describe("loadSbxConfig hostCommands", () => {
  it("reads hostCommands from config file", () => {
    const configDir = resolvePath(testDir, ".pi", "agent");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(resolvePath(configDir, "sandbox.json"), JSON.stringify({
      image: "my-img",
      hostCommands: ["git", "docker", "npm"],
    }));

    const cfg = loadSbxConfig(testDir);
    expect(cfg.hostCommands).toEqual(["git", "docker", "npm"]);
  });

  it("returns undefined hostCommands when not in config", () => {
    const cfg = loadSbxConfig(testDir);
    expect(cfg.hostCommands).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/config.test.ts
```

Expected: FAIL — `Property 'hostCommands' does not exist on type 'SbxConfig'`.

- [ ] **Step 3: Add `hostCommands` to `SbxConfig` interface**

Edit `src/config.ts`:

```ts
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
	hostCommands?: string[];
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/config.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: add hostCommands to SbxConfig"
```

---

### Task 2: Rename `toRemote` → `hostToRemote`

**Files:**
- Modify: `src/paths.ts:50-66`
- Modify: `src/ops.ts:5,56,64,77,90,101,123`
- Modify: `tests/paths.test.ts:5,28,30,33,36,39,43`

- [ ] **Step 1: Run existing tests to establish baseline**

```bash
npm test -- tests/paths.test.ts
```

Expected: All tests PASS.

- [ ] **Step 2: Rename function in `src/paths.ts`**

Edit `src/paths.ts` line 50:

```ts
export function hostToRemote(hostPath: string, hostCwd: string, mounts?: MountSpec[]): string {
```

(函数体不变)

- [ ] **Step 3: Update import and calls in `src/ops.ts`**

Edit `src/ops.ts` line 5:

```ts
import { hostToRemote, isReadOnlyMount, isInsideCwd, isAllowedExternalResource, shq } from "./paths";
```

Replace all `toRemote(` with `hostToRemote(` in `src/ops.ts` (6 occurrences).

- [ ] **Step 4: Update import and calls in `tests/paths.test.ts`**

Edit `tests/paths.test.ts` line 5:

```ts
import { hostToRemote, toContainerPath, shq, isInsideCwd, isReadOnlyMount,
```

Replace all `toRemote(` with `hostToRemote(` in test file (7 occurrences).

- [ ] **Step 5: Run tests as regression check**

```bash
npm test -- tests/paths.test.ts
```

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/paths.ts src/ops.ts tests/paths.test.ts
git commit -m "refactor: rename toRemote to hostToRemote"
```

---

### Task 3: Add `remoteToHost` to paths.ts

**Files:**
- Modify: `src/paths.ts`
- Modify: `tests/paths.test.ts`

- [ ] **Step 1: Write failing tests**

Edit `tests/paths.test.ts` line 5, add `remoteToHost` to import:

```ts
import { hostToRemote, remoteToHost, toContainerPath, shq, isInsideCwd, isReadOnlyMount,
```

Append at end of file:

```ts
describe("remoteToHost", () => {
  const testHostCwd = "/home/user/project";

  it("maps /workspace to hostCwd", () => {
    expect(remoteToHost("/workspace", testHostCwd, [])).toBe("/home/user/project");
  });

  it("maps /workspace/src/foo to hostCwd/src/foo", () => {
    expect(remoteToHost("/workspace/src/foo.ts", testHostCwd, []))
      .toBe("/home/user/project/src/foo.ts");
  });

  it("passes through non-container absolute paths unchanged", () => {
    expect(remoteToHost("/home/user/project/src/foo.ts", testHostCwd, []))
      .toBe("/home/user/project/src/foo.ts");
  });

  it("passes through relative paths unchanged", () => {
    expect(remoteToHost("src/foo.ts", testHostCwd, [])).toBe("src/foo.ts");
  });

  it("maps /skills/<name>/... to mount source", () => {
    const mounts = [{ source: "/opt/skills/my-skill", target: "/skills/my-skill" }];
    expect(remoteToHost("/skills/my-skill/SKILL.md", testHostCwd, mounts))
      .toBe("/opt/skills/my-skill/SKILL.md");
  });

  it("maps /skills/<name> to mount source root", () => {
    const mounts = [{ source: "/opt/skills/my-skill", target: "/skills/my-skill" }];
    expect(remoteToHost("/skills/my-skill", testHostCwd, mounts))
      .toBe("/opt/skills/my-skill");
  });

  it("throws for unmapped /skills path", () => {
    expect(() => remoteToHost("/skills/unknown/file", "/home/user", []))
      .toThrow("Cannot map container path");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/paths.test.ts
```

Expected: FAIL — `remoteToHost is not exported`.

- [ ] **Step 3: Implement `remoteToHost` in `src/paths.ts`**

Add after the `hostToRemote` function:

```ts
export function remoteToHost(
	containerPath: string,
	hostCwd: string,
	mounts: MountSpec[],
): string {
	if (!containerPath.startsWith(REMOTE_ROOT) && !containerPath.startsWith(SKILLS_ROOT)) {
		return containerPath;
	}
	if (containerPath === REMOTE_ROOT) return hostCwd;
	if (containerPath.startsWith(`${REMOTE_ROOT}/`)) {
		return resolvePath(hostCwd, containerPath.slice(REMOTE_ROOT.length + 1));
	}
	for (const m of mounts) {
		if (containerPath === m.target) return m.source;
		if (containerPath.startsWith(`${m.target}/`)) {
			return resolvePath(m.source, containerPath.slice(m.target.length + 1));
		}
	}
	throw new Error(`Cannot map container path to host: ${containerPath}`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- tests/paths.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/paths.ts tests/paths.test.ts
git commit -m "feat: add remoteToHost for container-to-host path mapping"
```

---

### Task 4: Add `extractCommandName` + rename `createBashOps` → `createRemoteBashOps`

**Files:**
- Modify: `src/ops.ts`
- Create: `tests/ops.test.ts`

- [ ] **Step 1: Write failing test for `extractCommandName`**

Create `tests/ops.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { extractCommandName } from "../src/ops";

describe("extractCommandName", () => {
  it("extracts simple command", () => {
    expect(extractCommandName("git status")).toBe("git");
  });

  it("extracts single word", () => {
    expect(extractCommandName("npm")).toBe("npm");
  });

  it("trims leading whitespace", () => {
    expect(extractCommandName("  git add .")).toBe("git");
  });

  it("skips env assignments", () => {
    expect(extractCommandName("GIT_DIR=foo git log")).toBe("git");
  });

  it("skips multiple env assignments", () => {
    expect(extractCommandName("A=1 B=2 git log")).toBe("git");
  });

  it("returns full path commands", () => {
    expect(extractCommandName("/usr/bin/node --version")).toBe("/usr/bin/node");
  });

  it("returns null for empty command", () => {
    expect(extractCommandName("")).toBeNull();
  });

  it("returns null for whitespace-only command", () => {
    expect(extractCommandName("   ")).toBeNull();
  });

  it("returns null for env-only (no command)", () => {
    expect(extractCommandName("FOO=bar")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/ops.test.ts
```

Expected: FAIL — `extractCommandName is not exported`.

- [ ] **Step 3: Implement `extractCommandName` in `src/ops.ts`**

Add after `createBashOps`:

```ts
export function extractCommandName(command: string): string | null {
	const trimmed = command.trimStart();
	if (!trimmed) return null;
	let i = 0;
	while (i < trimmed.length) {
		const eqIdx = trimmed.indexOf("=", i);
		if (eqIdx === -1) break;
		const beforeEq = trimmed.slice(i, eqIdx);
		if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(beforeEq)) {
			i = trimmed.indexOf(" ", eqIdx);
			if (i === -1) return null;
			while (trimmed[i] === " ") i++;
		} else {
			break;
		}
	}
	const rest = trimmed.slice(i);
	const spaceIdx = rest.indexOf(" ");
	return spaceIdx === -1 ? rest || null : rest.slice(0, spaceIdx);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/ops.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Rename `createBashOps` → `createRemoteBashOps`**

Edit `src/ops.ts` line 120:

```ts
export function createRemoteBashOps(sbx: SbxHandle): BashOperations {
```

- [ ] **Step 6: Run typecheck to catch remaining `createBashOps` references**

```bash
npm run typecheck
```

Expected: Error — `createBashOps` not found in `index.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/ops.ts tests/ops.test.ts
git commit -m "feat: add extractCommandName; rename createBashOps to createRemoteBashOps"
```

---

### Task 5: Add `createHostBashOps`

**Files:**
- Modify: `src/ops.ts`
- Modify: `tests/ops.test.ts`

- [ ] **Step 1: Write failing test for `createHostBashOps`**

Append to `tests/ops.test.ts`:

```ts
import { createHostBashOps } from "../src/ops";

describe("createHostBashOps", () => {
  it("returns BashOperations with exec function", () => {
    const ops = createHostBashOps("/home/user/project", []);
    expect(typeof ops.exec).toBe("function");
  });

  it("executes a command on host", async () => {
    const ops = createHostBashOps(process.cwd(), []);
    const chunks: Buffer[] = [];
    const result = await ops.exec("echo hello", process.cwd(), {
      onData: (b) => chunks.push(b),
    });
    expect(result.exitCode).toBe(0);
    expect(Buffer.concat(chunks).toString().trim()).toBe("hello");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/ops.test.ts
```

Expected: FAIL — `createHostBashOps is not exported`.

- [ ] **Step 3: Implement `createHostBashOps` in `src/ops.ts`**

Add `createLocalBashOperations` import on line 3:

```ts
import type { ReadOperations, WriteOperations, EditOperations, BashOperations } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
```

Add `remoteToHost` to paths import on line 5:

```ts
import { hostToRemote, remoteToHost, isReadOnlyMount, isInsideCwd, isAllowedExternalResource, shq } from "./paths";
```

Add after `extractCommandName`:

```ts
export function createHostBashOps(hostCwd: string, mounts: MountSpec[]): BashOperations {
	const local = createLocalBashOperations();
	return {
		exec: (command, cwd, opts) => {
			const mappedCwd = remoteToHost(cwd, hostCwd, mounts);
			return local.exec(command, mappedCwd, opts);
		},
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/ops.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck
```

Expected: Error — `createBashOps` not found in `index.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/ops.ts tests/ops.test.ts
git commit -m "feat: add createHostBashOps for host command execution"
```

---

### Task 6: Wire whitelist routing in index.ts

**Files:**
- Modify: `index.ts`
- Modify: `tests/commands.test.ts`

- [ ] **Step 1: Write failing test for whitelist routing**

Append to `tests/commands.test.ts`:

```ts
import { extractCommandName } from "../src/ops";

describe("host command whitelist (unit level)", () => {
  it("extractCommandName matches hostCommands whitelist check", () => {
    const hostCommands = ["git", "docker"];
    const cmdName = extractCommandName("git status");
    expect(cmdName).toBe("git");
    expect(hostCommands.includes(cmdName!)).toBe(true);
  });

  it("extractCommandName does not match non-whitelisted command", () => {
    const hostCommands = ["git", "docker"];
    const cmdName = extractCommandName("ls -la");
    expect(cmdName).toBe("ls");
    expect(hostCommands.includes(cmdName!)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it passes (extractCommandName already implemented)**

```bash
npm test -- tests/commands.test.ts
```

Expected: New tests PASS.

- [ ] **Step 3: Update imports in `index.ts`**

Replace the import from `./src/ops` (lines 15-21):

```ts
import {
	createReadOps,
	createWriteOps,
	createEditOps,
	createRemoteBashOps,
	createHostBashOps,
	execCapture,
	extractCommandName,
} from "./src/ops";
```

- [ ] **Step 4: Add `hostBashTool` cache variable**

After `const localBash = createBashTool(localCwd);` (line 132), add:

```ts
let hostBashTool: ReturnType<typeof createBashTool> | null = null;
```

- [ ] **Step 5: Update bash tool `registerTool` (lines 185-194)**

Replace the entire `pi.registerTool({ ...localBash, ... })` block:

```ts
pi.registerTool({
	...localBash,
	label: "bash (sandboxed)",
	async execute(id, params, signal, onUpdate, _ctx) {
		const sbx = getSbx();
		if (!sbx) return localBash.execute(id, params, signal, onUpdate);

		const hostCommands = sbx.config.hostCommands ?? [];
		const cmdName = extractCommandName(params.command);
		if (cmdName && hostCommands.includes(cmdName)) {
			if (!hostBashTool) {
				hostBashTool = createBashTool(localCwd, {
					operations: createHostBashOps(sbx.hostCwd, sbx.mounts),
				});
			}
			return hostBashTool.execute(id, params, signal, onUpdate);
		}

		const tool = createBashTool(localCwd, { operations: createRemoteBashOps(sbx) });
		return tool.execute(id, params, signal, onUpdate);
	},
});
```

- [ ] **Step 6: Update `user_bash` event (lines 196-200)**

```ts
pi.on("user_bash", () => {
	const sbx = getSbx();
	if (!sbx) return;
	return { operations: createRemoteBashOps(sbx) };
});
```

- [ ] **Step 7: Add LLM prompt in `before_agent_start`**

Inside `before_agent_start`, before the `return` statement (around line 206), add after the `skillInfo` declaration:

```ts
const hostCommands = sbx.config.hostCommands ?? [];
const hostCmdHint = hostCommands.length
	? [
		"",
		`The following commands run directly on the host (not inside the container):`,
		`  ${hostCommands.join(", ")}`,
		"",
		`When using these commands, prefer relative paths (e.g. \`src/foo.ts\`)`,
		`rather than absolute /workspace paths, because they execute outside the`,
		`container where /workspace does not exist.`,
	].join("\n")
	: "";
```

Update the `return` statement to include `hostCmdHint`:

```ts
return {
	systemPrompt: event.systemPrompt.replace(
		/Current working directory:\s*\S+/,
		[
			`Current working directory: ${REMOTE_ROOT} (sandboxed in docker container ${sbx.name}, host cwd ${localCwd} mounted read-write)`,
			skillInfo,
			hostCmdHint,
		].filter(Boolean).join("\n"),
	),
};
```

- [ ] **Step 8: Run typecheck**

```bash
npm run typecheck
```

Expected: No errors.

- [ ] **Step 9: Run all tests**

```bash
npm test
```

Expected: All tests PASS.

- [ ] **Step 10: Commit**

```bash
git add index.ts tests/commands.test.ts
git commit -m "feat: route whitelisted commands to host; add LLM prompt"
```

---

### Task 7: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update "What runs where" table**

In the `## What runs where` section, add after `! user bash`:

```
| `bash` (whitelisted) | on the host (see `hostCommands` in config) |
```

- [ ] **Step 2: Update configuration example**

Update the `sandbox.json` example:

```json
{
  "image": "pi-container-sandbox",
  "tag": "latest",
  "containerName": null,
  "tier": "medium",
  "persist": false,
  "cacheVolume": null,
  "hostCommands": ["git", "docker"]
}
```

Add description after the example:

```
`hostCommands` (optional string array): Commands in this list run directly
on the host instead of inside the container. Matches by command name
(the first word of the bash command). For example, listing `"git"` means
`git status`, `git diff`, etc. all execute on the host.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document hostCommands whitelist in README"
```

---

### Self-Review

**1. Spec coverage:**
- [x] `SbxConfig.hostCommands` — Task 1
- [x] `hostToRemote` rename — Task 2
- [x] `remoteToHost` — Task 3
- [x] `extractCommandName` — Task 4
- [x] `createRemoteBashOps` rename — Task 4
- [x] `createHostBashOps` — Task 5
- [x] bash tool whitelist routing — Task 6
- [x] LLM prompt — Task 6
- [x] Git branch — Task 0
- [x] README update — Task 7

**2. Placeholder scan:** No TBD, TODO, or vague instructions found.

**3. Type consistency:**
- `SbxConfig.hostCommands?: string[]` — consistent across all tasks
- `remoteToHost(containerPath, hostCwd, mounts)` — matches all calls
- `extractCommandName(command): string | null` — matches all tests and routing
- `createHostBashOps(hostCwd, mounts): BashOperations` — matches routing call
- `createRemoteBashOps(sbx): BashOperations` — matches all references
