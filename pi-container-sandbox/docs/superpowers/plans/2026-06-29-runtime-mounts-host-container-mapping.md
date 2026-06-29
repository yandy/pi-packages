# runtime.mounts host→container 路径映射 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `runtime.mounts` 从 `string[]`（skill 根目录扫描）改为 `MountConfig[]`（host→container 直接映射），支持 ro/rw 权限控制。

**Architecture:** `MountConfig`（config 层）→ `MountSpec`（runtime 层）在 `index.ts` 边界转换。`discoverSkillMounts()` 只扫描 home dirs。用户自定义 mounts 和 skill mounts 按 target 合并，冲突时报错。`isReadOnlyMount` 从硬编码 `true` 改为检查 `mode` 字段。

**Tech Stack:** TypeScript, Vitest, Node.js fs

## Global Constraints

- 旧 `string[]` 格式不再支持
- `mode` 默认 `'ro'`
- 用户 mount 与 skill mount 的 target 冲突时**报错**（非静默覆盖）
- `discoverSkillMounts` 不再接收 `additionalPaths` 参数
- `~/.pi/agent/skills` 改用 `getAgentDir()` 计算

---

### Task 1: config 类型层 → MountConfig + mounts 类型变更

**Files:**
- Modify: `pi-container-sandbox/src/config.ts`

**Interfaces:**
- Produces: `MountConfig` 接口, `RuntimeConfig.mounts: MountConfig[]`

- [ ] **Step 1: 添加 MountConfig 接口，改 mounts 类型**

在 `src/config.ts` 的 `import type { SizeTier } from "./tiers";` 之后插入 `MountConfig` 接口；将 `RuntimeConfig` 中 `mounts: string[]` 改为 `mounts: MountConfig[]`：

```typescript
export interface MountConfig {
	source: string;
	target: string;
	mode?: 'ro' | 'rw';
}
```

`DEFAULT_SBX_CONFIG` 不需要改（`mounts: []` 对 `MountConfig[]` 依然合法）。

- [ ] **Step 2: 运行 typecheck 和测试**

```bash
cd pi-container-sandbox && uv run npx tsc --noEmit && npx vitest run
```

预期：`tests/config.test.ts` 中旧的 `mounts: ["/extra/tools"]` 字符串数组测试会因类型不匹配而编译失败 → RED。其余测试 PASS。

- [ ] **Step 3: 提交**

```bash
git add pi-container-sandbox/src/config.ts
git commit -m "feat: add MountConfig type, change RuntimeConfig.mounts to MountConfig[]"
```

---

### Task 2: MountSpec 加 mode → 运行时权限传播

**Files:**
- Modify: `pi-container-sandbox/src/runtime.ts`

**Interfaces:**
- Consumes: `MountConfig`（仅类型层面，config.ts 已导出）
- Produces: `MountSpec.mode?: 'ro' | 'rw'`

- [ ] **Step 1: MountSpec 加 mode 字段**

在 `src/runtime.ts` 中：

```typescript
export interface MountSpec {
	source: string;
	target: string;
	mode?: 'ro' | 'rw';  // ← 新增
}
```

- [ ] **Step 2: Docker bind 逻辑改用 mode**

`startContainer()` 中：

```typescript
// 旧
if (extraMounts) {
	for (const m of extraMounts) binds.push(`${m.source}:${m.target}:ro`);
}

// 新
if (extraMounts) {
	for (const m of extraMounts) {
		const mode = m.mode === 'rw' ? 'rw' : 'ro';
		binds.push(`${m.source}:${m.target}:${mode}`);
	}
}
```

- [ ] **Step 3: 运行测试验证**

```bash
cd pi-container-sandbox && uv run npx tsc --noEmit && npx vitest run --exclude 'tests/runtime*'
```

预期：config.test.ts mounts 旧测试 RED（Task 1 遗留问题），其余 PASS。

- [ ] **Step 4: 提交**

```bash
git add pi-container-sandbox/src/runtime.ts
git commit -m "feat: add mode field to MountSpec, use mode for docker bind flags"
```

---

### Task 3: discoverSkillMounts 去除 additionalPaths + 修正 agent dir 路径

**Files:**
- Modify: `pi-container-sandbox/src/skills.ts`

**Interfaces:**
- Consumes: `MountSpec`（runtime.ts 已添加 mode）
- Produces: `discoverSkillMounts(): MountSpec[]`（新签名）

- [ ] **Step 1: 添加 getAgentDir import，改写函数**

`src/skills.ts` 完整替换：

```typescript
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { MountSpec } from "./runtime";

export function discoverSkillMounts(): MountSpec[] {
	const home = homedir();
	const agentDir = getAgentDir();
	const skillRoots = [
		resolvePath(home, ".agents", "skills"),
		resolvePath(agentDir, "skills"),
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
				if (mounts.some((m) => m.target === target)) {
					console.debug(`sandbox: skipping duplicate mount target ${target} (already mounted from another source)`);
					continue;
				}
				mounts.push({ source: full, target, mode: 'ro' as const });
			}
		} catch {
			// Permission or I/O error - skip silently
		}
	}

	return mounts;
}
```

- [ ] **Step 2: 运行 typecheck**

```bash
cd pi-container-sandbox && uv run npx tsc --noEmit
```

预期：`index.ts` 中对 `discoverSkillMounts(extraPaths)` 的调用会报编译错误（参数多余）→ RED。其余文件通过。

- [ ] **Step 3: 提交**

```bash
git add pi-container-sandbox/src/skills.ts
git commit -m "refactor: remove additionalPaths from discoverSkillMounts, use getAgentDir() for agent skills path"
```

---

### Task 4: isReadOnlyMount 尊重 mode 字段

**Files:**
- Modify: `pi-container-sandbox/src/paths.ts`

**Interfaces:**
- Consumes: `MountSpec.mode?: 'ro' | 'rw'`

- [ ] **Step 1: 先写测试（RED）**

在 `tests/paths.test.ts` 已有的 `isReadOnlyMount` describe 块之后追加：

```typescript
describe("isReadOnlyMount with mode", () => {
	it("returns true for ro mount", () => {
		const mounts: MountSpec[] = [{ source: "/host/data", target: "/data", mode: "ro" }];
		expect(isReadOnlyMount("/data/file.txt", mounts)).toBe(true);
	});
	it("returns false for rw mount", () => {
		const mounts: MountSpec[] = [{ source: "/host/data", target: "/data", mode: "rw" }];
		expect(isReadOnlyMount("/data/file.txt", mounts)).toBe(false);
	});
	it("returns true when mode is not specified (default ro)", () => {
		const mounts: MountSpec[] = [{ source: "/host/data", target: "/data" }];
		expect(isReadOnlyMount("/data/file.txt", mounts)).toBe(true);
	});
});
```

- [ ] **Step 2: 运行测试，验证 RED**

```bash
cd pi-container-sandbox && npx vitest run tests/paths.test.ts
```

预期：前两个新测试 PASS（现有实现对所有 mount 返回 true，所以 ro→true 对，但 rw→false 会 FAIL）。第三个测试 PASS。

- [ ] **Step 3: 实现（GREEN）**

`src/paths.ts` 中 `isReadOnlyMount`：

```typescript
export function isReadOnlyMount(containerPath: string, mounts: MountSpec[]): boolean {
	for (const m of mounts) {
		if (containerPath === m.target || containerPath.startsWith(`${m.target}/`)) {
			return m.mode !== 'rw';
		}
	}
	return false;
}
```

- [ ] **Step 4: 运行测试，验证 GREEN**

```bash
cd pi-container-sandbox && npx vitest run tests/paths.test.ts
```

预期：全部 43 测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add pi-container-sandbox/tests/paths.test.ts pi-container-sandbox/src/paths.ts
git commit -m "feat: isReadOnlyMount respects MountSpec.mode field"
```

---

### Task 5: index.ts 集成 — MountConfig→MountSpec 转换 + 合并 + 冲突检测

**Files:**
- Modify: `pi-container-sandbox/index.ts`

**Interfaces:**
- Consumes: `MountConfig`（config.ts）、`MountSpec`（runtime.ts）、`discoverSkillMounts()`（skills.ts）
- Produces: `allMounts: MountSpec[]` 传入 `DockerRuntime` 和 `SbxSession`

- [ ] **Step 1: 添加 import**

在 `index.ts` 顶部 import 中添加 `MountSpec`：

```typescript
import { DockerRuntime, deriveContainerName, type MountSpec } from "./src/runtime";
```

- [ ] **Step 2: 替换 session_start 中的 mount 组装逻辑**

在 `session_start` handler 中，替换以下代码块：

```typescript
// 旧
const extraPaths = rt.mounts.length ? rt.mounts : undefined;
const sandboxName = rt.name ?? deriveContainerName(localCwd);
const isReusable = !!(rt.name);

const cacheVolume = rt.cache ?? undefined;

const skillMounts = discoverSkillMounts(extraPaths);
```

替换为：

```typescript
// 将 sandbox.json 中的 MountConfig[] 转换为 MountSpec[]
const userMounts: MountSpec[] = rt.mounts.map((m) => ({
	source: m.source,
	target: m.target,
	mode: m.mode ?? 'ro' as const,
}));

// 自动发现 home 目录下的 skill mounts
const skillMounts = discoverSkillMounts();

// 合并：检测 target 冲突
for (const um of userMounts) {
	const conflict = skillMounts.find((sm) => sm.target === um.target);
	if (conflict) {
		throw new Error(
			`sandbox: mount target conflict: "${um.target}" is already used by auto-discovered skill at "${conflict.source}". ` +
			`Choose a different target for your custom mount at "${um.source}".`
		);
	}
}
const allMounts = [...skillMounts, ...userMounts];

const sandboxName = rt.name ?? deriveContainerName(localCwd);
const isReusable = !!(rt.name);

const cacheVolume = rt.cache ?? undefined;
```

- [ ] **Step 3: 更新 extraMounts 和 setSbx 的 mounts 引用**

```typescript
// 旧
extraMounts: skillMounts.length ? skillMounts : undefined,

// 新
extraMounts: allMounts.length ? allMounts : undefined,
```

```typescript
// 旧
keep, mounts: skillMounts, allowedExternalPrefixes,

// 新
keep, mounts: allMounts, allowedExternalPrefixes,
```

- [ ] **Step 4: 更新 before_agent_start 消息**

```typescript
// 旧
const skillInfo = sbx.mounts.length
	? `Agent skills are mounted read-only at /skills/ (e.g. ${sbx.mounts.map((m) => m.target).join(", ")}). Read skill files via /skills/<name>/SKILL.md. Writing to /skills/ is forbidden.`
	: "No skill directories are mounted.";

// 新
const skillTargets = sbx.mounts.filter((m) => m.target.startsWith('/skills/')).map((m) => m.target);
const otherMounts = sbx.mounts.filter((m) => !m.target.startsWith('/skills/'));
const skillsPart = skillTargets.length
	? `Agent skills are mounted read-only at /skills/ (e.g. ${skillTargets.join(", ")}). Read skill files via /skills/<name>/SKILL.md. Writing to /skills/ is forbidden.`
	: "No agent skill directories are mounted.";
const mountsPart = otherMounts.length
	? `Additional mounts: ${otherMounts.map((m) => `${m.source} → ${m.target}${m.mode === 'rw' ? ' (rw)' : ' (ro)'}`).join(", ")}.`
	: "";
const skillInfo = [skillsPart, mountsPart].filter(Boolean).join("\n");
```

- [ ] **Step 5: 更新 setStatus 和 notify 中的 mounts 引用**

`setStatus` 行：

```typescript
// 旧
ctx.ui.theme.fg("accent", `${statusPrefix}: ${actualName} (net=${allowNetwork ? "on" : "off"})${resStr}`),

// 新
ctx.ui.theme.fg("accent", `${statusPrefix}: ${actualName} (net=${allowNetwork ? "on" : "off"})${resStr}${allMounts.length ? `, mounts=${allMounts.length}` : ""}`),
```

`notify` 数组：

```typescript
// 旧
skillMounts.length ? `Skills mounted: ${skillMounts.map((m) => m.target).join(", ")}` : "",

// 新
skillMounts.length ? `Skills mounted: ${skillMounts.map((m) => m.target).join(", ")}` : "",
userMounts.length ? `Extra mounts: ${userMounts.map((m) => `${m.source} → ${m.target} (${m.mode ?? 'ro'})`).join(", ")}` : "",
```

- [ ] **Step 6: 运行 typecheck**

```bash
cd pi-container-sandbox && uv run npx tsc --noEmit
```

预期：通过（config.test.ts 的旧 mounts 测试可能仍报类型错误，但 TypeScript 类型检查自身通过）。

- [ ] **Step 7: 提交**

```bash
git add pi-container-sandbox/index.ts
git commit -m "feat: convert MountConfig[] to MountSpec[], merge with skill mounts, conflict detection"
```

---

### Task 6: 测试适配 + 新增测试

**Files:**
- Modify: `pi-container-sandbox/tests/config.test.ts`
- Modify: `pi-container-sandbox/tests/skills.test.ts`

**Interfaces:**
- Consumes: `MountConfig`（config.ts）、`discoverSkillMounts()`（新版签名）

- [ ] **Step 1: 更新 config.test.ts 中 mounts 的测试用例**

`tests/config.test.ts` 中 `"parses memory, cpus, swap, pidsLimit, mounts from runtime group"` 测试：

```typescript
// 旧
mounts: ["/extra/tools"]

// 新
mounts: [{ source: "/host/projects", target: "/projects" }]
```

对应的断言：

```typescript
// 旧
expect(cfg.runtime.mounts).toEqual(["/extra/tools"]);

// 新
expect(cfg.runtime.mounts).toEqual([{ source: "/host/projects", target: "/projects" }]);
```

- [ ] **Step 2: 重写 skills.test.ts**

`tests/skills.test.ts` 完整替换（新签名不需要 `additionalPaths` 参数，测试改为验证基本行为）：

```typescript
import { describe, expect, it } from "vitest";
import { discoverSkillMounts } from "../src/skills";

describe("discoverSkillMounts", () => {
	it("returns an array of MountSpec", () => {
		const mounts = discoverSkillMounts();
		expect(Array.isArray(mounts)).toBe(true);
	});

	it("all mounts have source, target, and mode='ro'", () => {
		const mounts = discoverSkillMounts();
		for (const m of mounts) {
			expect(typeof m.source).toBe("string");
			expect(typeof m.target).toBe("string");
			expect(m.target.startsWith("/skills/")).toBe(true);
			expect(m.mode).toBe("ro");
		}
	});
});
```

- [ ] **Step 3: 运行测试**

```bash
cd pi-container-sandbox && npx vitest run --exclude 'tests/runtime*'
```

预期：全部 PASS。

- [ ] **Step 4: 提交**

```bash
git add pi-container-sandbox/tests/config.test.ts pi-container-sandbox/tests/skills.test.ts
git commit -m "test: adapt tests for MountConfig and discoverSkillMounts changes"
```

---

### Task 7: 最终验证

- [ ] **Step 1: TypeScript 类型检查**

```bash
cd pi-container-sandbox && uv run npx tsc --noEmit
```
预期：零错误。

- [ ] **Step 2: 全部测试**

```bash
cd pi-container-sandbox && npx vitest run
```
预期：全部 PASS。

- [ ] **Step 3: 确认无副作用的模块测试通过**

```bash
cd pi-container-sandbox && npx vitest run tests/ops.test.ts tests/commands.test.ts tests/session.test.ts tests/tiers.test.ts
```
预期：全部 PASS。

- [ ] **Step 4: 提交**

```bash
git commit --allow-empty -m "chore: final verification — all tests pass"
```

---

## 变更文件总览

| 文件 | 操作 | Task |
|------|------|------|
| `src/config.ts` | 新增 `MountConfig`，改 `mounts` 类型 | 1 |
| `src/runtime.ts` | `MountSpec` 加 `mode`，Docker bind 用 mode | 2 |
| `src/skills.ts` | 移除 `additionalPaths`，用 `getAgentDir()`，加 `mode` | 3 |
| `src/paths.ts` | `isReadOnlyMount` 检查 `mode !== 'rw'` | 4 |
| `index.ts` | 转换 + 合并 + 冲突检测 + 消息更新 | 5 |
| `tests/config.test.ts` | mounts 测试适配新格式 | 6 |
| `tests/skills.test.ts` | 适配新函数签名 | 6 |
| `tests/paths.test.ts` | 新增 rw/ro 模式测试 | 4 |
