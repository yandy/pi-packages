# pi-container-sandbox

pi coding-agent 扩展：用**进程级沙箱**约束 AI agent 的文件效果——默认**工作目录可写、其余宿主文件可读**（deepseek harness `workspace-write` 语义）。2.0 起不再使用容器。

## 安装

```bash
# 从 npm 安装
pi install npm:@yandy0725/pi-container-sandbox

# 或从本地仓库安装
pi install .
```

## 工作原理

bash 命令被包装进平台沙箱 runner 后在本地 spawn（**路径透明**：宿主路径原样有效）；write/edit 工具在执行前做进程内写围栏；read 不受限。

| 平台 | Runner | 机制 |
|---|---|---|
| Linux | `bwrap`（首选） | `--ro-bind / /` 全盘只读 + 工作区 rw bind + `--tmpfs /tmp` |
| Linux | `landlock-run`（回退，随包分发预编译二进制） | Landlock LSM 允许清单：`/` 只读，工作区 + `/tmp` 可写 |
| macOS | `sandbox-exec`（系统内置） | Seatbelt SBPL：`deny file-write*` + 工作区/临时区例外 |
| 其他 | 无 | **fail-closed**：受约束命令一律拒绝执行，绝不静默裸跑 |

## 三档权限模式

| 模式 | 文件效果 |
|---|---|
| `read-only` | 仅 `/dev/null` 可写 |
| `workspace-write`（默认） | 工作目录 + `/tmp` + `os.tmpdir()` 可写，其余只读 |
| `danger-full-access` | 完全绕过沙箱（显式逃生门） |

网络始终放行（不做网络隔离）。

## /permission 命令

- `/permission` —— 显示当前状态（模式及来源、选中 runner 与 enforcement、工作区）
- `/permission <read-only|workspace-write|danger-full-access>` —— 切换模式，**进程级**生效：父会话与所有 subagent 子会话的下一次工具调用立即采用

## 提权审批（模型发起）

bash/write/edit 带两个可选参数：`sandbox_permissions`（`workspace-write` 或 `danger-full-access`）+ `justification`（一句话理由）。操作被沙箱拒绝后，模型可带这两个参数原样重试一次，会弹出审批（Allow once / Deny）；批准只对那一次调用生效。无 UI 通道（headless、后台 subagent）时提权一律拒绝（fail-closed）。

## 配置

`~/.pi/agent/sandbox.json`（全局）与 `<项目>/.pi/sandbox.json`（项目），逐字段 项目 > 全局 > 默认：

```json
{
  "mode": "workspace-write",
  "runnerCommand": null,
  "runnerFailureSignatures": null,
  "probeTimeoutMs": 5000
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `workspace-write` | 默认权限模式；非法值回落默认并告警 |
| `runnerCommand` | `null` | 自定义 bwrap 兼容 runner argv（须与下一项成对） |
| `runnerFailureSignatures` | `null` | 自定义 runner 的失败诊断签名（非空单行） |
| `probeTimeoutMs` | `5000` | runner 功能探测超时（正数） |

## 安全说明

- 受约束进程可**读取**宿主上你有权读的一切（包括 `~/.ssh` 等）——这是本沙箱的设计语义（与 deepseek harness 一致）；root 专属文件受文件权限保护
- 受限子进程强制 `LC_MESSAGES=C`（保证拒绝诊断可分类），不改动你的 `LANG`/`LC_CTYPE`
- landlock 回退在旧内核 ABI 上为 partial enforcement（状态里会标注）

## 从 1.x 迁移

- 容器运行时（docker/podman）、镜像构建、`runtime.mounts`/`image`/`host` 配置组、`/sandbox` 命令、`--container*` flags、外部路径审批流全部移除
- 旧 `sandbox.json` 的 `image`/`runtime`/`host` 段会被忽略并告警；按需改写上表新字段
- 需要容器级强隔离（独立文件系统/网络命名空间）请停留在 1.x

## 开发

```bash
npm test              # 单元 + 集成（无 runner 环境集成自动 skip）
npm run typecheck
./tests/e2e.sh
```

## License

MIT
