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

**适用范围仅限模型发起的动作。** 你自己输入的 `!命令` / `!!命令`（以及 RPC 的 `bash` 命令）由 pi 经 `user_bash` 事件执行，本扩展不处理该事件 —— 它由你自己的 shell 裸跑，不受上面三档模式约束。你在 pi 之外启动的进程同理。

| 平台 | Runner | 机制 |
|---|---|---|
| Linux | `bwrap`（首选） | `--ro-bind / /` 全盘只读 + 工作区、宿主 `/tmp` 与配置的 `writableRoots` 的 rw bind |
| Linux | `landlock-run`（回退，随包分发预编译二进制） | Landlock LSM 允许清单：`/` 只读，工作区 + `/tmp` + 配置的 `writableRoots` 可写 |
| macOS | `sandbox-exec`（系统内置） | Seatbelt SBPL：`deny file-write*` + 工作区/临时区例外 |
| Windows | `windows-acl`（内置，`partial` 强制） | 受限令牌沙箱：`WRITE_RESTRICTED` 令牌 + 对工作区与 `%TEMP%` 的能力 SID ACL 授权 + Low 强制完整性标签；**仅 powershell 工具**（受限模式下 `bash` 被拒绝） |
| 其他 | 无 | **fail-closed**：受约束命令一律拒绝执行，绝不静默裸跑 |

### Windows

`windows-acl` runner 以 `WRITE_RESTRICTED` 受限令牌启动每条受限命令，并把令牌完整性级别降到 Low。`workspace-write` 下令牌还携带能力 SID，获得工作区与宿主 `%TEMP%` 的写授权，并在两个授权根上打可继承的 `NO_WRITE_UP` 标签；`read-only` 不授予任何写能力。强制是 **`partial`** 的——与参考实现相同，存在三处结构性缺口：

- **NTFS 硬链接是文件对象别名**：工作区内被授权文件的硬链接在外部同样可写
- **读不受限**：与其他 runner 一致，受约束进程能读调用者可读的一切
- **被其他 AppContainer 工具以包 SID 打标过的文件对 Low 完整性子进程不可读**（移除外来 ACE 或重装目录树可恢复）

另有一处本包自己的缺口：**`writableRoots` 到不了 `windows-acl` runner**。它的 argv 契约是写死的两根（`--workspace` / `--temp`）；推广到 N 根需要新的能力 SID 域分隔方案、一个关于“新建对象继承哪个能力”的定案（今天是 `temp → workspace → Everyone`），以及 N 根的嵌套检查。所以 Windows 上 `writableRoots` 只对 `write`/`edit` 围栏生效，受限 `powershell` 仍只有工作区 + `%TEMP%`。列表非空时会 warn 一次。这个不对称是 **fail-closed 方向**的（shell 比围栏更窄）。

受限 shell 只有 **`powershell` 工具**。在 Windows（pi >= 1.0.0）上，pi-sandbox 把受限 `bash` 以 `exposure: "hidden"` 注册——pi 的语义是 *registered but unreachable*：模型看不到它，显式点名（`defaultTools`、`--tools`、`setActiveTools()`）也无法激活它。保留这份注册是有意的：扩展工具按名覆盖内建定义，`bash` 这个名字被本包的拒绝壳占据，Windows 上不存在任何通往未受限内建 `bash` 的路径；若未来宿主改变 `hidden` 的兑现方式，该定义仍会拒绝受限模式下的每次调用（绝不 spawn，fail-closed）。除非显式切到 `danger-full-access`（唯一逃生门，与其他平台一样 `bash` 照常裸跑），沙箱绝不在 Windows 上非受限地运行 bash。

已知限制：**`defaultTools` 去不掉扩展注册的工具**（`-name` 条目只能移除内置工具；扩展工具除非在定义里声明退出，否则会被自动激活）。pi-sandbox 不要求用户为此配置：Windows 上 `bash` 这个名字在**定义层**就已从模型侧撤下（`exposure: "hidden"`），没有可配置掉的余地。若 `powershell` 未激活（低于 1.0.0 的老宿主——该版本没有 `powershell` 工具，或选择列表把它排除在外），`/permission` 状态行显示 `shell: powershell only (not activated)`，并在 `bash` 仍在活动列表时（老宿主）于激活期提示一次；`{ "defaultTools": ["+powershell"] }`（需要 pi >= 1.0.0）可把它加回来。

**支持范围。**与所移植的上游设计（deepseek-harness）一致：**不设新 OS 下限**——机制是 `WRITE_RESTRICTED` 受限令牌 + Low 强制标签，两者都是老 API（当初选它而不是 `mxc`，正是因为 mxc 要 Windows 11 24H2+）。本仓端到端验证在 **Windows 10 Enterprise LTSC 2019（build 17763.316）**上完成：自动化 e2e 与人工验收清单均绿。更新版本预期一致（后端不依赖新版本特性），但本仓尚未验证。注意：上游的**测试**跑在 Windows Server 2025 上，它的测试夹具不可移植到老 build；本包的 Windows 夹具刻意只用与版本无关的原语。

PowerShell 语言模式取决于启动约束，不是 ACL 边界的一部分：`read-only` 下 `%TEMP%` 不可写，pwsh 可能退化为 ConstrainedLanguage（`Add-Type`/COM/反射失败）；`workspace-write` 保持 FullLanguage。

**`NUL` 在两种模式下都可写**——这是**设备自身的环境属性**（设备 DACL 授予 Everyone 读/写/执行），不是沙箱的能力授予，因此与令牌拿到哪些授权根无关。它只能通过设备拼法到达：`cmd` 的 `> NUL`，以及 Node 的 `\\.\NUL`。**相对路径** `NUL` 不是设备：libuv 构造 NT 路径时不做 Win32 设备名映射，因此 `writeFileSync('NUL', …)` 是子进程 cwd 下一个名为 `NUL` 的**普通文件**——在工作区内允许、在工作区外被拒，与其他文件名完全同等。

**常驻的安全描述符改动。** 授权幂等但**不回收**：pi 退出后，工作区与 `%TEMP%` 上的 ACE、world `FILE_DELETE_CHILD` 拒绝项与 Low 强制标签仍然保留。这会向**任何**以同一用户身份运行在 Low 完整性的进程放宽该目录树；事后再清除可继承标签也不会回退已传播到子对象的标签。切回 `read-only` 会让能力 ACE 失效（该令牌不携带能力 SID），但不会移除它们。首次授权会在整棵 `%TEMP%` 树上做急切传播（大树可能耗时数秒），之后每次调用命中精确匹配的快路径。`%TEMP%` 与 `TMP` 本身**不**被重写——沙箱的可写临时根就是宿主 `%TEMP%`。

**`%TEMP%` 的代价。** `%TEMP%` 是用户共享树：其子目录会继承拒绝项，因此第三方程序用 `GENERIC_ALL`/`FullControl` 打开自己的 temp 子目录会被拒。基于 DELETE 的删除、`MAXIMUM_ALLOWED` 与常规读写打开不受影响。

**拒绝分类只认英文消息文本。** 工具用来注入 `[sandbox: …]` 拒绝标记、提权提示与 denial 记账的方言，都是英文的 Win32 / `cmd` / PowerShell 消息文本，且只匹配子进程的 **stderr**。在本地化（如 zh-CN）的 Windows 上这些消息会被本地化：沙箱**仍然拒绝**访问（强制层与语言无关），但工具可能不会标注该拒绝，denial-first 提权也不会记账。看不到拒绝标记时按“分类缺口”而非“强制失效”处理。

`koffi`（Win32 调用的 FFI 层）是常规依赖，懒加载且仅在 Windows 上加载——Win32 绑定表在其他平台上永不物化。

随包提供的 `diagnose-windows-sandbox-acl` 技能（诊断并修复“Windows 文件权限挡住 pi-sandbox 授权”的场景）**仅在 Windows 上**贡献给 pi。它的修复会修改安全描述符，必须由不受限的调用者执行——请通过一次已批准的 `danger-full-access`（或手工）运行。

## 三档权限模式

| 模式 | 文件效果 |
|---|---|
| `read-only` | 仅 `/dev/null` 可写 |
| `workspace-write`（默认） | 工作目录 + `/tmp` + `os.tmpdir()` + 配置的 `writableRoots`（见「配置」一节）可写，其余只读 |
| `danger-full-access` | 完全绕过沙箱（显式逃生门） |

网络始终放行（不做网络隔离）。

## /permission 命令

- `/permission` —— 显示当前状态（模式及来源、选中 runner 与 enforcement、工作区，以及你配了额外可写根时解析后的结果）
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
  "probeTimeoutMs": 5000,
  "writableRoots": []
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `workspace-write` | 默认权限模式；非法值回落默认并告警 |
| `runnerCommand` | `null` | 自定义 bwrap 兼容 runner argv（须与下一项成对） |
| `runnerFailureSignatures` | `null` | 自定义 runner 的失败诊断签名（非空单行） |
| `probeTimeoutMs` | `5000` | runner 功能探测超时（正数） |
| `writableRoots` | `[]` | 工作区 + tmp 之外的额外可写目录；与其他字段一样参与合并（项目 > 全局 > 默认） |

### 额外可写根（`writableRoots`）

工具 cache 是受限命令失败最常见的原因：`uv` 写 `~/.cache/uv`、`pip` 写 `~/.cache/pip`、`npm` 写 `~/.npm`、`pnpm` 的 store 在 `~/.local/share/pnpm/store`。`workspace-write` 下它们全是只读，而从这一档往上只剩 `danger-full-access` 一级——为一次 cache 写付这个代价太高。两条出路，按优先级：

1. **把工具状态重定向到已经可写的根里。**拒绝消息会列出常用的变量（`UV_CACHE_DIR`、`PIP_CACHE_DIR`、`npm_config_cache`、`GOCACHE`、`pnpm install --store-dir`），所以模型通常自己就能解决，不需弹审批窗。重定向到 `/tmp` 的代价只是重启后没了热 cache。
2. **把那个具体目录授予出去**，写在 `~/.pi/agent/sandbox.json`：

```json
{
  "writableRoots": ["~/.cache/uv", "~/.cache/pip", "~/.npm", "~/.local/share/pnpm/store"]
}
```

规则：

- **加最小的。绝不要加整个 home 目录。**凡是**等于或包含** home 目录、文件系统根、或 pi 的 agentDir（`~/.pi/agent`）的条目，一律 **warn + 拒绝**，不会生效。
- `<ws>/.pi` **授予不了**：pi 自己的项目配置目录无论你怎么列都恒为只读（见「受保护路径」）。
- `~` 与 `~/…` 会展开；其余必须是绝对路径。`$HOME/…` 与 `%USERPROFILE%\…` 不展开。
- **不存在的根会被跳过**并 warn——runner 无法授权一个不存在的路径（bwrap 对不存在的 `--bind` 源直接硬失败），write/edit 围栏也同步跳过，两边一致而不是单侧放行。`mkdir -p` 建好后下一次工具调用即生效。
- 只在 `workspace-write` 下有意义；`read-only` 忽略整个列表。
- **Windows** 上见上面 `windows-acl` 的第四条缺口：只对围栏生效，不对受限 shell 生效。

`/permission` 会打印真正解析出来的根，所以写错或被跳过的条目是看得见的，不会静默失效。

`~/.cache` 有意**不**在默认授予之列：桌面机器上它不只是 cache——里面有之后会以 root 安装的包管理器构建缓存（`~/.cache/paru/clone/*`）、活的 IPC socket、正在运行的桌面会话与锁屏状态、浏览器 profile，以及之后会无沙箱执行的二进制（`ms-playwright`、`puppeteer`、`electron`）。而受约束进程本来就能**读**一切，所以放开它买不到机密性收益，只交出完整性与持久化。它连大家真碰到的工具也修不好（`pnpm` 的 store 在 `XDG_DATA_HOME` 下，`npm` 用 `~/.npm`，Playwright 把 `~/.cache/ms-playwright` 写死、不认 `XDG_CACHE_HOME`）。完整论证：`docs/superpowers/specs/2026-10-14-writable-roots-design.md` §3。

## 受保护路径

`<工作区>/.pi` 恒为**只读**，即使它就在工作区里面。pi 从那里加载项目级 extensions / agents / skills / prompts / themes，而每个 subagent 子会话都会重新发现它们——所以沙箱内写一次 `.pi/agents/x.md`，下一次 subagent 调用就会以你的完全权限运行它，不需要 `/reload`，也不需要重启。

- 对 `write`/`edit` 工具在**所有平台**生效，且与目录是否存在无关——「从零创建它」正是攻击本身，所以「它还不存在」不能成为放行的理由。
- 把它列进 `writableRoots` **抬不动**这层保护。
- `danger-full-access` 能解除：提权审批就是为这个准备的。拒绝文案会说清原因与重试配方，模型于是去请求批准，而不是换写法反复试探。

受限 shell 侧的覆盖情况取决于后端，`/permission` 会如实报告而不是暗示全覆盖：

| 后端 | 受限 shell 里的 `.pi` |
|---|---|
| `bwrap` | `.pi` 存在时受保护（嵌套在工作区 bind 内的只读 bind） |
| `sandbox-exec` | 受保护，含「从零创建」 |
| `landlock-run` | **不受保护** —— Landlock 规则是并集，表达不了 deny-within-allow；装上 `bwrap` 可闭合 |
| `windows-acl` | **不受保护** —— runner 尚无挖洞实现 |

已知缺口：bwrap 下，`.pi` 还不存在时 bash 仍能创建它。`--ro-bind` 对缺失的源硬失败（那会表现为 `SANDBOX_UNAVAILABLE` 而不是拒绝），而另一种做法——从别处 bind 一个空的只读目录过来——会让 bwrap 在你项目里真创建一个 `<工作区>/.pi`。无论如何 `write`/`edit` 在所有平台都拦住这条路。

同一类但**未**覆盖：`.git/hooks`、`.git/config`、项目根的 `AGENTS.md`。`.git` 需要比 `.pi` 更细的规则（`git commit` 要写 `.git`），是单独一次设计。

## 安全说明

- 受约束进程可**读取**宿主上你有权读的一切（包括 `~/.ssh` 等）——这是本沙箱的设计语义（与 deepseek harness 一致）；root 专属文件受文件权限保护
- bwrap 下 bash 的 `/tmp` **就是宿主 /tmp**（rw bind，与 write/edit 围栏及 landlock/macOS 一致）：沙箱内命令可以直接修改/删除宿主的临时文件（含会话 socket 与 pi 自己的临时文件），宿主 `/tmp` 的权限原样生效；宿主 `/tmp` 不可写时沙箱内也随之不可写
- Windows 下沙箱的临时根就是宿主 `%TEMP%`（`windows-acl` runner 授权真实路径、不重写 `TMP`/`TEMP`）：受限命令可以修改/删除宿主临时文件，与上面 bwrap 的 `/tmp` 同属“宿主 tmp 就是宿主 tmp”的语义
- 受限子进程强制 `LC_MESSAGES=C`（保证拒绝诊断可分类），不改动你的 `LANG`/`LC_CTYPE`
- 受限 bash 在独立进程组中运行（detached）：timeout/abort 会杀掉整个进程组；但若 pi 自身被硬杀（如 SIGKILL），命令派生的后台孙进程可能存活（pi 内部的子进程追踪 API 不对扩展开放）
- landlock 回退在旧内核 ABI 上为 partial enforcement（状态里会标注）
- `writableRoots` 是有意放宽边界：每个解析成功的条目对受限命令**和** write/edit 围栏都变成可写，且写在那里的东西会活过这条命令（cache 的意义就在此）。授予能跑起来的最窄目录
- 项目级配置与其他字段一样参与合并，所以 `<项目>/.pi/sandbox.json` 能给自己授予额外可写根——**包括 home 底下的凭据目录**（`~/.ssh`、`~/.aws`），拒绝规则不覆盖它们（它只拒 home 目录本身及其祖先）。信任一个文件夹时请顺手看一眼那个文件；项目也可以传 `"writableRoots": []` 把全局授予关掉

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
