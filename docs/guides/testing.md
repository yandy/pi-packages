# 测试规范

本文档是 monorepo 中所有 pi package 的测试统一规范。

## 目录

- [通用约定](#通用约定)
  - [异步等待](#异步等待)
- [环境隔离](#环境隔离)
  - [文件系统隔离](#文件系统隔离)
  - [环境变量隔离](#环境变量隔离)
  - [`getAgentDir` 隔离](#getagentdir-隔离)
  - [参数注入](#参数注入)
- [检查清单](#检查清单)
- [常见模式参考](#常见模式参考)

---

## 通用约定

### 目录与命名

- 测试文件放在 `tests/`，命名为 `<module>.test.ts`
- 测试框架为 `vitest`

### 配置

每个 Extension package 的 `vitest.config.ts`：

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
```

根 `vitest.config.ts` 使用 `projects` 字段按需覆盖（纯 Skills 包无测试，不用注册）：

```ts
export default defineConfig({
  test: {
    projects: ["pi-ask-user", "pi-coding-tools", /* ... */],
  },
});
```

### 脚本

`package.json` 中的 scripts：

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

### 异步等待

触发异步 handler / 回调后，**断言其副作用前必须等条件成立**，不能用
`await new Promise((r) => setTimeout(r, 0))` 顶替——那是猜时间，被测链里只要有真实 I/O 就会
偶发失败，而且只在并行跑整仓时暴露。

实测（pi-memory `/dream`，2026-10-24）：成功回调在 `notify` 之前 `await SessionManager.list(cwd)`
（真实磁盘 I/O），测试只等一个 tick。空闲机器上 tick 被 clamp 到 0–4ms，而 `list` 中位 1.4ms、
最长 6.4ms——300 次里 **5 次 tick 先到（1.7%）**；整仓 26 个 vitest worker 并行时余量进一步被吃掉，
于是表现为「包内单跑必绿、`npm test` 偶发红」。

```ts
/** 等条件成立（10ms 轮询，默认 2s 封顶，超时抛明确错误）。 */
async function waitFor(condition: () => boolean, description: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${description} after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

await waitFor(() => notify.mock.calls.length > 0, "dream completion notify");
expect(notify).toHaveBeenCalledWith("consolidated", "info");
```

- **负向断言**（断言"没被调用"）不要用 `waitFor`：条件本来就不会成立，等满超时再失败。这类断言保留
  `flush()`（或等一个已知时间窗口），并说明为什么这个窗口足够。
- **防止回退**：把被测链里的真实 I/O 依赖固定拖慢到 tick 之上（如
  `vi.spyOn(SessionManager, "list")` 延迟 30ms），这样谁把 `waitFor` 换回 `flush`，用例会**确定性**变红。
- 只有**确实在测时间行为**（debounce、interval、超时）时才用固定 sleep，并注明"为什么是这个值"。
- 轮询间隔不要小于 10ms（`setTimeout(check, 1)` 白烧 CPU）。

---

## 环境隔离

任何会受配置文件、环境变量、文件系统路径影响的测试，**必须在隔离环境中运行**，不得依赖运行机器的真实状态。

### 文件系统隔离

使用 `mkdtemp` + `tmpdir()` 创建临时目录，`beforeEach` 创建、`afterEach` 清理：

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pkg-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
```

同步版本（适用于 `vi.mock` hoisting 场景）：

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pkg-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
```

**禁止**使用硬编码路径（如 `/tmp/my-test-dir`）——即使有清理逻辑，并行运行时仍会冲突。

### 环境变量隔离

`process.env` 的修改必须在 `afterEach` 中恢复。

推荐使用 vitest 提供的 `vi.stubEnv()`：

```ts
import { vi } from "vitest";

beforeEach(() => { vi.stubEnv("MY_VAR", "test-value"); });
afterEach(() => { vi.unstubAllEnvs(); });
```

或手动存取原始值：

```ts
let original: string | undefined;
beforeEach(() => {
  original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tempDir;
});
afterEach(() => {
  if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = original;
});
```

特别注意 `PI_CODING_AGENT_DIR` —— 它会影响全局和项目 config 的查询路径。详见[下一节](#getagentdir-隔离)。

### `getAgentDir` 隔离

`getAgentDir()` 的实现会读取 `PI_CODING_AGENT_DIR` 环境变量，未设置时回退到 `homedir()/.pi/agent`。测试必须确保它落到隔离路径，三选一：

| 方式 | 示例 | 适用场景 |
|------|------|----------|
| Mock `getAgentDir` | `vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => tempDir }))` | 不关心 `PI_CODING_AGENT_DIR` 环境变量本身的测试 |
| Stub `PI_CODING_AGENT_DIR` | `vi.stubEnv("PI_CODING_AGENT_DIR", tempDir)` | 需要验证 `PI_CODING_AGENT_DIR` 环境变量行为的测试；**跨平台首选** |
| 替换 `HOME` | `process.env.HOME = tempDir` | ⚠️ 仅 POSIX 有效。Windows 上 `os.homedir()` 读 `USERPROFILE` 而非 `HOME`，该方式在 Windows 静默失效（干净 CI runner 上碰巧通过、开发者机器上失败），跨平台测试请改用上面两种方式 |

> **平台注意**：`os.homedir()` 在 Windows 读 `USERPROFILE`，在 POSIX 读 `HOME`。任何依赖 `HOME` 的隔离都必须同时覆盖两个平台的真实读取源，否则 Windows CI 与本地行为会分叉。

三种方式的共同点：`tempDir` 都来自 `mkdtemp(join(tmpdir(), ...))`。

> **注意**：当使用 `vi.mock` mock `getAgentDir` 时，mock 函数是 **hoisting** 的（在 import 之前执行），因此 mock 内无法引用 `beforeEach` 中创建的临时目录变量。需要使用 `vi.hoisted()` 创建一个可变引用，然后在 `beforeEach` 中修改它。

### 参数注入

被测函数应接受可注入的路径参数（如 `loadConfig(dir)`），而非硬编码读取 `~/.pi/`、`process.cwd()` 或 `homedir()`。如果源码尚未支持，可添加内部参数（如 `_globalDir`、`_cwd`）供测试注入。

示例：

```ts
// 源码
export function loadConfig(opts?: { _globalDir?: string }) {
  const globalDir = opts?._globalDir ?? getAgentDir();
  // ...
}

// 测试
it("reads config from temp dir", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfg-"));
  const cfg = await loadConfig({ _globalDir: dir });
  // ...
});
```

---

## 检查清单

- [ ] 没有直接读写 `~/.pi/`、`process.cwd()/.pi/`、`homedir()` 等真实路径
- [ ] 文件系统操作使用 `tmpdir()` + `mkdtemp()`，且在 `afterEach` 中清理
- [ ] `process.env` 修改有恢复逻辑，或使用 `vi.stubEnv()`
- [ ] `PI_CODING_AGENT_DIR` 被正确处理（stub 或显式注入）
- [ ] `getAgentDir()` 的返回值被隔离（mock / stub `PI_CODING_AGENT_DIR` / 替换 `HOME`，三选一）
- [ ] 不使用硬编码的 `/tmp/xxx` 路径（并行运行会冲突）
- [ ] 被测函数接受路径参数注入（而非硬编码读取真实路径）
- [ ] 异步副作用用 `waitFor` 等条件，不是猜一个 `setTimeout(0)`（见[异步等待](#异步等待)）
- [ ] 负向断言（"没被调用"）没有套用 `waitFor`；确有固定等待处注明了原因

---

## 常见模式参考

以下为项目中各 package 的实测参考文件：

| 模式 | 参考文件 |
|------|----------|
| 文件系统隔离 + 路径注入 | `pi-vision-tools/tests/config.test.ts` |
| 配置双向合并（global + project） | `pi-memory/tests/config.test.ts` |
| 环境变量 stub + 文件系统隔离 | `pi-sandbox/tests/index-smoke.test.ts` |
| Mock `getAgentDir` + 完整 mock | `pi-coding-tools/tests/config.test.ts`、`pi-web-tools/tests/config.test.ts` |
| `vi.stubEnv("PI_CODING_AGENT_DIR")` 隔离 getAgentDir + `mkdtempSync` 双目录（global/project）隔离 | `pi-sandbox/tests/config.test.ts` |
| `vi.hoisted()` + `mkdtempSync` 解决 hoisting | `pi-container-sandbox/tests/config-global-merge.test.ts` |
| Stub `PI_CODING_AGENT_DIR` 隔离全局目录（跨平台） | `pi-subagents/tests/config/custom-agents.test.ts` |
| 双目录隔离（globalDir + projectDir）工具函数 | `pi-subagents/tests/helpers/tmp-settings-dirs.ts` |
| 异步条件等待（真实 I/O 之后断言副作用 + 拖慢依赖防回退） | `pi-memory/tests/index-wiring.test.ts` |
