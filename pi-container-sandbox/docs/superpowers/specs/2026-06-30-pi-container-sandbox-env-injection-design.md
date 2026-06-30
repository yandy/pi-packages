# pi-container-sandbox Env Injection Design

## 目标

支持用户通过 `sandbox.json` 配置向 Docker 容器注入环境变量。

## 背景

目前 `DockerRuntime.startContainer()` 中 `Env` 被硬编码为 `["DEBIAN_FRONTEND=noninteractive"]`，用户无法配置自定义环境变量。`ExecOpts.env` 通道虽已定义但未使用，本次不做修改。

## 设计

### 数据流

```
sandbox.json: { "runtime": { "env": ["NODE_ENV=production", "TOKEN=$(cat /path/to/file)"] } }
  → loadConfig() 合并全局+项目配置
    → config.runtime.env → ["NODE_ENV=production", "TOKEN=$(cat /path/to/file)"]
      → shell 展开（宿主机上执行）
        → expanded: ["NODE_ENV=production", "TOKEN=actual-content"]
          → index.ts session_start: new DockerRuntime({ ..., env: expanded })
            → startContainer(): Env: ["DEBIAN_FRONTEND=noninteractive", "NODE_ENV=production", "TOKEN=actual-content"]
```

### Shell 展开机制

用户在 `sandbox.json` 中配置的 env 值支持 shell 命令替换（如 `$(...)`、反引号等）。
展开在**宿主机**上执行，时机为 Docker 容器创建之前，确保 Docker API 收到的是已展开的字面值。

**实现方式**：对每条 `KEY=VALUE`，将 VALUE 部分通过 `bash -c 'echo -n "<VALUE>"'` 解析：

```typescript
import { execSync } from "child_process";

function expandEnvValue(key: string, value: string): string {
  try {
    const expanded = execSync(
      `bash -c 'echo -n "${value.replace(/'/g, "'\"'\"'")}'`,
      { encoding: "utf-8", timeout: 5000, cwd: hostCwd }
    );
    return `${key}=${expanded}`;
  } catch {
    // 展开失败时降级为原始字面值
    return `${key}=${value}`;
  }
}
```

**展开时机**：在 `startContainer()` 内部，合并 builtin env 之前对每个用户 env 条目做展开。

**展开失败**：超时或执行错误时降级为原始字面值，打印 warning 日志，不阻塞容器启动。

### 文件变更

#### 1. `src/config.ts` — 配置模型

`RuntimeConfig` 新增 `env` 字段：

```typescript
interface RuntimeConfig {
  // ... existing fields ...
  /** 注入容器的环境变量，格式为 "KEY=VALUE" */
  env?: string[];
}
```

`DEFAULT_SBX_CONFIG.runtime` 默认值：

```typescript
env: [],
```

#### 2. `src/runtime.ts` — 运行时

`SandboxOptions` 新增 `env` 字段：

```typescript
interface SandboxOptions {
  // ... existing fields ...
  env?: string[];
}
```

`DockerRuntime` 构造时存储 `opts.env`，`startContainer()` 中合并：

```typescript
const builtinEnv = ["DEBIAN_FRONTEND=noninteractive"];
const userEnv = this.opts.env ?? [];
const env = [...builtinEnv, ...userEnv];
// 传入 createContainer({ Env: env })
```

用户 env 排在后面，可以覆盖内置 env（如有同名变量）。

#### 3. `index.ts` — 入口编排

`session_start` hook 中，从 `config.runtime.env` 读取并传入 `SandboxOptions`：

```typescript
const runtime = new DockerRuntime({
  // ... existing options ...
  env: config.runtime.env,
});
```

#### 4. `src/session.ts` — 不需要修改

`env` 仅在 `DockerRuntime` 初始化时消费，不需要在 `SbxSession` 中传递。

### 配置合并

沿用现有按组深合并策略。`env` 作为 `runtime` 组下的数组字段，项目级配置覆盖全局级（与其他 runtime 字段如 `mounts` 一致）：

- 不配置 `env`：行为不变，等效于 `[]`
- 仅项目级配置：使用项目级
- 全局和项目都有：项目级覆盖全局级

### 不在范围

- 命令行 `--env` 参数
- `ExecOpts.env` per-exec 透传通道
- 敏感值掩码/脱敏
