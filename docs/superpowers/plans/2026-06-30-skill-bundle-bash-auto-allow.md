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

### Task 1: 改造 `describeBashExternalDirectoryGate` 支持 skill 路径过滤

**Files:**
- Modify: `pi-permission-system/src/handlers/gates/bash-external-directory.ts`

**Interfaces:**
- Consumes: `AccessPath` (via `bashProgram.externalPaths()`), `isPathWithinDirectory` (from `path-utils`)
- Produces: `describeBashExternalDirectoryGate(tcc, bashProgram, resolver, skillDirs?)` — 新增可选参数 `skillDirs: string[]`

- [ ] **Step 1: 导入 `isPathWithinDirectory`**

```typescript
import { isPathWithinDirectory } from "../../path-utils";
```

- [ ] **Step 2: 添加 `skillDirs` 参数并过滤**

在 `describeBashExternalDirectoryGate` 中：

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

在 `const externalPaths = bashProgram.externalPaths();` 之后、`selectUncoveredExternalPaths` 之前插入过滤：

```typescript
	const externalPaths = bashProgram.externalPaths();
	if (externalPaths.length === 0) return null;

	// Filter out paths within skill bundle directories — they are trusted by
	// virtue of the skill having been loaded.
	const skillPaths: AccessPath[] = [];
	const nonSkillPaths = skillDirs?.length
		? externalPaths.filter((p) => {
				const boundary = p.boundaryValue();
				if (!boundary) return true;
				const isSkillPath = skillDirs.some((dir) => isPathWithinDirectory(boundary, dir));
				if (isSkillPath) {
					skillPaths.push(p);
					return false;
				}
				return true;
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

- [ ] **Step 3: 更新 JSDoc**

在函数 JSDoc 中补充 `skillDirs` 参数说明：

```
 * @param skillDirs Optional list of normalized absolute directories of
 *   currently loaded skills. External paths within any of these directories
 *   are excluded from the external-directory check.
```

- [ ] **Step 4: 运行现有测试确认兼容**

```bash
cd pi-permission-system && npx vitest run tests/handlers/gates/bash-external-directory.test.ts
```

Expected: All existing tests PASS（`skillDirs` 参数是可选的，不传时行为不变）

- [ ] **Step 5: Commit**

```bash
git add pi-permission-system/src/handlers/gates/bash-external-directory.ts
git commit -m "feat: filter skill-bundle paths in bash-external-directory gate"
```

---

### Task 2: 在 pipeline 中透传 skill 目录

**Files:**
- Modify: `pi-permission-system/src/handlers/gates/tool-call-gate-pipeline.ts`

**Interfaces:**
- Consumes: `this.inputs.getActiveSkillEntries()` (已有)
- Changes: `describeBashExternalDirectoryGate` 调用处多传一个参数

- [ ] **Step 1: 提取 skill 目录并传入 gate**

在 `evaluate` 方法中，`const infraDirs` 之后添加：

```typescript
		const skillDirs = this.inputs.getActiveSkillEntries()
			.map((e) => e.normalizedBaseDir)
			.filter(Boolean);
```

将 gate producer 从：
```typescript
			() => describeBashExternalDirectoryGate(tcc, bashProgram, this.resolver),
```

改为：
```typescript
			() => describeBashExternalDirectoryGate(tcc, bashProgram, this.resolver, skillDirs),
```

- [ ] **Step 2: 运行现有测试确认兼容**

```bash
cd pi-permission-system && npx vitest run tests/handlers/gates/tool-call-gate-pipeline.test.ts
```

Expected: All existing tests PASS

- [ ] **Step 3: Commit**

```bash
git add pi-permission-system/src/handlers/gates/tool-call-gate-pipeline.ts
git commit -m "feat: pass skill dirs to bash-external-directory gate"
```

---

### Task 3: 添加测试

**Files:**
- Modify: `pi-permission-system/tests/handlers/gates/bash-external-directory.test.ts`

- [ ] **Step 1: 新增测试 — skill 路径全部被过滤时返回 null**

```typescript
	it("returns null when all external paths are within skill directories", async () => {
		const skillDirs = ["/home/.pi/agent-code/git/github.com/yandy/superpowers/skills/sdd"];
		const resolver = makeResolver(makeCheckResult("ask"));
		const result = await describeGate(
			makeTcc({
				input: { command: "bash /home/.pi/agent-code/git/github.com/yandy/superpowers/skills/sdd/scripts/review-package abc123 HEAD" },
			}),
			resolver,
			skillDirs,
		);
		expect(result).toBeNull();
	});
```

注意：`describeGate` 辅助函数也需要扩展以支持第四个参数。在其签名中添加：

```typescript
async function describeGate(
	tcc: ToolCallContext,
	resolver: ScopedPermissionResolver,
	skillDirs?: readonly string[],
): Promise<GateResult> {
	// ... same body, but pass skillDirs:
	return describeBashExternalDirectoryGate(tcc, bashProgram, resolver, skillDirs);
}
```

- [ ] **Step 2: 新增测试 — 部分 skill 路径被过滤，剩余路径触发 gate**

```typescript
	it("returns descriptor for non-skill external paths when skill paths are filtered", async () => {
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
		// Only the non-skill path (/etc/hosts) should remain
		expect(desc.denialContext).toMatchObject({
			kind: "bash_external_directory",
		});
	});
```

- [ ] **Step 3: 新增测试 — 不传 skillDirs 时行为不变（向后兼容）**

```typescript
	it("behaves identically when skillDirs is not passed (backward compat)", async () => {
		const resolver = makeResolver(makeCheckResult("ask"));
		// Call without skillDirs — should produce a descriptor as before
		const result = await describeGate(
			makeTcc({ input: { command: "cat /outside/file.ts" } }),
			resolver,
		);
		expect(isGateDescriptor(result)).toBe(true);
	});
```

- [ ] **Step 4: 运行测试**

```bash
cd pi-permission-system && npx vitest run tests/handlers/gates/bash-external-directory.test.ts
```

Expected: 原有测试 + 3 个新测试均 PASS

- [ ] **Step 5: Commit**

```bash
git add pi-permission-system/tests/handlers/gates/bash-external-directory.test.ts
git commit -m "test: skill-bundle path filtering in bash-external-directory gate"
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
