# pi-sandbox

pi coding-agent 扩展：**进程级沙箱**（bwrap / landlock / seatbelt / windows-acl）——默认**工作目录可写、其余宿主文件可读**，fail-closed。

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
| Linux | `bwrap`（首选） | `--ro-bind / /` 全盘只读 + 工作区与宿主 `/tmp` 的 rw bind |
| Linux | `landlock-run`（回退，随包分发预编译二进制） | Landlock LSM 允许清单：`/` 只读，工作区 + `/tmp` 可写 |
| macOS | `sandbox-exec`（系统内置） | Seatbelt SBPL：`deny file-write*` + 工作区/临时区例外 |
| Windows | `windows-acl`（内置，`partial` 强制） | 受限令牌沙箱：`WRITE_RESTRICTED` 令牌 + 对工作区与 `%TEMP%` 的能力 SID ACL 授权 + Low 强制完整性标签；**仅 powershell 工具**（受限模式下 `bash` 被拒绝） |
| 其他 | 无 | **fail-closed**：受约束命令一律拒绝执行，绝不静默裸跑 |

### Windows

`windows-acl` runner 以 `WRITE_RESTRICTED` 受限令牌启动每条受限命令，并把令牌完整性级别降到 Low。`workspace-write` 下令牌还携带能力 SID，获得工作区与宿主 `%TEMP%` 的写授权，并在两个授权根上打可继承的 `NO_WRITE_UP` 标签；`read-only` 不授予任何写能力。强制是 **`partial`** 的——与参考实现相同，存在三处结构性缺口：

- **NTFS 硬链接是文件对象别名**：工作区内被授权文件的硬链接在外部同样可写
- **读不受限**：与其他 runner 一致，受约束进程能读调用者可读的一切
- **被其他 AppContainer 工具以包 SID 打标过的文件对 Low 完整性子进程不可读**（移除外来 ACE 或重装目录树可恢复）

受限 shell 只有 **`powershell` 工具**。受限模式下 `bash` 一律被拒绝（绝不 spawn）并给出可执行的错误指引；在 `~/.pi/agent/settings.json` 中启用该工具（需要 pi >= 1.0.0，`powershell` 工具自该版本起提供）：

```json
{ "defaultTools": ["-bash", "+powershell"] }
```

未启用前 pi-sandbox 会在激活时提示一次，`/permission` 状态行显示 `shell: powershell only (not activated)`。`danger-full-access` 是唯一逃生门（与其他平台一样，`bash` 照常裸跑）。

PowerShell 语言模式取决于启动约束，不是 ACL 边界的一部分：`read-only` 下 `%TEMP%` 不可写，pwsh 可能退化为 ConstrainedLanguage（`Add-Type`/COM/反射失败）；`workspace-write` 保持 FullLanguage。

**常驻的安全描述符改动。** 授权幂等但**不回收**：pi 退出后，工作区与 `%TEMP%` 上的 ACE、world `FILE_DELETE_CHILD` 拒绝项与 Low 强制标签仍然保留。这会向**任何**以同一用户身份运行在 Low 完整性的进程放宽该目录树；事后再清除可继承标签也不会回退已传播到子对象的标签。切回 `read-only` 会让能力 ACE 失效（该令牌不携带能力 SID），但不会移除它们。首次授权会在整棵 `%TEMP%` 树上做急切传播（大树可能耗时数秒），之后每次调用命中精确匹配的快路径。`%TEMP%` 与 `TMP` 本身**不**被重写——沙箱的可写临时根就是宿主 `%TEMP%`。

**`%TEMP%` 的代价。** `%TEMP%` 是用户共享树：其子目录会继承拒绝项，因此第三方程序用 `GENERIC_ALL`/`FullControl` 打开自己的 temp 子目录会被拒。基于 DELETE 的删除、`MAXIMUM_ALLOWED` 与常规读写打开不受影响。

`koffi`（Win32 调用的 FFI 层）是常规依赖，懒加载且仅在 Windows 上加载——Win32 绑定表在其他平台上永不物化。

随包提供的 `diagnose-windows-sandbox-acl` 技能（诊断并修复“Windows 文件权限挡住 pi-sandbox 授权”的场景）**仅在 Windows 上**贡献给 pi。它的修复会修改安全描述符，必须由不受限的调用者执行——请通过一次已批准的 `danger-full-access`（或手工）运行。

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

## 提权审批（模型发起，denial-first）

bash/write/edit 带两个可选参数：`sandbox_permissions`（`workspace-write` 或 `danger-full-access`）+ `justification`（一句话理由）。审批是 **denial-first** 的：

- 严格更宽的请求只在**本会话真实发生过同类沙箱拒绝**后（bash ↔ `command`，write/edit ↔ `operation`）才会弹审批；没有前置拒绝时提权参数会被**忽略**，调用按当前档位正常执行，结果附一行 `[sandbox: escalation fields were ignored …]` 告诉模型参数没生效——这消除了模型"先发制人"带提权参数造成的弹窗轰炸；
- 拒绝记录**一次性消费**：一次拒绝只放行一笔提权重试（批准仍只对那一次调用生效）；
- 占位符参数按字段归一化：省略或传 JSON `null` 都表示"不提权"，参数 schema 也显式声明了 `null`——因此 strict schema 提供商（pi 会把这两个字段标成必填）下的模型有一个合法的"不提权"取值可传；`justification` 上的 `"null"` / 空白字符串同样归一化为"未提供"。字符串占位符（`"null"` / 空串 / 纯空白）另有一层兜底：工具的 `prepareArguments` 在参数校验前把它们剥掉——strict 提供商下模型常把必填的可选字段写成字符串 `"null"`，这层兜底让普通调用照常执行，不再产生与沙箱无关的硬错误。

弹窗提供 **Allow once / Deny**；选 Deny 后可再填一句**可选理由**（回车跳过），理由会随拒绝错误回传给模型，让它明白为什么被拒、不要换写法反复试探。subagent 子会话（前台与后台都算）的提权会转发到父会话弹窗（同进程 pi-subagents，且父会话需有 UI）；无父通道时（headless、跨进程子代理）提权一律拒绝（fail-closed），此时用 `/permission` 放宽进程档位解救。

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
- bwrap 下 bash 的 `/tmp` **就是宿主 /tmp**（rw bind，与 write/edit 围栏及 landlock/macOS 一致）：沙箱内命令可以直接修改/删除宿主的临时文件（含会话 socket 与 pi 自己的临时文件），宿主 `/tmp` 的权限原样生效；宿主 `/tmp` 不可写时沙箱内也随之不可写
- Windows 下沙箱的临时根就是宿主 `%TEMP%`（`windows-acl` runner 授权真实路径、不重写 `TMP`/`TEMP`）：受限命令可以修改/删除宿主临时文件，与上面 bwrap 的 `/tmp` 同属“宿主 tmp 就是宿主 tmp”的语义
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
