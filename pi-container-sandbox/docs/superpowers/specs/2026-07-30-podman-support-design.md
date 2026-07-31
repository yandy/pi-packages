# Podman Runtime 支持 — 设计规格

## 背景

`pi-container-sandbox` 当前只支持 Docker 作为容器运行时。用户希望增加 Podman 支持，以适配无 Docker 环境或偏好 Podman rootless 的场景。

## 目标

1. 支持 Docker 和 Podman 两种容器运行时，用户通过 `sandbox.json` 显式选择
2. 默认 `auto` 模式：优先 Podman，不可用则 fallback Docker
3. Podman rootless 兼容：不传 `--user`，资源限制支持降级重试
4. 移除 `tier` 概念，简化配置模型：用户显式配置 resource 参数才传给 CLI

## 架构

### 整体结构

```
container-cli.ts (重命名自 docker-cli.ts)
  ├── container(binary, args, opts)      // 同步 exec
  └── containerSpawn(binary, args, opts)  // 异步 spawn

runtime.ts
  ├── Runtime 接口 (不变)
  ├── DockerRuntime  (重构: 调用 container("docker", ...))
  └── PodmanRuntime  (新增: 调用 container("podman", ...))

index.ts / commands/sandbox.ts
  └── createRuntime(config) → Runtime (工厂函数，替代直接 new DockerRuntime)
```

### 关键设计决策

**Runtime 多态 vs 策略模式：** 选择两个独立 Runtime 类（DockerRuntime + PodmanRuntime），而非单个带引擎参数类。理由：
- Docker/Podman 行为差异足够大（`--user`、资源降级），塞进一个类会导致大量 if/else
- `Runtime` 接口已存在，继承扩展自然
- 公共 helper（镜像名生成、env 展开）提取为模块级函数，避免代码重复

**container-cli.ts 泛化：** `docker()`/`dockerSpawn()` 改为 `container(binary, args)`/`containerSpawn(binary, args)`。逻辑完全相同（spawn、超时、signal、stdin），仅二进制名参数化。docker-cli.ts 保留为兼容重导出。

## 配置变更

### `sandbox.json` — `runtime` 组

```json
{
  "runtime": {
    "engine": "auto",
    "name": null,
    "network": true,
    "persist": false,
    "memory": null,
    "cpus": null,
    "swap": null,
    "pidsLimit": null,
    "cache": null,
    "mounts": [],
    "env": []
  }
}
```

变更说明：

| 字段 | 变更 | 说明 |
|------|------|------|
| `engine` | **新增** | `"docker"` / `"podman"` / `"auto"`，默认 `"auto"` |
| `tier` | **移除** | 不再需要，直接用 memory/cpus/swap |
| `memory` | 行为变更 | null 时不传 `--memory` |
| `cpus` | 行为变更 | null 时不传 `--cpus` |
| `swap` | 行为变更 | null 时不传 `--memory-swap` |
| `pidsLimit` | 行为变更 | 默认从 `512` 改为 `null`，null 不传 `--pids-limit` |

`engine` 取值：

| 值 | 行为 |
|---|---|
| `"auto"`（默认） | 优先 podman → 不可用则 docker → 都不可用报错 |
| `"podman"` | 强制 podman，不可用报错 |
| `"docker"` | 强制 docker，不可用报错 |

### 资源参数传参规则

```
终值 = 显式配置值 ?? null
```

即只有 sandbox.json 中用户显式写了资源参数才传给容器 CLI，否则不传。这是对原有行为（tier 含默认值总传）的**向后不兼容变更**，但对 podman rootless 兼容性是必要的。

## Docker vs Podman 行为差异

| 方面 | Docker | Podman |
|------|--------|--------|
| 二进制 | `docker` | `podman` |
| `--user 1000:1000` | ✅ 传 | ❌ 不传（rootless 自动映射） |
| `--cap-drop ALL` | ✅ | ✅ |
| `--security-opt no-new-privileges` | ✅ | ✅ |
| `--network bridge/none` | ✅ | ✅ |
| `--memory/--cpus/--pids-limit` | 配置了传 | 配置了传，cgroups 报错降级重试 |
| Dockerfile | `docker/*.Dockerfile` | 相同 Dockerfile（podman build 兼容） |
| 可用性检查 | `docker info` | `podman info` |

## Podman 资源限制降级逻辑

```
1. 构建 podman run 参数（含 --memory, --cpus, --pids-limit）
2. 启动容器
3. 如果失败且错误信息匹配 cgroups/cgroup 关键词:
   → 去掉 --memory, --cpus, --pids-limit 重试
   → 重试成功: UI 通知 "资源限制未生效（需要 cgroups v2）"
   → 重试失败: 抛原始错误
4. 其他错误直接抛出
```

匹配关键词：`cgroup`、`cgroups`、`cg`（出现在错误信息中）。

## 引擎检测逻辑（auto 模式）

```
function detectEngine(): "podman" | "docker" {
  // 优先 podman
  try { container("podman", ["info"]); return "podman"; } catch {}
  try { container("docker", ["info"]); return "docker"; } catch {}
  throw new Error("No container runtime available (podman or docker)");
}
```

## 移除项清单

| 移除项 | 说明 |
|--------|------|
| `src/tiers.ts` | 文件删除 |
| `TIER_SPECS` 相关 import/使用 | `index.ts` 中移除 |
| `SbxConfig.runtime.tier` 字段 | `config.ts` 类型定义 |
| `DEFAULT_SBX_CONFIG.runtime.tier` | 默认配置 |
| `/sandbox tiers` 命令及 handler | `commands/sandbox.ts` |
| UI status `size=medium` 显示 | `index.ts` session_start 中 |
| pidsLimit 硬编码默认值 `512` | `runtime.ts` startContainer / index.ts |

## 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/docker-cli.ts` → `src/container-cli.ts` | 重命名+泛化 | `docker()`→`container(binary,...)`, `dockerSpawn()`→`containerSpawn(binary,...)` |
| `src/docker-cli.ts` | 保留 | 重导出：`docker(args) => container("docker", args)` |
| `src/runtime.ts` | 重构 | 提取共享 helper；DockerRuntime 重构；新增 PodmanRuntime |
| `src/config.ts` | 修改 | `RuntimeConfig` 新增 `engine`，移除 `tier`；新增 `detectEngine()` |
| `src/tiers.ts` | 删除 | 不再需要 |
| `src/session.ts` | 修改 | `SbxSession` 移除 `resources` 中 tier 相关，新增 `engine` |
| `index.ts` | 修改 | `createRuntime()` 工厂；移除 tier 逻辑；UI 消息改用引擎名 |
| `src/commands/sandbox.ts` | 修改 | 移除 tiers handler；build/status/doctor 改用引擎名 |
| `tests/runtime.test.ts` | 修改 | 新增 PodmanRuntime 测试；更新现有测试适配新接口 |
| `tests/tiers.test.ts` | 删除 | tier 已移除 |
| `tests/config.test.ts` | 修改 | 适配 engine 字段，移除 tier 相关测试 |
| `tests/*.test.ts` | 修改 | 适配移除 tier 后的行为变更 |
| `README.md` / `README.zh.md` | 修改 | 更新文档反映 podman 支持和配置变更 |

## 测试策略

### 单元测试
- `container-cli.test.ts`：验证 `container()`/`containerSpawn()` 接受不同二进制名
- `runtime.test.ts`：PodmanRuntime 生命周期、exec、imageExists、buildImage（skipIf podman 不可用）
- `config.test.ts`：engine 默认值、配置合并、移除 tier 后的兼容性

### 集成测试
- PodmanRuntime 资源降级重试：模拟 cgroups 错误
- 引擎检测：`detectEngine()` 返回正确引擎

### 手动验证
```bash
# 在支持 podman 的机器上
pi -e ./index.ts --container
/sandbox status  # 应显示 podman 容器
/sandbox exec echo hello
```
