# Skill Bundle Bash 脚本自动放行 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当 bash 执行的脚本文件位于已加载 skill 目录内时，跳过 `external_directory` 确认。

**Architecture:** 在 `describeBashExternalDirectoryGate` 中，用 `PermissionSession` 已有的 `getActiveSkillEntries()` 提供的 `normalizedBaseDir` 过滤外部路径，落在 skill 目录内的路径在 `selectUncoveredExternalPaths` 之前移除。

**Tech Stack:** TypeScript, Vitest

## Global Constraints

- 仅影响 `bash` 工具的 external_directory gate，不改变其他工具行为
- 不新增配置项
- skill 目录来源：`SkillPromptEntry.normalizedBaseDir`（`PermissionSession.getActiveSkillEntries()`）
- 过滤后的行为：全部被过滤 → 返回 `null`（跳过 gate）；部分被过滤 → 对剩余路径继续检查

---

### Task 1: 编写测试（先写，预期失败）

**Files:**
- Modify: `pi-permission-system/tests/handlers/gates/bash-external-directory.test.ts`

**Interfaces:**
- Changes: `describeGate(tcc, resolver, skillDirs?)` 辅助函数签名扩展
- Produces: 3 个新测试用例覆盖新行为 + 向后兼容

- [ ] **Step 1: 扩展 `describeGate` 辅助函数签名**

```typescript
async function describeGate(
	tcc: ToolCallContext,
	resolver: ScopedPermissionResolver,
	skillDirs?: readonly string[],
): Promise<GateResult> {
	const command = getNonEmptyString(toRecord(tcc.input).command);
	const bashProgram = tcc.toolName === "bash" && command ? await BashProgram.parse(command, tcc.cwd) : null;
	return describeBashExternalDirectoryGate(tcc, bashProgram, resolver, skillDirs);
}
```

改动仅一行：`describeBashExternalDirectoryGate(tcc, bashProgram, resolver, skillDirs)` —— 第四个参数透传。

- [ ] **Step 2: 新增测试 — 全部路径在 skill 目录内 → 返回 null**

```typescript
	it("returns null when all external paths are within skill directories", async () => {
		const skillDirs = ["/home/.pi/agent-code/git/github.com/yandy/superpowers/skills/sdd"];
		const result = await describeGate(
			makeTcc({
				input: { command: "bash /home/.pi/agent-code/git/github.com/yandy/superpowers/skills/sdd/scripts/review-package abc123 HEAD" },
			}),
			makeResolver(makeCheckResult("ask")),
			skillDirs,
		);
		expect(result).toBeNull();
	});
```

- [ ] **Step 3: 新增测试 — 部分路径在 skill 内，剩余路径触发 gate**

```typescript
	it("filters skill paths, returns descriptor for remaining external paths", async () => {
		const skillDirs = ["/home/.pi/agent-code/git/github.com/yandy/superpowers/skills/sdd"];
		const result = await describeGate(
			makeTcc({
				input: { command: "diff /home/.pi/agent-code/git/github.com/yandy/superpowers/skills/sdd/scripts/task-brief /etc/hosts" },
			}),
			makeResolver(makeCheckResult("ask")),
			skillDirs,
		);
		expect(isGateDescriptor(result)).toBe(true);
		const desc = result as GateDescriptor;
		expect(desc.denialContext).toMatchObject({
			kind: "bash_external_directory",
		});
	});
```

- [ ] **Step 4: 新增测试 — 不传 skillDirs 时行为不变（向后兼容）**

```typescript
	it("behaves identically when skillDirs is not passed (backward compat)", async () => {
		const result = await describeGate(
			makeTcc({ input: { command: "cat /outside/file.ts" } }),
			makeResolver(makeCheckResult("ask")),
		);
		expect(isGateDescriptor(result)).toBe(true);
	});
```

- [ ] **Step 5: 运行测试确认失败**

```bash
cd pi-permission-system && npx vitest run tests/handlers/gates/bash-external-directory.test.ts
```

Expected:
- 原有 11 个测试 PASS
- 新增 3 个测试中，Step 2（全部 skill 路径）和 Step 3（部分过滤）FAIL（`describeBashExternalDirectoryGate` 尚未接受第四个参数）
- Step 4（向后兼容）PASS（不传第四个参数时现有逻辑不变）

- [ ] **Step 6: Commit**

```bash
git add pi-permission-system/tests/handlers/gates/bash-external-directory.test.ts
git commit -m "test: add failing tests for skill-bundle path filtering"
```

---

### Task 2: 实现 `describeBashExternalDirectoryGate` 过滤逻辑

**Files:**
- Modify: `pi-permission-system/src/handlers/gates/bash-external-directory.ts`

**Interfaces:**
- Consumes: `isPathWithinDirectory` (from `path-utils`)
- Produces: `describeBashExternalDirectoryGate(tcc, bashProgram, resolver, skillDirs?)` — 新增可选参数

- [ ] **Step 1: 导入 `isPathWithinDirectory`**

在现有 import 块中添加：
```typescript
import { isPathWithinDirectory } from "../../path-utils";
```

- [ ] **Step 2: 添加 `skillDirs` 参数**

签名从：
```typescript
export function describeBashExternalDirectoryGate(
	tcc: ToolCallContext,
	bashProgram: BashProgram | null,
	resolver: ScopedPermissionResolver,
): GateResult {
```

改为：
```typescript
export function describeBashExternalDirectoryGate(
	tcc: ToolCallContext,
	bashProgram: BashProgram | null,
	resolver: ScopedPermissionResolver,
	skillDirs?: readonly string[],
): GateResult {
```

- [ ] **Step 3: 在 `externalPaths` 之后插入过滤逻辑**

将：
```typescript
	const externalPaths = bashProgram.externalPaths();
	if (externalPaths.length === 0) return null;

	// Resolve every external path ...
	const { uncovered: uncoveredEntries, worstCheck } = selectUncoveredExternalPaths(
		externalPaths,
		resolver,
		tcc.agentName ?? undefined,
	);
```

替换为：
```typescript
	const externalPaths = bashProgram.externalPaths();
	if (externalPaths.length === 0) return null;

	// Filter out paths within skill bundle directories — they are trusted by
	// virtue of the skill having been loaded.
	const nonSkillPaths = skillDirs?.length
		? externalPaths.filter((p) => {
				const boundary = p.boundaryValue();
				return !boundary || !skillDirs.some((dir) => isPathWithinDirectory(boundary, dir));
			})
		: externalPaths;

	// All external paths are within skill directories — allow silently.
	if (nonSkillPaths.length === 0) return null;

	// Resolve every external path on the external_directory surface and keep the
	// ones not already allowed (config-level allows suppress the prompt just as
	// session-level allows do); the shared helper single-sources the #418 alias
	// matching and the worst-uncovered selection.
	const { uncovered: uncoveredEntries, worstCheck } = selectUncoveredExternalPaths(
		nonSkillPaths,
		resolver,
		tcc.agentName ?? undefined,
	);
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd pi-permission-system && npx vitest run tests/handlers/gates/bash-external-directory.test.ts
```

Expected: 全部 14 个测试 PASS（包括 Task 1 新增的 3 个）

- [ ] **Step 5: Commit**

```bash
git add pi-permission-system/src/handlers/gates/bash-external-directory.ts
git commit -m "feat: filter skill-bundle paths in bash-external-directory gate"
```

---

### Task 3: 在 pipeline 中透传 skill 目录

**Files:**
- Modify: `pi-permission-system/src/handlers/gates/tool-call-gate-pipeline.ts`

- [ ] **Step 1: 提取 skill 目录并传入 gate**

在 `evaluate` 方法中，`const infraDirs` 行之后添加：
```typescript
		const skillDirs = this.inputs.getActiveSkillEntries()
			.map((e) => e.normalizedBaseDir)
			.filter(Boolean);
```

将 gate producer 调用从：
```typescript
			() => describeBashExternalDirectoryGate(tcc, bashProgram, this.resolver),
```
改为：
```typescript
			() => describeBashExternalDirectoryGate(tcc, bashProgram, this.resolver, skillDirs),
```

- [ ] **Step 2: 运行 pipeline 测试**

```bash
cd pi-permission-system && npx vitest run tests/handlers/gates/tool-call-gate-pipeline.test.ts
```

Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add pi-permission-system/src/handlers/gates/tool-call-gate-pipeline.ts
git commit -m "feat: pass skill dirs to bash-external-directory gate"
```

---

### Task 4: 最终验证

- [ ] **Step 1: 运行全量测试**

```bash
cd pi-permission-system && npx vitest run
```

Expected: All tests PASS

- [ ] **Step 2: TypeScript 编译检查**

```bash
cd pi-permission-system && npx tsc --noEmit
```

Expected: No errors
