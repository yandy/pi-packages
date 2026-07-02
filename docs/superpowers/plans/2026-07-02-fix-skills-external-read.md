# Fix: `isInsideCwd` 缺少 `/skills` 路径识别

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 `isInsideCwd` 函数对 `/skills`（SKILLS_ROOT）路径无感知的问题，重命名为更准确的 `isInsideContainer`，使 `/skills` 及其子路径被正确识别为容器内合法路径。

**Architecture:** `isInsideCwd` 目前只检查 `/workspace` 和项目 cwd，不检查 `/skills` 挂载路径。这导致 `/skills` 根目录（不匹配子挂载点）触发 `getExternalPath` → `guardExternalRead` 中的 external read 逻辑。修复方式：重命名函数以反映"容器范围内路径"的语义，并加入 `SKILLS_ROOT` 判断。

**Tech Stack:** TypeScript, Vitest

## Global Constraints

- 不修改任何其他函数的行为
- 所有现有测试必须保持通过
- 遵循 TDD：先测试后实现

---

### Task 1: 写失败测试 —— `isInsideCwd` / `getExternalPath` 对 `/skills` 路径

**Files:**
- Modify: `pi-container-sandbox/tests/paths.test.ts`

**Interfaces:**
- Produces: 新增对 `isInsideCwd` 和 `getExternalPath` 的 `/skills` 路径测试用例

- [ ] **Step 1: 添加 `isInsideCwd` 对 `/skills` 路径的测试**

在 `describe("isInsideCwd", ...)` 块内，现有 "returns false for paths outside cwd" 测试之后，添加：

```typescript
	it("returns true for /skills paths", () => {
		expect(isInsideCwd("/skills", testDir)).toBe(true);
		expect(isInsideCwd("/skills/find-docs/SKILL.md", testDir)).toBe(true);
	});
```

- [ ] **Step 2: 添加 `getExternalPath` 对 `/skills` 路径的测试**

在 `describe("getExternalPath", ...)` 块内，现有 "returns null for /workspace paths" 测试之后，添加：

```typescript
	it("returns null for /skills paths", () => {
		expect(getExternalPath("/skills", testDir, [])).toBeNull();
		expect(getExternalPath("/skills/my-skill/SKILL.md", testDir, [])).toBeNull();
	});
	it("returns null for /skills paths with mounts present", () => {
		const mounts: MountSpec[] = [{ source: "/host/skills", target: "/skills/my-skill" }];
		expect(getExternalPath("/skills/my-skill/SKILL.md", testDir, mounts)).toBeNull();
		expect(getExternalPath("/skills/my-skill", testDir, mounts)).toBeNull();
	});
```

- [ ] **Step 3: 运行测试，确认失败**

```bash
cd pi-container-sandbox && npx vitest run tests/paths.test.ts
```

预期：`isInsideCwd` 的 `/skills` 测试 FAIL，`getExternalPath` 的 `/skills` 测试中 "/skills" 那条 FAIL。

- [ ] **Step 4: Commit 测试**

```bash
git add pi-container-sandbox/tests/paths.test.ts
git commit -m "test: add failing tests for /skills paths in isInsideCwd and getExternalPath"
```

---

### Task 2: 实现修复 —— 重命名 `isInsideCwd` → `isInsideContainer` + 加 `/skills` 检查

**Files:**
- Modify: `pi-container-sandbox/src/paths.ts` (isInsideCwd 函数 & export)
- Modify: `pi-container-sandbox/src/ops.ts` (import & 调用处)

**Interfaces:**
- Consumes: `SKILLS_ROOT` 常量（已在 paths.ts 中定义）
- Produces: `isInsideContainer(hostPath: string, hostCwd: string): boolean` 替代 `isInsideCwd`

- [ ] **Step 1: 在 `paths.ts` 中重命名并加逻辑**

将 `isInsideCwd` 函数改为：

```typescript
export function isInsideContainer(hostPath: string, hostCwd: string): boolean {
	if (hostPath === CONTAINER_ROOT || hostPath.startsWith(`${CONTAINER_ROOT}/`)) return true;
	if (hostPath === SKILLS_ROOT || hostPath.startsWith(`${SKILLS_ROOT}/`)) return true;
	const abs = resolvePath(hostCwd, hostPath);
	return abs === hostCwd || abs.startsWith(`${hostCwd}/`);
}
```

同时更新 `getExternalPath` 中的调用（从 `isInsideCwd` 改为 `isInsideContainer`）。

- [ ] **Step 2: 在 `ops.ts` 中更新 import 和调用**

import 行：
```typescript
import { hostToContainer, isAllowedExternalResource, isInsideContainer, isReadOnlyMount, containerToHost, shq } from "./paths";
```

`tryExternal` 中的调用：
```typescript
if (isInsideContainer(p, sbx.hostCwd)) return { external: false };
```

- [ ] **Step 3: 更新测试文件中的 import 和调用**

`paths.test.ts`:
```typescript
import { ..., isInsideContainer, ... } from "../src/paths";
```

测试块名称改为 `describe("isInsideContainer", ...)`。

- [ ] **Step 4: 运行测试确认通过**

```bash
cd pi-container-sandbox && npx vitest run tests/paths.test.ts
```

预期：所有测试通过（包括新增的 `/skills` 测试）。

- [ ] **Step 5: Commit 实现**

```bash
git add pi-container-sandbox/src/paths.ts pi-container-sandbox/src/ops.ts pi-container-sandbox/tests/paths.test.ts
git commit -m "fix: rename isInsideCwd to isInsideContainer and add /skills path recognition"
```

---

### Task 3: 验证 —— 全量测试

**Files:**
- (无修改，仅验证)

- [ ] **Step 1: 运行 pi-container-sandbox 全量测试**

```bash
cd pi-container-sandbox && npx vitest run
```

预期：140 tests passed (3 新增) = 143 tests passed。

- [ ] **Step 2: Commit（如有必要）**

如果全量测试通过不需要额外修改，跳过。
