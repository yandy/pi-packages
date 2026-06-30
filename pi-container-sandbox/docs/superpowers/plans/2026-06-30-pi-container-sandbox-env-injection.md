# pi-container-sandbox Env Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 支持用户通过 `sandbox.json` 配置向 Docker 容器注入环境变量，值中支持 shell 命令替换（如 `$(cat /path/to/file)`），在宿主机上展开后传入容器。

**Architecture:** 在已有配置流水线（sandbox.json → loadSbxConfig → RuntimeConfig → SandboxOptions → DockerRuntime）中新增 `env` 字段，展开发生在 `startContainer()` 内部调用 Docker API 之前。

**Tech Stack:** TypeScript, Node.js `child_process.execSync`, dockerode, vitest

## Global Constraints

- 仅通过 `sandbox.json` 配置，不走命令行参数
- env 格式为 `"KEY=VALUE"` 字符串数组
- VALUE 部分在宿主机上通过 `bash -c 'echo -n "<VALUE>"'` 展开
- 展开失败降级为原始字面值，不阻塞容器启动
- 配置合并：项目级覆盖全局级（与其他 runtime 字段一致）
- ExecOpts.env per-exec 通道本次不改动

---

### Task 1: Config model — 添加 env 字段到 RuntimeConfig 和默认配置

**Files:**
- Modify: `src/config.ts:15-29` (RuntimeConfig interface)
- Modify: `src/config.ts:31-38` (DEFAULT_SBX_CONFIG)

**Interfaces:**
- Produces: `RuntimeConfig.env?: string[]` — 供 Task 3 在 `loadSbxConfig()` 读取后传入 `SandboxOptions`

- [ ] **Step 1: 写入测试 — 验证 env 字段默认值和解析**

```typescript
// 在 tests/config.test.ts 的 describe("new runtime fields") 块末尾添加：

it("parses env array from runtime group", () => {
  const configDir = resolvePath(testDir, TEST_CONFIG_DIR);
  mkdirSync(configDir, { recursive: true });
  writeFileSync(resolvePath(configDir, "sandbox.json"), JSON.stringify({
    runtime: { env: ["NODE_ENV=production", "DEBUG=app:*"] },
  }));
  const cfg = loadSbxConfig(testDir);
  expect(cfg.runtime.env).toEqual(["NODE_ENV=production", "DEBUG=app:*"]);
});

it("env defaults to empty array when not configured", () => {
  const cfg = loadSbxConfig(testDir);
  expect(cfg.runtime.env).toEqual([]);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd pi-container-sandbox && npx vitest run tests/config.test.ts -t "env"
```

Expected: TypeScript 编译错误 — `runtime.env` 不存在

- [ ] **Step 3: 实现 — 添加 env 字段**

`src/config.ts` — RuntimeConfig 接口，在 `mounts` 后添加：

```typescript
export interface RuntimeConfig {
	name: string | null;
	tier: SizeTier;
	network: boolean;
	persist: boolean;
	memory: string | null;
	cpus: string | null;
	swap: string | null;
	pidsLimit: number | null;
	cache: string | null;
	mounts: MountConfig[];
	env?: string[];
}
```

`src/config.ts` — DEFAULT_SBX_CONFIG.runtime，在 `mounts: []` 后添加 `env: []`：

```typescript
export const DEFAULT_SBX_CONFIG: SbxConfig = {
	image: { name: "pi-container-sandbox", tag: "latest" },
	runtime: {
		name: null, tier: "medium", network: true, persist: false,
		memory: null, cpus: null, swap: null, pidsLimit: null,
		cache: null, mounts: [], env: [],
	},
	host: { commands: [] },
};
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd pi-container-sandbox && npx vitest run tests/config.test.ts -t "env"
```

Expected: 2 tests PASS

- [ ] **Step 5: 运行全部 config 测试确保无回归**

```bash
cd pi-container-sandbox && npx vitest run tests/config.test.ts
```

Expected: All tests PASS

- [ ] **Step 6: 提交**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(pi-container-sandbox): add env field to RuntimeConfig and defaults"
```

---

### Task 2: Runtime — 添加 env 到 SandboxOptions，实现展开，合并到容器 Env

**Files:**
- Modify: `src/runtime.ts:30-42` (SandboxOptions interface)
- Modify: `src/runtime.ts:175-220` (startContainer 方法, createContainer 调用处)
- Modify: `src/runtime.ts:1-11` (import 区域, 新增 `execSync`)
- Create: `tests/runtime-env.test.ts`

**Interfaces:**
- Consumes: `SandboxOptions.env?: string[]` — 由 Task 3 从 `config.runtime.env` 传入
- Produces: `DockerRuntime.startContainer()` 内展开并合并后的 `Env` 数组

- [ ] **Step 1: 写入测试 — 验证 env 展开和传给 Docker 的行为**

创建 `tests/runtime-env.test.ts`：

```typescript
import { execSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

// Unit test: verify expandEnvValue helper
// We import the (soon-to-be-created) helper function.
// Since it's not exported yet, we inline a local equivalent for now.

function expandEnvValue(key: string, value: string, cwd: string): string {
  try {
    const expanded = execSync(
      `bash -c 'echo -n "${value.replace(/'/g, "'\"'\"'")}"'`,
      { encoding: "utf-8", timeout: 5000, cwd }
    );
    return `${key}=${expanded}`;
  } catch {
    return `${key}=${value}`;
  }
}

describe("expandEnvValue", () => {
  it("passes through plain values unchanged", () => {
    const result = expandEnvValue("NODE_ENV", "production", "/tmp");
    expect(result).toBe("NODE_ENV=production");
  });

  it("expands shell command substitution with $(...)", () => {
    // Write a temp file with known content, then cat it via $(...)
    const tmpFile = "/tmp/pi-test-env-expand-" + Date.now();
    execSync(`echo -n "secret-token" > "${tmpFile}"`);
    try {
      const result = expandEnvValue("TOKEN", `$(cat "${tmpFile}")`, "/tmp");
      expect(result).toBe("TOKEN=secret-token");
    } finally {
      execSync(`rm -f "${tmpFile}"`);
    }
  });

  it("expands $HOME variable reference", () => {
    const home = process.env.HOME || "/home/user";
    const result = expandEnvValue("HOME_DIR", "$HOME", "/tmp");
    expect(result).toBe(`HOME_DIR=${home}`);
  });

  it("falls back to literal on invalid shell expression", () => {
    const result = expandEnvValue("KEY", "$(nonexistent-command 2>/dev/null)", "/tmp");
    // The command fails → falls back to literal
    expect(result).toBe("KEY=$(nonexistent-command 2>/dev/null)");
  });

  it("handles values with single quotes by escaping them", () => {
    const result = expandEnvValue("MSG", "it's working", "/tmp");
    expect(result).toBe("MSG=it's working");
  });

  it("preserves key=value format with multiple equals signs", () => {
    // Value contains = → still works, only the first = splits key/value
    const result = expandEnvValue("URL", "https://example.com?a=1&b=2", "/tmp");
    expect(result).toBe("URL=https://example.com?a=1&b=2");
  });
});

describe("env merge order", () => {
  it("builtin env comes before user env, user can override", () => {
    // Simulate what startContainer does
    const builtinEnv = ["DEBIAN_FRONTEND=noninteractive"];
    const userEnv = ["DEBIAN_FRONTEND=dialog", "CUSTOM=val"];
    const merged = [...builtinEnv, ...userEnv.map((e) => e)];
    // Docker uses the LAST occurrence for dup keys, so user's override wins
    expect(merged).toEqual([
      "DEBIAN_FRONTEND=noninteractive",
      "DEBIAN_FRONTEND=dialog",
      "CUSTOM=val",
    ]);
  });

  it("when env is undefined, use builtin only", () => {
    const builtinEnv = ["DEBIAN_FRONTEND=noninteractive"];
    const userEnv: string[] | undefined = undefined;
    const env = [...builtinEnv, ...(userEnv ?? [])];
    expect(env).toEqual(["DEBIAN_FRONTEND=noninteractive"]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd pi-container-sandbox && npx vitest run tests/runtime-env.test.ts
```

Expected: All expandEnvValue tests PASS (helper is local), merge tests PASS

- [ ] **Step 3: 实现 — SandboxOptions 添加 env 字段**

`src/runtime.ts` — SandboxOptions 接口，在 `cacheVolume` 后添加：

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
	onProgress?: (msg: string) => void;
	env?: string[];
}
```

- [ ] **Step 4: 实现 — env 展开和合并**

`src/runtime.ts` — 在文件顶部 import 区域添加 `execSync`：

```typescript
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import Dockerode from "dockerode";
import { PACKAGE_DOCKER_DIR } from "./config";
```

`src/runtime.ts` — DockerRuntime 类内，在 `_parseBytes` 方法前添加 `_expandEnv` 私有方法：

找到 `private _parseBytes` 所在行（约第 350 行），在其上方插入：

```typescript
	private _expandEnv(entries: string[]): string[] {
		return entries.map((entry) => {
			const eqIdx = entry.indexOf("=");
			if (eqIdx === -1) return entry; // 无 = 的非法格式，原样保留
			const key = entry.slice(0, eqIdx);
			const value = entry.slice(eqIdx + 1);
			try {
				const expanded = execSync(
					`bash -c 'echo -n "${value.replace(/'/g, "'\"'\"'")}"'`,
					{ encoding: "utf-8", timeout: 5000, cwd: this.opts.hostCwd },
				);
				return `${key}=${expanded}`;
			} catch {
				return entry; // 展开失败降级为原始值
			}
		});
	}
```

`src/runtime.ts` — `startContainer()` 方法，将硬编码的 Env 替换为合并版本。

找到（约第 216 行）：

```typescript
		Env: ["DEBIAN_FRONTEND=noninteractive"],
```

替换为：

```typescript
		Env: [
			"DEBIAN_FRONTEND=noninteractive",
			...this._expandEnv(this.opts.env ?? []),
		],
```

- [ ] **Step 5: 运行 runtime-env 测试确认通过**

```bash
cd pi-container-sandbox && npx vitest run tests/runtime-env.test.ts
```

Expected: All tests PASS

- [ ] **Step 6: 运行全部 runtime 测试确保无回归**

```bash
cd pi-container-sandbox && npx vitest run tests/runtime.test.ts
```

Expected: All tests PASS (Docker-dependent tests skip if Docker unavailable)

- [ ] **Step 7: 提交**

```bash
git add src/runtime.ts tests/runtime-env.test.ts
git commit -m "feat(pi-container-sandbox): add env expansion and injection in startContainer"
```

---

### Task 3: index.ts — 将 config.runtime.env 传入 SandboxOptions

**Files:**
- Modify: `index.ts:158-175` (session_start handler 中 DockerRuntime 构造处)

**Interfaces:**
- Consumes: `config.runtime.env?: string[]` — 由 Task 1 从 `loadSbxConfig()` 产生
- Produces: 传入 `new DockerRuntime({ ..., env })` 的参数

- [ ] **Step 1: 实现 — 在 session_start 中读取并传入 env**

`index.ts` — 在 `session_start` hook 内，`DockerRuntime` 构造处。

找到（约第 225 行，`const runtime = new DockerRuntime({` 附近）：

```typescript
		const runtime = new DockerRuntime({
			image, hostCwd: localCwd, name: sandboxName, allowNetwork,
			resources,
			extraMounts: allMounts.length ? allMounts : undefined,
			cacheVolume,
			onProgress: (msg: string) => ctx.ui.setStatus("sandbox", `[build] ${msg}`),
		});
```

在 `cacheVolume` 后添加 `env`：

```typescript
		const runtime = new DockerRuntime({
			image, hostCwd: localCwd, name: sandboxName, allowNetwork,
			resources,
			extraMounts: allMounts.length ? allMounts : undefined,
			cacheVolume,
			env: cfg.runtime.env,
			onProgress: (msg: string) => ctx.ui.setStatus("sandbox", `[build] ${msg}`),
		});
```

- [ ] **Step 2: 编译验证**

```bash
cd pi-container-sandbox && npx tsc --noEmit
```

Expected: No compilation errors

- [ ] **Step 3: 运行全部测试确保无回归**

```bash
cd pi-container-sandbox && npx vitest run
```

Expected: All tests PASS (Docker-dependent tests skip if unavailable)

- [ ] **Step 4: 提交**

```bash
git add index.ts
git commit -m "feat(pi-container-sandbox): wire config.runtime.env into DockerRuntime"
```

---

### Task 4: 更新 README 文档

**Files:**
- Modify: `README.zh.md` (sandbox.json 配置参考表格)
- Modify: `README.md` (英文版同步)

**Interfaces:**
- 无代码接口，纯文档变更

- [ ] **Step 1: 读取 sandbox.json 配置参考区域**

- [ ] **Step 2: 在 RuntimeConfig 配置表格中添加 env 行**

在 `README.zh.md` 和 `README.md` 的 `runtime` 配置表格中，`mounts` 之后添加：

```markdown
| `env` | `string[]` | `[]` | 注入容器的环境变量，格式 `"KEY=VALUE"`。值支持 shell 命令替换（如 `"TOKEN=$(cat /path/to/file)"`），在宿主机上展开后传入容器。展开失败时降级为原始字面值 |
```

英文版对应：

```markdown
| `env` | `string[]` | `[]` | Environment variables injected into the container in `"KEY=VALUE"` format. Values support shell command substitution (e.g. `"TOKEN=$(cat /path/to/file)"`), expanded on the host before passing to Docker. Falls back to literal value on expansion failure |
```

- [ ] **Step 3: 查看渲染效果确认**

```bash
cat pi-container-sandbox/README.zh.md | grep -A1 "env"
```

- [ ] **Step 4: 提交**

```bash
git add README.md README.zh.md
git commit -m "docs(pi-container-sandbox): document env injection in README"
```

---

### Task 5: 运行全量测试和最终检查

**Files:**
- 无代码变更，仅验证

- [ ] **Step 1: 运行全量 vitest 测试**

```bash
cd pi-container-sandbox && npx vitest run
```

Expected: All tests PASS

- [ ] **Step 2: TypeScript 编译检查**

```bash
cd pi-container-sandbox && npx tsc --noEmit
```

Expected: No errors

- [ ] **Step 3: 检查 git 状态**

```bash
cd pi-container-sandbox && git status && git log --oneline -5
```

- [ ] **Step 4: (可选) 在测试项目创建 sandbox.json 手动验证**

```json
{
  "runtime": {
    "env": ["NODE_ENV=staging", "CUSTOM_VAR=hello"]
  }
}
```

启动 pi 后检查容器内 `echo $NODE_ENV` 应输出 `staging`。
