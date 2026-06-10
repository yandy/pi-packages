# pi-container-sandbox Refinement Design

基于 `feat-mx-container-sandbox` 分支 Code Review 发现的优势及 `feat-ds-container-sandbox` 评审问题，对
DS 分支进行改进。

## 背景

DS 分支当前通过 `docker` CLI（`spawn`）操作容器，评审发现以下问题：

| 问题 | 严重度 | 来源 |
|------|--------|------|
| `execStream` timeout 单位混乱（秒 vs 毫秒） | Critical | DS 评审 |
| `process.once` 在多 session 下累积 | Critical (降级) | 两个评审 |
| 冗余 `tierSpec` fallback | Important | DS 评审 |
| `/sandbox stop` 忽略 keep/persist | Important | DS 评审 |
| Skill mount 去重缺日志 | Important | DS 评审 |
| E2E capacity check ⚠️ → 应为 ❌/FAIL | Important | DS 评审 |
| `PathApprovalStore` 并发写入冲突 | Important | DS 评审 |
| `writeFile` 不创建父目录 | Important | MX 评审 |
| 路径转义检测被移除 | Important | MX 评审 (规范偏差) |

MX 分支的 dockerode SDK 交互方式在三个方面显著优于 DS 的 CLI 方式：
- **Demux 流解复用** — 正确解析 Docker 多路复用协议（8 字节头部），分离 stdout/stderr
- **Abort/timeout 编排** — 统一 AbortController 组合超时和调用方 AbortSignal
- **`withReady` 并发去重** — `_initPromise` 模式防止多个调用者触发重复的 init/build/start

## 目标

1. dockerode 迁移：全量重写 runtime + ops，获得 demux/abort/withReady 全部优势
2. 修复所有 Critical + Important 评审问题
3. 以 MX README 为底，补充 DS 独有功能

---

## 设计

### 1. runtime.ts — `Runtime` 接口 + `DockerRuntime` 实现

重写为：

```ts
// src/runtime.ts

export interface MountSpec {
  source: string;
  target: string;
}

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
  dockerfileContext?: string;
}

export interface ExecOpts {
  cmd: string[];
  workDir?: string;
  env?: string[];
  stdin?: string | Buffer;
  timeoutMs?: number;
  signal?: AbortSignal;
  onData?: (data: Buffer) => void;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

export interface Runtime {
  init(): Promise<void>;
  isReady(): boolean;
  ensureImage(): Promise<void>;
  startContainer(): Promise<void>;
  withReady(): Promise<void>;
  exec(opts: ExecOpts): Promise<ExecResult>;
  shutdown(): Promise<void>;
  getContainerId(): string | null;
  getWorkRoot(): string;
}

export class DockerRuntime implements Runtime {
  private docker: Dockerode | null;
  private container: Dockerode.Container | null;
  private id: string | null;
  private _initPromise: Promise<void> | null;
  private opts: SandboxOptions;

  constructor(opts: SandboxOptions);
  async init(): Promise<void>;          // 创建 dockerode + ping
  async ensureImage(): Promise<void>;   // 检查本地镜像，不存在则 build
  async startContainer(): Promise<void>;
  async withReady(): Promise<void>;     // 去重并发初始化入口
  async exec(opts: ExecOpts): Promise<ExecResult>;  // demux + abort + timeout
  async shutdown(): Promise<void>;      // stop + remove（respect keep）
  isReady(): boolean;
  getContainerId(): string | null;
  getWorkRoot(): string;                // 总是 "/workspace"
}

// 保留工具函数
export function deriveContainerName(hostCwd: string): string;
```

**关键设计点：**

- `exec()` 内置 Docker 多路复用协议解析：读取 8 字节头部 → stream type (1=stdout, 2=stderr) + payload size → 分派 payload
- `exec()` 的 `timeoutMs` 和 `signal` 统一通过 `AbortController` 编排，超时或 abort 时 `stream.destroy()`
- `withReady()` 用 `_initPromise` 去重并发调用
- `startContainer()` 保留 DS 安全设置：`--user 1000:1000`、`--cap-drop ALL`、`--security-opt no-new-privileges`、`--pids-limit`
- `ensureImage()` 支持 Dockerfile 构建和 `dockerfileContext` 路径
- 不再依赖 `docker` CLI 命令，全部通过 dockerode SDK 实现

### 2. session.ts — 沙箱会话状态（原 sandbox.ts）

```ts
// src/session.ts
import type { Runtime, MountSpec, SandboxOptions } from "./runtime";
import type { SbxConfig } from "./config";

export interface SbxSession {
  runtime: Runtime;              // ← 原 runtime: Runtime（CLI），现为 DockerRuntime
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

let sandboxInstance: SbxSession | null = null;

export function getSbx(): SbxSession | null;
export function setSbx(s: SbxSession): void;
export function clearSbx(): void;
```

### 3. ops.ts — execCapture / execStream 改用 Runtime.exec()

```ts
// src/ops.ts

export interface SbxHandle {
  runtime: Runtime;       // ← 替换原先的 Runtime (CLI)
  name: string;
  hostCwd: string;
  mounts: MountSpec[];
  allowedExternalPrefixes: string[];
}

// execCapture: 由 spawn docker exec → runtime.exec()
export async function execCapture(
  sbx: SbxHandle, command: string, timeoutMs?: number
): Promise<Buffer> {
  const result = await sbx.runtime.exec({
    cmd: ["sh", "-c", command],
    timeoutMs,        // ← 统一为 ms
  });
  if (result.exitCode !== 0) {
    throw new Error(`exec failed (${result.exitCode}): ${result.stderr.toString()}`);
  }
  return result.stdout;
}

// execStream: 由 spawn docker exec → runtime.exec()
export async function execStream(
  sbx: SbxHandle, command: string,
  opts: { onData: (b: Buffer) => void; signal?: AbortSignal; timeout?: number }
): Promise<{ exitCode: number | null }> {
  const result = await sbx.runtime.exec({
    cmd: ["sh", "-c", command],
    onData: opts.onData,
    signal: opts.signal,
    timeoutMs: opts.timeout,  // ← ms，修复原先的秒/毫秒混淆
  });
  return { exitCode: result.exitCode };
}

// createReadOps / createWriteOps / createEditOps / createBashOps
// 接口不变，内部调用新的 execCapture/execStream
```

### 4. index.ts 入口改动

**session_start 处理器：**

```ts
pi.on("session_start", async (_event, ctx) => {
  // flag 检查（不变）
  if (noc || !container) return;

  try {
    // 1. 创建 DockerRuntime 并初始化
    const runtime = new DockerRuntime({ image, hostCwd, name, ... });
    await runtime.init();
    if (!runtime.isReady()) {
      ctx.ui.notify("Docker not available. Running without sandbox.", "warning");
      return;
    }

    // 2. 构建/启动容器（withReady 去重并发）
    await runtime.withReady();

    // 3. 注册 SbxSession
    setSbx({ runtime, name: actualName, ... });

    // 4. 进程信号处理（带 cleaned 守护）
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      const s = getSbx();
      if (!s || s.keep) return;
      s.runtime.shutdown();
      clearSbx();
    };
    process.on("exit", cleanup);
    process.once("SIGINT", () => { cleanup(); process.exit(130); });
    process.once("SIGTERM", () => { cleanup(); process.exit(143); });

    // 5. 健康检查 + 通知（保持现有逻辑）
    // ...
  } catch (e) { ... }
});
```

**其他修复：**
- `TIER_SPECS[sizeTier || "medium"]` → `TIER_SPECS[sizeTier]`（移除冗余 fallback）
- `session_shutdown` 中 `sbx.runtime.stop/remove` → `sbx.runtime.shutdown()`

**session_shutdown 处理器：**

```ts
pi.on("session_shutdown", async () => {
  const sbx = getSbx();
  if (!sbx) return;
  if (!sbx.keep) await sbx.runtime.shutdown();
  clearSbx();
});
```

### 5. commands/sandbox.ts — stop 处理器修复

```ts
stop: async (_args, ctx) => {
  const sbx = getSbx();
  if (!sbx) { ... return; }
  if (sbx.keep) {
    ctx.ui.notify(
      `Container ${sbx.name} has keep/persist set. Use /sandbox keep off to clear persistence.`,
      "warning",
    );
    return;
  }
  await sbx.runtime.shutdown();
  clearSbx();
  ctx.ui.notify(`Sandbox ${sbx.name} stopped and removed.`, "info");
},
```

`sbx.runtime.kind` 引用处替换为 `"docker"` 字面量。

### 6. runtime.ts 文件删除

原 `src/runtime.ts` 被完全重写为新的 `Runtime` 接口 + `DockerRuntime` 类。删除全部 `docker` CLI `spawn` 相关代码。

### 7. 新增依赖

```json
{
  "dependencies": {
    "dockerode": "^4.x"
  },
  "devDependencies": {
    "@types/dockerode": "^3.x"
  }
}
```

---

## 评审问题修复（非架构）

### Issue 1: Skill mount 去重缺日志

`src/skills.ts:28` — 跳过重复挂载时打印日志：

```ts
if (mounts.some((m) => m.target === target)) {
  // 新增日志
  console.debug(`sandbox: skipping duplicate mount target ${target} (already mounted from another source)`);
  continue;
}
```

### Issue 2: E2E capacity check ⚠️ → ❌/FAIL

`tests/e2e.sh:129` — `⚠️` 改为 `❌`，计入 FAIL 计数器：

```bash
[ -n "$CAPS" ] && echo "$CAPS" | grep -q "0000000000000000" && {
  echo "  ✅ C6: no caps"; PASS=$((PASS + 1));
} || {
  echo "  ❌ C6: caps check failed ($CAPS)"; FAIL=$((FAIL + 1));
}
```

### Issue 3: PathApprovalStore 并发写入保护

`src/paths.ts:PathApprovalStore.save()` — 写入前读文件检查 mtime，若外部修改则 merge 后重写：

```ts
save(): void {
  const dir = path.dirname(this.filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // 读取当前磁盘文件，检查是否被外部修改
  const existing = this.loadFromDisk();
  if (existing && existing.mtime > this.lastSaveTime) {
    // 外部修改：merge 并采用较晚的过期时间
    for (const [p, exp] of existing.records) {
      const current = this._records.get(p);
      if (!current || exp > current) {
        this._records.set(p, exp);
      }
    }
  }

  // 原子写入：先写 tmp 再 rename
  const tmp = this.filePath + ".tmp";
  const data = JSON.stringify(this.toJSON(), null, 2);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, this.filePath);
  this.lastSaveTime = Date.now();
}
```

### Issue 4: writeFile 创建父目录

`src/ops.ts:createWriteOps.writeFile()` — 写入前调用 `mkdir -p`：

```ts
writeFile: async (p, content) => {
  const remote = toRemote(p, sbx.hostCwd, sbx.mounts);
  if (isReadOnlyMount(remote, sbx.mounts)) {
    throw new Error(`sandbox: refusing to write to ${remote}: read-only skill mount`);
  }
  // 确保父目录存在
  const parent = path.dirname(remote);
  await execCapture(sbx, `mkdir -p ${shq(parent)}`);
  // 写入文件
  const buf = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
  const b64 = buf.toString("base64");
  await execCapture(sbx, `printf %s ${shq(b64)} | base64 -d > ${shq(remote)}`);
},
```

### Issue 5: 恢复路径越界检测

恢复 `src/paths.ts` 中的 `toContainerPath` 函数和越界检测逻辑。`translatePathForRead` 等函数在路径越界时返回错误提示而非静默传递不安全的容器路径。

```ts
export function toContainerPath(
  hostPath: string,
  hostCwd: string,
  mounts: MountSpec[],
): { ok: true; path: string } | { ok: false; reason: string } {
  // 解析绝对路径
  const abs = resolvePath(hostCwd, hostPath);

  // 检查是否在 hostCwd 内
  if (isInsideCwd(abs, hostCwd)) {
    return { ok: true, path: path.join(REMOTE_ROOT, path.relative(hostCwd, abs)) };
  }

  // 检查是否在挂载点内
  for (const mount of mounts) {
    if (isInsideCwd(abs, mount.source)) {
      return { ok: true, path: path.join(mount.target, path.relative(mount.source, abs)) };
    }
  }

  return { ok: false, reason: `Path escapes sandbox: ${hostPath}` };
}
```

---

## README 改进

以 MX README 为底，补充 DS 独有功能：

| 保留（来自 MX） | 补充（来自 DS） |
|---|---|
| 标题 + Quick start | — |
| What runs where 表格 | — |
| Commands 表 | `/sandbox` 全部子命令（status/start/stop/keep/exec/doctor/config/allow/paths/tiers） |
| Configuration 环境变量 | — |
| CLI flags | DS 独有 flags（container-net, container-mount-skills, sandbox-cache, container-mount-paths, container-allow-paths, container-memory, container-cpus, container-swap, container-pids-limit） |
| Resource limits | Tier definitions（small/medium/large 规格） |
| Troubleshooting | Skills 挂载说明、Path approval 机制 |
| Development 命令 | E2E 测试说明 |
| How it works | 更新为 dockerode 实现 |
| Differences from similar projects | 移除（DS 分支无此章节） |
| License | MIT |

---

## 文件变更汇总

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/runtime.ts` | 重写 | `Runtime` 接口 + `DockerRuntime` 类（dockerode） |
| `src/session.ts` | 重命名 | 原 `src/sandbox.ts`，SbxSession 类型 + 模块级状态 |
| `src/ops.ts` | 修改 | execCapture/execStream 改用 runtime.exec()，writeFile 添加 mkdir -p |
| `index.ts` | 修改 | session_start 使用 DockerRuntime，cleaned 守护，移除冗余 fallback |
| `src/commands/sandbox.ts` | 修改 | stop 处理器尊重 keep/persist，替换 runtime.kind |
| `src/skills.ts` | 修改 | 添加去重日志 |
| `src/paths.ts` | 修改 | PathApprovalStore 并发保护，恢复 toContainerPath 越界检测 |
| `tests/e2e.sh` | 修改 | capacity check ⚠️ → ❌，计入 FAIL |
| `README.md` | 重写 | 以 MX README 为底，补充 DS 独有功能 |
| `package.json` | 修改 | 添加 dockerode + @types/dockerode |
| `package-lock.json` | 修改 | 依赖更新 |
| `src/sandbox.ts` | 删除 | 重命名为 src/session.ts |
