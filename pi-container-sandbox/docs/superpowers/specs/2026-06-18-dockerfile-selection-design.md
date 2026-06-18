# Dockerfile 选择构建设计

## 目标

将镜像自动构建改为交互式选择构建。当镜像不存在时，弹出 Dockerfile 选择 UI，用户选择内置 Dockerfile 构建或跳过自行构建。`/sandbox build` 命令同样走选择流程。

## 改动文件

### 1. `src/config.ts` — 新增 Dockerfile 发现

```ts
// 新增常量
export const DOCKERFILE_SKIP = "__skip__";

// 新增函数
export function discoverDockerfiles(): string[] {
  // 扫描 PACKAGE_DOCKER_DIR 中的 *.Dockerfile 文件
  // 返回不含后缀的文件名列表，如 ["cn", "gh"]
}
```

### 2. `src/runtime.ts` — 拆分检查与构建

- 新增 `imageExists(): Promise<boolean>` — 检查镜像是否已存在，用于 `session_start` 判断是否弹选择框
- 新增 `buildImage(BuildImageOpts): Promise<void>` — 显式构建镜像，接收 dockerfile/buildContext/buildArgs/onProgress
- 新增 `getImage(): string` — 暴露当前使用的镜像名
- 移除 `ensureImage()` 方法和 `forceBuild` 字段
- 移除 `rebuildImage()`（用 `buildImage` 替代）
- `_doInit()` 中移除 `ensureImage` 调用，只保留 `startContainer`

### 3. `index.ts` — session_start 流程重构

- 移除 `--build-image` flag 注册
- `session_start` 中 `withReady` 失败时（镜像缺失），调用 Dockerfile 选择+构建流程
- 选择流程：
  1. `discoverDockerfiles()` 扫描 docker 目录
  2. `ctx.ui.select("选择 Dockerfile 构建镜像", ["cn (内置)", "gh (内置)", "跳过 - 我自己构建"])`
  3. 选 Dockerfile → `runtime.buildImage({ dockerfile: "cn.Dockerfile", buildContext: PACKAGE_DOCKER_DIR, onProgress })` → 重试 `withReady`
  4. 选"跳过" → 通知用户手动构建，不启动 sandbox

### 4. `src/commands/sandbox.ts` — build 命令重构

- `build` handler 不要求 sandbox 已启动
- 独立完成：扫描 Dockerfiles → select → buildImage
- 需要能独立创建 `DockerRuntime` 来执行构建（或提取 buildImage 为独立函数）

### 5. `package.json` — build-image 脚本

新增 `scripts/build-image.ts`：有参数直接用指定 Dockerfile 构建，无参数用 `node:readline` 交互选择。

## 核心流程

```
session_start                      /sandbox build
  │                                   │
  ├─ imageExists()?                   ├─ discoverDockerfiles()
  │   ├─ yes → startContainer    ──→  ├─ select([...names, "跳过"])
  │   └─ no  → ──────────────────→    ├─ 选 Dockerfile → buildImage()
  │                                   └─ 选"跳过" → 通知提示
  ├─ 选 Dockerfile → buildImage()
  │   → startContainer
  └─ 选"跳过" → 通知提示
```

## 不改变的部分

- `--dockerfile` / `--dockerfile-context` flags 保留
- `sandbox.json` 中的 dockerfile/buildContext/buildArgs 配置保留
- 其他 flags 不受影响
