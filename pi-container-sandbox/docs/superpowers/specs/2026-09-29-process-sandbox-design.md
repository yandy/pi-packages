# pi-container-sandbox 2.0.0：进程级沙箱（替换容器运行时）设计

日期：2026-09-29
状态：已与用户逐节确认
前置研究：`.superpowers/refs/deepseek-harness/`（deepseek harness 源码，MIT/BSD-3）

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
      [workspace-write 追加: --tmpfs /tmp --bind $ws $ws]
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

bwrap/landlock 保持 deepseek 的自有拼写（bwrap 只加 `--tmpfs /tmp`，landlock 只加 `'/tmp'`），seatbelt 与 fs 围栏共用 `writableRoots()`——四处语义由同一推导函数供给并有测试钉住 parity，防止"write 工具能写 /tmp 但 bash 不能"式漂移。

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

## 7. 提权审批（escalation，LLM 发起式）

### 工具 schema 扩展

bash / write / edit 各增加可选参数：
- `sandbox_permissions?: 'workspace-write' | 'danger-full-access'`（封闭目标词汇 `ESCALATION_TARGETS`；`read-only` 是底线，不可作为目标）
- `justification?: string`

参数描述与 `promptGuidelines` 写明提权规则（deepseek `sandboxPermissionsDescription` 语义）："被沙箱拒绝后，用最小够用的更宽模式把**原调用原样重试一次**，会弹用户审批"。

### 拒绝时给模型的标记（两处来源：fs 围栏拒绝、bash denial 分类命中）

```
[sandbox: file access denied under <effective-mode> mode]
[sandbox: escalation available — retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]
```
（fs 工具的 subject 用 `operation`，bash 用 `command`。）

### approveEscalation 校验顺序（执行前，全部 fail-closed）

1. 配对校验：`sandbox_permissions` 与 `justification` 必须同时出现，justification 非空，否则 malformed 错误
2. 目标 == effective mode → 免审批，按当前模式执行
3. 目标不在 `WIDER_MODES[effective]` 中（更窄或非法）→ 抛错 "not strictly wider than this call's current <mode> mode"
   - `WIDER_MODES = { 'read-only': ['workspace-write','danger-full-access'], 'workspace-write': ['danger-full-access'] }`
   - "严格更宽"对着**每次调用的 effective mode** 在执行期检查，不是 schema 约束（schema 是注册表全局的，effective mode 才是逐调用真相）
4. `ctx.hasUI === false` → 抛错 "requires approval, but no approval channel is available"（**必须显式查 hasUI**：noOpUIContext.select 静默返回 undefined，不查会把"无通道"误判为"用户取消"）
5. `ctx.ui.select`，标题含：目标模式 + justification 原文 + 命令/路径摘要；选项 `允许一次` / `拒绝`
6. 结果：`允许一次` → 仅该次调用以更宽模式执行（不持久、不影响会话/进程状态）；`拒绝` → 抛错 "the user rejected escalating this <subject> to <mode>; it stays denied, so stop and explain instead of working around it"；select 返回 undefined → 按取消抛错

对话历史中该流程记录为 2 次 tool call（被拒原调用 + 提权重试），已与用户确认接受此成本（换取审批记录含模型陈述的 justification、且提权路径不依赖拒绝分类启发式的正确性）。

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
- `bindExtensions({})` 不传 uiContext → 子会话 `hasUI === false`、`ctx.ui.select` 为 noOp（返回 undefined）→ **子 agent 的 escalation 一律 fail-closed**（§7 第 4 步），错误文本指示模型 "stop and explain"

**拒绝上报与解救路径**（无专用通道，走普通结果流）：

```
子会话工具被拒（含 escalation unavailable）→ error result 进入子会话历史
→ 子 LLM 在最终结果中说明被拒与所需权限
→ 前台：作为 subagent 工具结果回到父会话；后台：父 LLM 经 get_subagent_result 读到
→ 父 LLM 向用户解释 → 用户 /permission 放宽（进程级，子会话下次调用即生效）
→ 父 LLM 可 steer_subagent 让子 agent 原地重试，无需重 spawn
```

用户也可通过 session-navigation 实时观察子会话拒绝并主动放宽。若未来 pi-subagents 给子会话接入 uiContext，本设计在每次调用时检查 `ctx.hasUI`，子会话 escalation 自动恢复弹窗，无需改代码。

**状态归属**：
- 进程级（模块单例）：runner 链探测结论、/permission 用户覆盖
- activate 闭包级（每会话）：config、workspace root
- 不再有任何模块级沙箱会话单例（现 `session.ts` 的 `sandboxInstance` 模式废除）

并行后台子会话各自 spawn 独立 bwrap/landlock/sandbox-exec 进程，无共享运行时、无容器名冲突。与 pi-permission-system 无命令名冲突（对方注册 `/permission-system`），`sessionCreated` 时序不受影响。

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
- 失败分类：runner failure（exit 门控、informationalLines 剔除、fatal 匹配）与 denial 分类的顺序与方言隔离
- fs 围栏：workspace 内放行、/tmp 放行、外部拒绝（附标记）、read-only 全拒、danger-full-access 关闭围栏
- effective mode 解析优先级：escalation > /permission 覆盖 > config
- runner 链选择：linux 双候选探测顺序、darwin 免探测、未知平台 unavailable

**集成**（环境有 bwrap 才跑，否则 skip）：真实 confine 下 bash 在 workspace 内 touch 成功、workspace 外写入 EROFS、读宿主任意路径成功。

现有 199 个容器测试随删除清单移除；`tests/e2e.sh` 重写为进程沙箱版或删除。

## 12. 发布

- 版本 2.0.0（breaking），遵循 `docs/guides/release.md`
- README.md / README.zh.md 全部重写（进程沙箱语义、三档模式、/permission、escalation、平台要求：Linux bwrap 或内核 ≥5.13、macOS 内置）
- 发布说明写明迁移：旧 sandbox.json 的 image/runtime/host 配置失效；容器用户如需强隔离应停留在 1.x
