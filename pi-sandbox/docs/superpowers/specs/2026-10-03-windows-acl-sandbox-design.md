# pi-sandbox：Windows（windows-acl）支持设计

日期：2026-10-03
状态：已与用户逐节确认（Q1–Q5 五轮拍板），待 spec 评审
前置研究：`.superpowers/refs/deepseek-harness/`（deepseek harness 源码，MIT）——具体为 `packages/sandbox/sandbox-windows-acl`（0.2.0-rc.2 源码形态）、`packages/sandbox/sandbox-local`、`packages/subprocess/win32-process`，以及两份 Agent Note：`2026-08-08-windows-acl-restricted-token-sandbox.zh.md`（受限令牌档）与 `2026-09-19-windows-acl-mandatory-integrity-confinement.zh.md`（删除约束）
前置设计：`2026-09-29-process-sandbox-design.md`（平台链、confine seam、围栏、fail-closed）。其 §1「非目标：Windows 支持」由本设计**取代**；其余原则（fail-closed、四后端语义对齐、拒绝/失败两套分类）继续有效且不得重排

## 1. 背景与问题

现状：`PLATFORM_CHAINS`（`src/runners.ts`）只有 `linux` 与 `darwin` 两条链，Windows 命中空链 → `SandboxUnavailableError` → **所有受限模式下的 bash 命令被拒绝**。这是 fail-closed 的正确实现，但对 Windows 用户等于"沙箱不可用"。

用户诉求：参考 dsh 的 windows-acl 实现，让 pi-sandbox 在 Windows 上真正可用。

为什么不复用现有三件套：`bwrap` / `sandbox-exec` 在 Windows 无对应物；`landlock-run` 是 Linux LSM。Windows 的写入限制原语只有 Win32 API（`CreateRestrictedToken`、`SetEntriesInAclW`/`SetNamedSecurityInfoW`、`CreateProcessAsUserW`、Job Object），**没有任何可当 argv 前缀使用的系统程序**。

### 1.1 事实基础（均已核实，标注出处）

| 事实 | 出处 |
|---|---|
| pi 默认工具集是 `["read","bash","edit","write"]`，`powershell` 不在其中（opt-in） | `pi-coding-agent/dist/core/settings-manager.js:35` `DEFAULT_TOOL_NAMES` |
| 原生 Windows 上 pi 把 `bash` 解析到 Git Bash（`shellPath` → `Program Files\Git\bin\bash.exe` → PATH `bash.exe`） | `pi-coding-agent/dist/utils/shell.js:58` `getShellConfig` |
| `getShellConfig` / `getPowerShellConfig` 从包根导出，扩展可直接用 | `pi-coding-agent/dist/index.d.ts:43` |
| `createPowerShellToolDefinition` 是 pi **1.0.0** 才有的 API（0.80.2 无 `dist/core/tools/powershell.js`） | 本仓锁定的 0.80.2 与全局安装的 1.0.0 对比 |
| `PowerShellOperations = BashOperations`（同型接口） | `pi-coding-agent/dist/core/tools/powershell.d.ts` |
| `ExtensionAPI.getActiveTools(): string[]` 可判定工具是否激活 | `pi-coding-agent/dist/core/extensions/types.d.ts:1237` |
| npm 上 `@deepseek-ai/dsh-sandbox-windows-acl` 只有 **0.0.1-rc.1**（与研究的 0.2.0-rc.2 源码不是一回事） | `npm view` |
| `koffi@3.3.2` 对 `win32-x64/ia32/arm64` 有官方预编译包，无需本地工具链 | `npm view koffi` |
| Node 的类型剥离对 **node_modules 内**的 `.ts` 明确拒绝 → 独立进程那一侧只能是 `.js` | Node 文档 + 依赖包安装位置（`~/.pi/agent/npm/node_modules/...`） |
| pi 要求 `node >=22.19.0` | `pi-coding-agent/package.json` engines |
| dsh 的 Windows 侧模型 shell 只有 pwsh（其 `bash-sandbox` 从不跑 Windows） | `.superpowers/refs/.../packages/shell/{bash,pwsh}-sandbox` |

## 2. 已确认决策（用户逐条拍板，不得擅自变更）

| # | 决策 | 内容 |
|---|---|---|
| D1 | 验证方式 | 以**真机为准**：设计给出编号验收清单与预期输出（PowerShell + git-bash 两套命令），用户在 Windows 机器执行并回贴输出，据此迭代。CI 保持 ubuntu；win32 专属测试干净 skip |
| D2 | tmp 语义 | **授予宿主 `%TEMP%`**（对齐 pi-sandbox 现有"宿主 tmp 就是宿主 tmp"语义），**不**重写 TMP/TEMP → git-bash 的 `/tmp` 仍指向宿主 `%TEMP%`，路径透明保住 |
| D3 | shell 覆盖 | Windows **只支持 pwsh**：受限模式下 `bash` **拒绝执行**并给出可执行指引（含 `settings.json` 片段）；`danger-full-access` 下 `bash` 照常裸跑；pwsh 未激活时**激活期提示一次** + `/permission` 状态行标注 |
| D4 | 打包形态 | 单包：koffi 进 `pi-sandbox` 的 `dependencies`（仅 win32 懒加载），实现放 `pi-sandbox/src/win32/` |
| D5 | 机制 | 移植 dsh windows-acl：`WRITE_RESTRICTED` 受限令牌 + Low 强制完整性 + 环境性删除拒绝；runner **自派生 SID、自幂等授权**（无 seam-managed SID 入参） |
| D6 | 生命周期 | workspace 与 `%TEMP%` 的授权**都 standing（不回收）**；残留与外部性写进 README |
| D7 | 依赖下限 | peer 保持 `>=0.80.2`，powershell 覆盖靠**运行时探测** `createPowerShellToolDefinition` → 版本走 **1.4.0** |
| D8 | 诊断技能 | **本次包含**：`resources/skills/diagnose-windows-sandbox-acl/`（SKILL.md + 保真移植的 PowerShell 修复脚本）；**仅 Windows 加载**，经 `resources_discover` 事件按平台注册（见 Ruling 9） |

**D3 修订 1（第二版，2026-10-03 首轮真机实测后，用户确认；已被 D3 修订 2 取代）**：原指定文案 `{ "defaultTools": ["-bash", "+powershell"] }` **无效且无必要** —— pi 1.0.0 在 Windows 默认只激活 `powershell`；用户看到的 `bash` 是 pi-sandbox 自己覆盖注册的（扩展注册的工具会被自动激活，而 `defaultTools` 的 `-name` 无法取消扩展工具）。因此改为：

1. win32 下我们的 `bash` 工具以 **`defaultActive: false`** 注册（模型默认看不到它，与 pi 的本意一致）；**但仍保留注册** —— 不注册就会露出 pi 内建的无沙箱 bash，显式 `defaultTools: ["bash"]` / `--tools bash` 会得到 fail-open；保留后显式激活仍是**拒绝**（fail-closed）。
2. 面向模型/用户的指引只保留**有效**方向：`{ "defaultTools": ["+powershell"] }`（`+name` 激活是 pi 支持的语义），不再出现 `-bash`。

**D3 修订 2（第三版，2026-10-03 第二轮真机实测后，用户确认；pi 1.0.0 源码逐行实证 + 本地 SDK 探针复现）**：第二版的 **`defaultActive: false` 无效**（真机证伪）。两代机制与为何前者无效：

1. `_buildRuntime` 把默认激活名**写死**为 `["read","bash","edit","write"]`（`dist/core/agent-session.js:2889-2893`），`_refreshToolRegistry` 按**名字**从注册表取同名工具激活（扩展工具按名覆盖内建定义，本包注册的 `bash` 正落在这份默认名单内）；
2. `defaultActive: false` 的类型文档语义正是“**被命名即激活**”（`_isActivatedOnRegistration`，`types.d.ts:471-475`）→ 它拦不住任何“按名激活”的路径（默认列表、`--tools`、`defaultTools`、`setActiveTools()`），本包 bash 照旧进入活动集并出现在模型工具列表里；
3. 正解 **`exposure: "hidden"`**：`_applyToolLoadout` 构建声明集合时**丢弃** hidden（`agent-session.js:1124`），`_isDeclarable` 对 hidden 返回 false → 既**不声明**给模型，也**不可被命名激活**（pi 文档：`hidden` = *registered but unreachable*）；
4. `hidden` **不解除按名遮蔽**：扩展注册仍覆盖内建 `bash` 定义 → 模型侧与“不注册”等效（看不到、叫不活），但 `bash` 这个名字被本包的拒绝壳占据，不存在“显式启用就拿到无沙箱 bash”的 fail-open 路径。

**第三版落地**：win32 下 bash 包装以 `exposure: "hidden"` 注册（不再设 `defaultActive`——它在 pi 1.0.0 上无效；pi ≤0.80.x 既不认识 `exposure` 也不支持 `defaultActive`，含 `hidden` 定义会被自动激活并逐次拒绝，仍属 fail-closed）；`UnsupportedWindowsShellError` 拒绝壳**保留**作纵深防御（防未来宿主改变激活语义，或调用方直接使用该工具定义）。`powershell` 仍为 `direct` + 自动激活；非 win32 不变（bash 默认激活）。Ruling 2 的指引不变：只给 `{ "defaultTools": ["+powershell"] }`。

**对 D3 修订 1 的事实更正**：修订 1 写的“pi 1.0.0 在 Windows 默认只激活 `powershell`”不准确——pi 的默认激活名是常量 `["read","bash","edit","write"]`（`settings-manager.js:35` 的 `DEFAULT_TOOL_NAMES`，平台无关，不含 `powershell`）。Windows 上“默认只有一个可用 shell（powershell）”是**本包覆盖注册的扩展工具被自动激活**的结果（扩展工具在 `_refreshToolRegistry` 的 `includeAllExtensionTools` 分支被加入活动集），而不是 pi 的平台默认；用户此前“只看到 powershell、bash 又是 pi-sandbox 注册的”观测，来自其 `-bash +powershell` 配置（`-bash` 对**内建** bash 生效）叠加本包当时的 bash 覆盖注册。

### 2.1 Rulings（实现与测试按编号引用）

- **Ruling 1**：win32 是唯一候选链，**不做功能探测**，但做**可解析性前置检查**（不 spawn 任何进程）：① `src/win32/runner.js` 存在；② `koffi` 可由 `createRequire` 解析；③ node 可执行文件可解析——运行时是 Node（`process.versions.node && !process.versions.bun`）时用 `process.execPath`，否则在 PATH 上找 `node.exe`。任一项不可达即 `unavailable` → `SandboxUnavailableError` + 对应 Windows 指引（重装包 / 安装 Node）。
- **Ruling 2**：Windows 受限模式下 `bash` 拒绝执行（绝不 spawn）；`danger-full-access` 下 `bash` 走既有裸 spawn。拒绝错误是**独立类型**（不复用 `SandboxUnavailableError` 的措辞），文案含「Windows 上只约束 powershell 工具、请改用该工具、bash 保持 fail-closed」三项；pi ≥1.0.0 前提与 `danger-full-access` 逃生门保留；**不得**再出现 `-bash`（见 D3 修订）。
- **Ruling 3**：runner 自派生 SID、自授权；argv **不含** `--write-sid/--temp-write-sid`（dsh 的 seam-managed 契约在本包无消费方）。
- **Ruling 4**：workspace 与 `%TEMP%` 的 ACE/拒绝项/Low 标签都不回收；`dispose` 只关令牌与句柄。
- **Ruling 5**：不重写 TMP/TEMP。
- **Ruling 6**：win32 enforcement 恒为 `partial`；runner 失败规则 = `{allowedExitCodes:[127], fatalSignatures:["windows-acl-run: "]}`。
- **Ruling 7**：拒绝方言 = `access is denied` / `access to the path` / `permission denied` / `operation not permitted`（大小写不敏感子串）。
- **Ruling 8**（2026-10-03 修订，D3 修订 2 后再次限定）：win32 且 `pi.getActiveTools()` 不含 `powershell` 时，激活期提示一次（有 UI 走 `ctx.ui.notify`，无 UI 写 stderr），提示只给**有效**方向 `{ "defaultTools": ["+powershell"] }`；`/permission` 状态行显示 `shell: powershell only (not activated)`。**实现条件比本句更窄**：另要求 `bash ∈ active`（T15 实现时控制者给定），以免 ≤0.80.x 宿主每次都提示升级；D3 第三版后本包 bash 为 `hidden`、永不进活动列表，故该提示在 pi ≥1.0.0 上实际不再触发，只服务于老宿主（其 bash 自动激活且无 powershell 工具）。**已知边界（未裁决）**：pi ≥1.0.0 上显式排除 `powershell`（`defaultTools: ["-powershell"]` / `--exclude-tools powershell`）时不会提示；若要覆盖该状态，触发条件须放宽为“仅 `powershell ∉ active`”。
- **Ruling 9**：诊断技能**只在 Windows 上加载**——由扩展在 `resources_discover` 事件里按平台返回 `skillPaths`（非 win32 返回空，即零目录条目），**不用**静态 `pi.skills` 清单声明。handler **只允许追加**（返回本技能路径，或空数组表示“什么也不加”），**绝不返回"完整集合"**：pi 侧是合并语义（`mergePaths(lastSkillPaths, …)`，已核实）。pi 从磁盘加载包，因此**不做** dsh 的 ASAR/SEA 临时提取，脚本按 skill 目录相对路径引用。技能场景本身需**不受限调用者**（修改安全描述符），靠已批准的 `danger-full-access` 承担。
- **Ruling 10**：任何 Win32 失败都不得 spawn 未受限子进程；错误必须携带 API 名 + 精确 win32 码 + 系统文本 + 上下文。

## 3. 方案选择（被否决的路线）

### 3.1 为什么不选 mxc / AppContainer

同 dsh 的结论：mxc 的 OS 下限（Win11 24H2，BaseContainer 档需 25H2+）过新，且低档回退到 AppContainer + 宿主 DACL 改造；AppContainer 令牌**没有环境读访问**，任意路径读需要为每条路径预授读 ACE（全盘 DACL 改写）。受限令牌只对**写**做交集，零读授权，且不受影响的读/网络/进程可见性与本包的既有词汇表一致。

### 3.2 为什么不选 PowerShell runner（零原生依赖）

用 `Add-Type` 现场编译 C# P/Invoke 完成令牌 + ACL + `CreateProcessAsUserW` + 句柄继承，确实能去掉 koffi。代价：每次命令额外 0.5–2s（PowerShell 启动 + 程序集编译/加载），且要从零设计并调试大量句柄继承/stdio 直通互操作代码——没有可对照的已验证实现。移植 dsh 的代码路径风险显著更低。

### 3.3 为什么不选自建原生 runner 包（仿 landlock-run）

形态与本仓已有的 `@deepseek-ai/node-addon-system` 一致（C 代码 + 每架构预编译 + optionalDependencies），但需要 Windows 构建链路、新的多架构原生包与发布流程，而本仓 CI 只有 ubuntu。成本最高，收益只是省掉 koffi 这 2MB。

### 3.4 为什么不直接依赖 npm 上的 dsh 包

发布的 `@deepseek-ai/dsh-sandbox-windows-acl@0.0.1-rc.1` 与研究中的 0.2.0-rc.2 源码不是同一实现（peer 依赖、导出面、能力均不同），且其 peer 依赖拖入 cordis 生态。研究用途只读源码移植。

### 3.5 为什么不选 WSL 转发

要求用户装 WSL + bwrap，`C:\` 与 `/mnt/c` 路径互映破坏路径透明，且**原生 Windows 进程完全不受约束**——不满足诉求。

## 4. 架构

### 4.1 分层与进程边界

```
pi 进程（不受限）
 ├─ bash-ops.ts / shell-ops.ts（TS）      ← confine() 产出 argv 前缀；win32 上 bash 直接拒绝
 │    └─ node.exe src/win32/runner.js …   ← 独立进程，不受限，只负责"造令牌 + 派生受限子进程"
 │         └─ 受限子进程（WRITE_RESTRICTED + Low IL）   ← 真正的受限执行
 └─ fence.ts（write/edit 进程内围栏）     ← 与 runner 共用 writableRoots 推导
```

`.js` 是硬约束：扩展安装后位于 `~/.pi/agent/npm/node_modules/...`，Node 拒绝为 node_modules 内的 `.ts` 做类型剥离。TS 侧通过 `allowJs` 引用，JSDoc 提供类型。

### 4.2 三层隔离（每层关闭一个具体漏洞，缺一不可）

| 层 | 实现 | 关闭什么 |
|---|---|---|
| ① 受限令牌 | `CreateRestrictedToken(WRITE_RESTRICTED \| DISABLE_MAX_PRIVILEGE \| LUA_TOKEN)`；restricting 列表：`read-only = [logonSID, Everyone]`，`workspace-write = [logonSID, Everyone, workspaceSID, tempSID]` | 写类访问的 pass-2 交集检查：只有携带能力 SID 的令牌能写授权根；读只走正常检查（**读不受限**） |
| ② Low 强制完整性 | 令牌 `SetTokenInformation(TokenIntegrityLevel)` 降到 S-1-16-4096；每个授权根在同一份 descriptor 里打 `SYSTEM_MANDATORY_LABEL_NO_WRITE_UP` 可继承标签（`OI\|CI`） | ①只覆盖对象**自身**的访问检查；Windows 还允许凭**父目录**的 `FILE_DELETE_CHILD` 删除，那条路不需要 restricting SID 副署。标签在访问检查内部强制执行 → 授权根之外的 Medium 对象**既防写也防删** |
| ③ 环境性删除拒绝 | 每个授权根对 world SID 加 `FILE_DELETE_CHILD` 拒绝 ACE，**只带 `CONTAINER_INHERIT_ACE`** | 两个授权根都带 Low 标签时，仅靠②仍可互删。拒绝项使能力 ACE 的 DELETE 位成为根内唯一删除授权来源。只继承到容器是因为 `0x40` 属于 `FILE_ALL_ACCESS`，落到文件上会让根内每次 `GENERIC_ALL` 打开被拒 |

令牌授权掩码 `GRANT_MASK = (FILE_GENERIC_WRITE | DELETE | FILE_DELETE_CHILD) & ~STANDARD_RIGHTS_WRITE`——`WRITE_DAC`/`WRITE_OWNER` 被排除，受限子进程无法改 DACL 或夺取所有权逃逸。

保活组 `logonSID + Everyone` 两种模式都必须保留：没有它们早期 DLL 初始化以 `0xC0000142` 死亡、CNG 让 pwsh 以 `0xE0434352` 崩溃。`Everyone` 仍在列表里，但其环境性写权限已被②的标签层否定。`Authenticated Users` 两种列表都不存在（CIM/WMI 不可用 `0x80041003`，同时关闭 `C:\` 根建树逃逸）；`INTERACTIVE`/`LOCAL` 也不存在（宿主 Public 树对 INTERACTIVE 授予写权限）。

### 4.3 能力身份与确定性派生（纯函数，Linux 上可单测）

```
workspaceWriteSid(ws) = sha256(ws) → 两个 uint32 % (2^30-1) + 1 → "S-1-4-x-y"
tempWriteSid(tmp)     = sha256("temp\0" + tmp) → 同上 → "S-1-4-x-y-1"   // 第三级子授权域分离
```

两者都**确定性**（temp 是宿主 `%TEMP%`，不是随机私有目录），因此**不需要**任何会话态授权表：runner 每次调用都幂等重放授权，跨进程/跨会话/跨重启都命中精确跳过。SID 字符串本身不是秘密，它的能力完全由命名它的 ACE 定义。

### 4.4 授权应用：一次 `SetNamedSecurityInfoW`，三项编辑

`GetNamedSecurityInfoW` 读回 `DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION` → **精确三元组比对**（允许 ACE 的 type/inheritance/mask/SID + 拒绝 ACE 的 type/inheritance/mask/SID + 标签 ACE 的 type/inheritance/policy/SID）→ 三者完全一致则只 `LocalFree` 返回（**这是跨进程复用的关键**，避免急切全树传播）→ 否则 `SetEntriesInAclW` 合并（拒绝项在前）后在**同一次** `SetNamedSecurityInfoW` 里应用 DACL + 标签。

并发：整段 get-merge-set 在每路径 `LockFileEx` 独占锁内，锁文件 `<GetTempPathW()>\dsh-acl-locks\<sha256(小写路径)[0:16]>.lock`（句柄 share read/write 但**不** share delete——可删除的锁文件会在持有者脚下被替换，让两个进程同时"持有"同一把锁）。

分配契约：`GetNamedSecurityInfoW` 返回的 ACL 指针位于 descriptor 分配内部，**只**能 `LocalFree` descriptor；在 `SetEntriesInAclW` 消费完 ACL 之前不得释放。

### 4.5 runner 契约

```
<node.exe> <pkg>/src/win32/runner.js \
    --workspace <ws> --temp <tmpRoot> --mode <read-only|workspace-write> \
    -- <argv...>
```

调用序列：

```
parseArgs → requireDirectory(ws, temp) → win32()（koffi 懒加载）
→ SetConsoleCtrlHandler(null, 1)          // 自身忽略 Ctrl+C，活到能镜像退出码
→ openProcessToken(TOKEN_QUERY|TOKEN_DUPLICATE|TOKEN_ADJUST_DEFAULT|TOKEN_ASSIGN_PRIMARY)
→ findLogonSid()                          // TokenGroups 中 SE_GROUP_LOGON_ID 的拷贝
→ 本进程派生 workspaceSID / tempSID（Ruling 3）
→ workspace-write：grantWrite(ws)、grantWrite(tmp)（幂等）
→ createRestrictedToken(restricting = 按模式的列表)
→ restrictTokenIntegrity(Low)
→ setTokenDefaultDaclGrant(见 4.6)
→ CreateProcessAsUserW（kill-on-close Job、stdio 直通、STARTF_USESHOWWINDOW+SW_HIDE）
→ wait → 镜像子进程退出码（全 32 位）
```

失败契约：任何 runner 侧失败（参数非法、目录不存在、令牌/授权/spawn 错误）→ stderr `windows-acl-run: <detail>` + **exit 127**（Ruling 6）。

### 4.6 令牌默认 DACL 补丁（不移植就会坏的地方）

受限令牌继承的默认 DACL 只命名用户的环境 SID，**不含任何 restricting SID**，于是受限子进程新建**匿名管道**（孙进程 stdio）会在创建时被 pass-2 检查拒绝（`ERROR_ACCESS_DENIED`，Node 表现为 spawn EPERM）。因此 `SetTokenInformation(TokenDefaultDacl)` 合并一条 `FILE_ALL_ACCESS` 允许 ACE，SID 选择顺序与 dsh 一致：`tempSID → workspaceSID → Everyone`（本包授权了 `%TEMP%`，所以 tempSID 就在 restricting 列表里）。新建对象自身 DACL 因此能过 pass-2，而**创建本身仍被父对象的 DACL 门控**。

### 4.7 进程生命周期与清理

- 子进程在 kill-on-close Job 内创建（先 suspended，分配到 Job 后再恢复初始线程，目标代码不会在分配前执行）。
- win32 上 pi 侧 **不**使用 `detached`（pi 自己也是 `detached: process.platform !== "win32"`），并加 `windowsHide`；kill 只杀 runner → Job 句柄关闭 → **整棵进程树消亡**。
- timeout/abort 的既有文案契约（`timeout:<n>` / `aborted`）不变。
- 不使用 `CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE`（受限令牌下子进程会以 `STATUS_DLL_INIT_FAILED` 死亡）。

### 4.8 TS 侧接线

| 文件 | 改动 |
|---|---|
| `src/runners.ts` | 新增 `RunnerKind` `windows-acl`、win32 链、runner argv 构造、`partial`、可解析性前置检查（Ruling 1） |
| `src/confine.ts` | win32 的 `denialSignatures`（Ruling 7）与 `runnerFailureRules`（Ruling 6） |
| `src/policy.ts` | win32 的 tmp 根默认值 = `[os.tmpdir()]`（去掉 POSIX 的 `"/tmp"`；经既有 `_tmpRoots` 注入点可在 Linux 覆盖测） |
| `src/fence.ts` | win32 containment：大小写不敏感 + 用 `path.sep` 而非硬编码 `/`；保留 dev/ino 身份回退（覆盖 8.3 短名与 junction）。大小写判定经**参数注入**（由 `process.platform` 派生、单测可覆盖），使 win32 语义在 Linux 上可测（testing.md「参数注入」） |
| `src/shell-ops.ts`（新） | 从 `bash-ops.ts` 抽出受限 ops 工厂（confine/spawn/超时/中止/denial 记账），bash 与 powershell 共用；`bash-ops.ts` 对外导出与行为**零变化**（现有测试即回归网）。平台判定同样经**注入点**，使 bash 的 win32 拒绝分支可在 Linux 单测 |
| `src/powershell-ops.ts`（新） | PowerShell 专用 ops：`getPowerShellConfig()` 取 argv + pi 的 UTF-8 输出前缀。被拒时经与 bash **同一条** denial 记账路径（`onDenial` → ledger 的 `command` 类），使 pwsh 的拒绝能驱动 denial-first 提权重试 |
| `src/tools.ts` | 注册 `powershell` 工具覆盖（运行时探测 `createPowerShellToolDefinition`）；win32 下 bash 覆盖以 `exposure: "hidden"` 注册（D3 修订 2：不声明、不可命名激活、仍按名遮蔽内建）+ 受限模式拒绝壳（Ruling 2，纵深防御） |

**宿主版本差异的接入规则（D7 的必然要求）**：pi 是 ESM（`"type": "module"`），因此对**版本门控**的宿主 API（`createPowerShellToolDefinition`、`getPowerShellConfig`、`getActiveTools`）**不得**用静态具名导入——在 0.80.2 上运行时会因缺失导出而链接失败（连扩展都加载不了）。一律用命名空间导入 + 属性访问 + `typeof === "function"` 探测：

```ts
import * as piHost from "@earendil-works/pi-coding-agent";
const host = piHost as unknown as Record<string, unknown>;
const createPowerShellToolDefinition = typeof host.createPowerShellToolDefinition === "function"
  ? (host.createPowerShellToolDefinition as (cwd: string, opts: unknown) => unknown)
  : undefined;
```
| `index.ts` | 激活期 pwsh 未激活提示（Ruling 8）；`/permission` 状态行的 win32 标注；`resources_discover` 处理器的 platform 门控（Ruling 9） |
| `src/win32/skill-paths.ts`（新） | 纯函数 `aclSkillPaths(platform)`：win32 返回**技能目录的绝对路径**（`fileURLToPath(new URL("../../resources/skills/diagnose-windows-sandbox-acl", import.meta.url))`），其余平台返回 `[]`（可在 Linux 单测断言） |

### 4.9 模块划分

```
src/win32/abi.js      Win32 常量 + x64 布局（进程/Job/ACL/令牌四组；纯数据，按 dsh verify/abi-probe.cpp 的值写断言）
src/win32/ffi.js      koffi 懒加载 + 绑定表（kernel32/advapi32）+ 指针/内存 helper + Win32Error 格式化
src/win32/proc.js     进程原语：quoteArg/buildCommandLine、kill-on-close Job、suspended→assign→resume、CreateProcessAsUserW、waitForProcessExit
src/win32/token.js    logon SID、well-known SID、restricting 列表、Low IL、默认 DACL 补丁
src/win32/acl.js      DACL/标签读改写、环境性删除拒绝、per-path LockFileEx 锁
src/win32/sid.js      能力 SID 派生 + 路径边界校验（纯函数）
src/win32/cli.js      参数解析/校验（纯函数）
src/win32/runner.js   独立入口（thin：main + exit code；main 可注入 api/spawn 以便单测）
```

行数估计（按参考实现折算）：`abi`+`ffi` ≈ 420（沙箱绑定 + 进程/Job 绑定）、`proc` ≈ 320（从 `dsh-win32-process/src/process.ts` 的 `quoteArg`/`buildCommandLine`/`createKillOnCloseJob`/`inheritedStandardHandles`/`spawnJobProcess`/`spawnInheritedJobProcess`/`waitForProcessExit` 子集折算；**不**含 piped stdio、fd-7 控制管道、普通 runner 原语）、`token` ≈ 250、`acl` ≈ 340、`sid`+`cli` ≈ 130、`runner` ≈ 170，合计约 **1600 行 JS**（未含 TS 接线与测试）。测试可注入面：`ffi.js` 暴露测试用的 `types` 注入点，`token`/`acl`/`proc`/`runner` 的每个函数都接受 `api` 作为参数——因此除真实 Win32 语义外的逻辑均可在 Linux 上单测。

### 4.10 诊断技能的落位与**平台门控**

```
pi-sandbox/resources/skills/diagnose-windows-sandbox-acl/
  SKILL.md
  scripts/diagnose-windows-sandbox-acl.ps1
```

- **技能目录不能用约定名 `skills/`**（Linux 自检修订，2026-10-03）：pi 的包资源发现在 settings 的**对象形式/filter 模式**下走 `collectDefaultResources()`——`manifest.skills` 未声明时回退到约定目录 `<pkg>/skills` 并无条件加载到**所有平台**（`package-manager.js` `collectPackageResources`/`collectDefaultResources`；本地探针实测：`packages: [{source: …}]` 时 Linux 上技能出现）。因此技能放在非约定目录 `resources/skills/`，`pi` manifest **不声明** `skills`——manifest 模式与 filter/默认模式因而都不会自动贡献它，平台门控全靠下面的 `resources_discover`。
- **不用**静态 `pi.skills` manifest 声明（那会在 Linux/macOS 上也进模型目录，白占 KV cache 并误导模型）。改为在 `index.ts` 里注册 `pi.on("resources_discover", …)`：handler 返回 `{ skillPaths: aclSkillPaths(process.platform) }`，win32 给技能目录的**绝对路径**、其余平台给 `[]`（返回空 → pi 不会添加任何技能路径）。
- **路径必须返回绝对路径**（真机修订，2026-10-03）：pi 对 `resources_discover` 返回的路径走 `normalizeExtensionPaths` → `resolveResourcePath(p) = resolvePath(p, this.cwd)`，即**相对路径按会话 cwd 解析**；`buildExtensionResourcePaths` 设的 `baseDir = dirname(extensionPath)` 只进来源标注（`metadata.baseDir`），**不参与解析**（`dist/core/resource-loader.js:608-614`、`:794-796`）。真机证据：从 `C:\pi-sandbox-accept` 启动 `pi -e C:\pi-packages\pi-sandbox` 时相对路径解析到 `C:\pi-sandbox-accept\skills\...`，技能不出现（§14 首跑 FAIL）。因此 `aclSkillPaths("win32")` 返回 `fileURLToPath(new URL("../../resources/skills/diagnose-windows-sandbox-acl", import.meta.url))` 的**绝对路径**（`resolvePath` 对绝对路径原样返回）。
- handler 抛错会被 pi 捕获为扩展错误（fail-safe），不会阻断启动；但技能缺失会直接体现在真机验收的目录断言里。
- `files` 包含 `resources/`（不声明 `pi.skills`、不改 `pi.extensions`）。

#### 选用 `resources_discover` 的依据与风险（已核实，不得擅自改为静态声明）

| 问题 | 结论 | 证据 |
|---|---|---|
| 会不会覆盖掉其他技能？ | **纯追加，不覆盖**：`extendResources` 做 `lastSkillPaths = mergePaths(lastSkillPaths, 新路径)`（与已发现集合取并集），外层还有 `if (skillPaths.length > 0)` 短路——返回 `[]` 时连碰都不碰既有集合；多个扩展返回的路径全部收集后追加 | `pi-coding-agent/dist/core/resource-loader.js:331`、`dist/core/extensions/runner.js` `emitResourcesDiscover` |
| 未来 pi 不再发该事件会怎样？ | **安全降级**：handler 按事件名存入 `extension.handlers` Map，宿主不发就是永不触发——不报错、不警告、不影响扩展加载 | `dist/core/extensions/loader.js:216-220`、`runner.js:87-89` `snapshotEventHandlers` |
| 它是公开 API 还是内部实现？ | **公开类型面、但文档零覆盖**：`on(event: "resources_discover", handler)` 是 `ExtensionAPI` 上的类型化重载，`ResourcesDiscoverEvent/Result` 由包根导出且属于公开的 `ExtensionEvent` 联合；但 `pi` 的 `docs/` 全库零命中 | `dist/core/extensions/types.d.ts:1145`、`dist/index.d.ts` 导出面 |
| 文档推荐的做法是什么？ | **manifest `pi.skills`**（或“无 manifest 时按约定目录自动发现 `skills/`”）。本仓现成先例 **pi-ask-user**（扩展包 + 技能）用的就是静态声明——但它在**所有平台**都加载 | `pi` `docs/packages.md`、`docs/skills.md`；`pi-ask-user/package.json` → `{"extensions":["./index.ts"],"skills":["./skills"]}` |
| 为什么不用 manifest 也不能用约定目录？ | 两条路都会**绕过平台门控**：manifest 模式只按 `pi.skills` 加载（声明即在所有平台加载）；settings 对象形式（filter/`autoload` 缺省）走 `collectDefaultResources()`，在 `manifest.skills` 未声明时回退到约定目录 `<pkg>/skills` 并无条件加载（本地探针：`packages:[{source:…}]` 时 Linux 上出现技能）。故技能放非约定目录 `resources/skills/` + manifest 不声明 `skills` + 绝对路径 `resources_discover` 三件套 | `package-manager.js` `collectPackageResources`（manifest 分支）/`collectDefaultResources`（约定目录分支）、`applyPackageFilter`；本地 SDK 探针（见 ledger） |

- 非目标说明：`compatibility` frontmatter 字段（Agent Skills 的“环境要求”）**pi 不消费**（`skills.js`/`resource-loader.js` 零命中），所以“用 frontmatter 声明平台”这条不存在；pi 也没有任何 per-platform 技能门控机制。
- **回退方案（仅当未来 pi 移除该事件时启用）**：改为静态 manifest 声明，并接受“非 Windows 平台多一条用不上的目录条目”；该条目成本在 README 的 Windows 小节说明。真机验收清单里的“技能出现在目录中”断言是发现失效的手段。

## 5. 语义矩阵

| 模式 | restricting 列表 | 授权 | 子进程 TMP/TEMP | bash | pwsh |
|---|---|---|---|---|---|
| `read-only` | `[logonSID, Everyone]` | 无 | 不重写（写会被拒） | 拒绝 + 指引 | 受限执行；pwsh 可能退化 ConstrainedLanguage |
| `workspace-write` | `[logonSID, Everyone, wsSID, tempSID]` | workspace + `%TEMP%` | 不重写（`%TEMP%` 已授权） | 拒绝 + 指引 | 受限执行；有可写 temp → 保持 FullLanguage |
| `danger-full-access` | — | — | — | 既有裸 spawn（Ruling 2） | 既有裸 spawn |

- **`read-only` 不含能力 SID**，所以历史 `workspace-write` 留下的常驻 ACE 在降级后**自动失效**（pass-2 只授予 restricting 列表携带的内容），无需清理。
- **`writableRoots`（win32）= `[canonical(workspace), canonical(os.tmpdir())]`**，`read-only` 为空；fence 与 runner 共用同一推导，防止"write 工具能写而 bash 不能"的漂移。`%TEMP%` 的两侧（授权路径与围栏根）一律取 `canonicalPath(os.tmpdir())`（`realpathSync.native`，解析 junction 与短名拼写），避免拼写差异导致两侧不相交。
- 拒绝与失败两套分类保持 pi-sandbox 既有语义：命中拒绝方言 → `[sandbox: file access denied …]` + 提权提示标记 + 记账一次（驱动 denial-first 提权）；命中失败规则 → `SandboxUnavailableError`。

## 6. 失败模式矩阵

| 失败点 | 处理 | 模型/用户看到 |
|---|---|---|
| koffi / runner.js / node 不可达 | 选择期前置检查 → `unavailable`（Ruling 1） | `SANDBOX_UNAVAILABLE (mode)` + Windows 指引 |
| runner 侧任一失败（参数、目录、令牌、授权、spawn） | 不 spawn 受限子进程；`windows-acl-run: <detail>` + exit 127 | 既有 `classifyRunnerFailure` → `SandboxUnavailableError(detail)` |
| 受限子进程被拒 | 方言命中（Ruling 7） | 拒绝标记 + 提权提示 + denial ledger |
| 授权应用中途失败 | 已应用路径尽力撤销 + `AggregateError`；standing 授权**不算**错误产物 | 原始 `Win32Error`（API 名 + win32 码 + 系统文本 + 路径） |
| 被授权目录不是调用者所有 / 缺 `WRITE_OWNER` | 大声失败（SACL 写入需要；不静默降级隔离） | 同 dsh：仅授予 Modify 的目录会失败，文档记录 |
| 受限模式下调用 `bash` | 拒绝，绝不 spawn（Ruling 2） | 独立错误类型 + `settings.json` 片段 + pi 版本前提 + `danger-full-access` 逃生门 |
| pwsh 未激活 | 激活期提示一次 + 状态行标注（Ruling 8） | UI 通知 / stderr 警告 |
| FAT/无 ACL 卷作授权根 | 大声失败（文档记录为未验证区域） | `Win32Error` |

## 7. 安全与信任边界

**`partial` 强制（三处结构性缺口，全部继承自 dsh 并保留文档）**

1. **NTFS 硬链接是文件对象别名**：工作区内被授权文件的硬链接在外部同样可写。拒绝所有多链接文件不可行（pnpm 安装大量使用硬链接）。
2. **读不受限**：`WRITE_RESTRICTED` 只交叉检查写访问，受限子进程能读调用者可读的一切（含其他工作区）。
3. **被其他 AppContainer 工具以包 SID 打标过的文件对 Low 完整性令牌不可读**（内核规则未确证），需移除外来 ACE 或重装目录树。

**standing 授权的残留与外部性（D6 的代价，必须写进 README）**

- workspace 与 `%TEMP%` 树上的 Low 可继承标签**生命期长于 pi**，会向**任何**以同一用户身份运行在 Low 完整性的进程放宽该目录树（Medium 下本会被拒）；清除可继承标签**不会回退**已传播到子对象的标签，所以撤销只能做一半。
- `%TEMP%` 是用户共享树：其子目录会继承 `FILE_DELETE_CHILD` 拒绝项，因此第三方程序用 `GENERIC_ALL`/`FullControl` 打开自己 temp 子目录会被拒（基于 DELETE 的删除、`MAXIMUM_ALLOWED`、常规读写打开不受影响）；首次授权会在整棵 `%TEMP%` 树上做急切传播（可能数秒），之后每次命中精确跳过。
- 授权根内**目录**的 FullControl 打开被拒绝（拒绝项属于完全访问掩码，无法避免的代价）。

**其他继承边界**：控制台隔离不可用（子进程共享宿主控制台，`CREATE_NO_WINDOW`/`CREATE_NEW_CONSOLE` 会以 `STATUS_DLL_INIT_FAILED` 死亡）；`NUL` 在两种模式下可通过**设备拼法**写（`cmd` 的 `> NUL`、Node 的 `\\.\NUL`；设备 DACL 授予 Everyone 读写，属环境性而非授权；**相对 `NUL`** 是 cwd 下的普通文件名，按工作区边界判权）；受限令牌下 `whoami` 与令牌检查 cmdlet 可能失败（诊断噪音）。

## 8. 与参考实现（dsh）的差异清单

| # | 维度 | dsh | 本设计 | 原因 |
|---|---|---|---|---|
| 1 | 授权管理位置 | seam 持有 `AclWriteGrant`，按会话 materialize/revoke，向 runner 传成对 `--write-sid/--temp-write-sid`（`manageDacls:false`） | runner **自派生 SID、自幂等授权**；argv 无 SID 参数（Ruling 3） | pi-sandbox 无常驻 server 的会话授权生命周期；temp 是确定性宿主路径 → SID 可确定性派生 |
| 2 | temp 语义 | **拒绝**授予宿主临时根；每会话随机私有目录 + 重写 TMP/TEMP + 退出清理 | 授予宿主 **`%TEMP%`**；不重写（D2/Ruling 5） | 保住"宿主 tmp 就是宿主 tmp"的路径透明，与四后端语义对齐 |
| 3 | 生命周期 | workspace standing + **temp revocable** | 两者**都 standing**（Ruling 4） | 撤销无法回退已传播的标签；且撤销后每次都要重传播 |
| 4 | 需要移植的边界检查 | `assertTempRootOutsideWorkspace` / `assertPrivateTempDisjoint` | 不需要（两处固定根，重叠后果只是冗余授权） | D2 的直接后果 |
| 5 | shell 工具面 | Windows 上模型侧只有 pwsh（`pwsh-sandbox`）；POSIX 才是 bash | Windows 上 pwsh 受限、bash **拒绝**（Ruling 2） | D3；dsh 在 Windows 上根本不注册 bash 工具，我们用拒绝保证 fail-closed |
| 6 | 下层原语 | 共享库 `dsh-win32-process`：另有普通 runner 原语、fd-7 CRT 控制管道、`pollProcessExit`/`isJobEmpty`、环境块排序 | 只移植沙箱需要的那部分；不要 fd-7、不要普通 runner 原语；环境走 Node 继承 | YAGNI；pi 的 shell ops 不使用子进程控制管道 |
| 7 | 选择/探测 | 唯一候选不探测 | 唯一候选不功能探测，但加**可解析性前置检查**（Ruling 1） | dsh 的 runner 是包内文件必然存在；我们要把"koffi/runner/node 缺失"从 spawn ENOENT 变成清晰的 `SANDBOX_UNAVAILABLE` |
| 8 | 拒绝/失败接入点 | seam 返回 `denialSignatures`/`runnerFailureRules`，由 bash/pwsh 执行器包渲染 | 值相同，接入本包自己的 `classifyDenial`/`classifyRunnerFailure`，命中后注入拒绝标记 + 提权提示 | pi-sandbox 的拒绝必须能驱动 denial-first 提权记账 |
| 9 | 写侧围栏 | 独立 cordis 服务 `dsh-fs-sandbox` | 内建 `fence.ts`，本次补 win32 语义 | 架构对应物，Windows 语义是本包新增工作 |
| 10 | 进程清理 | Job object 在 runner 内；seam 无 detached 逻辑 | 同样 Job object；额外在 win32 关闭 `detached` | dsh 的 Windows 侧没有"shell ops + 进程组"这一层 |
| 11 | 诊断技能分发与加载 | 随包发布，经 cordis skills 服务注册，启动时从 ASAR/SEA 提取到临时目录 | 技能目录随包发布，经 pi 的 `resources_discover` 事件**按平台**注册（win32 才返回路径），**不提取**（Ruling 9） | pi 从磁盘加载包，无需归档内路径处理；静态 manifest 声明会在非 Windows 上也进模型目录 |
| 12 | 打包形态 | 独立包 `dsh-sandbox-windows-acl` | 合进单包 `src/win32/` + koffi 依赖 | D4 |

## 9. 已知取舍与非目标

**非目标**：读隔离；网络隔离（始终允许，与既有设计一致）；进程可见性；控制台隔离；`!`/`!!` 用户手输命令（不受扩展接管，既有行为）；Windows 上的 CIM/WMI 可用性。

**已知取舍**：

1. `%TEMP%` 与 workspace 的常驻 ACL/标签改动（见 §7 外部性），且不回收。
2. 首次授权在大型 `%TEMP%`/工作区上做急切全树传播（秒级），之后 O(1)。
3. **默认配置的 Windows 用户第一次让模型跑命令会撞上 bash 拒绝**，必须显式改 `defaultTools`（这是 D3 的必然结果，也是它想要的 fail-closed）。
4. `read-only` 下 pwsh 会退化到 ConstrainedLanguage（`Add-Type`/COM/反射失败），`workspace-write` 保持 FullLanguage——属 PowerShell 启动行为，不是 ACL 边界的一部分。
5. FAT 类无 ACL 目标未验证；NULL-DACL 目录在 grant/revoke 往返下不保持身份（后者本包不触发，因为不 revoke）。
6. 受限孙进程的 named-pipe stdio（libuv `stdio:'pipe'`）仍会被拒；继承/忽略 stdio 与匿名管道可用。pi 的 shell ops 用管道连接的是 **runner**（不受限），所以本包的模型可见路径不受影响。

## 10. 测试计划

### 10.1 Linux / CI 可跑（本机可跑，随 `npm test`）

| 对象 | 断言 | 测试文件 |
|---|---|---|
| `sid.js` 派生 | 与已知向量一致、域分离（同路径 temp ≠ workspace）、子授权数量 | `tests/win32-sid.test.ts` |
| `cli.js` 参数 | 缺参/未知参/缺命令/模式校验/目录校验的逐例 | `tests/win32-cli.test.ts` |
| `abi.js` 布局 | x64 结构体尺寸与偏移（`STARTUPINFO`/`EXPLICIT_ACCESS_W`/`TOKEN_MANDATORY_LABEL`/ACL 头） | `tests/win32-abi.test.ts` |
| token/acl（**注入 mock 绑定表**） | 每处分配与提前退出的失败路径、精确 ACE 跳过、拒绝项 `CI`-only、标签载荷、锁的 get-merge-set 顺序 | `tests/win32-token.test.ts`、`tests/win32-acl.test.ts` |
| runner 选择 | win32 链、`partial`、前置检查失败 → `unavailable`、hooks 注入 | `tests/runners.test.ts`（扩充） |
| confine | win32 argv 形态、方言、失败规则、分类（exit 127 + 签名） | `tests/confine.test.ts`（扩充） |
| policy/fence | win32 tmp 根、大小写不敏感、`\`/`/` 混用、8.3 身份回退 | `tests/policy.test.ts`、`tests/fence.test.ts`（扩充） |
| shell ops | bash 在 win32 受限模式拒绝（Ruling 2）、danger-full-access 裸跑；pwsh argv/UTF-8 前缀/超时/中止/denial 记账 | `tests/bash-ops.test.ts`（扩充）、`tests/powershell-ops.test.ts` |
| skills 清单 | `aclSkillPaths(platform)` 的平台门控（win32 给路径、其余给空）、SKILL.md frontmatter 可解析、脚本文件随 `files` 发布 | `tests/win32-skill-paths.test.ts`、`tests/skills-manifest.test.ts` |
| 回归 | 现有 228 例全绿（`bash-ops.ts` 抽取为行为保持型重构） | 既有全部 |

### 10.2 Windows 真机套件（`describe.skipIf(process.platform !== "win32")`）

真令牌 + 真 spawn：workspace 内写成功；外部写被拒；外部删除被拒（`cmd del`、`Remove-Item`、.NET `File::Delete`、Node `unlink` 四条路径且**宿主文件仍在**）；外部读成功；`NUL` 两模式可写（设备拼法 `\\.\NUL` / `> NUL`；相对 `NUL` 是普通文件名）；`read-only` 拒 workspace 写；`%TEMP%` 可写；同一 workspace 的两个进程互不越界；硬链接已知边界；pwsh 语言模式（workspace-write FullLanguage / read-only ConstrainedLanguage）；退出码镜像（含 `0xC0000005`）；超时与中止连孙进程一起死；runner 失败签名分类；围栏与 runner 语义一致；`bash` 拒绝守卫（`assertShellAllowed`）在两种受限模式抛 `UnsupportedWindowsShellError`；覆盖注册 `powershell`（扩展工具，pi 会自动激活）被 pi 接受（不报错）。

诊断技能的**平台门控**（真机侧）：启动一次会话，确认 `diagnose-windows-sandbox-acl` **出现在**可用技能目录中（若相对路径未生效则改用 `import.meta.url` 绝对路径，见 §4.10）；同一份构建在 Linux/macOS 上启动时不出现该技能。

### 10.3 诊断技能测试

Linux：`aclSkillPaths` 平台门控的逐值断言、SKILL.md frontmatter 解析、脚本存在性与 `files` 发布面。
Windows：合成 ACL 场景（缺 `WRITE_DAC` 的目录、显式包允许 ACE 的文件）→ 断言 `REPORT`/`RECAP` 输出、备份与恢复脚本产物、失败时逆序回滚、`-AllowRoot` 边界（只改请求对象或严格内部）。

### 10.4 真机验收流程

1. 我给出编号清单与预期输出（PowerShell + git-bash 两套命令）。
2. 你在 Windows 机器执行并回贴原始输出。
3. 差异逐条归因（实现缺陷 / 环境差异 / 文档需要补充），修完复跑。
4. 把结论写回本 spec 的验收记录节（新增 §13）。

## 11. 文档与发布清单

| 产物 | 改动 |
|---|---|
| `README.md` / `README.zh.md` | 平台表新增 Windows 行（runner `windows-acl`、机制、`partial`）；新增 Windows 小节：机制、standalone/boundary 清单、`%TEMP%` 常驻改动与外部性、pwsh 语言模式差异、bash 拒绝与 `defaultTools` 配置、koffi 依赖、诊断技能用法 |
| `package.json` | `dependencies` += `koffi`；`files` += `resources/`（技能在非约定目录 `resources/skills/`，见 §4.10）；**不改** `pi` manifest（技能走 `resources_discover` 动态注册）；版本 **1.3.2 → 1.4.0** |
| 发布 | 按 `docs/guides/release.md`（minor）；是否发版由用户另行决定 |

## 12. 交付范围

- worktree：`.worktrees/pi-sandbox-windows-support`，分支 `pi-sandbox-windows-support`（基线 228 例全绿）；
- 交付物：`src/win32/*.js`（新增，约 1200 行）、`src/win32/skill-paths.ts` + `src/shell-ops.ts` + `src/powershell-ops.ts`（新增）、`src/{runners,confine,policy,fence,tools,bash-ops}.ts` 与 `index.ts`（改动）、`resources/skills/diagnose-windows-sandbox-acl/`（新增，非约定目录，仅 Windows 加载）、测试（§10）、文档（§11）；
- **不含**：读/网络隔离、控制台隔离、Windows 上的 bash 受限执行（D3 的有意排除）、`@deepseek-ai/node-addon-system` 式的原生二进制包（§3.3）、npm 发版本身。

## 13. 验收记录（真机执行后回填）

### 13.1 自动化端到端套件（Windows 10 Enterprise LTSC 2019，build 17763.316，用户机器）

被测环境：Windows 10 Enterprise LTSC 2019（EditionID `EnterpriseS`，build **17763.316**）、PowerShell 版本见当日 `$PSVersionTable`（记录时待补）。

命令：`npx vitest run tests/win32/e2e.test.ts`（提交 `efde10cb`）

**结果：22 passed / 0 skipped。** 覆盖并已证实的真机行为：受限令牌创建、能力 SID 的 DACL 授权（工作区 + `%TEMP%`）、`read-only` 拒绝工作区写、四种删除路径（`cmd del` / `Remove-Item` / `.NET File::Delete` / Node `unlink`）在授权根之外全部被拒且宿主文件存活、授权根之外可读、NUL 设备在两种模式下可写、退出码镜像（含 `0xC0000005` 全 32 位）、缺失根时的 `windows-acl-run: ` + exit 127 契约、Win32 失败与"被拒绝"的分类区分、授予根与围栏 `writableRoots` 一致、管道 stdio 孙进程被拒、以及三处跨平台断言（bash 拒绝文案、拒绝断言守卫）。

### 13.2 真机回归中发现并修复的两处测试缺陷（后端无缺陷）

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | NUL 用例在两种模式下 EPERM，路径 `…\pi-sandbox\NUL` | 用例用了**裸相对名** `'NUL'`：libuv 走 NT 路径不做 Win32 设备名映射，它于是成为 cwd 下的普通文件（cwd 不在授权根内） | 改用设备拼法；并新增两条用例分别钉住 `cmd` 的 `> NUL` 与"相对名是普通文件" |
| 2 | 改用 `\\.\NUL` 后仍 EPERM，路径 `C:\.NUL` | **双重转义**：路径嵌在"生成的代码文本"里被解析两次，掉了一层反斜杠；Windows 把单个前导 `\` 读作"当前盘当前目录" | 路径改经 **argv** 传递（`spawnSync` 逐字、不经 shell、只解析一层），用 `String.raw` 书写 |

结论：NUL 可写是设备 DACL 的**环境性**属性（两种模式都成立），只能通过设备拼法到达；裸相对名 `NUL` 是普通文件，受工作区边界约束。

### 13.3 诊断脚本套件（Windows 10 Enterprise LTSC 2019 / 17763.316）

命令：`npx vitest run tests/win32/diagnose-script.test.ts`（最终提交 `4230584d`，夹具修正后）

**结果：10 passed / 0 skipped。** 首次真机跑为 6 passed / 4 failed，经五轮收敛（4 → 3 → 2 → 1 → 1 → 0），**全部失败都在测试夹具／工具链一侧，脚本与沙箱后端零缺陷**。用例覆盖：健康目录 `NOT_THIS_CLASS` 且零改动、缺 `WRITE_OWNER` 的补授权 + 备份/恢复产物、包 ACE 移除、**同 SID 的 deny 必须保留**（SDDL 里按 `(A;…)`/`(D;…)` 区分）、`-AllowRoot` 外的包来源拒绝、受保护根（`%ProgramFiles%\WindowsApps`）拒绝、用打印出的 `ROLLBACK` 命令还原、用法错误 exit 2、junction 背后的包来源拒绝、`-Out` 下恰一个 JSONL 报告。

真机暴露的夹具/环境陷阱（均已消除，也是后续写 Windows 夹具的经验）：

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | `icacls /grant *S-1-4-…` 报 `ERROR_NONE_MAPPED(1332)` | S-1-4（Non-Unique 权威）无名称映射，且 `*SID` 对 `/grant` 也不总是绕过 | 不再由测试写 `S-1-4` 能力 ACE；“S-1-4 不是包 SID”改由 Linux 静态断言钉住 |
| 2 | 子进程收到的 `$env:ProgramFiles` 仍是原值 | Node 传 `env` 在本机不生效（大小写去重、libuv 排序两种猜测都不对） | 改为在**同一个 PowerShell 进程内**先赋值再 `& <脚本>`，并用 `exit $LASTEXITCODE` 透传 |
| 3 | 用例 7 撞 vitest 默认 5s 超时 | 每次 PowerShell 启动 ~1.5s，该用例要跑 3 次脚本 + 一次回滚 | 套件级 `{ timeout: 120_000 }` |
| 4 | `-File` 下 `-Path a b` 未绑成数组，exit 1 | PowerShell 把第二个值位置绑定给 `-AllowRoot` → “参数指定多次” | 改用 `-Command` + `-Path 'a','b'` 显式数组 |
| 5 | 受托人=当前用户的 deny 含 `SYNCHRONIZE`，打掉 `CreateFileW(FILE_WRITE_DAC)` 探测 | `icacls (W)`/`(D)` 的掩码展开都含 `S`，而 Win32 打开句柄隐式请求 `SYNCHRONIZE`（核心语义，各版本一致） | deny 受托人改为包 SID 自身（对用户访问检查无影响），断言改看 SDDL ACE 类型 |
| 6 | `icacls /deny "*SID:…"` status 0 但**静默不写 ACE** | 老构建的 icacls 对 `/deny` 的未解析 SID 不落盘（由“脚本 collateral 检查通过 ⇒ 写入时就不存在”反推） | 夹具改用 .NET `Get-Acl`/`AddAccessRule(…,'Deny')`/`Set-Acl`，并**写完立即回读自检**；同时把 deny 放在两条 icacls 写之后 |

**参考实现的测试环境（关键事实，2026-10-03 查证）**：dsh 的设计说明写明 **“no new OS floor”**（`.agents/notes/implemented/feature/2026-08-08-windows-acl-restricted-token-sandbox.md:31,43`；它拒绝 mxc 的理由正是 mxc 要 Win11 24H2+）——**支持老 Windows 是这条路线的一部分**；但 dsh 的 Windows CI 车道是 `dsh-windows-2025-{4…96}core` + 自托管 `dsh-win-ci`（`.github/workflows/ci-master.yml:230,330-355`），**它的测试夹具只在 Windows Server 2025（build ≥26100）上验证过**。本包因此不照搬参考夹具，全部改用与系统构建无关的原语（上表 1/5/6 三类 icacls 依赖即是直接后果）；**支持范围与 dsh 一致：不设新 OS 下限**，本仓在 17763 实测。

### 13.4 人工验收清单（用户执行）

**各条验证对应的提交（可追溯，2026-10-03 复核）**：

- **§1–§13 + §15**：在 `1ec25e51` 上验证。该提交之后沙箱强制链路（`src/win32/**`（除 `skill-paths.ts`）、`runners/fence/shell-ops/powershell-ops/confine/tools.ts`、`index.ts`）**零改动**，`tests/win32/e2e.test.ts`（22/22）也**零改动** → 结论沿用。
- **§14（Windows 出现）**：在 `9aa989ee` 上确认，但 `67f7458d` 之后技能从 `skills/` 迁到 `resources/skills/`（仅位置与 `files` 打包变化，脚本与 SKILL.md 与该提交**逐字节相同**）→ **此项待复验**。
- **诊断脚本套件 10/10**：在 `4230584d` 上；此后 `resources/skills/**` 与 `tests/win32/**` **零改动**（只有文档与 `tests/` 其他文件的可移植性修改，见 `06ca28b9`）→ 结论沿用。
- **§17**：未跑。

| 条目 | 结果 | 证据 |
|---|---|---|
| §0 自动化前置（e2e 22 例） | ✅ | `npx vitest run tests/win32/e2e.test.ts` → 22 passed / 0 skipped |
| §1–§4 shell 工具面（D3 第三版：bash `hidden`） | ✅ | 用户确认通过：`/permission` 显示 `shell: powershell only`（无 `(not activated)`）、模型工具列表无 `bash`、`--tools bash` 也不放行、受限 pwsh 可用 |
| §5–§13 受限执行/拒绝/围栏/Job/会话隔离 | ✅ | 用户确认通过（未逐条留存原始输出） |
| §14 技能目录：Windows 出现 | ✅ | 用户真机确认 `diagnose-windows-sandbox-acl` 出现在可用技能中 |
| §14 非 Windows 对照 | ✅ | 控制器本地 SDK 探针：移动技能到 `resources/skills/` 后，`packages` 的**字符串与对象两种配置形式**下 Linux 均不出现（移动前对象形式会出现——该漏洞已修，见 §4.10） |
| §15 常驻 ACL 残留 | ✅ | 用户 `icacls` 原文：工作区根 `S-1-4-539123267-14510658:(OI)(CI)(W,D,DC)`、`%TEMP%` 根 `S-1-4-683821589-677972989-1:(OI)(CI)(W,D,DC)`、两处 `Everyone:(CI)(DENY)(S,DC)` 与 Low 标签，pi 退出后仍在 |
| §17 诊断技能修复流程 | ⏸ 未运行 | 用户评估后决定不再投入真机时间（2026-10-03）：脚本行为已有真机 10/10 证据，但“模型路由 + 批准提示 + RECAP/回滚”的端到端流程未验证；恢复只需 5 分钟（清单 §17） |

**未验证项汇总（不影响合并，已知边界）**：① §17 端到端（同上）；② §14 的 Windows 结论在技能目录迁移（`67f7458d`）后待复验（内容逐字节未变，仅位置/打包）；③ Windows 全量套件的平台策略期望（`06ca28b9` 修复后未复跑；Linux/CI 全量仍绿）。

### 13.5 待回填

人工清单：`docs/superpowers/verification/2026-10-03-windows-acl-acceptance.md`（§1–§15、§17；§14 已随技能落地复验通过）。
