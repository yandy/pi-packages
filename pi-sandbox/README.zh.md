# pi-sandbox

pi coding-agent 扩展：**进程级沙箱**（bwrap / landlock / seatbelt）——默认**工作目录可写、其余宿主文件可读**，fail-closed。

## 安装

```bash
# 从 npm 安装
pi install npm:@yandy0725/pi-sandbox

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

bash/write/edit 带两个可选参数：`sandbox_permissions`（`workspace-write` 或 `danger-full-access`）+ `justification`（一句话理由）。操作被沙箱拒绝后，模型可带这两个参数原样重试一次，会弹出审批（Allow once / Deny）；批准只对那一次调用生效。subagent 子会话（前台与后台都算）的提权会转发到父会话弹窗（同进程 pi-subagents，且父会话需有 UI）；无父通道时（headless、跨进程子代理）提权一律拒绝（fail-closed），此时用 `/permission` 放宽进程档位解救。

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
- 受限 bash 在独立进程组中运行（detached）：timeout/abort 会杀掉整个进程组；但若 pi 自身被硬杀（如 SIGKILL），命令派生的后台孙进程可能存活（pi 内部的子进程追踪 API 不对扩展开放）
- landlock 回退在旧内核 ABI 上为 partial enforcement（状态里会标注）

## 从 pi-container-sandbox 1.x 迁移

- 配置文件位置不变（`~/.pi/agent/sandbox.json`、`<project>/.pi/sandbox.json`）；旧 `image`/`runtime`/`host` 段会被忽略并告警，按需改写为上面的新字段
- 容器运行时（docker/podman）、镜像构建、`runtime.mounts`、`/sandbox` 命令、`--container*` flags、外部路径审批流不属于本包
- 需要容器级强隔离（独立文件系统/网络命名空间）请安装 `@yandy0725/pi-container-sandbox`（保留容器实现）
- `pi-sandbox` 与 `@yandy0725/pi-container-sandbox` **互斥**：两者都接管 `bash`/`write`/`edit`，且共用同一个 `sandbox.json`（schema 不兼容）——同一时刻只启用一个，切换前先卸载或停用另一个

## 开发

```bash
npm test              # 单元 + 集成（无 runner 环境集成自动 skip）
npm run typecheck
./tests/e2e.sh
```

### 用本地构建验证提权转发

父会话可以用 `pi -e <path>` 直接加载本地 pi-sandbox，但 **`-e` 只影响父会话**：pi-subagents 为子会话另建资源加载器，子会话按 `agentDir` 与项目 `.pi/` **重新发现**扩展。若 `~/.pi/agent/settings.json` 里仍声明 `npm:@yandy0725/pi-sandbox`，子会话会加载发布版，转发会**静默失效**（子会话只报 `requires approval, but no approval channel is available`）。让父子两侧发现同一份构建：

```bash
AG=$(mktemp -d); cp ~/.pi/agent/auth.json "$AG/" 2>/dev/null || true
cat > "$AG/settings.json" <<EOF
{ "packages": ["<repo>/pi-sandbox", "<repo>/pi-subagents"] }
EOF
cd <可写项目目录> && PI_CODING_AGENT_DIR="$AG" pi
```

观察点与验证记录见 `docs/superpowers/specs/2026-09-30-escalation-approval-forwarding-design.md` §11。

## License

MIT
