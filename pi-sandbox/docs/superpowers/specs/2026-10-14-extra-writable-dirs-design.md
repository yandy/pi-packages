# pi-sandbox：workspace-write 额外可写目录（`extraWritableDirs`）设计

日期：2026-10-14
状态：已批准（待实现）
落点：`pi-sandbox/src/config.ts`、`src/policy.ts`、`src/fence.ts`、`src/runners.ts`、`src/confine.ts`、`src/shell-ops.ts`、`src/tools.ts`、`index.ts`、`src/win32/cli.js`、`src/win32/runner.js`、`src/win32/sid.js`、`tests/*`、`README.md`、`README.zh.md`

## 1. 背景与目标

任务：workspace-write 模式增加配置项，在 workspace 与 tmp 之外追加（多个）可写目录。

现状：可写根由 `policy.writableRoots`（`src/policy.ts`）从 `workspaceRoot` + `defaultTmpRoots()` 推导，五条路径消费它——fs 围栏（write/edit）、bwrap、landlock、seatbelt、windows-acl。配置只读全局 `~/.pi/agent/sandbox.json`；项目级文件被静默忽略（2026-10-14 决策），所以模型无法写这份配置——新增字段不会成为"模型自我放宽"面，它只是用户级授权。

目标：用户在全局配置里列出额外目录后，`workspace-write` 下受限命令与 write/edit 工具都能在这些目录里自由读写；`read-only` 与 `danger-full-access` 语义不变；四处后端语义对齐（本包的既有原则，见 2026-09-29 spec 的 /tmp 一节）。

## 2. 用户已确认的决策

| 问题 | 决定 |
|---|---|
| 路径表达 | **绝对路径 + 展开 `~/`**（`~` / `~/…` / win32 `~\…`；不支持 `~user`） |
| 缺失目录 | **加载时告警 + 丢弃该条**，其余配置与目录正常生效 |
| Windows | **一并支持**，四后端语义对齐，无平台差异 |
| 字段名 | **`extraWritableDirs`**（`string[]`，默认 `[]`） |

## 3. 配置契约与加载语义

```json
{
  "mode": "workspace-write",
  "runnerCommand": null,
  "runnerFailureSignatures": null,
  "probeTimeoutMs": 5000,
  "extraWritableDirs": ["~/shared-cache", "/srv/team-data"]
}
```

规范化顺序（加载时，进程内一次）：

1. `~` / `~/…`（win32 也接受 `~\…`）展开为 `os.homedir()`；
2. 展开后不是绝对路径 → `console.warn` 并丢弃该条；
3. 不是已存在目录（`statSync().isDirectory()`）→ `console.warn` 并丢弃该条；
4. `realpathSync.native` 规范化（symlink 解析到真实目标，与 `canonicalPath` 同语义）；
5. 去重（canonical 拼写），保持声明顺序。

与 workspace、`/tmp` 重叠或互相嵌套不报错（授权取并集，重复无害），只做精确去重。

错误分层（沿用现有 fail-safe 风格）：

| 情况 | 处理 |
|---|---|
| 整份不是数组 / 含非字符串元素 | throw → `getSandboxConfig` 捕获 → 整份回退默认 + 告警 |
| 单条非绝对 / 不存在 / 不是目录 | 告警 + 丢弃该条，其余正常 |

职责划分：`validateSandboxConfig` 保持**纯函数**（只做结构校验：不是数组或含非字符串元素即 throw）；新增 `resolveExtraWritableDirs(entries, source)` 承担 `~` 展开、绝对性、存在性、realpath、去重与逐条告警（空串/纯空白按"非绝对路径"丢弃），由 `loadSandboxConfig` 调用。测试分别钉住两层。

生效时机与现状一致：`getSandboxConfig` 进程内缓存一次，改配置需重启 pi；`/permission` 切换模式不影响已解析的目录集合。

## 4. 运行时接线（单一真源）

`policy.writableRoots` 增加第 4 个可选参数，仍是**唯一**的可写根推导函数：

```ts
writableRoots(mode, workspaceRoot, tmpRoots = defaultTmpRoots(), extraRoots = [])
// read-only / danger-full-access → []
// workspace-write → dedupe(canonical(workspace) ⊕ canonical(tmp) ⊕ canonical(extra))
```

| 消费方 | 接线 |
|---|---|
| fs 围栏（`assertWriteAllowed`） | `FencePolicy` 新增 `extraRoots?: readonly string[]`；传给 `writableRoots` |
| bwrap | `bwrapProfileArgs` 在 `--bind /tmp`、`--bind workspace` 后逐目录 `--bind d d`（仅 workspace-write） |
| landlock | `landlockProfileArgs` 的 readWrite 列表追加（仅 workspace-write） |
| seatbelt | `seatbeltProfileArgs` 调 `writableRoots(..., policy.extraRoots)`，与围栏同源 |
| windows-acl | `RunnerPolicy` 新增 `extraRoots`；argv 追加可重复 `--writable <dir>`（仅 workspace-write） |

- `RunnerPolicy`（四后端共用）新增 `extraRoots: readonly string[]`；`confine()` 里 canonical 化一次（新增 `policy.canonicalRoots(paths)`：`canonicalPath` + 去重，供 `confine` 使用）。
- 自定义 `runnerCommand` 走 `bwrapProfileArgs`，自动同享额外 bind。
- shell ops（bash/pwsh）经 `ConfineOptions.extraRoots` 透传；`tools.ts` 的 bash/pwsh/write/edit 都从 `configForCall(deps)` 取 `extraWritableDirs`。
- `danger-full-access` 不经过围栏与 `confine`，无影响。

**`/permission` 状态行**（仅配置非空时追加）——`workspace-write` 下：

```
extra writable: /srv/team-data
```

当前模式不生效时带后缀：

```
extra writable: /srv/team-data (inactive: read-only)
```

**测试注入点**（testing.md「参数注入」）：`SandboxToolDeps._extraRoots`、`FencePolicy.extraRoots`、`ConfineOptions.extraRoots`；生产路径从不传 `_extraRoots`。

## 5. Windows ACL 细节

### 5.1 runner CLI（`src/win32/cli.js`）

- 新增可重复参数 `--writable <dir>`；argv 顺序稳定：`[node, runner, --workspace, ws, --temp, tmp, --writable, d1, --writable, d2, --mode, mode, --, argv...]`。
- 缺值报 `missing value after --writable`；未知参数照旧拒绝。
- 与 `--workspace`/`--temp` 一样**两种模式都做 `requireDirectory` 校验**（provider bug 必须在 runner 边界大声失败）；read-only 下不授予任何东西。

### 5.2 每目录一个 capability SID（`src/win32/sid.js`，方案 A）

```js
extraWriteSid(dir) = S-1-4-x-y-2
// x,y = sha256("extra\0" + canonical(dir)) 前两个 uint32 % (2^30-1) + 1（与 temp 同款域标签式）
```

- 双域分隔：hash 域标签 `"extra\0"` + 第三子授权 `-2`（workspace 无第三级、temp `-1`），任何组合都不可能混淆。
- 按 canonical 目录路径确定性派生 → 同一目录跨会话/重启恒得同一 SID；重复授予命中 `grantWrite` 的 exact-ACE 快路径（不重新传播整棵树）。
- 传入列表按 `canonicalSidInput` 去重，restricting 列表保持干净。

### 5.3 runner `main()`（`src/win32/runner.js`，workspace-write）

- 逐目录 `grantWrite(api, dir, sidPtr, lowLabelSid, worldSid)`：常驻 ACE + Low 标签 + world `FILE_DELETE_CHILD` deny，均带继承——**目录内新建文件经父目录继承获得该目录的 SID**。
- `writeSids = [workspaceSid, tempSid, ...extraSids]` 全部进 restricting 列表（在 `[logonSid, Everyone]` 之上）。
- **默认 DACL 保持现状**（temp SID 优先）：其职责只是给"无可继承 ACE 的新对象"兜底 pass-2，并维持"temp 树里创建的对象不获得 workspace 能力"的既有语义。不引入新规则。
- read-only：不构造 extraSids，`writeSids` 仍为空 → 既有 ACE 保持惰性（与 workspace 降级同款）。

### 5.4 为什么是每目录独立 SID（A），而不是共享 extra SID（B）

ACE 常驻不撤销；放行与否取决于令牌携带哪些 restricting SID。共享 SID 下"配过任意额外目录的会话"都携带同一个 SID：用户把 A 从配置里删掉后，A 的常驻 ACE 仍会放行（restricting 列表命中共享 SID）——配置收窄不生效，是相对用户声明的静默越权。独立 SID 下删除即失效（令牌不再携带 A 的 SID），配回来时 ACE 仍在、立即恢复。实现差异只有"逐目录派生 SID"一步。B 被否。

## 6. 失败语义（Windows，fail-closed）

任一环节失败——目录缺参数、不是已存在目录、SID 解析失败、`grantWrite` 因非属主/无法改 ACL 失败——抛 `RunnerFailure` → exit 127 + `windows-acl-run: <detail>` → TS 侧 `classifyRunnerFailure` 判为 runner 失败 → `SandboxUnavailableError`，命令**不执行**、绝不降级裸跑。不引入撤销/dispose。

## 7. 文档

`README.md` 与 `README.zh.md` 同步：

- 配置示例加 `"extraWritableDirs": []`；字段表新增一行（默认 `[]`；仅 workspace-write 生效；绝对路径、支持 `~/`；必须是已存在目录，否则启动告警并忽略该条）。
- 三档模式表：`workspace-write` 行改为 `working directory + /tmp + os.tmpdir() + extraWritableDirs`。
- Security notes 的 Windows 常驻描述符条目补充：额外目录同样留下常驻 capability ACE + Low 标签 + world `FILE_DELETE_CHILD` deny（退出 pi 后不撤销；对同用户任意 Low 完整性进程放宽）；目录不可授予时将 fail-closed。
- 「Cache/data relocation is out of policy」一段补一句：让工具在工作区外写文件的合法途径是用户把该目录加进 `extraWritableDirs`，模型仍不得自行迁移缓存/数据目录。
- 版本按 minor（新增可选字段，非破坏性）；README 不放 changelog 块。

## 8. 备选与被否

1. **共享 extra SID（方案 B）**：见 §5.4；配置收窄不生效，否。
2. **不改 `writableRoots`，五处各自并集（方案 C）**：并集逻辑分散到围栏 + 4 后端，正是 2026-09-29 spec 要防的语义漂移，否。
3. **只做 POSIX、Windows 降级**：与"四后端语义对齐"原则冲突，用户明确选择一并支持，否。
4. **独立配置子对象（如 `writable.extra`）**：YAGNI，schema 破坏性成本，否。

## 9. 不做清单

- 子路径/文件级白名单、通配符——只有根级授权
- 配置热重载（重启 pi 生效，与现状一致）
- ACE 撤销/清理（与 workspace/%TEMP% 同一既有限制）
- 改 deny-first 提权契约、加新的提权目标级
- read-only 下的任何例外、注入 `TMPDIR`/改动 tmp 语义
- `/permission` 动态增删 extras（只显示）
- 恢复项目级 `sandbox.json`（全局唯一不变式不破）

## 10. 风险与缓解

- **Windows 常驻放宽面扩大**：文档明示 + 状态行可见 + "移出配置立即失效"有测试钉住。
- **大目录首授传播慢**：`grantWrite` 首次会把 ACE/Low 标签传播到整棵子树（%TEMP% 已有此性质）；额外目录若选大（如整个 home）首条命令可能明显变慢。文档提示，不另做优化。
- **配置 typo 静默失效**：加载告警 + `/permission` 状态行可查。
- **授权根运行中被删**：各后端 fail-closed（与 workspace 同性质）。

## 11. 验证

自动化（`npm test -w pi-sandbox`）：

| 文件 | 覆盖 |
|---|---|
| `tests/config.test.ts` | 结构错误 → 整份回退；非绝对/不存在 → 告警丢弃；`~/` 展开；realpath 去重；`DEFAULT_SANDBOX_CONFIG` 含 `[]`；项目级文件仍静默忽略且不参与该字段 |
| `tests/policy.test.ts` | `writableRoots` 含 extraRoots；read-only/danger 为空；canonical 去重；`canonicalRoots` 去重 |
| `tests/fence.test.ts` | extras 内可写、外仍拒；read-only 全拒；extras 内 symlink 目标判定一致 |
| `tests/runners.test.ts` | bwrap `--bind`、landlock readWrite、seatbelt subpath、win32 argv 可重复 `--writable` 且顺序稳定 |
| `tests/tools.test.ts` | write/edit 与 bash/pwsh 均消费注入的 extras（argv 级断言） |
| `tests/index-smoke.test.ts` | `/permission` 显示 extras 与 `(inactive: read-only)` |
| `tests/win32-sid.test.ts` | `extraWriteSid` golden vectors、与 workspace/temp 的域分隔 |
| `tests/win32-cli.test.ts` | 多个 `--writable`、缺值、未知参数、两模式校验 |
| `tests/win32-runner.test.ts` | fake api 断言逐目录 `grantWrite`、restricting 列表含全部 SID、read-only 不授予 |
| `tests/integration.test.ts` | 真机（沿用既有 `skipIf`，runner 可用时；本机有 bwrap）：extras 内可写、extras 外仍拒、read-only 下 extras 也拒 |

命令链验证：`npm test -w pi-sandbox`、`npm run typecheck -w pi-sandbox`、`npm run lint -w pi-sandbox` 全绿。
