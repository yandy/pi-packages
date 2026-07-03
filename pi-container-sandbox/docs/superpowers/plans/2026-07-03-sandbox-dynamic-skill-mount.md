# Sandbox 动态 Skill Mount 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 sandbox 的 skill mount 发现从静态目录扫描改为从 `ctx.getSystemPrompt()` 的 `<available_skills>` XML 动态解析，使所有来源的 skill 都能挂载到容器内，并修正 `<location>` 为容器内路径。

**Architecture:** `session_start` 中一次解析 XML → 存 `skillFileMapping` + 创建 docker mounts。`before_agent_start` 直接读 `sbx.skillFileMapping` 做 `<location>` 替换，不重复解析。

**Tech Stack:** TypeScript, Vitest, Dockerode (不变)

## Global Constraints

- `MountSpec`、`MountConfig` 类型不变
- `sandbox.json` 配置格式不变
- `DockerRuntime` 接口不变
- 路径映射函数（`hostToContainer`、`containerToHost`）不变
- 外部路径审批机制不变
- `SbxHandle.mounts` 类型不变（flat `MountSpec[]`，在 ops 边界合并）
- 不修改 `src/ops.ts`、`src/paths.ts`、`src/runtime.ts`、`src/config.ts`
- XML 只解析一次（`session_start`），不重复解析
- 测试：`npx vitest run`，零失败

---

### Task 1: 更新 `SbxSession` 类型定义

**Files:**
- Modify: `pi-container-sandbox/src/session.ts`

**Interfaces:**
- Consumes: `MountSpec` from `./runtime`, `SbxConfig` from `./config`
- Produces: `SbxSession` with `skillMounts`、`userMounts`、`skillFileMapping`（替换 `mounts`）

- [ ] **Step 1: 修改类型定义**

将 `src/session.ts` 中的 `SbxSession` 接口从:

```typescript
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
```

改为:

```typescript
export interface SbxSession {
	runtime: Runtime;
	name: string;
	hostCwd: string;
	keep: boolean;
	/** Skill mounts auto-discovered from system prompt <available_skills> XML. Always /skills/<name>, ro. */
	skillMounts: MountSpec[];
	/** User-defined mounts from sandbox.json runtime.mounts. */
	userMounts: MountSpec[];
	/** Raw parseAvailableSkills result. Used by before_agent_start to fix <location> paths. */
	skillFileMapping: Array<{ name: string; hostFilePath: string }>;
	allowedExternalPrefixes: string[];
	resources?: SandboxOptions["resources"];
	imageRef: string;
	config: SbxConfig;
	isReusable: boolean;
	isReattached: boolean;
}
```

- [ ] **Step 2: 确认无其他 `mounts` 引用在 session.ts 内**

Run: `cd pi-container-sandbox && grep -n "mounts" src/session.ts`
Expected: 只有注释中的 "mounts" 单词，没有 `mounts:` 字段定义

- [ ] **Step 3: 运行类型检查（预期其他文件报错）**

Run: `cd pi-container-sandbox && npx tsc --noEmit 2>&1 | head -30`
Expected: `index.ts`、`tests/` 中有 `sbx.mounts` 引用报错 — 预期内，后续 Task 修复

- [ ] **Step 4: Commit**

```bash
cd pi-container-sandbox
git add src/session.ts
git commit -m "refactor(session): split mounts into skillMounts + userMounts + skillFileMapping"
```

---

### Task 2: 重写 `src/skills.ts`

**Files:**
- Modify: `pi-container-sandbox/src/skills.ts`

**Interfaces:**
- Consumes: `MountSpec` from `./runtime`
- Produces:
  - `parseAvailableSkills(systemPrompt: string): Array<{ name: string; hostFilePath: string }>`
  - `skillsToMountSpecs(skills: Array<{ name: string; hostFilePath: string }>): MountSpec[]`

- [ ] **Step 1: 编写失败测试**

写入 `tests/skills.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { parseAvailableSkills, skillsToMountSpecs } from "../src/skills";

describe("parseAvailableSkills", () => {
	it("parses a single skill from <available_skills> XML", () => {
		const prompt = `<available_skills>
  <skill>
    <name>ask-user</name>
    <description>Ask the user questions</description>
    <location>/home/user/.pi/agent-code/npm/node_modules/@yandy0725/pi-ask-user/skills/ask-user/SKILL.md</location>
  </skill>
</available_skills>`;

		const result = parseAvailableSkills(prompt);
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe("ask-user");
		expect(result[0].hostFilePath).toContain("SKILL.md");
	});

	it("parses multiple skills", () => {
		const prompt = `<available_skills>
  <skill>
    <name>ask-user</name>
    <description>Ask user</description>
    <location>/a/SKILL.md</location>
  </skill>
  <skill>
    <name>find-docs</name>
    <description>Find docs</description>
    <location>/b/SKILL.md</location>
  </skill>
</available_skills>`;

		const result = parseAvailableSkills(prompt);
		expect(result).toHaveLength(2);
		expect(result[0].name).toBe("ask-user");
		expect(result[1].name).toBe("find-docs");
	});

	it("throws when systemPrompt is empty", () => {
		expect(() => parseAvailableSkills("")).toThrow("empty system prompt");
	});

	it("throws when no <available_skills> block exists", () => {
		expect(() => parseAvailableSkills("no skills here")).toThrow(
			"could not find any <available_skills>",
		);
	});

	it("handles whitespace and newlines inside name/location tags", () => {
		const prompt = `<available_skills>
  <skill>
    <name>
      my-skill
    </name>
    <description>desc</description>
    <location>
      /path/to/my-skill/SKILL.md
    </location>
  </skill>
</available_skills>`;

		const result = parseAvailableSkills(prompt);
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe("my-skill");
		expect(result[0].hostFilePath).toBe("/path/to/my-skill/SKILL.md");
	});

	it("skips skills where name or location is empty after trim", () => {
		const prompt = `<available_skills>
  <skill>
    <name></name>
    <location>/a/SKILL.md</location>
  </skill>
  <skill>
    <name>valid</name>
    <location>/b/SKILL.md</location>
  </skill>
</available_skills>`;

		const result = parseAvailableSkills(prompt);
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe("valid");
	});
});

describe("skillsToMountSpecs", () => {
	it("converts skills to ro mount specs with /skills/<name> targets", () => {
		const skills = [
			{ name: "ask-user", hostFilePath: "/home/.pi/skills/ask-user/SKILL.md" },
			{ name: "find-docs", hostFilePath: "/home/.pi/skills/find-docs/SKILL.md" },
		];

		const mounts = skillsToMountSpecs(skills);
		expect(mounts).toHaveLength(2);
		expect(mounts[0]).toEqual({
			source: "/home/.pi/skills/ask-user",
			target: "/skills/ask-user",
			mode: "ro",
		});
		expect(mounts[1]).toEqual({
			source: "/home/.pi/skills/find-docs",
			target: "/skills/find-docs",
			mode: "ro",
		});
	});

	it("returns empty array for empty input", () => {
		expect(skillsToMountSpecs([])).toEqual([]);
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd pi-container-sandbox && npx vitest run tests/skills.test.ts`
Expected: 报错 — `parseAvailableSkills is not exported`

- [ ] **Step 3: 实现 `parseAvailableSkills` 和 `skillsToMountSpecs`**

写入 `src/skills.ts`（完全重写）:

```typescript
import { dirname } from "node:path";
import type { MountSpec } from "./runtime";

/**
 * Parse all skills from the system prompt's <available_skills> XML block.
 *
 * The system prompt emitted by pi includes:
 *
 *   <available_skills>
 *     <skill>
 *       <name>ask-user</name>
 *       <description>...</description>
 *       <location>/path/to/SKILL.md</location>
 *     </skill>
 *   </available_skills>
 *
 * Returns each skill's <name> and the host file path from <location>.
 * Throws if the prompt is empty or contains no <available_skills> block.
 */
export function parseAvailableSkills(systemPrompt: string): Array<{
	name: string;
	hostFilePath: string;
}> {
	if (!systemPrompt) {
		throw new Error(
			"sandbox: getSystemPrompt() returned an empty system prompt. " +
				"Cannot discover skill mounts.",
		);
	}

	const skills: Array<{ name: string; hostFilePath: string }> = [];
	const regex = /<skill>\s*<name>(.*?)<\/name>[\s\S]*?<location>(.*?)<\/location>/g;

	let match: RegExpExecArray | null;
	while ((match = regex.exec(systemPrompt)) !== null) {
		const rawName = match[1].trim();
		const rawLocation = match[2].trim();

		if (!rawName || !rawLocation) continue;

		skills.push({ name: rawName, hostFilePath: rawLocation });
	}

	if (skills.length === 0) {
		throw new Error(
			"sandbox: could not find any <available_skills> entries in the system prompt. " +
				"Cannot discover skill mounts.",
		);
	}

	return skills;
}

/**
 * Convert parsed skills into Docker mount specs.
 *
 * Each skill's parent directory (dirname of hostFilePath) is mounted
 * read-only at /skills/<name>/ inside the container.
 */
export function skillsToMountSpecs(
	skills: Array<{ name: string; hostFilePath: string }>,
): MountSpec[] {
	return skills.map((skill) => ({
		source: dirname(skill.hostFilePath),
		target: `/skills/${skill.name}`,
		mode: "ro" as const,
	}));
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd pi-container-sandbox && npx vitest run tests/skills.test.ts`
Expected: 8 tests PASS

- [ ] **Step 5: Commit**

```bash
cd pi-container-sandbox
git add src/skills.ts tests/skills.test.ts
git commit -m "feat(skills): replace discoverSkillMounts with XML-based parseAvailableSkills"
```

---

### Task 3: 更新测试辅助函数

**Files:**
- Modify: `pi-container-sandbox/tests/_helpers.ts`

- [ ] **Step 1: 更新 `createTestSession`**

将:

```typescript
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
```

改为:

```typescript
export function createTestSession(overrides?: Partial<SbxSession>): SbxSession {
	return {
		runtime: mockRuntime(),
		name: "test-box",
		hostCwd: "/tmp",
		keep: false,
		skillMounts: [],
		userMounts: [],
		skillFileMapping: [],
		allowedExternalPrefixes: [],
		imageRef: "img:latest",
		config: { ...DEFAULT_CONFIG, ...overrides?.config },
		isReusable: false,
		isReattached: false,
		...overrides,
	};
}
```

- [ ] **Step 2: Commit**

```bash
cd pi-container-sandbox
git add tests/_helpers.ts
git commit -m "refactor(test): update helpers for new SbxSession fields"
```

---

### Task 4: 更新 `tests/session.test.ts`

**Files:**
- Modify: `pi-container-sandbox/tests/session.test.ts`

- [ ] **Step 1: 更新 mock session**

将 `mockSession` 中的:

```typescript
	mounts: [],
```

改为:

```typescript
	skillMounts: [],
	userMounts: [],
	skillFileMapping: [],
```

- [ ] **Step 2: 运行测试确认通过**

Run: `cd pi-container-sandbox && npx vitest run tests/session.test.ts`
Expected: 3 tests PASS

- [ ] **Step 3: Commit**

```bash
cd pi-container-sandbox
git add tests/session.test.ts
git commit -m "refactor(test): update session test for new SbxSession fields"
```

---

### Task 5: 更新 `index.ts` — `session_start` handler

**Files:**
- Modify: `pi-container-sandbox/index.ts`

- [ ] **Step 1: 替换 import**

将:

```typescript
import { discoverSkillMounts } from "./src/skills";
```

替换为:

```typescript
import { parseAvailableSkills, skillsToMountSpecs } from "./src/skills";
```

- [ ] **Step 2: 替换 skill 发现逻辑**

将:

```typescript
			// Auto-discover skill mounts under home directory
			const skillMounts = discoverSkillMounts();

			// Merge: detect target conflicts
			for (const um of userMounts) {
				const conflict = skillMounts.find((sm) => sm.target === um.target);
				if (conflict) {
					throw new Error(
						`sandbox: mount target conflict: "${um.target}" is already used by auto-discovered skill at "${conflict.source}". ` +
							`Choose a different target for your custom mount at "${um.source}".`,
					);
				}
			}
			const allMounts = [...skillMounts, ...userMounts];
```

替换为:

```typescript
			// Dynamic skill discovery: parse <available_skills> XML from system prompt.
			// Catches ALL pi-loaded skills — npm packages, project .agents/skills/,
			// settings config, etc. — not just ~/.agents/skills/.
			const skillParsed = parseAvailableSkills(ctx.getSystemPrompt());
			const skillMounts = skillsToMountSpecs(skillParsed);

			// Detect target conflicts between user mounts and skill mounts
			for (const um of userMounts) {
				const conflict = skillMounts.find((sm) => sm.target === um.target);
				if (conflict) {
					throw new Error(
						`sandbox: mount target "${um.target}" is reserved for skill "${conflict.source}". ` +
							`Use a different target in sandbox.json.`,
					);
				}
			}
			const allMounts = [...skillMounts, ...userMounts];
```

- [ ] **Step 3: 更新 `setSbx` 调用**

将:

```typescript
			setSbx({
				runtime,
				name: sandboxName,
				hostCwd: localCwd,
				keep,
				mounts: allMounts,
				allowedExternalPrefixes,
				resources,
				imageRef: image,
				config: cfg,
				isReusable,
				isReattached: false,
			});
```

替换为:

```typescript
			setSbx({
				runtime,
				name: sandboxName,
				hostCwd: localCwd,
				keep,
				skillMounts,
				userMounts,
				skillFileMapping: skillParsed,
				allowedExternalPrefixes,
				resources,
				imageRef: image,
				config: cfg,
				isReusable,
				isReattached: false,
			});
```

- [ ] **Step 4: 确认通知消息行正确**

以下两行不需要改动（`skillMounts` 变量名没变）:

```typescript
			skillMounts.length ? `Skills mounted: ${skillMounts.map((m) => m.target).join(", ")}` : "",
			userMounts.length
				? `Extra mounts: ${userMounts.map((m) => `${m.source} → ${m.target} (${m.mode ?? "ro"})`).join(", ")}`
				: "",
```

- [ ] **Step 5: 运行类型检查**

Run: `cd pi-container-sandbox && npx tsc --noEmit 2>&1 | head -20`
Expected: `before_agent_start` 和剩下的 `sbx.mounts` 引用仍有类型错误（Task 6、7 处理）

- [ ] **Step 6: Commit**

```bash
cd pi-container-sandbox
git add index.ts
git commit -m "feat(sandbox): dynamic skill mount discovery from system prompt XML"
```

---

### Task 6: 更新 `index.ts` — `before_agent_start` handler

**Files:**
- Modify: `pi-container-sandbox/index.ts`

- [ ] **Step 1: 替换整个 `before_agent_start` handler**

将当前的:

```typescript
	pi.on("before_agent_start", async (event) => {
		const sbx = getSbx();
		if (!sbx) return;

		const skillTargets = sbx.mounts.filter((m) => m.target.startsWith("/skills/")).map((m) => m.target);
		const otherMounts = sbx.mounts.filter((m) => !m.target.startsWith("/skills/"));
		const skillsPart = skillTargets.length
			? `Agent skills are mounted read-only at /skills/ (e.g. ${skillTargets.join(", ")}). Read skill files via /skills/<name>/SKILL.md. Writing to /skills/ is forbidden.`
			: "No agent skill directories are mounted.";
		const mountsPart = otherMounts.length
			? `Additional mounts: ${otherMounts.map((m) => `${m.source} → ${m.target}${m.mode === "rw" ? " (rw)" : " (ro)"}`).join(", ")}.`
			: "";
		const skillInfo = [skillsPart, mountsPart].filter(Boolean).join("\n");

		const hostCommands = sbx.config.host.commands ?? [];
		const hostCmdHint = hostCommands.length
			? [
					"",
					`The following commands run directly on the host (not inside the container):`,
					`  ${hostCommands.join(", ")}`,
					"",
					`When using these commands, prefer relative paths (e.g. \`src/foo.ts\`)`,
					`rather than absolute ${CONTAINER_ROOT} paths, because they execute outside the container where ${CONTAINER_ROOT} does not exist.`,
				].join("\n")
			: "";

		return {
			systemPrompt: event.systemPrompt.replace(
				/Current working directory:\s*\S+/,
				[
					`Current working directory: ${CONTAINER_ROOT} (sandboxed in docker container ${sbx.name}, host cwd ${localCwd} mounted read-write)`,
					skillInfo,
					hostCmdHint,
				]
					.filter(Boolean)
					.join("\n"),
			),
		};
	});
```

替换为:

```typescript
	pi.on("before_agent_start", async (event) => {
		const sbx = getSbx();
		if (!sbx) return;

		// 1. Fix <location> paths to point inside the container.
		//    Uses skillFileMapping (from session_start) — no XML re-parsing.
		let fixedPrompt = event.systemPrompt;
		for (const { name, hostFilePath } of sbx.skillFileMapping) {
			fixedPrompt = fixedPrompt.replace(
				`<location>${hostFilePath}</location>`,
				`<location>/skills/${name}/SKILL.md</location>`,
			);
		}

		// 2. Build skill mount info from sbx.skillMounts (no /skills/ prefix filtering)
		const skillInfo = sbx.skillMounts.length
			? `Skills mounted at: ${sbx.skillMounts.map((m) => m.target).join(", ")}.`
			: "";

		const userInfo = sbx.userMounts.length
			? `User mounts: ${sbx.userMounts.map((m) => `${m.source} → ${m.target}${m.mode === "rw" ? " (rw)" : ""}`).join(", ")}.`
			: "";

		// 3. Build host command hint
		const hostCommands = sbx.config.host.commands ?? [];
		const hostCmdHint = hostCommands.length
			? [
					"",
					`The following commands run directly on the host (not inside the container):`,
					`  ${hostCommands.join(", ")}`,
					"",
					`When using these commands, prefer relative paths (e.g. \`src/foo.ts\`)`,
					`rather than absolute ${CONTAINER_ROOT} paths, because they execute outside the container where ${CONTAINER_ROOT} does not exist.`,
				].join("\n")
			: "";

		// 4. Replace CWD line with sandbox-aware version
		return {
			systemPrompt: fixedPrompt.replace(
				/Current working directory:\s*\S+/,
				[
					`Current working directory: ${CONTAINER_ROOT} (sandboxed in docker container ${sbx.name}, host cwd ${localCwd} mounted read-write)`,
					[skillInfo, userInfo].filter(Boolean).join("\n"),
					hostCmdHint,
				]
					.filter(Boolean)
					.join("\n"),
			),
		};
	});
```

- [ ] **Step 2: 运行类型检查**

Run: `cd pi-container-sandbox && npx tsc --noEmit 2>&1 | head -20`
Expected: 仅剩 `guardExternalRead` 和 `hostBashTool` 中的 `sbx.mounts` 报错（Task 7）

- [ ] **Step 3: Commit**

```bash
cd pi-container-sandbox
git add index.ts
git commit -m "feat(sandbox): fix <location> to container path via skillFileMapping"
```

---

### Task 7: 更新 `index.ts` — 剩余 `sbx.mounts` 引用

**Files:**
- Modify: `pi-container-sandbox/index.ts`

两处 `sbx.mounts` → `[...sbx.skillMounts, ...sbx.userMounts]`

- [ ] **Step 1: 修复 `guardExternalRead`**

将:

```typescript
		const external = getExternalPath(paramsPath, sbx.hostCwd, sbx.mounts);
```

替换为:

```typescript
		const external = getExternalPath(paramsPath, sbx.hostCwd, [...sbx.skillMounts, ...sbx.userMounts]);
```

- [ ] **Step 2: 修复 `hostBashTool`**

将:

```typescript
						operations: createHostBashOps(sbx.hostCwd, sbx.mounts),
```

替换为:

```typescript
						operations: createHostBashOps(sbx.hostCwd, [...sbx.skillMounts, ...sbx.userMounts]),
```

- [ ] **Step 3: 确认零剩余引用**

Run: `cd pi-container-sandbox && grep -rn "\.mounts\b" index.ts | grep -v "skillMounts\|userMounts\|\.runtime\.mounts\|/skills/"`
Expected: 无输出

- [ ] **Step 4: 运行类型检查**

Run: `cd pi-container-sandbox && npx tsc --noEmit`
Expected: 零错误

- [ ] **Step 5: Commit**

```bash
cd pi-container-sandbox
git add index.ts
git commit -m "fix(sandbox): replace remaining sbx.mounts refs with spread merge"
```

---

### Task 8: 全量测试验证

**Files:**
- 无文件修改

- [ ] **Step 1: 运行全部测试**

Run: `cd pi-container-sandbox && npx vitest run --exclude '**/runtime*.test.ts' 2>&1`
Expected: 全部 PASS

- [ ] **Step 2: 运行类型检查**

Run: `cd pi-container-sandbox && npx tsc --noEmit`
Expected: 零错误

- [ ] **Step 3: 确认变更文件列表**

Run: `cd pi-container-sandbox && git diff main --name-only`
Expected:
```
pi-container-sandbox/index.ts
pi-container-sandbox/src/session.ts
pi-container-sandbox/src/skills.ts
pi-container-sandbox/tests/_helpers.ts
pi-container-sandbox/tests/session.test.ts
pi-container-sandbox/tests/skills.test.ts
```

- [ ] **Step 4: Commit**

```bash
cd pi-container-sandbox
git add .
git commit -m "verify: full test suite passes after dynamic skill mount refactor"
```
