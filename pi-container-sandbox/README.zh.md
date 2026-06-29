# pi-container-sandbox

一个 [pi](https://pi.dev/docs/latest/extensions) 扩展，将 agent 的 `bash`、`read`、`write`、`edit` 工具以及用户的 `!` bash 运行在每会话独立的 Docker 容器中，从而隔离编程操作的副作用。

## 快速开始

需要 Docker（任意较新版本）运行中且当前用户可访问
（需要对 `/var/run/docker.sock` 或 Docker Desktop 有读写权限）。

```bash
# 从 npm 安装
pi install npm:@yandy0725/pi-container-sandbox

# 或从本地仓库安装
pi install .

# 或直接运行
npm install && npm run build-image
pi -e ./index.ts
```

首次使用时，扩展会自动使用本地 `docker/Dockerfile` 构建内置的 sandbox 镜像
（`pi-container-sandbox:latest`）。后续运行会复用该镜像。

```bash
# 在任意项目中使用
pi
# /sandbox         # 查看容器信息
# !pwd             # 在容器内执行，输出 /workspace
# !ls              # 列出容器内的项目根目录
```

## 各工具运行在哪里

| 工具 / 命令 | 运行位置 |
|---|---|
| `bash`（agent）   | 容器内，工作目录为 `/workspace` |
| `read`           | 容器内（通过 `allow` 授权的外部路径直接从宿主机读取） |
| `write`          | 容器内 |
| `edit`           | 容器内（读取操作：同 `read`；写入操作：容器内） |
| `!` 用户 bash    | 容器内 |
| `bash`（白名单） | 宿主机直接执行（参见配置中的 `hostCommands`） |
| `find`、`grep`、`ls` | pi 的宿主机默认行为（使用 `bash` 工具调用可在容器内执行） |

项目的 cwd 以 **读写** 方式 bind-mount 到容器内的 `/workspace`。
agent 的编辑操作会同时反映在宿主机和容器中。
agent skill 目录以 **只读** 方式挂载到 `/skills/`。

> **注意：** `/sandbox allow` 和 `--container-allow-paths` 仅影响
> `read` 工具（以及 `edit` 的读取操作）。要向项目 cwd 之外的路径
> 写入文件，请使用 `--container-mount-paths` 将其 bind-mount 到容器中。

容器默认在 pi 退出时删除，除非设置了 `--sandbox-persist` 或 `--container-keep`。

## 命令

| 命令 | 描述 |
|---|---|
| `/sandbox` / `/sandbox status` | 显示容器 ID、资源配置、宿主机工作目录 |
| `/sandbox start` | 手动启动 sandbox 容器 |
| `/sandbox stop` | 停止并移除容器（若 keep/persist 启用则阻止） |
| `/sandbox keep [name]` | 保存容器名称用于下次会话复用 |
| `/sandbox exec <cmd>` | 在容器内执行命令 |
| `/sandbox doctor` | 验证容器内核心工具是否可用 |
| `/sandbox config` | 显示 `.pi/agent/sandbox.json` 内容 |
| `/sandbox allow <path>` | 授权读取宿主机外部路径 |
| `/sandbox paths [revoke <path>]` | 列出或撤销已持久化的路径授权 |
| `/sandbox tiers [set <tier>]` | 列出或切换资源规格 |

## 配置

配置从两个位置读取，项目配置覆盖全局配置。

### 全局配置

`~/.pi/agent/sandbox.json`：

```json
{
  "runtime": { "tier": "medium" }
}
```

### `.pi/sandbox.json`（项目级）

```json
{
  "image": { "name": "pi-container-sandbox", "tag": "latest" },
  "runtime": {
    "name": null, "tier": "medium", "network": true, "persist": false,
    "memory": null, "cpus": null, "swap": null, "pidsLimit": null,
    "cache": null, "mounts": []
  },
  "build": { "dockerfile": null, "context": null, "args": {} },
  "host": { "commands": [] }
}
```

#### image 组
| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `name` | string | `"pi-container-sandbox"` | 镜像名 |
| `tag` | string | `"latest"` | 镜像标签 |

#### runtime 组
| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `name` | string \| null | `null` | 容器复用名 |
| `tier` | `"small"` \| `"medium"` \| `"large"` | `"medium"` | 资源规格 |
| `network` | boolean | `true` | 容器网络 |
| `persist` | boolean | `false` | 退出后保留容器 |
| `memory` | string \| null | `null` | 内存覆盖 |
| `cpus` | string \| null | `null` | CPU 覆盖 |
| `swap` | string \| null | `null` | swap 覆盖 |
| `pidsLimit` | number \| null | `null` | PID 限制 |
| `cache` | string \| null | `null` | 缓存卷名 |
| `mounts` | string[] | `[]` | 额外挂载路径 |

#### build 组
| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `dockerfile` | string \| null | `null` | Dockerfile 路径 |
| `context` | string \| null | `null` | 构建上下文 |
| `args` | Record<string, string> | `{}` | 构建参数 |

#### host 组
| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `commands` | string[] | `[]` | 宿主机命令白名单 |

### 资源规格

| 规格 | 内存 | CPU | swap |
|------|------|-----|------|
| small | 1g | 1 | 512m |
| medium | 4g | 2 | 2g |
| large | 8g | 4 | 4g |

使用 `--container-size` 参数或 `/sandbox tiers set` 切换。

### CLI 参数

| 参数 | 默认值 | 描述 |
|------|--------|------|
| `--container` | `true` | 启用 sandbox |
| `--no-container` / `--noc` | `false` | 禁用 sandbox |

其他所有配置项均通过 `sandbox.json` 配置。

## 外部文件读取

当 agent 尝试**读取**项目 cwd 之外的文件（如系统配置文件）时，sandbox 会弹出交互式授权提示。可以通过 `--container-allow-paths` 参数或 `/sandbox allow` 命令预先授权。已授权的路径会持久化到 `.pi/agent/path-approvals.json`。

路径授权后，`read` 工具会直接从**宿主机文件系统**读取（绕过容器）。只有 `read` 工具和 `edit` 的读取操作受影响 —— `write`、`edit` 的写入操作以及 `bash` **不受**影响，始终在容器内运行。

### 授权机制对比

| 工具 | 外部读取 | 外部写入 |
|------|---------|---------|
| `read` | `--container-allow-paths` / `/sandbox allow` | — |
| `edit`（读操作） | `--container-allow-paths` / `/sandbox allow` | — |
| `edit`（写操作） | — | `--container-mount-paths` |
| `write` | — | `--container-mount-paths` |
| `bash` | — | `--container-mount-paths` |

- **allow**：轻量级只读宿主机访问。路径按前缀匹配（例如授权 `/etc` 即可读取 `/etc` 下的所有文件）。
- **mount**：将宿主机目录 bind-mount 到容器内相同路径，在容器内拥有完整读写权限。用于写入操作，或需要让工具在容器内操作外部路径的场景。

## 资源限制（默认值）

- 内存：4 GiB（medium 规格）
- CPU：2 核
- PID 数量：512
- 无 Linux capabilities：`--cap-drop ALL`
- 禁止权限提升：`--security-opt no-new-privileges`
- 用户：非 root（uid 1000）
- 网络：默认（容器可访问互联网）
- 容器内无 Docker socket

## 故障排查

### `Sandbox not ready: Docker not available`

确保 Docker 正在运行：

```bash
docker ps
```

如果 Docker 已运行但扩展无法连接，可能当前用户对 `/var/run/docker.sock` 没有权限。在 Linux 上，可将自己加入 `docker` 组。

### 镜像构建失败

自动构建会下载多种工具（rg、fd、bat、node、uv、bun 等）并校验 SHA-256。如果某个下载失败（例如在公司代理后），构建也会失败。可手动预构建：

```bash
npm run build-image
```

### agent 的编辑没有反映到宿主机

bind mount 位于容器内的 `/workspace`，映射到宿主机的项目 cwd。检查 `docker inspect <container-name> | grep -A 5 Mounts`。

### 想进入容器内部

```bash
docker exec -it <container-name> bash
```

通过 `/sandbox status` 或 `docker ps --filter name=pi-sbx-` 查找容器名称。

## 开发

```bash
npm install              # 安装依赖
npm run typecheck        # tsc --noEmit
npm run lint             # biome lint
npm test                 # vitest 运行
npm run build-image      # 构建 sandbox 镜像
pi -e ./index.ts         # 本地运行扩展
bash tests/e2e.sh        # 运行 E2E 测试（需要 Docker + pi CLI）
```

## 工作原理

`pi-container-sandbox` 是一个 pi 扩展。在 `session_start` 时，它确保
`pi-container-sandbox:latest` 存在（如需要则从内置的 `docker/Dockerfile` 构建），
然后启动一个长生命周期的容器，将项目 cwd bind-mount 到 `/workspace`。
它替换 pi 的编程工具（`bash`、`read`、`write`、`edit`），使这些工具的 I/O
通过 dockerode 的 Docker Engine API 调用路由到容器内。用户的 `!` bash
通过 `user_bash` 事件使用相同的适配器。

容器在 `session_shutdown` / SIGINT / 进程退出时销毁（除非设置了 `keep`）。
如果 Docker 不可达，扩展会优雅降级到 pi 的默认宿主机工具并发出通知。

## 许可证

MIT
