# pi-sandbox：项目配置目录恒只读（deny-within-allow）设计

日期：2026-10-14
状态：已落地
前置设计：
- `2026-09-29-process-sandbox-design.md` §4（三档模式、可写根推导）、§6（拒绝方言）
- `2026-10-02-denial-first-escalation-design.md`（denial 账本与提权门禁）
- `2026-10-14-writable-roots-design.md` §4.2（放宽边界的键如何承担风险）

## 1. 背景与问题

`workspace-write` 放开整个工作区，而 pi 会从 `<cwd>/.pi/` 发现项目级 extensions / agents / skills / prompts / themes。于是沙箱内的一条命令可以写 `.pi/agents/x.md`，让它**在沙箱外、以完全权限**被执行。

生效时机（pi 1.1.0 dist，已核实）：

| 途径 | 是否生效 | 出处 |
|---|---|---|
| 改完什么都不做 | 否 | pi 没有对 `.pi/settings.json`、`.pi/extensions` 的文件监听；`utils/fs-watch.js` 只用于 theme 文件与 `.git/HEAD`、`.git/refs`（footer 显示分支） |
| `/reload` | 是，**含扩展代码本身** | `core/slash-commands.js:25`；`agent-session.js:2971-3000` → `settingsManager.reload()` + `_resourceLoader.reload()`，而 `resource-loader.reload()` 在已加载时先 `clearExtensionCache()` |
| 扩展调 `ctx.reload()` | 是 | `core/extensions/types.d.ts:322` |
| **同会话内新派发的 subagent** | **是，无需任何操作** | pi-subagents 为每个子会话另建资源加载器（只传 `cwd`/`agentDir`/`noPromptTemplates`/`noThemes`/`noContextFiles`），子会话按 `agentDir` 与项目 `.pi/` 重新发现扩展 |

第三条是关键：不需要 `/reload`、不需要重启，父会话下一次 `subagent` 调用就会加载它。

pi 的项目信任门挡不住这条：`TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES = ["settings.json","mcp.json","extensions","skills","prompts","themes","SYSTEM.md","APPEND_SYSTEM.md"]` 只覆盖 pi 自己的配置文件，且信任判定发生在**加载前**——正在干活的项目本来就是已信任的。

同类防护的既有先例：Claude Code 的 protected paths（`.claude` 设置文件、`.claude/skills|agents|commands|hooks`、shell 启动文件、`.git/hooks` 与 `.git/config`，且「allowWrite 抬不动保护」）；Codex 的「`.git/`、`.codex/` 在任何可写根下恒只读」。

## 2. 决策

| # | 决策 |
|---|---|
| D1 | 受保护根 = `<workspaceRoot>/<CONFIG_DIR_NAME>`（用宿主的 `CONFIG_DIR_NAME`，默认 `.pi`，可被 `pkg.piConfig.configDir` 覆盖，不硬编码） |
| D2 | 围栏侧（write/edit）**无条件**拒绝，与目录是否存在无关，全平台生效 |
| D3 | 保护压过 `writableRoots`：在允许判定**之后**检查，所以配了也抬不动 |
| D4 | `danger-full-access` 解除保护——「更改需要提权」，不是「永远不能改」 |
| D5 | runner 侧按后端能力分派挖洞，能力不足的后端**如实公告**，不假装挡住 |
| D6 | bwrap 的挖洞根按**存在性**门控：`.pi` 不存在就不挖，接受由此产生的残余缺口，换取零宿主副作用 |

## 3. 各后端能力矩阵

| 层 | 能否表达 deny-within-allow | 机制 |
|---|---|---|
| fs 围栏（write/edit） | ✅ 无条件 | 纯 TS，`matchProtectedRoot` 在 `isWithinRoots` 通过后再判一次 |
| bwrap | ✅（`.pi` 存在时） | 嵌套 `--ro-bind <ws>/.pi <ws>/.pi`，排在所有 rw bind **之后**（bwrap 按序挂载，后者遮蔽前者） |
| seatbelt | ✅ 无条件 | `(deny file-write* (subpath "<ws>/.pi"))` 追加在 allow 之后；对不存在的路径同样有效（拒的就是「创建」这个动作） |
| landlock | ❌ | 规则是权限的**并集**，没有 deny，无法从已授予的父目录里减掉一个子目录（「逐个列出 `.pi` 的兄弟目录」也不行：兄弟集是动态的，新建文件覆盖不到） |
| windows-acl | ❌（本期） | 需要 deny ACE 或断继承，是 runner argv 契约的改动 |

分派逻辑集中在 `confine.ts` 的 `protectedRootsFor(kind, workspaceRoot)`，profile 构造器保持纯函数（只读 `policy.protectedRoots`）。

### 3.1 bwrap 挖洞的真机验证（2026-10-14）

```
bwrap --ro-bind / / … --bind <ws> <ws> --ro-bind <ws>/.pi <ws>/.pi -- bash -c '…'
  touch <ws>/ok.txt              → 成功
  touch <ws>/.pi/agents/x.md     → touch: cannot touch '…': Read-only file system
```

错误文案**正是** `DENIAL_SIGNATURES.bwrap` 的方言，所以 `classifyDenial` 照旧命中 → denial 账本记上一笔 → denial-first 门禁放行提权重试。整条链路零改动即可用。

### 3.2 为什么 bwrap 必须按存在性门控（D6）

- `--ro-bind <src> <src>` 对**不存在的 src 硬失败**（实测 `bwrap: Can't find source path …: No such file or directory`），那会被 `classifyRunnerFailure` 归为 `SANDBOX_UNAVAILABLE`——整条命令跑不起来，而不是被拒绝；
- 用「别处一个已存在的空只读目录」当源 ro-bind 到 `<ws>/.pi` 上确实能挡住（实测沙箱内 `mkdir`/写入都是 `Read-only file system`），但两个代价：
  1. bwrap 会**在宿主上真创建** `<ws>/.pi` 空目录（实测确认）——每个跑过受限 bash 的项目里都会多一个 `.pi`；
  2. 源目录必须放在沙箱写不到的地方。`/tmp` 是可写的，放那里等于自废：受限进程能写源目录，内容会透过 bind 出现在 `<ws>/.pi`。可行的位置是 agentDir 下（在只读挂载内），但那要求 pi-sandbox 在 pi 自己的配置树里建目录。

结论：`.pi` 不存在时不挖洞，把「零宿主副作用」放在「堵住从零创建」之前。

## 4. 架构

```
src/protected.ts   protectedRoots(ws)      → [<ws>/.pi]              （与存在性无关，围栏用）
                   carveOutRoots(ws)       → 仅已存在的受保护根        （bwrap 用）
                   shellProtectionNote(…)  → /permission 状态行文案
        │
        ├── fence.ts   assertWriteAllowed：isWithinRoots 通过后再 matchProtectedRoot
        │              → 命中抛 ProtectedPathDenialError（**继承** FenceDenialError）
        │
        ├── confine.ts protectedRootsFor(kind, ws) 按后端分派 → RunnerPolicy.protectedRoots
        │              ├── bwrapProfileArgs   → --ro-bind 追加在 rw bind 之后
        │              ├── seatbeltProfileArgs → (deny file-write* (subpath …)) 追加在最后
        │              └── landlock / windows-acl → []
        │
        └── index.ts   /permission 状态行：protected read-only: … (write/edit: always denied; <shell 侧覆盖情况>)
```

### 4.1 `ProtectedPathDenialError extends FenceDenialError`

继承是**承重**的，不是分类洁癖：`tools.ts` 的两个围栏 ops 用 `if (error instanceof FenceDenialError) onDenial?.()` 记 denial 账本，而 denial-first 门禁靠这笔记录才放行提权重试。做成兄弟类会静默断掉提权链路——拒绝文案看着对，但模型永远提不了权，D4 直接失效。

### 4.2 专用拒绝文案

受保护目标**在**可写根内，所以通用文案的两句话在这里都是假的，必须换成专用文案（`protectedPathMarker`）：

- 不能说 `writable here: the workspace + /tmp`（目标就在 workspace 里）；
- 不能给 cache 重定向配方（`UV_CACHE_DIR` 之类与此无关，只会把模型引向无效尝试）。

要说的三件事：① 为什么工作区内也被拒（pi 从这里加载扩展、子会话每次重新发现 → 沙箱内的写会在沙箱外以完全权限跑）；② 配 `writableRoots` 抬不动它（否则模型会叫用户去改配置，那是无效的）；③ 提权配方。

首行仍逐字复用 `sandboxDenialMarker(mode)`，任何按该标记识别拒绝的下游（含既有测试断言）照旧生效。

### 4.3 symlink 与边界

- 判定用 `canonicalizeTarget` 之后的路径，所以 `<ws>/link -> <ws>/.pi` 式绕不过（已解到真身）；
- 受保护根自身也 canonical 一次，容忍工作区根是 symlink；
- 分隔符边界由 `isWithinRoots` 保证：`.pignore`、`.pix` 不命中 `.pi`；
- 宿主把 `configDirName` 配成空串或带分隔符时返回空列表——宁可不保护，也不能保护到 `/` 或工作区自身（后者会把整个工作区变成只读）。

## 5. 已知取舍

1. **`.pi` 不存在时 bash 能从零创建它**（bwrap 链）。围栏侧全平台拦住，所以 write/edit 这条路是关的；seatbelt 无此缺口（deny 对不存在的路径同样有效）。真机用例把这条缺口**如实钉住**（`integration.test.ts` 的 "residual gap"），将来若闭合，该用例应当被改成断言拒绝而不是被删掉。
2. **landlock 回退下 bash 侧完全无保护**，只有围栏侧。`/permission` 状态行会明说，并提示装 bwrap 可闭合。bwrap 在链上优先，只有它不可用时才回退。
3. **windows-acl 下 bash（powershell）侧完全无保护**，只有围栏侧。与 `writableRoots` 的 Ruling 5 同属 runner argv 契约待推广的一类。
4. **seatbelt 未经真机验证**：本机与 CI 都没有 macOS。`(deny file-write* (subpath X))` 追加在 allow 之后依赖的求值语义（顺序优先 / 最具体优先）在本 profile 里**本来就承重**（`(deny file-write*)` 之后再 `(allow file-write* …)`），两种口径下结论一致，但仍未实测。
5. **只保护 `.pi`**。同一类的其他自扩展路径未纳入：`.git/hooks`、`.git/config`（Claude Code 与 Codex 都保护）、项目根 `AGENTS.md`（指令注入而非代码执行）。`.git` 的取舍与 `.pi` 不同——`git commit` 要写 `.git`，全目录只读会打断正常提交，需要精确到 `hooks/` 与 `config`，是单独一次设计。

## 6. 测试计划

单测：

1. `protected.test.ts`：`protectedRoots` 用宿主 `CONFIG_DIR_NAME` 而非硬编码；与存在性无关；畸形 `configDirName` 返回空；`carveOutRoots` 的存在性门控与注入；
2. `fence.test.ts`：`.pi` 内写入被拒且抛 `ProtectedPathDenialError`；**它同时是 `FenceDenialError`**（继承关系承重）；`.pi` 不存在时也拒；普通工作区写入不受影响；`.pignore`/`.pix` 不命中；`writableRoots` 配到 `.pi` 下仍被拒；symlink 指向 `.pi` 被拒；`danger-full-access` 放行；`read-only` 下抛通用拒绝而非受保护拒绝；文案三要素齐备且不含 cache 配方与假的 "writable here"；
3. `runners.test.ts`：bwrap 的 `--ro-bind` 排在 rw bind **之后**（顺序承重）；`read-only` 下不加挖洞；seatbelt 的 deny 排在 allow 之后且 SBPL 转义；landlock 与 windows-acl 的 argv 不含受保护根；空列表与省略字段逐字节相同；
4. `confine.test.ts`：缺省自动探测（不存在→无挖洞，存在→有）；显式覆盖优先；symlink 工作区跟着 canonical 走；**按后端分派**——seatbelt 对不存在的 `.pi` 仍 deny、landlock/windows-acl 恒不挖洞、自定义 runnerCommand 按 bwrap 口径；
5. `tools.test.ts`：端到端三件事同时成立——默认拒绝、拒绝记进账本使提权获批后真能改、无前置拒绝时提权被忽略仍拒；edit 同样被拒且原文件不变；bash 的 argv 里 `--ro-bind` 在工作区 rw bind 之后；
6. `escalation.test.ts`：`protectedPathMarker` 首行复用 denial 标记、点名路径与原因、声明 `writableRoots` 抬不动、不含 cache 配方与假的 "writable here"；`protectedPathEscalationHint` 的重试语法与通用提示一致；
7. `index-smoke.test.ts`：状态行点名受保护根与 write/edit 恒拒；shell 侧覆盖情况如实（不存在→NOT protected yet 且说明原因）；`danger-full-access` 下整行消失。

真机（本机有 bwrap）：

8. `integration.test.ts`：`.pi` 存在时写入被拒且带标记 + 提权提示；旁边的普通工作区写入照常；**残余缺口用例**如实钉住「`.pi` 不存在时 bash 能从零创建」。

## 7. 交付范围

- worktree `.worktrees/pi-sandbox-writable-roots`，分支 `feat/pi-sandbox-writable-roots`（与 `writableRoots` 同 PR）；
- 交付物：`src/protected.ts` 新增；`src/fence.ts`、`src/confine.ts`、`src/runners.ts`、`src/escalation.ts`、`index.ts` 改动；`tests/protected.test.ts` 新增，其余测试文件扩充；本文件与 README 的「Protected paths」段；
- **不含**：landlock / windows-acl 的挖洞、`.git/hooks` 与 `AGENTS.md` 的保护、seatbelt 真机验证、npm 发版。
