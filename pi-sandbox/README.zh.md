# pi-sandbox

pi coding-agent 扩展：**进程级沙箱**（bwrap / landlock / seatbelt / windows-acl）——默认**工作目录与检测到的工具存储可写、其余宿主文件可读**，fail-closed。

## 安装

```bash
# 从 npm 安装
pi install npm:@yandy0725/pi-sandbox

# 或从本地仓库安装
pi install .
```

需要 pi >= 1.5.0。

低于 1.5.0 的宿主不受支持，且 pi 安装扩展时**不会校验或告警这个 peer 下限**。在这类宿主上，本扩展可能在 ESM 链接期加载失败，`bash` / `write` / `edit`（Windows 上还有 `powershell`）会回落到**未受限**的内建实现。请先升级 pi，再通过 `/permission` 与扩展加载状态确认 pi-sandbox 确实生效。

## 工作原理

bash 命令被包装进平台沙箱 runner 后在本地 spawn（**路径透明**：宿主路径原样有效）；write/edit 工具在执行前做进程内写围栏；read 不受限。

**适用范围仅限模型发起的动作。** 你自己输入的 `!命令` / `!!命令`（以及 RPC 的 `bash` 命令）由 pi 经 `user_bash` 事件执行，本扩展不处理该事件 —— 它由你自己的 shell 裸跑，不受上面三档模式约束。你在 pi 之外启动的进程同理。

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

受限 shell 只有 **`powershell` 工具**。在 Windows 上，pi-sandbox 把受限 `bash` 以 `exposure: "hidden"` 注册——pi 的语义是 *registered but unreachable*：模型看不到它，显式点名（`defaultTools`、`--tools`、`setActiveTools()`）也无法激活它。保留这份注册是有意的：扩展工具按名覆盖内建定义，`bash` 这个名字被本包的拒绝壳占据，Windows 上不存在任何通往未受限内建 `bash` 的路径；若未来宿主改变 `hidden` 的兑现方式，该定义仍会拒绝受限模式下的每次调用（绝不 spawn，fail-closed）。除非显式切到 `danger-full-access`（唯一逃生门，与其他平台一样 `bash` 照常裸跑），沙箱绝不在 Windows 上非受限地运行 bash。

已知限制：**`defaultTools` 去不掉扩展注册的工具**（`-name` 条目只能移除内置工具；扩展工具除非在定义里声明退出，否则会被自动激活）。pi-sandbox 不要求用户为此配置：Windows 上 `bash` 这个名字在**定义层**就已从模型侧撤下（`exposure: "hidden"`），没有可配置掉的余地。若 `powershell` 未激活（选择列表把它排除在外），`/permission` 状态行显示 `shell: powershell only (not activated)`；`{ "defaultTools": ["+powershell"] }` 可把它加回来。完全无法判断激活状态时——会话替换 / reload 后扩展 ctx 已陈旧，或读取激活工具列表抛错——状态行写 `shell: powershell only (activation unknown)` 而不是猜：裸露的 `shell: powershell only` 会被读成「已启用」。

**支持范围。**与所移植的上游设计（deepseek-harness）一致：**不设新 OS 下限**——机制是 `WRITE_RESTRICTED` 受限令牌 + Low 强制标签，两者都是老 API（当初选它而不是 `mxc`，正是因为 mxc 要 Windows 11 24H2+）。本仓端到端验证在 **Windows 10 Enterprise LTSC 2019（build 17763.316）**上完成：自动化 e2e 与人工验收清单均绿。更新版本预期一致（后端不依赖新版本特性），但本仓尚未验证。注意：上游的**测试**跑在 Windows Server 2025 上，它的测试夹具不可移植到老 build；本包的 Windows 夹具刻意只用与版本无关的原语。

PowerShell 语言模式取决于启动约束，不是 ACL 边界的一部分：`read-only` 下 `%TEMP%` 不可写，pwsh 可能退化为 ConstrainedLanguage（`Add-Type`/COM/反射失败）；`workspace-write` 保持 FullLanguage。

**`NUL` 在两种模式下都可写**——这是**设备自身的环境属性**（设备 DACL 授予 Everyone 读/写/执行），不是沙箱的能力授予，因此与令牌拿到哪些授权根无关。它只能通过设备拼法到达：`cmd` 的 `> NUL`，以及 Node 的 `\\.\NUL`。**相对路径** `NUL` 不是设备：libuv 构造 NT 路径时不做 Win32 设备名映射，因此 `writeFileSync('NUL', …)` 是子进程 cwd 下一个名为 `NUL` 的**普通文件**——在工作区内允许、在工作区外被拒，与其他文件名完全同等。

**常驻的安全描述符改动。** 授权幂等但**不回收**：pi 退出后，工作区与 `%TEMP%` 上的 ACE、world `FILE_DELETE_CHILD` 拒绝项与 Low 强制标签仍然保留。`workspace-write` 下 `~/.pi/agent/sandbox-writable.json` 里列出的目录与检测到的内置工具存储根同样留下常驻改动（按目录派生的 capability ACE、world `FILE_DELETE_CHILD` 拒绝项与 Low 标签）；若目录不可授予（你无法改 ACL——没有 WRITE_DAC/WRITE_OWNER），受限命令 **fail-closed**，绝不降级裸跑。已有大缓存的首次授权会递归传播描述符，可能明显延长当次命令；传播在独立 runner 进程中执行，后续命中精确匹配快路径。这会向**任何**以同一用户身份运行在 Low 完整性的进程放宽该目录树；事后再清除可继承标签也不会回退已传播到子对象的标签。切回 `read-only` 会让能力 ACE 失效（该令牌不携带能力 SID），但不会移除它们。首次授权会在整棵 `%TEMP%` 树上做急切传播（大树可能耗时数秒），之后每次调用命中精确匹配的快路径。`%TEMP%` 与 `TMP` 本身**不**被重写——沙箱的可写临时根就是宿主 `%TEMP%`。

**`%TEMP%` 的代价。** `%TEMP%` 是用户共享树：其子目录会继承拒绝项，因此第三方程序用 `GENERIC_ALL`/`FullControl` 打开自己的 temp 子目录会被拒。基于 DELETE 的删除、`MAXIMUM_ALLOWED` 与常规读写打开不受影响。

**拒绝分类只认英文消息文本。** 工具用来注入 `[sandbox: …]` 拒绝标记、提权提示与 denial 记账的方言，都是英文的 Win32 / `cmd` / PowerShell 消息文本，且只匹配子进程的 **stderr**。在本地化（如 zh-CN）的 Windows 上这些消息会被本地化：沙箱**仍然拒绝**访问（强制层与语言无关），但工具可能不会标注该拒绝，denial-first 提权也不会记账。看不到拒绝标记时按“分类缺口”而非“强制失效”处理。

`koffi`（Win32 调用的 FFI 层）是常规依赖，懒加载且仅在 Windows 上加载——Win32 绑定表在其他平台上永不物化。

随包提供的 `diagnose-windows-sandbox-acl` 技能（诊断并修复“Windows 文件权限挡住 pi-sandbox 授权”的场景）**仅在 Windows 上**贡献给 pi。它的修复会修改安全描述符，必须由不受限的调用者执行——请通过一次已批准的 `danger-full-access`（或手工）运行。

## 三档权限模式

| 模式 | 文件效果 |
|---|---|
| `read-only` | 仅 `/dev/null` 可写 |
| `workspace-write`（默认） | 工作目录 + `/tmp` + `os.tmpdir()` + 检测到的内置工具存储 + `sandbox-writable.json` 里的额外根可写，其余只读 |
| `danger-full-access` | 完全绕过沙箱（显式逃生门） |

网络始终放行（不做网络隔离）。

## /permission 命令

- `/permission` —— 显示当前状态（模式及来源、runner、工作区、内置工具存储的 `tool storage: auto (...)` / `off` 行；自定义额外根显示 `extra writable:`，当前模式不适用时后缀 `(inactive: <模式>)`）
- `/permission <read-only|workspace-write|danger-full-access>` —— 切换模式，**进程级**生效：父会话与所有 subagent 子会话的下一次工具调用立即采用

## 提权审批（模型发起，denial-first）

bash/write/edit 带两个可选参数：`sandbox_permissions`（`workspace-write` 或 `danger-full-access`）+ `justification`（一句话理由）。审批是 **denial-first** 的：

- 严格更宽的请求只在**本会话真实发生过同类沙箱拒绝**后（bash ↔ `command`，write/edit ↔ `operation`）才会弹审批；没有前置拒绝时提权参数会被**忽略**，调用按当前档位正常执行，结果附一行 `[sandbox: escalation fields were ignored …]` 告诉模型参数没生效——这消除了模型"先发制人"带提权参数造成的弹窗轰炸；
- 拒绝记录**一次性消费**：一次拒绝只放行一笔提权重试（批准仍只对那一次调用生效）；
- 占位符参数按字段归一化：省略或传 JSON `null` 都表示"不提权"，参数 schema 也显式声明了 `null`——因此 strict schema 提供商（pi 会把这两个字段标成必填）下的模型有一个合法的"不提权"取值可传；`justification` 上的 `"null"` / 空白字符串同样归一化为"未提供"。字符串占位符（`"null"` / 空串 / 纯空白）另有一层兜底：工具的 `prepareArguments` 在参数校验前把它们剥掉——strict 提供商下模型常把必填的可选字段写成字符串 `"null"`，这层兜底让普通调用照常执行，不再产生与沙箱无关的硬错误。

弹窗提供 **Deny / Allow once**（Deny 在首位，误按回车不会授予任何权限）；选 Deny 后可再填一句**可选理由**（回车跳过），理由会随拒绝错误回传给模型，让它明白为什么被拒、不要换写法反复试探。subagent 子会话（前台与后台都算）的提权会转发到父会话弹窗（同进程 pi-subagents，且父会话需有 UI）；无父通道时（headless、跨进程子代理）提权一律拒绝（fail-closed），此时用 `/permission` 放宽进程档位解救。

只有逐字 **Allow once** 才批准提权；`Deny` 保持既有拒绝文案（可带可选理由），`undefined` 表示 *cancelled*。从 UI/RPC 边界回来的其它任何值（RPC 客户端回 `"Allow"`、`null`、对象）都算无效审批应答，一律 fail-closed 并报 `nothing was executed`。宿主不是 TUI 时每个弹窗另有 300 秒本地 deadline 与一条本地中断通道：客户端始终不应答时按 *cancelled* 结算（**不是**拒绝），命令与文件写入都不会发生；此后到达的结果一律丢弃。

审批并发时由宿主管理弹窗。TUI 中最新弹窗获得焦点；早先弹窗仍留在宿主的对话框栈中，只是暂时隐藏而**不是已取消**，上层弹窗关闭后会重新显示。若新审批持续到达，早到的请求可能延后处理；pi-sandbox **不承诺处理顺序**。`/reload` 或切换会话可能让**当次**调用的审批保持 pending（宿主行为），但不影响其他审批。RPC 模式下，各审批请求独立结算；无人应答的请求在 300 秒本地 deadline 处按 *cancelled* 结算。

在初始审批选择前，实际显示 UI 的实例发出 `notify:request`，payload 为 `{ title: "Approval required", body: <审批标题>, urgency: "critical" }`。转发审批使用父实例的事件总线，不使用发起请求的子实例总线。可选的拒绝理由步骤不再发送。投递是 fire-and-forget，公告失败不改变审批控制流。

**缓存/数据目录搬迁属于越界行为。** 工具的常驻规则要求模型不得为了绕开沙箱把全局缓存/数据目录搬进 workspace——无论是环境变量覆盖（`XDG_CACHE_HOME`、`HOME`、`UV_CACHE_DIR`、`npm_config_cache`、`PNPM_HOME` 等）、改缓存的 flag（`--cache-dir`、`--store-dir` 等）还是配置文件——正确做法是原样运行工具，包括提权重试也不得夹带搬迁：搬迁是无声的，它会消掉本可上膛提权的那次拒绝。这条政策目前仅停留在提示词层：pi-sandbox 不检测、也不拒绝这类命令，用户显式要求搬迁时仍然成立。常用工具由内置存储档案默认覆盖；其它自定义路径由**用户**加入 `~/.pi/agent/sandbox-writable.json`。模型仍不得自行迁移缓存/数据目录。

## 配置

读 agent 目录（`~/.pi/agent/`）下的两个文件：`sandbox.json` 管沙箱本身，`sandbox-writable.json` 管额外可写根。两者都是每个 pi 进程只读取一次（解析结果被缓存），改配置需重启 pi。项目级 `<项目>/.pi/sandbox.json` 与 `<项目>/.pi/sandbox-writable.json` 都被**静默忽略**——不解析、不校验、不告警（项目目录对受限模型可写，配置层留在那里等于把改写自己 `mode` / `runnerCommand` / 可写根的能力交给模型）。文件缺失/损坏与非法取值的回落行为不变；两个文件互相独立地失败——`sandbox-writable.json` 坏了绝不会改变 `mode` 或 runner 设置。

`~/.pi/agent/sandbox.json`：

```json
{
  "mode": "workspace-write",
  "runnerCommand": null,
  "runnerFailureSignatures": null,
  "probeTimeoutMs": 5000,
  "toolStorage": true
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `workspace-write` | 默认权限模式；非法值回落默认并告警 |
| `runnerCommand` | `null` | 自定义 bwrap 兼容 runner argv（须与下一项成对） |
| `runnerFailureSignatures` | `null` | 自定义 runner 的失败诊断签名（非空单行） |
| `probeTimeoutMs` | `5000` | runner 功能探测超时（正数） |
| `toolStorage` | `true` | 是否检测并开放内置工具存储；`false` 全部关闭，非法值告警并回落默认 |

`~/.pi/agent/sandbox-writable.json` 是裸的目录路径 JSON 数组——没有根 key——加一个根就是改一行：

```json
["~/.cache/uv", "~/.local/share/pnpm/store", "/srv/team-data"]
```

额外可写根仅在 `workspace-write` 下、工作区与 tmp 之外生效。条目必须是绝对路径；`~` / `~/`（Win32 `~\`）展开到家目录，不支持 `~user`。非绝对路径、不存在、非目录的条目在加载时逐条告警并忽略；文件不是字符串数组（包括 JSON 非法）时整份告警并忽略，不产生任何额外可写根。文件缺失等于没有额外可写根，静默——与 `[]` 等价。`sandbox.json` 里的 `extraWritableDirs` 是 1.7.x 留下的旧写法：加载时告警并忽略——请把清单移到 `sandbox-writable.json`。

配置告警不会直接写终端：配置在任何 UI 上下文出现之前就被读取，所以告警先入缓冲，由第一个带 UI 的会话送出——TUI 里它作为 `Warning: …` 行出现在对话区（而不是被界面盖掉），`-p` / JSON 模式则写到 stderr。

### 内置工具存储

`workspace-write` 默认检测并开放常用工具的持久化存储，普通的 `uv sync`、`uv pip install`、`pnpm install` 等无需修改环境变量或提权。检测只看 PATH 入口和固定项目入口：`mvnw` / `gradlew` 以及 `node_modules/.bin/playwright`（含 `.cmd` / `.ps1`）；不执行工具、不解析 shell 命令或依赖清单。Corepack 入口会同时启用 Corepack、pnpm、Yarn 档案。`npx` 等通用启动器本身不会激活 Playwright，必须另有 PATH 或固定本地 Playwright 入口。

| 档案 | 纳入的存储 | 主要路径覆盖变量 |
|---|---|---|
| pip | HTTP/wheel cache | `PIP_CACHE_DIR`、`XDG_CACHE_HOME` |
| uv | 依赖 cache + managed Python 的 `python/` | `UV_CACHE_DIR`、`UV_PYTHON_INSTALL_DIR`、XDG |
| npm | cache、日志与 npx 内容 | `npm_config_cache` / `NPM_CONFIG_CACHE` |
| Corepack | 包管理器下载与 cache | `COREPACK_HOME` |
| pnpm | **store + cache + state + 具名锁目录** | `PNPM_HOME`、XDG cache/data/state |
| Yarn | Classic cache + Berry 全局 cache/metadata | `YARN_CACHE_FOLDER`、`YARN_GLOBAL_FOLDER` |
| Bun | 全局包 cache（含可选 links store） | `BUN_INSTALL_CACHE_DIR` |
| Go | module cache + build cache | `GOMODCACHE`、`GOCACHE`、`GOPATH` |
| Maven | local repository + Wrapper distributions | `MAVEN_USER_HOME` 只影响 wrapper |
| Gradle | `caches/`、`daemon/`、`jdks/`、`wrapper/dists/` | `GRADLE_USER_HOME` |
| vcpkg | binary/registries cache + manifest 的 `downloads/`、`buildtrees/`、`packages/` | `VCPKG_DEFAULT_BINARY_CACHE`、`X_VCPKG_REGISTRIES_CACHE`、`VCPKG_DOWNLOADS`、`VCPKG_ROOT`、XDG cache |
| Playwright | 下载的浏览器二进制 | `PLAYWRIGHT_BROWSERS_PATH`、`INIT_CWD`、Linux XDG cache |

路径按 Linux、macOS、Windows 的平台约定和父进程环境变量解析。例如 Linux 的 uv cache 是 `~/.cache/uv`、pnpm store 是 `~/.local/share/pnpm/store`；macOS 的 pip 是 `~/Library/Caches/pip`、pnpm store 是 `~/Library/pnpm/store`；Windows 的 uv cache 是 `%LOCALAPPDATA%\uv\cache`、managed Python 是 `%APPDATA%\uv\data\python`、pnpm store 是 `%LOCALAPPDATA%\pnpm\store`。pnpm 锁只开放 XDG runtime 或 `%LOCALAPPDATA%` 下的具名子目录，不开放共享根目录。

vcpkg cache 在 Windows 使用 `%LOCALAPPDATA%\vcpkg`，在 Linux/macOS 使用 `$XDG_CACHE_HOME/vcpkg` 或 `~/.cache/vcpkg`；设置 `VCPKG_ROOT` 时只额外开放其 `downloads/`、`buildtrees/`、`packages/` 子目录。Playwright 在 Windows 使用 `%LOCALAPPDATA%\ms-playwright`，macOS 使用 `~/Library/Caches/ms-playwright`，Linux 使用 `$XDG_CACHE_HOME/ms-playwright` 或 `~/.cache/ms-playwright`。相对 `PLAYWRIGHT_BROWSERS_PATH` 以 `INIT_CWD` 为基准，未设置时以 workspace 为基准。

缺失的内置存储根会在实际 `workspace-write` 调用前自动创建；read-only、danger-full-access 和 `/permission` 查询不会创建。每次调用都会复检，目录被删除后可在下次调用重建。单根创建或校验失败会告警并跳过该根，不让无关命令失去沙箱。PATH、环境变量与工具安装状态在进程内缓存，改动后重启 pi 生效。

**全局安装仍会被拦截。** `uv tool install`、`uv pip install --system`、`pnpm add -g`、全局自更新、PATH 上的 bin/shim、用户配置与凭据均不因存储档案自动开放。显式 `uv python install` 创建全局可执行入口也不属于存储授权；Windows 的 PEP 514 注册表写入不是目录授权。pnpm 因项目位于其它卷宗而选择的 store，以及配置文件或 CLI 参数指定的自定义路径，仍需用户显式授权。vcpkg classic 的 `installed/` 和 Playwright 的系统 Chrome/Edge 安装目录不在自动授权内。`PLAYWRIGHT_BROWSERS_PATH=0` 选择包内 `.local-browsers`：workspace 内的包已被覆盖，workspace 外的包位置仍需显式授权。

`~/.pi/agent/sandbox-writable.json` 继续用于这些自定义路径和尚未内置的工具。与内置档案不同，手工条目**必须是已存在目录**，扩展不会自动创建它们。Cargo 首版没有内置档案：其 `CARGO_HOME/.package-cache` 位于根目录，现有目录级管线若开放整个 `CARGO_HOME` 会连带开放 `bin/`；只有接受这一代价时才手工授予。CMake 常规构建不需要全局依赖 cache；显式启用用户 package registry 时可手工授权 POSIX `~/.cmake/packages`。

## 安全说明

- 受约束进程可**读取**宿主上你有权读的一切（包括 `~/.ssh` 等）——这是本沙箱的设计语义（与 deepseek harness 一致）；root 专属文件受文件权限保护
- 内置 store/cache/managed runtime 属于同用户信任域：受限进程写入的内容可能被后续非受限工具复用；pnpm store 的完整性检查不能让不可信写者变安全。设置 `toolStorage:false` 可关闭全部内置授权
- **不要**把家目录、`~/.pi` 或 pi agent 目录的任何祖先目录放进 `sandbox-writable.json`：否则受限模型可改写全局沙箱配置、`AGENTS.md` 或扩展——它们会在下次启动时不受限运行；此类条目会在加载时告警，但仍会保留（warn-only）
- bwrap 下 bash 的 `/tmp` **就是宿主 /tmp**（rw bind，与 write/edit 围栏及 landlock/macOS 一致）：沙箱内命令可以直接修改/删除宿主的临时文件（含会话 socket 与 pi 自己的临时文件），宿主 `/tmp` 的权限原样生效；宿主 `/tmp` 不可写时沙箱内也随之不可写
- Windows 下沙箱的临时根就是宿主 `%TEMP%`（`windows-acl` runner 授权真实路径、不重写 `TMP`/`TEMP`）：受限命令可以修改/删除宿主临时文件，与上面 bwrap 的 `/tmp` 同属“宿主 tmp 就是宿主 tmp”的语义
- 受限子进程强制 `LC_MESSAGES=C`（保证拒绝诊断可分类），不改动你的 `LANG`/`LC_CTYPE`
- 受限 bash 在独立进程组中运行（detached）：timeout/abort 会杀掉整个进程组；但若 pi 自身被硬杀（如 SIGKILL），命令派生的后台孙进程可能存活（pi 内部的子进程追踪 API 不对扩展开放）
- landlock 回退在旧内核 ABI 上为 partial enforcement（状态里会标注）

## 从 pi-container-sandbox 1.x 迁移

- 配置只认 agent 目录下的全局文件（`~/.pi/agent/sandbox.json` 管沙箱字段，`~/.pi/agent/sandbox-writable.json` 管额外可写根）：项目级 `<项目>/.pi/sandbox.json` 与 `<项目>/.pi/sandbox-writable.json` 都被静默忽略（原本依赖的项目设置请移到全局文件）；旧 `image`/`runtime`/`host` 段会被忽略并告警，按需改写为上面的新字段
- 容器运行时（docker/podman）、镜像构建、`runtime.mounts`、`/sandbox` 命令、`--container*` flags、外部路径审批流不属于本包
- 容器级强隔离（独立文件系统/网络命名空间）：不在本包范围。旧的 `@yandy0725/pi-container-sandbox` 已在本仓退役（npm 包标记为 deprecated，源码见 git 历史 `pi-container-sandbox-v1.3.0`）
- 仍在用旧包 `@yandy0725/pi-container-sandbox` 的话注意：它与 `pi-sandbox` **互斥**：两者都接管 `bash`/`write`/`edit`，且共用同一个全局 `~/.pi/agent/sandbox.json`（schema 不兼容）——同一时刻只启用一个，切换前先卸载或停用另一个。pi-sandbox 忽略项目级文件；旧包仍读它自己的项目 scope

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

## UI 能力

| 方法 | 守卫 | 非 TUI（RPC / headless） |
|---|---|---|
| `select` + `input`（`sandbox_permissions` / `file_operation` 提权审批；`input` 是拒绝时的可选理由） | `hasUI` 决定通道；`mode` 决定 deadline —— 只有 `tui` 视为有人值守。子会话沿 link 解析到最近一个仍有 UI 的父通道，并用**父会话的** `ctx.mode`，不看子会话 | 以 `extension_ui_request` 转发，带派生 `AbortSignal` 与 `timeout`。非 `tui` 宿主上每个弹窗有 300 秒本地 deadline，且本地结算与宿主 promise 竞争：客户端静默丢弃请求时按 *cancelled* 结算而不是挂住整轮，deadline 之后到达的任何结果（包括迟到的 `"Allow once"`）一律丢弃。只有逐字 `"Allow once"` 才批准提权（`"Deny"` 与取消各走自己的分支）；其它任何值（`"Allow"`、`null`、对象）一律 fail-closed 并报 `nothing was executed`。该 deadline 只取消本次审批：绝不批准，也不记作用户拒绝 |
| `notify`（配置告警、`/permission` 反馈） | 告警路径用 `hasUI` | 告警出口：有 UI 时走 `notify`；只有本进程从未出现过 UI（`pi -p`、JSON）才退 stderr；无 UI 的子会话留在缓冲里，不盖掉父会话的 TUI |

## License

MIT
