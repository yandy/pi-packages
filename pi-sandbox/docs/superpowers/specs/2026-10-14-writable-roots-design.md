# pi-sandbox：可配置额外可写根（writableRoots）与 `$XDG_CACHE_HOME` ruling 设计

日期：2026-10-14
状态：已与用户确认（in-chat：不默认放开 `$XDG_CACHE_HOME`；做可配置 `writableRoots`；本期不做 win32 runner），待落地
前置设计：
- `2026-09-29-process-sandbox-design.md` §4（三档模式、可写根推导）、§6（拒绝方言）、§7（提权提示）
- `2026-10-02-denial-first-escalation-design.md`（denial-first 门禁与提示预算）
- `2026-10-03-windows-acl-sandbox-design.md` Ruling 6（win32 恒为 partial，三处结构性缺口）

## 1. 背景与问题

用户提问：`workspace-write` 下 bash 只能写 workspace 与 `/tmp`，但 `pnpm`、`uv` 这类工具运行时要写 `$XDG_CACHE_HOME`（缺省 `~/.cache`），**是否有必要放开 `$XDG_CACHE_HOME`**。

现状（已核实，标注出处）：

1. 可写根只有三处：`workspaceRoot` + `defaultTmpRoots()`（POSIX 为 `/tmp` + `os.tmpdir()`，win32 为 `%TEMP%`）——`src/policy.ts:36-45`；
2. **没有任何配置口子**能加可写根：`SandboxConfig` 只有 `mode` / `runnerCommand` / `runnerFailureSignatures` / `probeTimeoutMs`——`src/config.ts:7-21`；
3. 提权阶梯从 `workspace-write` 出发只有一级：`danger-full-access`——`src/escalation.ts:9-11` 的 `WIDER_MODES`；
4. bash 侧撞围栏会被 `classifyDenial` 认出（bwrap 方言 `read-only file system`，`src/confine.ts:45-52`），于是模型拿到 `escalationHintMarker` 提示；但该提示只说 `writable here: the workspace + /tmp`（`src/escalation.ts:120`），**没有告诉模型怎么把工具状态挪进可写根**。

合起来的效果：一次 `uv sync` 写 `~/.cache/uv` 失败 → 模型唯一出路是请求 `danger-full-access` → 弹窗打扰用户 → 批准后那条命令**完全脱沙箱**。为一次 cache 写升到最大档，这个交换很差。

`2026-09-29-process-sandbox-design.md:184` 当初就设想过这条出路：

> 实际拒绝多发于 `~/.cache`、`/var/tmp`、`/run/user/<uid>` 这类落到围栏外的路径，换到可写根内即可完成，无需打扰用户

但落地时提示文案没有给出「怎么换」，配置层也没有「加可写根」的口子，于是这条出路实际不可达。

非目标：网络隔离；`read-only` 档语义变化；win32 runner 支持 N 根（见 Ruling 5）；把 `~/.cache` 加进默认（Ruling 1 明确否决）。

## 2. 已确认决策（用户拍板，不得擅自变更）

| # | 决策 |
|---|---|
| D1 | **不**把 `$XDG_CACHE_HOME` 加进默认可写根 |
| D2 | 改为提供可配置的额外可写根 `writableRoots` |
| D3 | 本期 win32 的 `windows-acl` runner **不**支持额外根；write/edit 围栏全平台生效；win32 配置非空时 warn 一次 + README 记为第四条已知限制 |

## 3. Ruling 1：为什么不默认放开 `$XDG_CACHE_HOME`

### 3.1 `~/.cache` 在桌面 Linux 上不是「可丢弃」的同义词

以提问用户自己的机器实测（2026-10-14，`du -sh ~/.cache` = **88 G**，133 个条目）：

| 条目 | 放开写之后的后果 |
|---|---|
| `~/.cache/paru/clone/*`（38 G，16 个 `PKGBUILD` + 已构建的 `*.pkg.tar.zst`） | 沙箱内植入包 → 之后 `paru -S` 让 pacman 以 **root** 安装。**写出沙箱 + 提权到 root** 的完整路径 |
| `~/.cache/biome/biome-socket-2.5.5`、`~/.cache/com.ebus.lark.nf_ipc.sock` | **活的 Unix domain socket**。删除后重绑即 IPC 劫持 |
| `kwin` / `plasmashell` / `kscreenlocker_greet` / `kwinsession.kcache` / `ksycoca6_*` / `xdg-desktop-portal-kde` / `polkit-kde-authentication-agent-1` | 正在运行的 Plasma 会话状态，含**锁屏**与 polkit 认证代理 |
| `ms-playwright`(2.2 G) / `puppeteer` / `electron` / `electron-builder` / `node-gyp` | 之后被**无沙箱执行**的二进制 |
| `mozilla` / `microsoft-edge` / `thunderbird` / `profiles` | 浏览器 profile 缓存；进程运行中写入会损坏 profile |
| `huggingface/hub`(7.1 G) | `huggingface_hub` 的 token 落在此树内 |
| `containers` / `distrobox` / `libvirt` / `virt-manager` / `umu` | 容器与虚拟机状态 |

### 3.2 收益侧：放开 `~/.cache` 带不来任何新的「读」

本沙箱的 `workspace-write` **已经全盘可读**（bwrap `--ro-bind / /`、landlock `readOnly: ["/"]`、seatbelt `(allow default)`、win32 的 `WRITE_RESTRICTED` 只交叉检查写访问——见 README「Security notes」第 1 条与 win32 spec 缺口 2）。所以放开 `~/.cache` 的写权限**不增加任何机密性损失**（那部分已经交出），只交出**完整性 + 持久化**——恰好是这套沙箱目前仅剩的两条属性。

而 `~/.cache` 正是少数几个「沙箱内写入 → 沙箱外进程读取并执行」的位置。沙箱的核心价值命题就是「写不出沙箱、活不过这条命令」，默认放开 `~/.cache` 直接削弱它。

### 3.3 而且它解决不了问题（形状不对）

用户举的两个例子里，只有一个真的走 `$XDG_CACHE_HOME`：

| 工具 | 实际需要写的位置 | 是否认 `XDG_CACHE_HOME` |
|---|---|---|
| `uv` | Linux `~/.cache/uv`；**macOS `~/Library/Caches/uv`** | Linux 认；macOS 不认 |
| `pip` | `~/.cache/pip` | 认 |
| `go build` | `os.UserCacheDir()/go-build`（Linux = `~/.cache`，macOS = `~/Library/Caches`） | Linux 认；macOS 不认 |
| **`pnpm`** | **store 在 `~/.local/share/pnpm/store`（`XDG_DATA_HOME`，不是 cache）** | 不认 |
| `npm` | `~/.npm/_cacache` | 不认（要 `npm_config_cache`） |
| `cargo` | `~/.cargo/registry` | 不认（要 `CARGO_HOME`） |
| Playwright | `~/.cache/ms-playwright` —— 源码里是 `homedir + '.cache'` **硬编码** | **不认**（要 `PLAYWRIGHT_BROWSERS_PATH`） |

即「交很大的面，只换到一部分工具」，且 macOS 上连 uv/go 都覆盖不到。

### 3.4 同行都没放开

| 产品 | `workspace-write` 默认可写 | 对 cache 的处理 |
|---|---|---|
| **Codex CLI** | cwd + `/tmp` + `$TMPDIR`；`writable_roots = []` | 官方 FAQ「构建因为写不了 home 下的 cache 而失败」→ 答「把那条路径加进 `writable_roots`」，并明确「**永远不要加整个 home**」。任何可写根下的 `.git/`、`.codex/` 仍强制只读 |
| **Claude Code** | cwd + per-user `$TMPDIR` + `--add-dir` | 文档给的补救是 `sandbox.filesystem.allowWrite: ["~/.kube", …]`；Security limitations 点名「过宽的文件写权限可导致提权」。project settings **不能**设 `filesystem.disabled`，admin-required 下 repo 的 `allowWrite` 被忽略 |

两家的答案都是「**窄口子可配置**」，不是「默认放开 cache」。

## 4. Ruling 2：`writableRoots` 配置

### 4.1 schema v3

`SandboxConfig` 增加一个字段：

```jsonc
{
  "mode": "workspace-write",
  "runnerCommand": null,
  "runnerFailureSignatures": null,
  "probeTimeoutMs": 5000,
  "writableRoots": []          // 新增：额外可写根（超出 workspace + tmp）
}
```

- 类型：`string[]`；非数组 / 含非字符串元素 → `validateSandboxConfig` **throw**（结构性错误，与 `runnerCommand` 同口径；`getSandboxConfig` 的 fail-safe 会回落默认并 warn）；
- 默认 `[]`，加入 `DEFAULT_SANDBOX_CONFIG` 即自动进入既有的逐字段合并循环（`config.ts` 按 `Object.keys(DEFAULT_SANDBOX_CONFIG)` 遍历）。

### 4.2 Ruling 2a：只认**全局**配置，项目级条目被忽略（有意偏离既有合并语义）

README 现在写的是「merged field by field: project > global > defaults」，`mode` 等四个字段确实如此。`writableRoots` **例外**：只从 `~/.pi/agent/sandbox.json` 取，`<project>/.pi/sandbox.json` 里的该字段被忽略 + warn。

理由：`writableRoots` 是**放宽**边界的键。项目级配置来自被检出的仓库内容，让仓库自己放宽沙箱等于让被约束方定义约束。Claude Code 对同类键采取同样立场（project settings 不能设 `filesystem.disabled`；admin-required 下 repo 的 `allowWrite` 被忽略）。cache 目录本身就是用户级资源，「按项目配 cache 根」的需求很弱，不值得为它开这个口。

> **顺带发现的既存问题（本次不修，已单独记录）**：`loadSandboxConfig` 让项目级 `.pi/sandbox.json` 覆盖 `mode`，因此一个仓库今天就能自带 `{"mode":"danger-full-access"}` 把沙箱整个关掉；pi 自己的项目信任门（`TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES`）只覆盖 pi 的 `settings.json`/`extensions`/`skills`/…，**不覆盖第三方扩展自读的 `sandbox.json`**。这不在本次交付范围内，见 §9。

### 4.3 条目解析规则（`resolveConfiguredRoots`，放在 `config.ts`）

按顺序，每步失败都是 **warn + 丢弃该条**（不 throw）——一条写错的条目不该把用户整份配置打回默认（与 `mode` 非法时「warn + 回落」同风格）：

1. **`~` 展开**：`~` 或 `~/…` → `homedir()`。其余形式（`$HOME/…`、`%USERPROFILE%\…`）**不**展开，按第 2 步判为相对路径丢弃——环境变量展开会把「谁的环境」变成一个隐式输入，且配置是跨会话缓存的；
2. **必须绝对**：展开后不是绝对路径 → 丢弃（POSIX `/…`；win32 盘符或 UNC）。裸盘符 `C:` 与盘符相对路径 `C:work` 按 `fence.ts` 既有口径视为歧义 → 丢弃；
3. **危险根拒绝**：解析出的根若**等于或包含**下列任一项 → 丢弃。
   - `homedir()`（Codex 的「永远不要加整个 home」；含 `/`、`/home`、`/Users` 这些祖先）
   - `getAgentDir()`（pi 自己的配置树 = `~/.pi/agent`；写它等于改 pi 的行为）
   - `workspaceRoot` 本身不是危险根（冗余但无害，去重即可）

   「包含」的判定用 `fence.ts` 的 `isWithinRoots` 口径（分隔符边界 + 平台大小写敏感性），避免 `C:\work` 命中 `C:\workshop`；
4. **存在性过滤**：`existsSync` 为假 → 丢弃 + warn「does not exist, skipped」。
   为什么是丢弃而不是自动 `mkdir`：① bwrap 的 `--bind <src> <src>` 对不存在的 src **硬失败**（`bwrap: Can't bind ...`），landlock 授权与 win32 的 ACL 授权同理，所以 runner 侧本来就不能传不存在的路径；② 若只让围栏放行而 runner 跳过，就会出现「`write` 工具说可以、bash 说 EROFS」的语义漂移，而 pi 的 write 工具会 `mkdir -p` 父目录——那等于**围栏侧真的在 workspace 外创建了目录**，是 fail-open；③ 沙箱不该因为「解析配置」这个动作就在文件系统上产生副作用。**围栏与四个 runner 必须使用同一份过滤后的列表**；
5. **canonical + 去重**：`canonicalPath()`（symlink 已解），与 `workspaceRoot` / tmp 根一起去重。

warn 去重：模块级 `Set<string>`，同一进程内同一条目只 warn 一次（配置按 cwd 缓存、解析按调用发生，不去重会每条命令刷一次）。提供 `resetConfiguredRootsWarningsForTests()`。

### 4.4 注入点（`testing.md`「参数注入」口径）

`resolveConfiguredRoots(raw, hooks?)`，`hooks` 全部可选、生产不传：

```ts
export interface ConfiguredRootsHooks {
  homeDir?: string;                       // 缺省 os.homedir()
  agentDir?: string;                      // 缺省 getAgentDir()（try/catch，取不到则跳过该条规则）
  workspaceRoot?: string;                 // 缺省 undefined = 不做冗余去重以外的判定
  exists?: (path: string) => boolean;     // 缺省 node:fs existsSync
  warn?: (message: string) => void;       // 缺省 console.warn（经去重 Set）
}
```

## 5. 架构：一处解析，五处消费

关键不变量（README 已承诺、本次要真正兑现）：**seatbelt profile 与 fs 围栏共用同一份可写根推导，防止语义漂移**（`policy.ts:29-31` 注释）。今天这句话只对了一半——`bwrapProfileArgs` 与 `landlockProfileArgs` 是**硬编码** `"/tmp"` + `workspaceRoot`，并没有走 `writableRoots()`。本次把四个 runner 与围栏统一到同一份推导。

```
config.ts  resolveConfiguredRoots(config.writableRoots)  ──► string[]（已展开/已校验/已过滤存在性/已 canonical）
                                                                    │
tools.ts  每次 execute 解析一次，透传给下面五处                        │
   ├── bash / powershell ──► shell-ops ──► confine ──► RunnerPolicy.extraRoots
   │                                                    ├── bwrapProfileArgs   → --bind r r
   │                                                    ├── landlockProfileArgs → --rw r
   │                                                    ├── seatbeltProfileArgs → (subpath "r")   [经 writableRoots()]
   │                                                    └── windowsAclRunnerArgv → 忽略（Ruling 5）
   └── write / edit ──► FencePolicy.extraRoots ──► writableRoots(mode, ws, tmp, extra)
```

### 5.1 函数签名变化

```ts
// policy.ts —— 第 4 参默认空，既有调用点与既有测试逐字不变
export function writableRoots(
  mode: SandboxMode,
  workspaceRoot: string,
  tmpRoots: readonly string[] = defaultTmpRoots(),
  extraRoots: readonly string[] = [],      // 新增：已解析的额外根
): string[]

// runners.ts
export interface RunnerPolicy {
  mode: ConfinedSandboxMode;
  workspaceRoot: string;
  extraRoots?: readonly string[];          // 新增
}

// fence.ts
export interface FencePolicy {
  mode: SandboxMode;
  workspaceRoot: string;
  caseSensitive?: boolean;
  extraRoots?: readonly string[];          // 新增（生产字段，非测试注入，故不加下划线前缀）
  _tmpRoots?: readonly string[];
}

// confine.ts
export interface ConfineOptions { …; extraRoots?: readonly string[] }   // 新增，进 RunnerPolicy
```

### 5.2 argv 顺序：额外根一律**追加在末尾**

`tests/runners.test.ts` 逐字钉住了 bwrap 与 landlock 的完整 argv 数组。额外根追加在最后，`extraRoots` 为空时输出与今天**逐字节相同**，既有断言零改动。

- bwrap：`… --bind /tmp /tmp --bind <ws> <ws> --bind <r1> <r1> …`
- landlock：`--ro / --rw /dev/null --rw /tmp --rw <ws> --rw <r1> …`
- seatbelt：`(allow file-write* (subpath "<ws>") (subpath "<tmp>") … (subpath "<r1>") …)`（顺序来自 `writableRoots()`）

### 5.3 Ruling 5：win32 runner 忽略额外根

`windowsAclRunnerArgv` 的 argv 契约是写死的两根（`--workspace` / `--temp`，`src/win32/cli.js:8-13`）。推广到 N 根不是 plumbing，有三个待定的设计问题，本期不做（D3）：

1. **SID 域分隔**：`workspaceWriteSid` 是两段 `S-1-4-x-y`，`tempWriteSid` 用固定第三段 `-1` 保证两者永不撞（`src/win32/sid.js`）。N 根需要新的分隔方案，且不能改动现有两个 SID 的公式——`tests/win32-sid.test.ts` 钉了黄金向量，用户机器上的 standing ACE 也按现公式 materialize；
2. **默认 DACL 语义**：`runner.js` 现在是确定的 `temp → workspace → Everyone` 顺序（「temp 树内新建对象绝不能拿到共享的 workspace 能力」）。N 根时新建对象该拿哪个能力，是个真问题；
3. **`assertGrantRootsDisjoint`** 要从 pairwise 推广到 N 根嵌套检查。

win32 行为：
- **write/edit 围栏照常生效**（围栏是纯 TS，不经 runner）；
- **受限 powershell 不生效**；
- `writableRoots` 非空且 `platform === "win32"` 时 `console.warn` 一次，明确说明这个不对称；
- README「Security notes」/ win32 段落记为 `windows-acl` 的**第四条**已知限制（前三条见 win32 spec Ruling 6）。

这个不对称是**fail-closed 方向**的（bash 更窄），且被显式公告，不是静默 fail-open。

## 6. Ruling 6：拒绝提示补上「不提权的出路」

`escalationHintMarker` 是按需付费的（只在真拒绝后进上下文，不占常态提示预算——见 `tools.ts` 的提示预算说明），所以配方放这里而不是工具描述里。只对 `subject === "command"` 追加（write/edit 的拒绝与工具 cache 无关）：

```
[sandbox: escalation available — writable here: the workspace + /tmp; before escalating, prefer redirecting the tool's state into a writable root (e.g. UV_CACHE_DIR=/tmp/uv-cache, PIP_CACHE_DIR=/tmp/pip-cache, npm_config_cache=/tmp/npm-cache, GOCACHE=/tmp/go-build, pnpm install --store-dir /tmp/pnpm-store); retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]
```

`subject === "operation"` 分支逐字不变。`tests/escalation.test.ts:169` 钉了 command 分支的旧文案，需同步更新。

## 7. 失败模式矩阵

| # | 场景 | 行为 |
|---|---|---|
| 1 | `writableRoots` 不是数组 / 含非字符串 | `validateSandboxConfig` throw → `getSandboxConfig` fail-safe 回落**整份**默认 + warn（既有 I2 语义） |
| 2 | 条目是相对路径（`cache/uv`） | warn + 丢弃该条，其余条目照常 |
| 3 | 条目是 `~` / `/home` / `/` / `getAgentDir()` 或其祖先 | warn + 丢弃（Ruling 3） |
| 4 | 条目不存在 | warn「does not exist, skipped」+ 丢弃；**围栏与四个 runner 一致**，不出现单侧放行 |
| 5 | 条目是 symlink 指向别处 | `canonicalPath` 解析后授予**真身**；围栏的身份回退（dev/ino）已覆盖拼写不一致 |
| 6 | 项目级 `.pi/sandbox.json` 带 `writableRoots` | 忽略 + warn 一次（Ruling 2a） |
| 7 | 配了根但 `mode` 是 `read-only` | `writableRoots()` 返回 `[]`，额外根自然被忽略（与 Codex 的 `writable_roots` 只在 workspace-write 下有意义一致）；不额外 warn |
| 8 | win32 + 非空 `writableRoots` | 围栏生效、runner 忽略、warn 一次（Ruling 5） |
| 9 | 自定义 `runnerCommand` | 额外根经 `bwrapProfileArgs` 拼进 argv（`confine.ts:120-127` 复用它），所以自定义 runner 也会收到 `--bind r r`；不兼容的 runner 会自己报错，由既有 `runnerFailureSignatures` 分类 |
| 10 | 同一进程内重复解析 | warn 去重 Set 保证每条目只 warn 一次 |

## 8. 安全与信任边界

- **默认零变化**：`writableRoots` 缺省 `[]`，所有 profile argv 与围栏判定与 1.4.1 逐字节相同；
- **放宽键不来自被检出的仓库**（Ruling 2a）；
- **危险根在解析期就被拒绝**，不是「文档里叫用户别加」；
- **不存在的根一律丢弃**，杜绝「围栏放行 + runner 跳过」的漂移；
- 用户显式配置的根就是用户的选择：本包不评判「你为什么要让 agent 能写 `~/.cache/uv`」，只拒绝会摧毁边界本身的那几类（home / 文件系统根 / pi 自己的配置树）。README 要照 Codex 的口径写清「加最小的、绝不加整个 home」。

## 9. 已知取舍与后续

1. **既存问题（本次不修）**：项目级 `.pi/sandbox.json` 能覆盖 `mode`，包括设成 `danger-full-access`；pi 的项目信任门不覆盖第三方扩展自读的配置文件。修法是让 `mode` 也只认全局，或接入 pi 的 trust 判定——需要单独一次决策（会改变既有用户的项目级配置行为）；
2. **既存问题（本次不修）**：`bwrapProfileArgs` 只 bind `/tmp`，不 bind `os.tmpdir()`，而围栏与 `defaultTmpRoots()` 放行两者。宿主设了 `TMPDIR` 且不是 `/tmp` 时会出现「围栏说可以、bwrap 说 EROFS」。本次统一推导时**保持现状**（改它会让 bwrap argv 在所有机器上变化，需要单独的兼容性判断），记在此处；
3. **win32 N 根**：见 Ruling 5 的三个设计问题，留作第二期；
4. **`.pi/` 自扩展路径**：workspace-write 放开整个工作区，而 pi 会从项目 `.pi/` 发现扩展/agents/skills，且**子会话每次都重新发现**（`2026-09-30-…-design.md:414`；已核实 `resource-loader.reload()` 会 `clearExtensionCache()`，`/reload` 与 `ctx.reload()` 也会重读扩展代码）。所以沙箱内命令写 `.pi/agents/*.md` 后，父会话下一次 `subagent` 调用就会以完全权限加载它，无需 `/reload`、无需重启。这正是 Claude Code 的 protected paths / Codex 的「`.git`、`.codex` 恒只读」所挡的那一类。本次不做 deny-within-allow 层，单独记为待决；
5. **`/permission` 状态输出**是否要列出额外可写根：本次一并加上（信息性，成本低）；
6. **既存问题（本次真机实测捕获，不修）**：bash 侧的拒绝分类靠后端方言子串（bwrap 为 `read-only file system`），而**ENOENT 会掩盖 EROFS**：`touch <不存在的目录>/x` 报的是 `No such file or directory`，不含任何方言，于是 `classifyDenial` 不命中——**不下发拒绝标记、不记 denial 账本、模型也拿不到提权许可**。实测于 2026-10-14（`touch ~/.sbx-int-denied-<pid>/y`，父目录不存在）。影响面比看上去大：“写不存在的目录”是模型很常见的失败形状。修法是让 shell-ops 额外识别 ENOENT 或改用结构信号（例如包一层探针），但两者都会改变现有拒绝口径，需单独一次决策；本次仅把集成测试的夹具改成“父目录必然存在”（直接 touch `$HOME` 下的文件名），并在用例里记下这个坑。

## 10. 文档改动清单

| 文件 | 改动 |
|---|---|
| `README.md` / `README.zh.md` | 配置表加 `writableRoots` 行；配置示例加该字段；说明**只认全局**、`~` 展开、危险根拒绝、不存在则跳过；Security notes 加「加最小的、绝不加整个 home」；win32 段落加第四条限制；推荐片段（`~/.cache/uv` 等窄口子） |
| `src/escalation.ts` | Ruling 6 的文案 |
| `src/config.ts` | schema v3 字段 + `resolveConfiguredRoots` |
| `src/policy.ts` | `writableRoots` 第 4 参 |
| `src/runners.ts` / `src/fence.ts` / `src/confine.ts` / `src/shell-ops.ts` / `src/tools.ts` | 透传 |
| `src/permission.ts` | 状态输出列出额外根 |

## 11. 测试计划

单测（Linux 本机可跑）：

1. `config.test.ts`：`writableRoots` 缺省 `[]`；非数组/非字符串元素 throw；全局有、项目有 → 只取全局 + warn；逐字段合并不被新字段破坏；
2. `policy.test.ts`（或新增 `configured-roots.test.ts`）：`~` 展开；相对路径丢弃；`~` / `/home` / `/` / agentDir 及其祖先被拒；不存在的根被丢弃 + warn；symlink 解析成真身；去重；`writableRoots()` 第 4 参进结果、`read-only` 下仍为 `[]`；warn 只发一次；
3. `runners.test.ts`：bwrap / landlock / seatbelt 在 `extraRoots` 下追加于末尾；`extraRoots` 为空时 argv 与既有断言逐字节相同（既有测试不改即证明）；`windowsAclRunnerArgv` **不含**额外根；
4. `fence.test.ts`：额外根内的写放行、根外仍拒；额外根不存在时（注入 `exists`）不放行；
5. `escalation.test.ts`：command 分支含新配方且旧片段仍在；operation 分支逐字不变；
6. `confine.test.ts`：`extraRoots` 从 `ConfineOptions` 进 `RunnerPolicy`；
7. `tools.test.ts`：bash/write/edit/powershell 四条 execute 路径都把配置根透传下去（用注入的 ops 工厂断言入参）；
8. `permission.test.ts`：状态输出含额外根。

真机集成（本机有 `bwrap`，`/usr/bin/bwrap`）：

9. `integration.test.ts` 或 `tests/e2e.sh`：配一个 `writableRoots: [<tmp 下的真实目录>]`，真 bwrap 下 `bash` 往该目录写成功、往 `~/.cache` 写仍失败并带拒绝标记；不存在的根 → 写失败（不留半授予状态）。

真机 win32（CI `windows-latest`，本地跑不了）：

10. `writableRoots` 非空 → warn 一次；受限 powershell 往额外根写**失败**（runner 忽略）；write 工具往额外根写**成功**（围栏生效）。

## 12. 交付范围

- worktree `.worktrees/pi-sandbox-writable-roots`，分支 `feat/pi-sandbox-writable-roots`；
- 交付物：`src/config.ts`、`src/policy.ts`、`src/runners.ts`、`src/fence.ts`、`src/confine.ts`、`src/shell-ops.ts`、`src/tools.ts`、`src/escalation.ts`、`src/permission.ts` 改动；对应测试；本文件与 §10 的文档改动；
- **不含**：win32 runner 的 N 根支持（Ruling 5）、项目级 `mode` 的收紧（§9.1）、bwrap 的 `os.tmpdir()` bind（§9.2）、`.pi/` protected paths（§9.4）、npm 发版（若发版按 `docs/guides/release.md`，minor：`1.4.1` → `1.5.0`）——由用户另行决定。
