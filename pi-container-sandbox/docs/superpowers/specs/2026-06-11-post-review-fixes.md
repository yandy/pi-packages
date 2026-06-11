# Post-Review Fixes

## 背景

对 `improve-build-image` 分支 (6c03f22..5f46e51) 做了全面 review，涵盖架构、代码质量、冗余代码、测试合理性四个维度。发现 3 个 Critical、5 个 Important、5 个 Minor 问题，以及 8 个测试质量改进点。

## 目标

1. 修复所有 Critical 和 Important 问题
2. 精简测试代码，消除冗余
3. 补充 ops/commands 模块缺失的测试覆盖

---

## 一、运行时修复

### 1.1 信号处理器异步泄漏 (Critical)

**文件**: `index.ts:315-325`

**问题**: 信号/退出处理器中 `shutdown()` 未被 await。
- `process.on("exit")` 不支持异步 —— 直接 fire-and-forget
- `SIGINT`/`SIGTERM` 处理器 `cleanup()` 后立即 `process.exit()`，未等待 shutdown

**修复**: 将 `beforeExit` 替换 `exit`（支持 async）；SIGINT/SIGTERM 中 await shutdown 后再 exit。

```ts
// 替换 process.on("exit", cleanup) 为:
process.on("beforeExit", async () => {
  if (cleaned) return;
  cleaned = true;
  const s = getSbx();
  if (s && !s.keep) await s.runtime.shutdown();
  clearSbx();
});

// SIGINT/SIGTERM 改为 async:
process.once("SIGINT", async () => {
  if (cleaned) return;
  cleaned = true;
  const s = getSbx();
  if (s && !s.keep) await s.runtime.shutdown();
  clearSbx();
  process.exit(130);
});
```

### 1.2 容器名超长截断 (Critical)

**文件**: `src/runtime.ts:59-64`

**问题**: `deriveContainerName` 对长路径（如嵌套 monorepo `/home/user/very/long/path/project-name`）产生的容器名可能超过 Docker 128 字符限制，导致容器创建失败。

**修复**: 截断 basename，确保 `pi-sbx-${basename}-${hash}` ≤ 128：

```ts
export function deriveContainerName(hostCwd: string): string {
  const normalized = hostCwd.replace(/\/+$/, "");
  const basename = normalized.split("/").filter(Boolean).pop() || "project";
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 6);
  const maxBasenameLen = 128 - `pi-sbx--${hash}`.length;
  const truncated = basename.length > maxBasenameLen
    ? basename.slice(0, maxBasenameLen)
    : basename;
  return `pi-sbx-${truncated}-${hash}`;
}
```

### 1.3 镜像构建超时 (Critical)

**文件**: `src/runtime.ts:132-145`

**问题**: `docker.modem.followProgress` 无限等待，网络卡住或层挂起会导致 session 启动永久阻塞。

**修复**: 用 `Promise.race` 包装构建 promise，设置默认 10 分钟超时（硬编码或环境变量 `SBX_BUILD_TIMEOUT`）：

```ts
const BUILD_TIMEOUT_MS = parseInt(process.env.SBX_BUILD_TIMEOUT || "600000", 10);

async ensureImage(): Promise<void> {
  // ... 前面的检查逻辑不变 ...
  
  const buildPromise = new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(buildStream,
      (err) => { if (err) reject(err); else resolve(); },
      (event: any) => { /* 现有 progress 逻辑 */ },
    );
  });
  
  const timeoutPromise = new Promise<void>((_, reject) =>
    setTimeout(() => reject(new Error(`Image build timed out after ${BUILD_TIMEOUT_MS}ms`)), BUILD_TIMEOUT_MS)
  );
  
  await Promise.race([buildPromise, timeoutPromise]);
  report(`Image ${image} built successfully.`);
}
```

### 1.4 `_parseBytes` 静默失败 (Important)

**文件**: `src/runtime.ts:382-391`

**问题**: 输入 `"4gb"` 或无效值时返回 0，导致下游 Docker API 收到 `Memory: 0` 产生 obscure 错误。

**修复**: 不匹配时抛出明确错误：

```ts
private _parseBytes(s: string): number {
  const match = s.match(/^(\d+(?:\.\d+)?)\s*(b|k|m|g|t)?$/i);
  if (!match) throw new Error(`Invalid memory size: "${s}". Expected format: <number><unit>, e.g. "4g", "512m"`);
  const val = parseFloat(match[1]);
  const unit = (match[2] ?? "b").toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4,
  };
  return Math.round(val * (multipliers[unit] ?? 1));
}
```

调用方 (`startContainer`) 中 parse 失败时应将 state 置为 broken 并 rethrow，而非继续用 0 值创建容器。

### 1.5 CWD 替换使用正则 (Important)

**文件**: `index.ts:210-218`

**问题**: `event.systemPrompt.replace("Current working directory: ...", ...)` 使用精确字符串匹配，pi 更新 system prompt 文案后静默失效。

**修复**: 使用正则替换：

```ts
pi.on("before_agent_start", (event) => {
  const sbx = getSbx();
  if (!sbx) return;
  const cwd = sbx.runtime.getWorkRoot();
  event.systemPrompt = event.systemPrompt.replace(
    /Current working directory:\s*\S+/,
    `Current working directory: ${cwd}`,
  );
});
```

### 1.6 支持 `DOCKER_HOST` 环境变量 (Important)

**文件**: `src/runtime.ts:84, 369`

**问题**: socket 路径硬编码为 `/var/run/docker.sock`，Docker Desktop（macOS 上 `~/.docker/run/docker.sock`）和 rootless Docker（`$XDG_RUNTIME_DIR/docker.sock`）用户无法使用。

**修复**: 从环境变量读取，抽取为工具函数：

```ts
function getDockerSocketPath(): string {
  const host = process.env.DOCKER_HOST;
  if (host && host.startsWith("unix://")) return host.slice(7);
  return process.env.DOCKER_SOCKET || "/var/run/docker.sock";
}
```

`init()` 和 `_requireDocker()` 中均使用此函数。

### 1.7 Exec 流解析器缓冲区上限 (Important)

**文件**: `src/runtime.ts:292-308`

**问题**: `pending` 缓冲区无限增长。畸形或多路复用错误的 Docker 响应可能耗尽内存。

**修复**: 添加 16MB 上限：

```ts
const MAX_BUFFER = 16 * 1024 * 1024;
stream.on("data", (chunk: Buffer) => {
  pending = Buffer.concat([pending, chunk]);
  if (pending.length > MAX_BUFFER) {
    stream.destroy(new Error("exec stream buffer exceeded 16MB limit"));
    return;
  }
  // ... 现有解析逻辑
});
```

### 1.8 Abort 时清理容器内 exec 进程 (Important)

**文件**: `src/runtime.ts:310-312`

**问题**: abort 时只 `stream.destroy()`，容器内的 `sh -c "..."` 进程继续运行。重复 abort 的 exec 会累积僵尸进程。

**修复**: abort 时发送 kill 信号到 exec 实例：

```ts
controller.signal.addEventListener("abort", async () => {
  try { stream.destroy(); } catch {}
  try {
    // 获取 exec inspect 中的 Pid，发送 SIGKILL
    const info = await exec.inspect();
    if (info.Pid) {
      const killExec = await container.exec({
        Cmd: ["sh", "-c", `kill -9 ${info.Pid} 2>/dev/null; exit 0`],
        AttachStdout: false, AttachStderr: false,
      });
      await killExec.start({ Detach: true });
    }
  } catch { /* best effort */ }
});
```

---

## 二、Minor 修复

### 2.1 `rebuildImage` 不修改 `this.opts` (Minor)

**文件**: `src/runtime.ts:150-161`

**问题**: `rebuildImage` 临时覆盖 `this.opts.forceBuild` 和 `onProgress`，并发调用时可能不正确地 restore。

**修复**: 将 forceBuild/onProgress 作为局部变量传递，而非修改 `this.opts`。在 `ensureImage` 签名中加入可选参数：

```ts
async ensureImage(opts?: {
  forceBuild?: boolean;
  onProgress?: (msg: string) => void;
}): Promise<void> {
  const forceBuild = opts?.forceBuild ?? this.opts.forceBuild;
  const onProgress = opts?.onProgress ?? this.opts.onProgress;
  // ... 使用局部变量而非 this.opts ...
}

async rebuildImage(onProgress?: (msg: string) => void): Promise<void> {
  await this.ensureImage({ forceBuild: true, onProgress });
}
```

### 2.2 `--sandbox-persist` 和 `--container-keep` 语义重复 (Minor)

**文件**: `index.ts:57-65, 93-97`

两个 flag 行为相同（阻止容器 shutdown）。保留一个，另一个标记为 deprecated alias。

### 2.3 `createEditOps` 重复只读挂载检查 (Minor)

**文件**: `src/ops.ts:116-122`

`createEditOps.writeFile` 和 `createWriteOps.writeFile` 对只读挂载各抛一个异常文案略有不同（"refusing to edit" vs "refusing to write"）。去掉 `createEditOps` 中的检查，让 `createWriteOps.writeFile` 统一处理。

### 2.4 `writeFile` 大文件 ARG_MAX 风险 (Minor)

**文件**: `src/ops.ts:96-98`

base64 内容作为 `printf` 参数传入，文件 > 128KB 可能超 `ARG_MAX`。

**修复**: 超过 64KB 时改为 stdin 传输：

```ts
const b64 = buf.toString("base64");
if (buf.length > 65536) {
  // 大文件: 分块通过 stdin 写入
  const chunkSize = 32 * 1024; // 32KB base64 chunks
  const cmd = `base64 -d > ${shq(remote)}`;
  // 使用 exec 的 stdin 而非 printf
  await execWithStdin(sbx, cmd, b64, chunkSize);
} else {
  await execCapture(sbx, `printf %s ${shq(b64)} | base64 -d > ${shq(remote)}`);
}
```

### 2.5 `saveSbxConfig` 保留未知字段 (Minor)

**文件**: `src/config.ts:59-68`

**问题**: `loadSbxConfig` 只读已知字段，`saveSbxConfig` 只写已知字段，用户手动添加的字段被丢弃。

**修复**: `loadSbxConfig` 使用 spread 保留未知字段：

```ts
export function loadSbxConfig(hostCwd: string): SbxConfig {
  const configPath = getSbxConfigPath(hostCwd);
  if (!existsSync(configPath)) return { ...DEFAULT_SBX_CONFIG };
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    return {
      ...DEFAULT_SBX_CONFIG,
      ...raw, // raw 中的已知字段覆盖默认值，未知字段透传
    };
  } catch {
    return { ...DEFAULT_SBX_CONFIG };
  }
}
```

---

## 三、测试改进

### 3.1 提取共享测试 helper

**新建文件**: `tests/_helpers.ts`

三个文件 (`session.test.ts`, `ops.test.ts`, `commands.test.ts`) 各自定义了 `mockRuntime()`。提取为共享：

```ts
// tests/_helpers.ts
import type { Runtime, ExecOpts, ExecResult } from "../src/runtime";
import { setSbx, type SbxSession } from "../src/session";

export function mockRuntime(overrides?: Partial<Runtime>): Runtime {
  return {
    init: async () => {},
    isReady: () => true,
    ensureImage: async () => {},
    rebuildImage: async () => {},
    startContainer: async () => {},
    withReady: async () => {},
    shutdown: async () => {},
    getContainerId: () => "mock-id",
    getWorkRoot: () => "/workspace",
    exec: async (_opts: ExecOpts): Promise<ExecResult> =>
      ({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
    ...overrides,
  };
}

export function mockSbx(overrides?: Partial<SbxSession>): void {
  setSbx({
    runtime: mockRuntime(),
    name: "test-box",
    hostCwd: "/tmp",
    keep: false,
    mounts: [],
    allowedExternalPrefixes: [],
    imageRef: "img:latest",
    config: { image: "pi-sandbox", tag: "latest", containerName: null, tier: "medium", persist: false, cacheVolume: null } as any,
    isReusable: false,
    isReattached: false,
    ...overrides,
  });
}
```

### 3.2 删除冗余测试

| 删除 | 文件 | 原因 |
|---|---|---|
| `SandboxOptions new image-build fields` | `tests/runtime.test.ts:251-271` | TypeScript 编译即验证，非运行时测试 |
| `imageRefForTag` 两个独立 it 块 | `tests/config.test.ts:25-32` | 字符串拼接，合并为一个 it |
| `TIER_SPECS` 三个 tier 值测试 | `tests/tiers.test.ts:23-33` | 用 `it.each` 替代重复 pattern |

### 3.3 合并 runtime exec 测试容器

**文件**: `tests/runtime.test.ts:129-230`

5 个 exec 测试各自创建/销毁容器。改为 `beforeAll` 启动一个共享容器，`afterAll` 清理，每个测试复用：

```ts
describe.skipIf(!dockerAvailable)("DockerRuntime exec", () => {
  const testName = `pi-test-exec-${Date.now()}`;
  let runtime: DockerRuntime;

  beforeAll(async () => {
    runtime = new DockerRuntime({
      image: "debian:12-slim", hostCwd: "/tmp",
      name: testName, allowNetwork: false,
      resources: { memory: "256m", cpus: "0.5" },
    });
    await runtime.init();
    await runtime.withReady();
  }, 120000);

  afterAll(async () => {
    try { await runtime.shutdown(); } catch {}
  });

  it("exec returns stdout and exitCode 0", async () => {
    const result = await runtime.exec({ cmd: ["echo", "-n", "hello"] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("hello");
  });

  // ... 其余 4 个测试同样复用 runtime
});
```

### 3.4 补充 ops.test.ts 覆盖

**文件**: `tests/ops.test.ts`

当前仅测试 `writeFile` 创建父目录。补充：

1. **`execCapture` 非零退出码抛异常** — 模拟 exitCode=1，验证 throw
2. **`createWriteOps.writeFile` 拒绝只读挂载** — mount 标记为 ro 时抛异常
3. **`createWriteOps.mkdir` 拒绝只读挂载** — 同上
4. **`createEditOps.writeFile` 委托给 createWriteOps.writeFile**

### 3.5 补充 commands.test.ts 覆盖

**文件**: `tests/commands.test.ts`

当前仅测试 `/sandbox stop` 和 `/sandbox build`。补充关键路径：

1. **`/sandbox status`** — 有 active session 时调用 `execCapture` 获取系统信息
2. **`/sandbox exec <cmd>`** — 执行命令并检验输出通知
3. **`/sandbox doctor`** — 验证执行了工具检查脚本
4. **`/sandbox keep <name>`** — 验证 config 写入

使用 `mockSbx()` helper 减少样板代码。

---

## 四、影响范围

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `index.ts` | 修改 | 信号处理 async、CWD 正则替换 |
| `src/runtime.ts` | 修改 | 容器名截断、构建超时、`_parseBytes` 抛异常、socket 路径、exec buffer 上限、abort kill、`rebuildImage` 局部参数 |
| `src/config.ts` | 修改 | `loadSbxConfig` 保留未知字段 |
| `src/ops.ts` | 修改 | 去掉 `createEditOps` 重复检查、大文件 stdin |
| `tests/_helpers.ts` | 新建 | `mockRuntime()`、`mockSbx()` 共享 helper |
| `tests/runtime.test.ts` | 修改 | 删除类型测试、合并 exec 容器、添加 `deriveContainerName` 截断测试 |
| `tests/ops.test.ts` | 修改 | 补充 execCapture 错误、只读挂载拒绝测试 |
| `tests/commands.test.ts` | 修改 | 使用 helper、补充 status/exec/doctor/keep 测试 |
| `tests/session.test.ts` | 修改 | 使用共享 `mockRuntime()` |
| `tests/config.test.ts` | 修改 | 合并 `imageRefForTag`、添加透传未知字段测试 |
| `tests/tiers.test.ts` | 修改 | `it.each` 替换重复 pattern |

---

## 五、验收标准

1. 所有 Critical/Important 问题已修复
2. `uv run npx tsc --noEmit` 零错误
3. `npx vitest run` 全部通过（预计 ~80 tests）
4. `tests/_helpers.ts` 被所有测试文件引用，无 mock 重复定义
5. ops.test.ts 覆盖 `execCapture` 错误路径和只读挂载拒绝
6. commands.test.ts 覆盖 status/exec/doctor/keep 关键路径
7. `deriveContainerName` 长路径截断行为正确
8. 向后兼容：现有 `sandbox.json` 和 CLI 使用方式不变化
