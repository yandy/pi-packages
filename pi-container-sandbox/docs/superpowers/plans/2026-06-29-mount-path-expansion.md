# runtime.mounts 路径展开（~ / ${userHome}）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `loadSbxConfig()` 中对 `runtime.mounts[].source` 和 `runtime.cache` 做 `~` / `${userHome}` 展开。

**Architecture:** 在 `src/paths.ts` 中新增纯函数 `expandPath(raw: string): string`，在 `src/config.ts` 的 `loadSbxConfig()` 中调用它展开 mount source 和 cache 路径。所有下游代码无需修改。

**Tech Stack:** TypeScript, Node.js (`os.homedir()`), vitest

## Global Constraints

- `~` 展开为当前用户 home 目录（`os.homedir()`）
- `${userHome}` 占位符替换为当前用户 home 目录
- 大小写敏感：只认 `${userHome}`，不认 `${userhome}` / `${USER_HOME}`
- `~otheruser` 不展开，原样保留
- 仅展开 `source` 和 `cache` 字段，`target` 不展开

---

### Task 1: 实现 `expandPath()` 函数 + 单元测试

**Files:**
- Modify: `pi-container-sandbox/src/paths.ts` — 在末尾新增导出
- Modify: `pi-container-sandbox/tests/paths.test.ts` — 在末尾新增 describe 块

**Interfaces:**
- Produces: `expandPath(raw: string): string` — 导出自 `src/paths.ts`，Task 2 消费

- [ ] **Step 1: 写失败的测试**

在 `pi-container-sandbox/tests/paths.test.ts` 末尾新增 import 和测试（文件末尾的 `});` 之后追加）：

```typescript
import { expandPath } from "../src/paths";
import { homedir } from "node:os";

describe("expandPath", () => {
	it("expands ~ to homedir", () => {
		expect(expandPath("~")).toBe(homedir());
	});

	it("expands ~/path to homedir + /path", () => {
		expect(expandPath("~/data/projects")).toBe(homedir() + "/data/projects");
	});

	it("expands ${userHome} placeholder", () => {
		expect(expandPath("${userHome}/data")).toBe(homedir() + "/data");
	});

	it("does not expand ~otheruser", () => {
		expect(expandPath("~otheruser/stuff")).toBe("~otheruser/stuff");
	});

	it("leaves absolute paths unchanged", () => {
		expect(expandPath("/absolute/path")).toBe("/absolute/path");
	});

	it("handles multiple ${userHome} occurrences", () => {
		expect(expandPath("${userHome}/a/${userHome}/b")).toBe(
			homedir() + "/a/" + homedir() + "/b",
		);
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd pi-container-sandbox && npx vitest run tests/paths.test.ts -t "expandPath"
```

Expected: FAIL — `expandPath is not exported`

- [ ] **Step 3: 实现 `expandPath()`**

在 `pi-container-sandbox/src/paths.ts` 末尾新增：

```typescript
import { homedir } from "node:os";

export function expandPath(raw: string): string {
	const home = homedir();
	let result = raw;
	if (result === '~' || result.startsWith('~/')) {
		result = home + result.slice(1);
	}
	result = result.replace(/\$\{userHome\}/g, home);
	return result;
}
```

注意：`homedir` 的 import 需要加到文件顶部的 import 区域。现有 import：
```typescript
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
```
需要改为：
```typescript
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd pi-container-sandbox && npx vitest run tests/paths.test.ts -t "expandPath"
```

Expected: 6 tests PASS

- [ ] **Step 5: 运行全部测试确认无回归**

```bash
cd pi-container-sandbox && npx vitest run
```

Expected: All 121 tests PASS (115 existing + 6 new)

- [ ] **Step 6: Commit**

```bash
git add pi-container-sandbox/src/paths.ts pi-container-sandbox/tests/paths.test.ts
git commit -m "feat: add expandPath() with ~ and ${userHome} support"
```

---

### Task 2: 在 `loadSbxConfig()` 中集成路径展开 + 集成测试

**Files:**
- Modify: `pi-container-sandbox/src/config.ts` — 在 `loadSbxConfig()` 返回值前插入展开逻辑
- Modify: `pi-container-sandbox/tests/config.test.ts` — 在 `describe("new runtime fields")` 块末尾新增测试

**Interfaces:**
- Consumes: `expandPath(raw: string): string` from `src/paths.ts` (Task 1)

- [ ] **Step 1: 写失败的集成测试**

在 `pi-container-sandbox/tests/config.test.ts` 的 `describe("new runtime fields")` 块末尾（`it("new fields default to null/empty when not configured"` 之后，`});` 闭合之前）新增：

```typescript
	it("expands ~ and ${userHome} in mount source and cache fields", () => {
		const configDir = resolvePath(testDir, TEST_CONFIG_DIR);
		mkdirSync(configDir, { recursive: true });
		writeFileSync(resolvePath(configDir, "sandbox.json"), JSON.stringify({
			runtime: {
				mounts: [
					{ source: "~/projects", target: "/projects" },
					{ source: "${userHome}/tools", target: "/tools" },
				],
				cache: "~/sandbox-cache",
			},
		}));
		const cfg = loadSbxConfig(testDir);

		const home = require("node:os").homedir();
		expect(cfg.runtime.mounts).toEqual([
			{ source: home + "/projects", target: "/projects" },
			{ source: home + "/tools", target: "/tools" },
		]);
		expect(cfg.runtime.cache).toBe(home + "/sandbox-cache");
	});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd pi-container-sandbox && npx vitest run tests/config.test.ts -t "expands"
```

Expected: FAIL — `source` 和 `cache` 仍为原始值 `"~/projects"`，不等于展开后的值

- [ ] **Step 3: 在 `loadSbxConfig()` 中集成展开**

修改 `pi-container-sandbox/src/config.ts`：

**3a.** 在文件顶部 import 区域新增一条 import（现有 import 来自 `"node:fs"`、`"node:path"`、`"node:url"` 等，找个位置插入）：

```typescript
import { expandPath } from "./paths";
```

**3b.** 在 `loadSbxConfig()` 函数的 `return` 语句之前插入展开逻辑。当前函数以 `return {` 开始返回 `SbxConfig` 对象。改为先构建 config 对象，展开路径，再返回：

```typescript
export function loadSbxConfig(hostCwd: string): SbxConfig {
	const agentDir = getAgentDir();
	const globalRaw = readJsonFile(resolvePath(agentDir, "sandbox.json")) || {};
	const projectRaw = readJsonFile(getSbxConfigPath(hostCwd)) || {};

	const config: SbxConfig = {
		image: mergeGroup(
			mergeGroup(DEFAULT_SBX_CONFIG.image, extractGroup(globalRaw, "image") as Partial<ImageConfig>),
			extractGroup(projectRaw, "image") as Partial<ImageConfig>,
		),
		runtime: mergeGroup(
			mergeGroup(DEFAULT_SBX_CONFIG.runtime, extractGroup(globalRaw, "runtime") as Partial<RuntimeConfig>),
			extractGroup(projectRaw, "runtime") as Partial<RuntimeConfig>,
		),
		host: mergeGroup(
			mergeGroup(DEFAULT_SBX_CONFIG.host, extractGroup(globalRaw, "host") as Partial<HostConfig>),
			extractGroup(projectRaw, "host") as Partial<HostConfig>,
		),
	};

	// Expand ~ and ${userHome} in mount source and cache paths
	config.runtime.mounts = config.runtime.mounts.map((m) => ({
		...m,
		source: expandPath(m.source),
	}));
	if (config.runtime.cache) {
		config.runtime.cache = expandPath(config.runtime.cache);
	}

	return config;
}
```

- [ ] **Step 4: 运行集成测试确认通过**

```bash
cd pi-container-sandbox && npx vitest run tests/config.test.ts -t "expands"
```

Expected: 1 test PASS

- [ ] **Step 5: 运行全部测试确认无回归**

```bash
cd pi-container-sandbox && npx vitest run
```

Expected: All 122 tests PASS (115 existing + 6 from Task 1 + 1 from Task 2)

- [ ] **Step 6: Commit**

```bash
git add pi-container-sandbox/src/config.ts pi-container-sandbox/tests/config.test.ts
git commit -m "feat: expand ~ and ${userHome} in mount source and cache during config load"
```
