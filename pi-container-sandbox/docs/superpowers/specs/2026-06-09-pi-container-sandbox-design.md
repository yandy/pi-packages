# pi-container-sandbox 设计规格

## 概述

pi coding-agent extension，将 read/write/edit/bash 等工具调用路由到 per-session Docker 容器中执行。

- Host cwd 以 rw 挂载到容器 `/workspace`
- Agent 以非 root 用户 (uid 1000) 运行
- 不暴露 host $HOME、SSH keys、云凭据、浏览器状态或 Docker socket
- 资源限制通过预设 tier + flag 覆盖
- 支持命名容器复用

## 架构

```
pi (host) ──tool_call──> extension ──docker exec──> container (/workspace)
                              │
                         /sandbox 命令 ──docker CLI──> 容器管理
```

Extension 通过拦截 `tool_call` 事件，将内置工具的实现替换为经过 Docker exec 路由的版本。

## 文件结构

```
pi-container-sandbox/
├── index.ts              # 入口，export default
├── package.json
├── tsconfig.json
├── README.md
├── docker/
│   └── Dockerfile
├── src/
│   ├── runtime.ts        # Runtime 抽象（探测/run/stop/exec/remove）
│   ├── config.ts         # .pi/agent/sandbox.json 读写
│   ├── tiers.ts          # Tier 定义 + 解析
│   ├── sandbox.ts        # Sandbox 会话管理
│   ├── ops.ts            # 工具操作适配器 (Read/Write/Edit/BashOperations)
│   ├── paths.ts          # 路径翻译、安全检查、外部路径审批持久化
│   ├── skills.ts         # Skill 目录发现与挂载
│   └── commands/
│       └── sandbox.ts    # /sandbox 子命令处理
```

单个 `index.ts` 入口，pi 通过 jiti 加载，不需要构建步骤。

## 模块职责

### runtime.ts
- `Runtime` 接口：kind, detect(), run(), stop(), remove(), exec(), isRunning(), start(), createVolume()
- `run()` 组装 `docker run -d --name ... --user 1000:1000 --memory ... --cpus ... --cap-drop ALL ...` 参数
- `detectRuntime()`: which("docker") + 3s smoke test (run debian:slim sleep infinity)
- 函数：`spawnWithTimeout()`, `randomSuffix()`, `deriveContainerName()`

### config.ts
- SbxProjectConfig 结构: image, tag, containerName, tier, persist, cacheVolume
- DEFAULTS: image="pi-container-sandbox", tag="latest"
- `loadSbxConfig(hostCwd)` → `.pi/agent/sandbox.json`
- `saveSbxConfig(hostCwd, config)` → 写入
- 所有配置均为项目级，不使用全局/用户配置

### tiers.ts
- 三层预设：small(1g/1cpu/512m swap), medium(4g/2cpu/2g swap), large(8g/4cpu/4g swap)
- `parseSizeTier()` 解析字符串
- `TierSpec` 接口

### sandbox.ts
- `SbxSession` 接口：runtime, name, hostCwd, keep, mounts, allowedExternalPrefixes, resources, imageRef, projectConfig, isReusable, isReattached
- 全局 `sandbox` 变量 + `getSbx()` getter
- `createSbx()` / `attachSbx()`（reaattach 逻辑）
- `destroySbx()`（stop + rm -f，除非 keep/persist）
- cleanup handler 注册（process exit/SIGINT/SIGTERM）

### ops.ts
- `createReadOps(sbx)` → 包装 path 翻译 + execCapture 的 ReadOperations
- `createWriteOps(sbx)` → WriteOperations（检查 readonly mount）
- `createEditOps(sbx)` → 组合 read + write
- `createBashOps(sbx)` → 包装 execStream 的 BashOperations
- `execCapture(sbx, command)` → spawn docker exec + 收集输出
- `execStream(sbx, command, opts)` → streaming 版本

### paths.ts
- `toRemote(hostPath, hostCwd, mounts)` → host path → /workspace 路径
- `isInsideCwd(path, hostCwd)` → 判断
- `isAllowedExternalResource(path, allowedPrefixes)` → 检查外部路径白名单
- `getExternalPath(path)` → 判断是否外部路径
- `PathApprovalStore` 类：load/save/add/revoke/find/list
- 持久化到 `.pi/agent/path-approvals.json`（项目级）
- `requestPathApproval()` → 交互式 select (once/always/7d/30d/deny)
- `ensureExternalReadApproved()` → 完整审批流程

### skills.ts
- `discoverSkillMounts(additionalPaths?)` → 扫描 `~/.agents/skills/`, `~/.pi/agent/skills/`
- 返回 MountSpec[] 挂载到 /skills

### commands/sandbox.ts
- `/sandbox` 子命令注册与 handler
- 所有 handler 接收 `(args: string, ctx)` 签名

## 命令清单

| 命令 | 功能 |
|------|------|
| `/sandbox` | 别名，等同于 `/sandbox status` |
| `/sandbox start` | 手动启动当前 session 容器 |
| `/sandbox stop` | 停止并销毁当前容器 |
| `/sandbox status` | 容器状态、镜像信息 |
| `/sandbox keep [name]` | 保留为命名容器，写入 sandbox.json |
| `/sandbox exec <cmd>` | 在容器内执行命令并显示结果 |
| `/sandbox doctor` | 检查容器内核心工具是否正常 |
| `/sandbox config` | 显示 `.pi/agent/sandbox.json` 内容 |
| `/sandbox allow <path>` | 交互式批准外部主机路径读权限 |
| `/sandbox paths` | 列出已持久化的路径审批 |
| `/sandbox paths revoke <path>` | 撤销指定路径审批 |
| `/sandbox tiers [list]` | 列出所有层级及其配置 |
| `/sandbox tiers set <tier>` | 切换资源层级，写入 .pi/agent/sandbox.json |

## Flags

| Flag | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `--container` | boolean | true | 启用 sandbox |
| `--no-container` | boolean | false | 强制禁用 sandbox |
| `--noc` | boolean | false | `--no-container` 别名 |
| `--container-size` | string | "medium" | 资源层级: small/medium/large |
| `--sandbox-name` | string | — | 指定容器名（支持复用） |
| `--sandbox-persist` | boolean | false | 退出后保留容器 |
| `--sandbox-cache` | string | — | Docker volume 名，挂载到 /cache |
| `--container-image` | string | — | 镜像引用（覆盖 sandbox.json） |
| `--container-net` | boolean | true | 允许容器出站网络 |
| `--no-container-net` | boolean | false | 禁用容器网络 |
| `--container-keep` | boolean | false | 退出后不停止容器 |
| `--container-mount-skills` | boolean | true | 挂载 skill 目录 |
| `--container-mount-paths` | string | — | 额外挂载目录（逗号分隔） |
| `--container-allow-paths` | string | — | 外部路径读白名单（逗号分隔） |
| `--container-memory` | string | — | 覆盖 memory 限制 |
| `--container-cpus` | string | — | 覆盖 CPU 限制 |
| `--container-swap` | string | — | 覆盖 swap 限制 |
| `--container-pids-limit` | string | — | 覆盖 PIDs 限制 |

## 配置结构

### `.pi/agent/sandbox.json` (项目级，唯一配置)

```json
{
  "image": "pi-container-sandbox",
  "tag": "latest",
  "containerName": null,
  "tier": "medium",
  "persist": false,
  "cacheVolume": null
}
```

### `.pi/agent/path-approvals.json` (项目级，路径审批持久化)

```json
[
  {
    "path": "/home/user/downloads",
    "approvedAt": 1717939200000,
    "expiresAt": null
  }
]
```

所有配置均为项目级，不使用全局/用户级配置。

## 资源层级

| tier | memory | cpus | swap |
|------|--------|------|------|
| small | 1g | 1 | 512m |
| medium | 4g | 2 | 2g |
| large | 8g | 4 | 4g |

Flag 可覆盖单参数: `--container-memory 16g`。

## 核心流程

### Session 启动（session_start）

```
1. 检查 --no-container/--noc/--container flags
2. detectRuntime() → docker smoke test (3s timeout)
3. 加载项目配置 (.pi/agent/sandbox.json)
4. 解析 tier → resources
5. 确定容器名:
   - --sandbox-name <name> → 使用指定名
   - sandbox.json containerName → 使用指定名
   - 默认 → pi-sbx-<dirname>-<hash6>
6. 检查容器状态:
   - 运行中 → reattach
   - 已停止 + reusable/persist → docker start
   - 不存在 → docker run -d --name ...
7. 检查镜像是否存在: docker image inspect → 不存在则报错退出
8. 发现 skill 目录挂载
9. 创建 Read/Write/Edit/Bash 工具适配器
10. 注册 process cleanup handlers
11. before_agent_start → 替换 CWD 提示为 /workspace
```

### 容器创建参数

```
docker run -d --name <name> --user 1000:1000
  --memory <limit> --cpus <count>
  --cap-drop ALL --security-opt no-new-privileges
  --pids-limit <n>
  -v <hostCwd>:/workspace -v <cache>:/cache
  -v <skills>:/skills/<name>:ro
  --network none  (如果 --no-container-net)
  <image> sleep infinity
```

### Dockerfile 更新

当前 Dockerfile 使用 `pi` 作为镜像名。需更新为:
- 默认镜像名改为与项目一致的 `pi-container-sandbox`
- 支持 `--build-arg` 传入版本号打 tag

### 工具拦截

```
read/write/edit/bash 工具注册时:
  sbx = getSbx()
  若 sbx == null → fallback 到本地 create*Tool(localCwd)
  若 sbx != null → create*Tool(localCwd, { operations: *Ops(sbx) })

路径翻译:
  toRemote(hostPath, hostCwd, mounts)
    → resolve host path
    → 检查外部路径 → 如需要，交互审批
    → 返回 /workspace/<relative>

bash 执行:
  docker exec <container> sh -c "cd <cwd> && <command>"
```

### Session 结束（session_shutdown）

```
若 keep 或 persist → 不做任何事
否则 → docker stop <name> && docker rm -f <name>
```

## 路径安全

- 所有工具路径限制于 `/workspace`（即 host cwd）内
- 容器视角的 CWD 为 `/workspace`，通过 `before_agent_start` 注入到 system prompt
- 外部路径访问需交互审批：once / always / 7 days / 30 days / deny
- `pi-clipboard-*` 临时文件自动放行
- Skill 目录只读挂载到 `/skills`，write/edit 操作拒绝
- 审批记录持久化到 `.pi/agent/path-approvals.json`（项目级）
- Docker socket、SSH agent、host $HOME 均不暴露给容器

## 错误处理

- detectRuntime 失败 → notify warning，sandbox disabled
- 镜像不存在 → notify error，提示手动 build，不启动 sandbox
- exec 超时 → throw Error
- 容器创建失败 → throw Error，catch 后 notify error
- 外部路径未审批 → throw Error 带说明如何授权

## 依赖

```json
{
  "dependencies": {
    "@earendil-works/pi-coding-agent": "^0.74.0"
  },
  "devDependencies": {
    "@types/node": "^25.6.0",
    "typescript": "~6.0.3"
  }
}
```

仅依赖 pi-coding-agent（提供 ExtensionAPI 类型 + create*Tool 工厂），无其他 npm 依赖。使用 Node.js 内置模块（fs, path, os, child_process, crypto）完成所有操作。

## 测试策略

- `npm run typecheck` 确保 TypeScript 编译通过
- 手动集成测试：`pi -e ./index.ts` 启动后验证容器创建、工具路由、路径安全
- 参考实现已成熟验证的核心模式直接采用
