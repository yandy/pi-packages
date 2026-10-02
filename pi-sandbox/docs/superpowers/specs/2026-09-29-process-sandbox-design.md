# pi-container-sandbox 2.0.0：进程级沙箱（替换容器运行时）设计

日期：2026-09-29
状态：已与用户逐节确认
前置研究：`.superpowers/refs/deepseek-harness/`（deepseek harness 源码，MIT/BSD-3）

> **2026-09-30 落地修订**：本设计已落地为独立包 `@yandy0725/pi-sandbox@1.0.0`。§1 的两条打包决策——「保留包名 `@yandy0725/pi-container-sandbox`，发 2.0.0」与「用进程沙箱完全替换 pi-container-sandbox，不并存容器引擎」——已被推翻：`pi-container-sandbox` 恢复为容器实现（其 2.0.0 从未发布），两包并存且**互斥**（都接管 `bash`/`write`/`edit`，共用 `sandbox.json` 但 schema 不兼容）。设计本体（三档模式、runner 链、fail-closed、提权审批、写围栏）与 Ruling 编号均不变，**不得重排**：源码与测试按编号引用——`index.ts`（§9、Ruling 19）、`src/config.ts`（§5）、`src/tools.ts`（§4/§7/§9、Ruling 14/15）、`src/bash-ops.ts`（Ruling 9/10/20）、`src/fence.ts`（§7、Ruling 7）、`src/confine.ts`（§2/§6）、`src/policy.ts`（§4）、`src/runners.ts`（§3）、`src/permission.ts` 与 `src/escalation.ts`（§8/§9）。同批作废的还有 §10 目录树的包名（应为 `pi-sandbox/`）与 §12 的版本号及「容器用户停留在 1.x」措辞（改为 1.0.0、安装 `@yandy0725/pi-container-sandbox`）。落地任务的 spec 见仓库根 `docs/superpowers/specs/2026-09-30-pi-sandbox-package-split-design.md`。

## 1. 背景与目标

现有 pi-container-sandbox 用 podman/docker 容器承载工具执行：工作目录挂载为 `/workspace`（rw），目录外除非配置 mounts 否则完全不可感知，外部读取靠宿主侧审批流。问题：容器依赖重（镜像构建、引擎探测）、路径不透明（需要 path-translation / skill mounts / 审批流一整套机制）、外部文件默认可见性为零。

目标：参考 deepseek harness 的进程沙箱（`dsh-sandbox` / `dsh-sandbox-local`），**完全替换容器运行时**，实现：

- 默认 `workspace-write`：工作目录（会话 cwd）可写，工作目录之外全部**可读**、不可写
- 路径透明：宿主路径原样有效，无 `/workspace` 映射
- 零容器依赖：Linux 用 bwrap / landlock-run，macOS 用 sandbox-exec
- fail-closed：无可用 runner 时拒绝执行，绝不静默裸跑

用户已确认的决策：
1. 用进程沙箱**完全替换** pi-container-sandbox（不并存容器引擎）
2. 保留包名 `@yandy0725/pi-container-sandbox`，发 **2.0.0** 大版本
3. Runner 链：bwrap 首选 → landlock-run 回退（依赖 `@deepseek-ai/node-addon-system@0.1.2`，BSD-3，npm 已发布，无 cordis 依赖）；macOS sandbox-exec；Windows/其他平台 fail-closed
4. 网络：**始终允许，无开关**（不做网络隔离）
5. 三档模式全支持：`read-only` / `workspace-write` / `danger-full-access`
6. 容器时代机制**全清**，最小配置
7. 删除 `/sandbox` 命令，新增 `/permission` 命令切换三档
8. 提权审批采用 deepseek 的 **LLM 发起式**（拒绝→模型带参重试→用户审批），不用"拒绝时自动弹窗"变体

非目标：Windows 支持、网络隔离、容器运行时保留、逐目录细粒度权限。

## 2. 总体架构

核心 seam 与 deepseek 一致——`confine(argv, policy)` 返回包装后的 argv 及分类事实：

```ts
interface ConfinedArgv {
  argv: string[];                        // runner + profile 参数 + '--' + 原始 argv
  enforcement: 'full' | 'partial';       // 后端强制完整性
  denialSignatures: readonly string[];   // 该后端"沙箱拒绝"的 stderr 方言
  runnerFailureRules: readonly RunnerFailureRule[]; // runner 自身失败的判定规则
}
```

工具集成（pi `registerTool`，TypeBox schema 已验证可扩展）：

- **bash**：注册 wrapper ops。`BashOperations.exec(command, cwd, opts)` 构造 `['bash','-c',command]`，按当次调用解析 policy → confine → **本地 spawn** 包装后 argv（cwd 用宿主路径原样），流式 onData / timeout / AbortSignal 语义保持 pi 现有接口。`danger-full-access` 直接 spawn 原始 argv。
  - **子进程 env = 继承进程 env + 强制 `LC_MESSAGES=C`**：把消息翻译钉死为英文，保证 glibc strerror / bash / coreutils / gettext 系程序的报错可被 §6 的 denialSignatures 匹配（zh_CN 等 locale 下否则变成"只读文件系统"）。只钉消息翻译，不动 `LANG`/`LC_CTYPE`：UTF-8 编码、排序、日期等行为不变（不用 `LC_ALL=C`，那会把文本处理降级为字节语义、改变用户命令行为）。用户已设 `LC_ALL` 时从子进程 env 中**移除**它：POSIX 中 `LC_ALL` 优先于 `LC_MESSAGES`，保留会使钉定静默失效；移除后 `LANG`/`LC_CTYPE` 照常生效，行为不变。这是对 deepseek 的显式改进：其 `scrubbedParentEnv` 原样继承 locale，denial 分类在非英文桌面环境下同样会漏判。
- **write / edit**：注册 wrapper，执行前做**进程内写围栏**（fs fence）：写路径 canonical 化后必须落在 `writableRoots` 内，否则拒绝（错误附拒绝标记+提权提示，见 §7）。通过后委托 pi 本地工具执行。
  - **不存在路径的 containment**（写目标常常尚不存在，deepseek `dsh-fs-sandbox` 同款语义）：先词法快路径比较 canonical 拼写；拼写不一致时沿**最近存在的祖先目录**向上走、比较文件系统身份（dev+ino）判定是否落在授予根下——既容忍 missing 后缀，又防祖先 symlink 换绑逃逸
- **read**：**不再注册覆盖**——所有模式读都放行，用 pi 默认本地 read 工具。

fail-closed：平台无可用 runner 时 bash 抛 `SANDBOX_UNAVAILABLE` 错误；唯一逃生门是用户显式设置 `danger-full-access`。

## 3. Runner 链

按平台选链，多候选按序功能探测，探测结论**进程级缓存**（与 cwd 无关）：

| 平台 | 链 | 探测 | enforcement |
|---|---|---|---|
| linux | ① bwrap ② landlock | bwrap：read-only profile 跑 `true`，exit 0 即可用；landlock：`@deepseek-ai/node-addon-system/landlock-run` 的 `probe(launcherPath, {timeoutMs})` 返回 `full`/`partial`/`unusable` | bwrap=full；landlock=probe 报告（旧内核 ABI 为 partial） |
| darwin | sandbox-exec（唯一候选） | 不探测；执行期拒绝即 fail-closed | full（静态声明） |
| 其他 | 空链 | — | `SANDBOX_UNAVAILABLE` |

### Profile 构造（照搬 deepseek `profiles.ts` 语义）

**bwrap**：
```
bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent
      [workspace-write 追加: --bind /tmp /tmp --bind $ws $ws]
      -- <argv...>
```

**landlock**（经 `landlockGrantArgs`）：
- readOnly: `['/']`
- readWrite: `['/dev/null']`；workspace-write 追加 `'/tmp'`、`$ws`
```
landlock-run <grant flags> -- <argv...>
```

**seatbelt**（SBPL，经 `sandbox-exec -p`）：
```
(version 1)(allow default)(deny file-write*)
(allow file-write* (literal "/dev/null") (subpath "<root1>") ...)
-- <argv...>
```
subpath 根 = `writableRoots(policy)`（见 §4），SBPL 字符串字面量需转义 `\` 与 `"`。

**runnerCommand 覆盖**（运维自定义 bwrap 兼容 runner）：`[...runnerCommand, ...bwrapProfileArgs(policy), '--', ...argv]`，声明 full enforcement；配置时必须配套非空 `runnerFailureSignatures`（每条非空、单行），否则加载报错。

## 4. 模式与 writableRoots

```ts
type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
```

- `read-only`：仅 `/dev/null` 可写
- `workspace-write`（默认）：workspace root + `/tmp` + `os.tmpdir()` 可写
- `danger-full-access`：跳过 confine 直接 spawn 原始 argv；fs 围栏关闭

**每次工具调用**解析生效模式（effective mode），优先级：

```
本次调用已批准的 escalation（§7，仅一次有效）
  > 进程级 /permission 用户覆盖（§8）
  > 配置默认 mode（§5）
```

**canonical 化**：所有授予根用 `realpathSync.native` 解析符号链接（失败时保留原拼写——不存在的根匹配不到任何路径，保守结果），与 deepseek `roots.ts` 一致。`writableRoots(workspace-write)` = `dedupe([workspaceRoot, '/tmp', tmpdir()].map(canonical))`；`read-only` = `[]`。workspace root = 该会话的 cwd（canonical 化）。

**writable 根在四个后端的映射**（`/tmp` 一处为 2026-10-01 的有意偏离）：bwrap 把宿主 `/tmp` rw bind 进沙箱（`--bind /tmp /tmp`，原路径透明），landlock 用 `--rw /tmp` 放行宿主 `/tmp`，seatbelt 与 fs 围栏共用 `writableRoots()`——四处对 `/tmp` 的语义一致（都是宿主 /tmp），并有测试钉住 argv/白名单，防止"write 工具能写 /tmp 但 bash 不能"式漂移。

> **决策（2026-10-01，用户拍板）**：原实现沿用 deepseek profile 的 `--tmpfs /tmp`，后果是 bash 里的 `/tmp` 是**每条命令重建的空私有 tmpfs**——宿主 /tmp 不可见、跨命令不持久、与 write 工具/landlock/seatbelt 三处语义漂移，还必须在模型提示里常驻一句 /tmp 说明（`BASH_TMP_NOTE`）。改为 `--bind /tmp /tmp` 后四处一致、提示可删、README 的"路径透明"对 /tmp 也成立。
> 已知并接受的代价：① 沙箱内命令的 /tmp 写入落到宿主——`rm -rf /tmp/*` 这类破坏不再被限制在命令内（宿主 /tmp 常有会话 socket 与 pi 自己的临时文件）；② 宿主 /tmp 不可写时沙箱内 /tmp 也随之不可写（旧实现由 tmpfs 兜底）；③ **偏离参考实现**（见下，不是拼写级差异）；④ 并发 bash 调用之间不再有 /tmp 隔离：旧实现每次工具调用一个新 bwrap 进程 → 新 mount namespace → 新 tmpfs（同名路径互不干扰，是并发安全的来源），现在共享宿主 /tmp，两个并发命令落在同一路径名会互相覆盖（与它们本来就共享 workspace 属同类风险）。
>
> **与参考实现的关系（deepseek harness，代码见 `.superpowers/refs/deepseek-harness`）**：分层与此包一一对应——`dsh-sandbox/roots.ts` ↔ `policy.ts`、`dsh-sandbox-local/profiles.ts` ↔ `runners.ts`、`dsh-fs-sandbox` ↔ `fence.ts`、`dsh-bash-sandbox` ↔ `bash-ops.ts`；同样是**只有 shell 走内核级 runner**，write/edit 只是 trusted code 里的预检（其 docstring 自陈 "This is containment, not a security boundary; kernel-grade isolation of untrusted CODE stays `ctx.shell`'s job"，与 §4 栏杆语义一致），read 不设围栏。
> 差异在于 bwrap/landlock 的 /tmp：参考实现里**不是疏漏而是被记录的 per-runner 差异**——`profiles.ts:19` `--tmpfs /tmp` vs `:33` `readWrite.push('/tmp', …)`，`roots.ts` 模块注释称之为 "the honest per-runner differences recorded in the sandbox RFC"，并由 `sandbox-local/tests/bwrap.e2e.ts`（"workspace-write mounts an EPHEMERAL /tmp: the write succeeds inside, the host /tmp stays untouched"）与 `landlock.e2e.ts`（"workspace-write grants the host /tmp (the documented Landlock-profile difference)"）钉住。本包的决定是**不记录差异，而对齐四处语义**——即有意偏离参考；被取代的还有参考测试里那套用 ephemeral /tmp 做鉴别的手法（`bash-sandbox/tests/bwrap.e2e.ts` 注释 "bwrap replaces `/tmp`, which cannot prove the workspace-root boundary"）。pi-sandbox 目前没有真实 runner e2e（argv 由单测钉住），因此无测试依赖那套手法；若将来加真机 e2e，需改用其他鉴别物（如只在工作区内的哨兵文件）。
> 参照意义：参考实现同样把 `os.tmpdir()` 只给 seatbelt 与 fs 围栏（bwrap/landlock 不含，尽管 `roots.ts` 注释承认 "omitting it would deny what the mode promises"）——本包的 `os.tmpdir()` 残留差集与参考一致，非本包独有。参考另有 Windows ACL runner 与 pwsh 词法，本包无（Windows 上 fail-closed）。
> 残留差集（未对齐，未决）：`os.tmpdir()`——`TMPDIR` 指向非 /tmp 路径时，只有 seatbelt 与 fs 围栏放行，bwrap 与 landlock 仍拒；对齐需把 runtime dir（wayland/dbus/pulse/gpg-agent socket）也 bind 进沙箱，风险更大，故不做。
> bwrap 的 `--dev`/`--proc` 另给沙箱两个私有挂载：`/dev` 是 uid=自己、mode=755 的新 tmpfs（所以 `/dev/shm` 与 /dev 下新建文件可写，但仅命令内有效），`/proc` 是新建 procfs。因此改动后 bwrap 沙箱内**命令内有效**的私有可写区仍有两处：`/dev` 与匿名内存。
> 另一个旧实现带来的具体痛点（本次治理的动机之一）：pi 把被截断的完整输出写在**宿主** `os.tmpdir()`（`dist/core/bash-executor.js` 的 `pi-bash-<id>.log`）并在结果里告知模型路径，但旧 profile 下沙箱内的 bash 读不到它（`No such file or directory`），只有非沙箱的 read/grep 工具读得到。

## 5. 配置 schema v2

路径不变：全局 `~/.pi/agent/sandbox.json`（`getAgentDir()`）+ 项目 `<cwd>/.pi/sandbox.json`（`CONFIG_DIR_NAME`）。

```json
{
  "mode": "workspace-write",
  "runnerCommand": null,
  "runnerFailureSignatures": null,
  "probeTimeoutMs": 5000
}
```

- 合并：逐字段 项目 > 全局 > 默认（不再是数组拼接——mounts/env/commands 已删除）
- `mode` 非法值：忽略并 warn，回落 `workspace-write`（fail-safe）
- `runnerCommand` / `runnerFailureSignatures` 必须成对出现；signatures 每条非空单行；`probeTimeoutMs` 必须为正有限数（0 对 Node 意味着无超时，必须拒绝）——校验规则同 deepseek
- 旧 schema 的 `image` / `runtime` / `host` 组：加载时忽略（存在则 warn 提示 2.0 已迁移）

## 6. 失败分类（bash 非零退出）

两级分类，顺序固定（先 runner 失败，后沙箱拒绝）：

1. **runnerFailureRules**（沙箱基础设施故障——命令根本没跑）：
   - bwrap: `[{fatalSignatures: ['bwrap: ']}]`
   - landlock: `[{allowedExitCodes: [125], fatalSignatures: ['landlock-run: '], informationalLines: ['landlock-run: partial enforcement (older Landlock ABI)']}]`
   - seatbelt: `[{fatalSignatures: ['sandbox-exec: ']}]`
   - 判定：exit code 满足 allowedExitCodes 门控（如有）→ 按大小写不敏感整行相等剔除 informationalLines → 剩余 stderr 行内大小写不敏感包含匹配 fatalSignatures
   - 命中 → 结果标记为沙箱基础设施错误（区别于普通命令失败）
2. **denialSignatures**（沙箱正常工作、拒绝了文件操作）：
   - bwrap: `['read-only file system']`；landlock: `['permission denied']`；seatbelt: `['operation not permitted']`；runnerCommand: `['read-only file system', 'permission denied']`
   - 命中 → 结果末尾追加拒绝标记 + 提权提示（§7）

分类只匹配**当前选中后端自己的方言**，不用跨后端并集（并集会把某后端从不产生的拒绝误报给它）。

**locale 鲁棒性**（配合 §2 的 `LC_MESSAGES=C` 钉死）：
- runnerFailureRules 的签名来自 runner 二进制自身（bwrap / landlock-run / sandbox-exec 均无条件英文输出），locale 无关
- denialSignatures 的文本来自用户命令经 glibc strerror 的输出，依赖 `LC_MESSAGES=C` 钉死后才可靠（用户已设 `LC_ALL` 时从子进程 env 移除它，否则 POSIX 优先级使钉定失效）
- **残余风险与兑底**：用户命令内部自行覆盖 locale（如 `LC_ALL=zh_CN cmd`）时分类仍可能漏判；漏判只损失"决策点的即时提示标记"，提权路径本身不断——`sandbox_permissions` 参数与提权规则常驻工具 schema / promptGuidelines（§7），模型不依赖 marker 也能发起提权

## 7. 提权审批（escalation，LLM 发起式）

### 工具 schema 扩展

bash / write / edit 各增加可选参数：
- `sandbox_permissions?: 'workspace-write' | 'danger-full-access'`（封闭目标词汇 `ESCALATION_TARGETS`；`read-only` 是底线，不可作为目标）
- `justification?: string`

> **2026-10-02 修订注记（strict schema 下的合法“不提权”取值）**：两个字段现在都显式包含 `Type.Null()`（`ESCALATION_PROPS`），即 `sandbox_permissions?: 'workspace-write' | 'danger-full-access' | null`、`justification?: string | null`。原因：strict 提供商（pi 内置工具的 `constrainedSampling: {type:"json_schema"}` + 模型 `compat.supportsStrictMode`，如 deepseek-flash）下 pi 的 `makeJsonSchemaNodeStrict` 会把**所有** property 塞进 `required`，并对“不允许 null”的字段补一层 `anyOf[X,{type:"null"}]`——模型在协议上无法“省略”，只能给 `null` 或乱写字符串 `"null"`。显式声明后有四个好处：模型拿到的是 schema 认可的取值；`schemaAllowsNull` 递归识别 → pi 不再补包裹层；JSON `null` 不再被 `normalizeOptionalNulls` 剥掉，而是原样送达 `resolveCall` 的归一化；非 strict provider 下 `required` 仍不含这两个字段（可省略）。可达性细节与实测见 `2026-10-02-denial-first-escalation-design.md` §4.3。

参数描述与 `promptGuidelines` 写明提权规则（deepseek `sandboxPermissionsDescription` 语义）："被沙箱拒绝后，用最小够用的更宽模式把**原调用原样重试一次**，会弹用户审批"。

落地形态按"提示预算"分面（2026-10-01 调整）：`tool.description` 与参数 schema 是**按工具**进每次请求的（同一句写进 bash/write/edit 就付 3 份），`promptGuidelines` 进 system prompt 的 rules 且 pi 按字符串去重（只付 1 份）。因此常驻面只保留**一句**跨工具规则 `SANDBOX_NOTE`（正常调用两个提权字段都不传、workspace-write 已包含工作区与 /tmp，`src/tools.ts`）；协议细节一律放按需面——拒绝标记、畸形参数报错、批准后标记（`src/escalation.ts`）。

> 曾短暂存在 bash 专属的 `BASH_TMP_NOTE`（“/tmp 是每命令重建的私有 tmpfs，跨命令暂存放工作区”）：它随 §4 的 `--bind /tmp /tmp` 决策一并删除——/tmp 现在就是宿主 /tmp，不再需要这套措辞（剩余差集 `os.tmpdir()` 只在真实被拒时经 denial hint 告知）。

### 拒绝时给模型的标记（两处来源：fs 围栏拒绝、bash denial 分类命中）

```
[sandbox: file access denied under <effective-mode> mode]
[sandbox: escalation available — writable here: the workspace + /tmp; retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]
```
（fs 工具的 subject 用 `operation`，bash 用 `command`。前半句先给"不用提权的出路"：实际拒绝多发于 `~/.cache`、`/var/tmp`、`/run/user/<uid>` 这类落到围栏外的路径，换到可写根内即可完成，无需打扰用户。）

批准后另发一条按需标记（随该次工具结果下发）：

```
[sandbox: this call ran with a one-shot escalation to <mode>; the approval covered this call only — later calls are confined again]
```

实测依据（2026-10-01 子代理事故复盘）：批准后模型拿到的只是普通输出，会把"批准过"当成"档位已放宽"，于是对后续每条命令（包括只读的 `ls`）继续带 `danger-full-access`——该次任务 46 条工具调用里 35 条提权，等于 35 个用户弹窗。

### approveEscalation 校验顺序（执行前；无可解析通道时全部 fail-closed）

1. 配对校验：`sandbox_permissions` 与 `justification` 必须同时出现，justification 非空，否则 malformed 错误
   - 文案契约（按需面）：`invalid escalation: this call was rejected before execution (nothing ran).` + `Cause: ...` + `Fix: to run without escalation, omit BOTH fields or send JSON null (never the string "null" or ""); ...`。动机是实际事故：模型把 malformed 错误误判为“沙箱拒绝”，进而要求最大档；错误必须自报"什么都没执行"并给出精确重试配方。
2. 目标 == effective mode → 免审批，按当前模式执行
3. 目标不在 `WIDER_MODES[effective]` 中（更窄或非法）→ 抛错 "not strictly wider than this call's current <mode> mode"
   - `WIDER_MODES = { 'read-only': ['workspace-write','danger-full-access'], 'workspace-write': ['danger-full-access'] }`
   - "严格更宽"对着**每次调用的 effective mode** 在执行期检查，不是 schema 约束（schema 是注册表全局的，effective mode 才是逐调用真相）
4. `ctx.hasUI === false` → 先经 escalation broker 严格解析父会话审批通道（见 `2026-09-30-escalation-approval-forwarding-design.md`）：解析到 → 转发到父会话弹窗（文案与选项完全一致，不加来源标识）；解析不到 → 抛错 "requires approval, but no approval channel is available"（**必须显式查 hasUI**：noOpUIContext.select 静默返回 undefined，不查会把"无通道"误判为"用户取消"）
5. `ctx.ui.select`，标题含：目标模式 + justification 原文 + 命令/路径摘要；选项 `允许一次` / `拒绝`
6. 结果：`允许一次` → 仅该次调用以更宽模式执行（不持久、不影响会话/进程状态）；`拒绝` → 抛错 "the user rejected escalating this <subject> to <mode>; it stays denied, so stop and explain instead of working around it"；select 返回 undefined → 按取消抛错

对话历史中该流程记录为 2 次 tool call（被拒原调用 + 提权重试），已与用户确认接受此成本（换取审批记录含模型陈述的 justification、且提权路径不依赖拒绝分类启发式的正确性）。

**2026-10-02 增补（denial-first 硬化，见 `2026-10-02-denial-first-escalation-design.md`）**：上述 1–6 步语义不变，在 `resolveCall` 层新增三处前置/嵌入处理：

- **归一化（在原第 1 步之前）**：`null` / `"null"`（trim、大小写无关）/ 空串 / 纯空白 → 视为未提供、按普通调用执行；原第 1 步的 malformed 分支不再接收这些占位符（它们曾是"模型误判为沙箱拒绝"的一条噪声来源）；
- **denial-first 门禁（在原第 3 步与第 4 步之间）**：严格更宽的请求必须命中本会话、同工具类（`command`/`operation`）的未消费拒绝记录（bash 沙箱拒绝 / fs 围栏拒绝时记账，一次性消费）；未命中则忽略提权参数、按 effective mode 执行，并在结果附 `[sandbox: escalation fields were ignored …]`。同档请求与非法目标不经过门禁（原第 2、3 步语义不变）；
- **Deny 理由（原第 5 步的 Deny 分支）**：`Deny` 后追问可选理由（`ctx.ui.input`，回车跳过），理由折叠空白、截断 500 字符，追加为拒绝错误后缀 `. The user's reason: <reason>`；无 input 能力的宿主自动跳过。

## 8. /permission 命令（进程级）

删除 `/sandbox` 命令，新增 `/permission`：

- `/permission`：显示当前状态——effective mode 及来源（permission 覆盖 / config 默认）、选中 runner 与 enforcement、workspace root、探测状态
- `/permission <read-only|workspace-write|danger-full-access>`：设置**进程级**用户覆盖（模块级单变量），notify 确认；非法参数列出三档
- **作用域为整个进程**：一个 pi 进程只有一个人类用户，用户在交互会话中设置的覆盖对父会话与所有子会话的**下一次工具调用**立即生效。这是救活被卡子 agent 的唯一持久杠杆（见 §9），无需重 spawn
- headless/API 模式（全程无 UI）：命令不可用，只剩 config 默认档位

与 escalation 的分工：`/permission` 是用户主动的会话间持久切换；escalation 是模型发起的逐调用一次性提权；审批权都在用户。

## 9. 与 pi-subagents 的相容性

源码验证（`pi-subagents/src/lifecycle/create-subagent-session.ts`）：

- 子会话**总是加载父会话全部扩展**（`bindExtensions({})`），递归守卫只剔除 subagent 派发工具 → 沙箱 wrapper 自动覆盖子 agent 的 bash/write/edit
- 子会话可有独立 cwd → workspace root 按**各会话自己的 cwd** 派生（extension activate 闭包状态），与 deepseek "从调用会话的不可变 cwd 派生" 一致
- `bindExtensions({})` 不传 uiContext → 子会话 `hasUI === false`、`ctx.ui.select` 为 noOp（返回 undefined）→ 子 agent 的 escalation 经 **escalation broker** 转发到父会话弹窗（`2026-09-30-escalation-approval-forwarding-design.md`）；无父通道时（跨进程子代理、headless 父会话、link 缺失）仍 **fail-closed**（§7 第 4 步），错误文本指示模型 "stop and explain"

**拒绝上报与解救路径**（转发通道不可用时，走普通结果流）：

```
子会话工具被拒（含 escalation unavailable）→ error result 进入子会话历史
→ 子 LLM 在最终结果中说明被拒与所需权限
→ 前台：作为 subagent 工具结果回到父会话；后台：父 LLM 经 get_subagent_result 读到
→ 父 LLM 向用户解释 → 用户 /permission 放宽（进程级，子会话下次调用即生效）
→ 父 LLM 可 steer_subagent 让子 agent 原地重试，无需重 spawn
```

用户也可通过 session-navigation 实时观察子会话拒绝并主动放宽。若未来 pi-subagents 给子会话接入 uiContext，本设计在每次调用时检查 `ctx.hasUI`，子会话 escalation 自动恢复弹窗，无需改代码。

**状态归属**（最终 review 后修正机制表述：pi 对每个会话的 bindExtensions 都会**重新调用扩展 factory**，activate 闭包不跨会话共享；且 pi 从不 chdir，会话 cwd 只经工具 execute 的 `ctx.cwd` 可达，`process.cwd()` 恒为启动目录）：
- 进程级：runner 链探测结论与按 cwd 键控的 config / workspace root 缓存（每实例一份即可，重复探测无害）；`/permission` 用户覆盖**必须挂 `globalThis` 单例**（模块级变量不行：宿主按 (cwd, generation) 缓存扩展模块，令牌变化即重新 import，模块级变量会重新初始化成默认值，父会话的覆盖对异 cwd 子会话或 reload 后的新实例不可见）
- 逐调用派生：workspace root = canonicalPath(ctx.cwd ?? activate 时 cwd)；项目级配置按 ctx.cwd 惰性加载
- 不再有任何模块级沙箱**会话实例**单例（1.x `session.ts` 的 `sandboxInstance` 模式废除——该禁令针对容器实例状态，不针对上述进程级覆盖/缓存单例）

并行后台子会话各自 spawn 独立 bwrap/landlock/sandbox-exec 进程，无共享运行时、无容器名冲突。`subagents:child:session-created` 事件（pi-subagents 经 `lifecycle.sessionCreated()` 发布）在子会话 `bindExtensions()` 之前同步 emit，因此审批通道的 link 必然早于子会话第一次工具调用。

## 10. 删除清单与新文件结构

**删除**：`src/runtime.ts`、`src/container-cli.ts`、`src/path-translation.ts`、`src/skills.ts`、`src/session.ts`（模块单例）、`src/paths.ts` 的容器映射/PathApprovalStore/审批流、`src/commands/sandbox.ts`、`docker/`（两个 Dockerfile）、镜像 build 命令、容器复用/资源限制、env 注入、host command 白名单、cache volume、skill mounts、tool_call 路径翻译、before_agent_start 的 skill location 重写、read 工具覆盖。

**保留可复用**：config 加载骨架（readJsonFile/mergeGroup/getAgentDir 路径）、`expandPath`（如 runnerCommand 需要）。

**新结构**：

```
pi-container-sandbox/
  index.ts               # activate：注册 bash/write/edit wrapper、/permission；闭包状态
  src/
    config.ts            # schema v2 加载/合并/校验
    policy.ts            # SandboxMode、canonicalPath、writableRoots、逐调用 effective mode 解析
    runners.ts           # 链选择+探测缓存+bwrap/landlock/seatbelt profile 构造（含 test hooks）
    confine.ts           # ConfinedArgv、denialSignatures、runnerFailureRules、失败分类
    escalation.ts        # WIDER_MODES、validateEscalationArgs、approveEscalation、标记文案
    ops.ts               # bash 包装 ops（本地 spawn confine 后 argv）+ fs 写围栏
    permission.ts        # 进程级用户覆盖单变量 + /permission 命令
  tests/                 # 见 §11
```

## 11. 测试策略

**单元**（无真实 runner 依赖，deepseek 式 test hooks 注入假 probe/假 launcher 路径）：
- profile 构造：三种 runner × 三档模式的 argv/SBPL 精确断言（含路径含引号/反斜杠的 SBPL 转义）
- writableRoots：canonical 化、去重、read-only 为空、与 seatbelt/fs 围栏 parity
- config：合并优先级、非法 mode 回落、runnerCommand/signatures 配对校验、probeTimeoutMs 正数校验、旧 schema 忽略+warn
- escalation 校验矩阵：同模式免审批 / 严格更宽需审批 / 更窄拒绝 / 缺 justification / hasUI=false fail-closed / 拒绝/取消文案
- 失败分类：runner failure（exit 门控、informationalLines 剔除、fatal 匹配）与 denial 分类的顺序与方言隔离；受限子进程 env 含 `LC_MESSAGES=C`（不覆盖用户已有 LANG/LC_CTYPE，并移除会覆盖钉定的 `LC_ALL`）
- fs 围栏：workspace 内放行、/tmp 放行、外部拒绝（附标记）、read-only 全拒、danger-full-access 关闭围栏
- effective mode 解析优先级：escalation > /permission 覆盖 > config
- runner 链选择：linux 双候选探测顺序、darwin 免探测、未知平台 unavailable

**集成**（环境有 bwrap 才跑，否则 skip）：真实 confine 下 bash 在 workspace 内 touch 成功、workspace 外写入 EROFS、读宿主任意路径成功。

现有 199 个容器测试随删除清单移除；`tests/e2e.sh` 重写为进程沙箱版或删除。

## 12. 发布

- 版本 2.0.0（breaking），遵循 `docs/guides/release.md`
- README.md / README.zh.md 全部重写（进程沙箱语义、三档模式、/permission、escalation、平台要求：Linux bwrap 或内核 ≥5.13、macOS 内置）
- 发布说明写明迁移：旧 sandbox.json 的 image/runtime/host 配置失效；容器用户如需强隔离应停留在 1.x
