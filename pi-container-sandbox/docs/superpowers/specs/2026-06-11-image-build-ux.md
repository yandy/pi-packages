# Image Build UX Improvement

## 背景

当前 `session_start` 启动 sandbox 时的镜像构建存在三个问题：

| 问题 | 严重度 | 根因 |
|------|--------|------|
| `pi install` 用户无法构建镜像 | Critical | `ensureImage()` 的 `buildContext` 默认使用 `hostCwd`（用户项目目录），而非 package 内置的 `docker/` 目录。用户项目目录下没有 Dockerfile，构建必然失败 |
| 缺少构建进度反馈 | Important | `docker.modem.followProgress` 仅用于 resolve/reject，未提取进度信息。用户看到的是长时间无响应 |
| 无法定制镜像 | Important | `SbxConfig` 不支持指定 Dockerfile 路径、构建上下文、build args。用户想加工具只能挂载 volume 或用外部镜像 |

## 目标

1. **`pi install` 开箱即用**：首次启动自动用 package 内置的 `docker/Dockerfile` 构建镜像
2. **构建过程可见**：实时输出 `docker build` 的层构建进度
3. **支持镜像定制**：用户可通过 sandbox.json 或 CLI flag 指定自己的 Dockerfile、构建上下文和 build args
4. **支持强制重建**：提供 `--build-image` flag 和 `/sandbox build` 命令

## 用户故事

### 故事 A：开箱即用

作为一个通过 `pi install pi-container-sandbox` 安装的用户，当我首次运行 `pi --container` 时：
- 扩展自动检测到 `pi-container-sandbox:latest` 镜像不存在
- 使用扩展内置的 Dockerfile 开始构建
- 终端显示实时构建进度（每层拉取/构建状态）
- 构建完成后容器正常启动

后续启动时，镜像已存在，直接跳过构建。

### 故事 B：定制镜像

作为一个需要在 sandbox 中额外安装 Python 包的用户，我：

1. 在项目根目录创建 `Dockerfile.sandbox`：
```dockerfile
FROM pi-container-sandbox:latest
RUN uv pip install requests pandas
```

2. 在 `.pi/agent/sandbox.json` 配置：
```json
{
  "image": "project-sandbox",
  "dockerfile": "./Dockerfile.sandbox"
}
```

3. 运行 `pi --container`，扩展用我的 Dockerfile 构建出 `project-sandbox:latest` 镜像并启动。

### 故事 C：强制重建

作为一个修改了 Dockerfile 的用户，我运行 `pi --container --build-image`，即使镜像已存在也强制重建。

或者，我在 session 中运行 `/sandbox build` 进行重建。

### 故事 D：CLI 临时指定

作为临时实验的用户，我运行：
```bash
pi --dockerfile ./test.dockerfile --container-image test-sandbox:v2
```
扩展用指定的 Dockerfile 构建并 tag 为 `test-sandbox:v2`。

---

## 设计

### 1. 配置扩展 — `SbxConfig`

`src/config.ts` 接口新增三个可选字段：

```typescript
export interface SbxConfig {
  image: string;
  tag: string;
  containerName: string | null;
  tier: SizeTier;
  persist: boolean;
  cacheVolume: string | null;
  // NEW
  dockerfile?: string;              // 自定义 Dockerfile 路径
  buildContext?: string;            // 自定义构建上下文目录
  buildArgs?: Record<string, string>; // --build-arg 键值对
}
```

### 2. Package 路径解析

新增 `PACKAGE_DOCKER_DIR` 常量，通过 `import.meta.url` 解析运行时 package 位置：

```typescript
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_DOCKER_DIR = resolve(__dirname, "..", "docker");
```

无论本地开发还是 `pi install`，都能正确定位到内置 `docker/Dockerfile`。

### 3. 运行时选项扩展 — `SandboxOptions`

```typescript
export interface SandboxOptions {
  // ...现有字段不变
  dockerfile?: string;
  buildContext?: string;
  buildArgs?: Record<string, string>;
  forceBuild?: boolean;
  onProgress?: (msg: string) => void;
}
```

删除未使用的 `dockerfileContext` 字段。

### 4. 镜像获取策略（重构 `ensureImage()`）

```
ensureImage()
    │
    ├─ forceBuild=false 且 本地镜像存在？
    │   └─ 是 → 直接返回，跳过构建
    │
    └─ 否 → docker.buildImage()
        ├─ buildContext  = opts.buildContext ?? PACKAGE_DOCKER_DIR
        ├─ dockerfile    = opts.dockerfile ?? "Dockerfile"
        ├─ buildargs     = opts.buildArgs
        └─ 通过 onProgress 回调实时输出构建进度
```

不再有 pull 逻辑 —— 用户决策为"不需要"。

### 5. 强制重建 — `rebuildImage()`

在 `Runtime` 接口和 `DockerRuntime` 中新增方法：

```typescript
rebuildImage(onProgress?: (msg: string) => void): Promise<void>;
```

实现：设置 `forceBuild=true`，调用 `ensureImage()`。

### 6. CLI flags

| Flag | 类型 | 说明 |
|------|------|------|
| `--build-image` | boolean, default false | 强制重建镜像 |
| `--dockerfile <path>` | string | 自定义 Dockerfile 路径 |
| `--dockerfile-context <path>` | string | 自定义构建上下文目录 |

### 7. `/sandbox build` 命令

新的子命令，调用 `runtime.rebuildImage()`：
- sandbox 未激活时提示错误
- 构建时通过 `setStatus` 显示进度
- 成功/失败均通知用户

### 8. 优先级

当 `sandbox.json` 和 CLI flag 同时指定时，CLI flag 优先：

```typescript
dockerfile: cfg.dockerfile ?? dockerfileFlag,
buildContext: cfg.buildContext ?? dockerfileContextFlag,
buildArgs: cfg.buildArgs,  // 仅来自 sandbox.json
forceBuild: buildImageFlag || false,
```

---

## 非目标

- 不从 registry pull 镜像（用户确认不需要）
- 不支持多阶段构建的基础镜像自动预构建
- 构建失败时不 fallback 到默认镜像，直接报错

---

## 影响范围

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/config.ts` | 修改 | 扩展 `SbxConfig` + `PACKAGE_DOCKER_DIR` |
| `src/runtime.ts` | 修改 | 重构 `ensureImage()`，新增 `rebuildImage()` |
| `index.ts` | 修改 | 注册 3 个新 flag，传递配置到 runtime |
| `src/commands/sandbox.ts` | 修改 | 新增 `build` handler |
| `tests/config.test.ts` | 修改 | 新字段测试 |
| `tests/runtime.test.ts` | 修改 | force-rebuild 选项测试 |
| `tests/commands.test.ts` | 修改 | `/sandbox build` 测试 |
| `tests/session.test.ts` | 修改 | mock 补充 `rebuildImage` |
| `tests/ops.test.ts` | 修改 | mock 补充 `rebuildImage` |

## 验收标准

1. `pi install pi-container-sandbox` 后运行 `pi --container`，首次自动构建成功
2. 构建过程有实时进度输出（不再是静默）
3. `.pi/agent/sandbox.json` 配置 `dockerfile`/`buildContext`/`buildArgs` 生效
4. `--build-image` 和 `/sandbox build` 强制重建镜像
5. `--dockerfile` 和 `--dockerfile-context` CLI flag 生效
6. 未配置新字段时行为与之前完全一致（向后兼容）
7. `uv run npx tsc --noEmit` 零错误
8. `npx vitest run` 全部通过
