# sandbox.json v2 配置重构

## 背景

当前 `sandbox.json` 存在两个问题：

1. **配置项缺失**：CLI flags 支持的 6 个配置项（`network`、`memory`、`cpus`、`swap`、`pidsLimit`、`mounts`）在 `sandbox.json` 中无法配置。
2. **命名混乱**：CLI flags 和 `sandbox.json` 字段中 `sandbox` / `container` 混用，字段组织扁平化 10 个顶层字段，缺少分组。

## 目标

1. 新增 6 个配置项到 `sandbox.json`
2. 统一命名为 `container` 前缀（CLI + 内部），`sandbox.json` 采用四分组嵌套结构
3. CLI flags 精简为仅保留 `--container` / `--no-container` / `--noc`，其余配置项全部由 `sandbox.json` 承载
4. 硬切换，不兼容旧版扁平格式

---

## 设计

### sandbox.json 结构

四分组嵌套结构：`image` / `runtime` / `build` / `host`。

```json
{
  "image": {
    "name": "pi-container-sandbox",
    "tag": "latest"
  },
  "runtime": {
    "name": null,
    "tier": "medium",
    "network": true,
    "persist": false,
    "mountSkills": true,
    "memory": null,
    "cpus": null,
    "swap": null,
    "pidsLimit": null,
    "cache": null,
    "mounts": []
  },
  "build": {
    "dockerfile": null,
    "context": null,
    "args": {}
  },
  "host": {
    "commands": []
  }
}
```

### 字段映射（旧 → 新）

| 旧扁平字段 | 新路径 | 类型 | 说明 |
|-----------|--------|------|------|
| `image` | `image.name` | `string` | 镜像名 |
| `tag` | `image.tag` | `string` | 镜像标签 |
| `containerName` | `runtime.name` | `string \| null` | 容器复用名 |
| `tier` | `runtime.tier` | `"small" \| "medium" \| "large"` | 资源规格 |
| — | `runtime.network` | `boolean` | **新增**：容器网络开关 |
| `persist` | `runtime.persist` | `boolean` | 退出后保留容器 |
| — | `runtime.mountSkills` | `boolean` | **新增**：挂载 agent skill 目录 |
| — | `runtime.memory` | `string \| null` | **新增**：内存覆盖 |
| — | `runtime.cpus` | `string \| null` | **新增**：CPU 覆盖 |
| — | `runtime.swap` | `string \| null` | **新增**：swap 覆盖 |
| — | `runtime.pidsLimit` | `number \| null` | **新增**：PID 限制 |
| `cacheVolume` | `runtime.cache` | `string \| null` | 缓存卷 |
| — | `runtime.mounts` | `string[]` | **新增**：额外挂载路径 |
| `dockerfile` | `build.dockerfile` | `string \| null` | Dockerfile 路径 |
| `buildContext` | `build.context` | `string \| null` | 构建上下文 |
| `buildArgs` | `build.args` | `Record<string, string>` | 构建参数 |
| `hostCommands` | `host.commands` | `string[]` | 宿主机命令白名单 |

### CLI Flags

仅保留 3 个顶层开关，其余全部移除：

| Flag | 类型 | 说明 |
|------|------|------|
| `--container` | boolean | 启用 sandbox（默认 on） |
| `--no-container` | boolean | 禁用 sandbox |
| `--noc` | boolean | `--no-container` 别名 |

### 配置合并

两层合并：全局 `~/.pi/agent/sandbox.json` → 项目 `.pi/sandbox.json`。

按分组浅合并（非扁平 spread），确保 `null` 值能正确覆盖：

```
最终配置 = {
  image:   { ...default.image,   ...global.image,   ...project.image },
  runtime: { ...default.runtime, ...global.runtime, ...project.runtime },
  build:   { ...default.build,   ...global.build,   ...project.build },
  host:    { ...default.host,    ...global.host,    ...project.host },
}
```

---

## 类型定义

```typescript
export type SizeTier = "small" | "medium" | "large";

export interface SbxConfig {
  image: ImageConfig;
  runtime: RuntimeConfig;
  build: BuildConfig;
  host: HostConfig;
}

export interface ImageConfig {
  name: string;
  tag: string;
}

export interface RuntimeConfig {
  name: string | null;
  tier: SizeTier;
  network: boolean;
  persist: boolean;
  mountSkills: boolean;
  memory: string | null;
  cpus: string | null;
  swap: string | null;
  pidsLimit: number | null;
  cache: string | null;
  mounts: string[];
}

export interface BuildConfig {
  dockerfile: string | null;
  context: string | null;
  args: Record<string, string>;
}

export interface HostConfig {
  commands: string[];
}

export const DEFAULT_SBX_CONFIG: SbxConfig = {
  image: { name: "pi-container-sandbox", tag: "latest" },
  runtime: {
    name: null, tier: "medium", network: true, persist: false,
    mountSkills: true,
    memory: null, cpus: null, swap: null, pidsLimit: null,
    cache: null, mounts: [],
  },
  build: { dockerfile: null, context: null, args: {} },
  host: { commands: [] },
};
```

---

## 影响范围

### `src/config.ts`

- 全部类型重写为四分组接口
- `DEFAULT_SBX_CONFIG` 重写
- `loadSbxConfig`：按分组浅合并
- `saveSbxConfig`：不变（写入整个 `SbxConfig` 对象）
- 旧字段辅助映射移除

### `index.ts`

- 删除所有 flag 注册，仅保留 `--container` / `--no-container` / `--noc`
- `session_start` 中所有 `pi.getFlag(...)` 替换为从 `cfg.image/runtime/build/host` 分组读取
- 从 `cfg` → `DockerRuntime` 的 `SandboxOptions` 做一次转换（`DockerRuntime` 内部接口不变）

### 内部适配

- `SbxSession.config` 类型更新为新的 `SbxConfig`
- `src/commands/sandbox.ts` 中引用 `cfg.containerName` → `cfg.runtime.name`，`cfg.cacheVolume` → `cfg.runtime.cache` 等
- `before_agent_start` 中的 `sbx.config.hostCommands` → `sbx.config.host.commands`

### 测试

| 文件 | 变更 |
|------|------|
| `tests/config.test.ts` | 适配新结构，默认值/合并/保存测试全部重写 |
| `tests/commands.test.ts` | 适配字段路径变化 |
| `tests/session.test.ts` | 适配 `SbxConfig` 类型 |

### 文档

- `README.md` / `README.zh.md`：移除 CLI flags 表格，更新 `sandbox.json` 配置示例

### 不变的部分

- `DockerRuntime` 及其 `SandboxOptions` 接口（内部，不暴露）
- `src/tiers.ts`（`SizeTier` 定义不变）
- `src/ops.ts`、`src/paths.ts`、`src/session.ts`（仅类型引用更新）
- `/sandbox allow` 命令和 `path-approvals.json` 路径授权机制（不受此次变更影响）

---

## 验收标准

1. `uv run npx tsc --noEmit` 零错误
2. `npx vitest run` 全部通过
3. 新 `sandbox.json` 四分组结构正确读写
4. 按分组浅合并逻辑正确（`null` 值覆盖、部分覆盖、全默认）
5. 仅 `--container` / `--no-container` / `--noc` 三个 flag 存在
6. `--no-container` 或 `--noc` 时 session 正确跳过 sandbox
7. 内部所有旧字段引用已迁移至新路径
