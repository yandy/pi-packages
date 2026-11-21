# pi-checkpoint 设计

新建 Extension package `pi-checkpoint`（npm 名 `@yandy0725/pi-checkpoint`）：将一次完整 Pi agent run 前后的工作区状态保存为隐藏 Git commit，并把该轮对话与最终净差异关联起来，供事后只读追溯。

## 1. 意图与目标

- 以 `before_agent_start → agent_settled` 定义一个 run，不按 `turn_end` 或单次工具调用建立检查点。
- 每个 run 保存 baseline 与 result 两个完整 Git tree；两者的 diff 表示这轮运行前后工作区的净变化。
- 不移动当前分支或 `HEAD`，不改变真实 Git index，不恢复、清理或重写工作区。
- 在 Pi 会话时间线中记录检查点，使用户能从对话定位变更统计、diff 预览和完整 Git 对象。
- 正常完成、用户中断以及没有代码变化的 run 都留下记录。

“净变化”是工作区状态差异，不是精确的作者归因。run 期间用户手动编辑、外部进程写入以及 Git 提交/切分支造成的文件变化都会包含在 diff 中。

## 2. 非目标 / 反目标

- 不记录每个 `turn_end`，不维护工具调用账本，不尝试推断每个文件由 LLM、用户还是外部进程修改。
- 不提供 restore、reset、clean、自动撤销或任何自动写回工作区的功能。
- 不创建或切换独立 worktree，不替用户提交到当前分支。
- 不把检查点内容或 diff 注入 LLM 上下文，不注册 LLM 工具。
- 首版不做独立 checkpoint 列表/选择器 UI；会话时间线本身就是列表。
- 不自动删除检查点，不承诺进程崩溃后的 result 捕获。
- 不递归捕获 submodule 内部工作区；superproject 只记录 gitlink 变化。ignored 文件不进入快照。
- 不把“隐藏 ref”解释为加密或秘密存储。

## 3. 宿主依据与约束

- `before_agent_start` 在一次外层 run 开始前触发，提供 `messageType: "user" | "custom"`。宿主要到该 hook 返回后才构造并持久化起始消息，因此此时不能直接读取本轮消息的 entry id。
- `agent_end` 后仍可能自动重试、压缩重试或处理排队消息，不能作为最终边界。
- `agent_settled` 是最终空闲信号，`event.aborted` 标识用户中断；中断前的文件变化同样需要捕获。
- 同一个 busy period 内的 steering、follow-up、自动重试与续跑归属于当前 run；只有新的 `before_agent_start` 才分配新 run。
- `ctx.sessionManager.getSessionId()` 提供 session 命名空间；`getLeafId()` 在 run 开始时提供起始消息之前的 `previousLeafId` 锚点，settled 后再从 session entries 解析本轮 `sourceEntryId`。
- `pi.appendEntry()` 持久化 custom entry，且不参与 LLM 上下文；`pi.registerEntryRenderer()` 在 TUI 会话时间线渲染它。
- `ctx.ui.notify` 只用于 best-effort 反馈，功能正确性不得依赖通知一定显示。
- 捕获 baseline 必须等待 Git 快照完成后再允许 agent 修改文件；result 捕获在 settled handler 中等待完成。Git 失败不得中断 agent run。
- 每个 extension 实例同时只拥有一个 active run；异步回调按 runId 与 session generation 校验，禁止旧会话的完成回调写入新会话。

## 4. 方案取舍

| 方案 | 内容 | 结论 |
|------|------|------|
| A 工作区净差异 | run 开始与结束各捕获完整 tree，以 diff 追溯净变化 | **采用**；直接覆盖实际文件结果，不依赖具体工具 |
| B 工具账本 + 净差异 | 额外监听工具写操作，同时保存最终 tree | 不采用；shell 与生成器仍可间接写文件，不能形成可靠作者归因 |
| 单快照 / 与上轮比较 | 只保存 result，下一个 run 与上一个 result 比较 | 不采用；两轮之间的人工修改会被误算到下一轮 |
| 真实 index 提交后恢复 | `git add -A`、提交，再恢复 index/worktree | 不采用；会劫持用户暂存状态并引入恢复失败风险 |
| 双隐藏 ref 配对 | baseline/result 各一个 ref，由会话记录保存配对 | 不采用；发布与恢复都要处理两个 ref 的部分完成状态 |
| 单隐藏 ref 父子提交 | result 以 baseline 为父提交，单个 ref 同时保持两者可达 | **采用**；天然表达同一 run 的顺序与 diff，发布边界清晰 |

## 5. 已确认决策（用户逐条拍板，不得擅自变更）

- 不使用 `turn_end` 粒度。
- 目标是追溯每一轮与 LLM 的对话，以及这轮最终总共改了什么。
- 采用工作区净差异路线，不加入工具行为账本。

## 6. Run 与引用模型

### 6.1 标识

每个 run 分配：

- `runId`：随机 UUID，只用于 Git ref 与异步身份校验。
- `runNumber`：session 内递增的人类可读编号，用于时间线展示与 `/checkpoint <编号>`。
- `previousLeafId`：run 开始时的 session leaf id，作为本轮消息插入前的锚点。
- `sourceEntryId`：settled 时从当前 branch 中 `previousLeafId` 之后的第一条 user message 解析；custom run 或无法可靠解析时为 `null`。关联失败不影响快照，也不靠 prompt 文本猜测匹配。不复制完整 prompt 到 Git commit 或 checkpoint entry。
- `messageType`：保留 `user` / `custom`，两类 run 都捕获。

`runNumber` 从 session 中已有 checkpoint entry 的最大编号加一；扫描 `getEntries()` 而非仅当前 branch，避免 session tree 不同分支复用编号。列表与命令查询使用 `getBranch()`，只呈现当前对话分支。ref 使用 runId，因此编号分配不决定 Git 对象的唯一性。最终 checkpoint entry 自身追加在完整 run 的对话之后，时间线顺序同时覆盖同 run 内后续排队消息。

### 6.2 Ref 与 commit graph

每个 run 只有一个 ref：

```text
refs/pi/checkpoint/<base64url(sessionId)>/<runId>
```

sessionId 经 base64url 编码，避免把 session 标识的字符直接带入 ref 语法。提交图如下：

```text
HEAD before run (若存在)
        ↑ parent
   baseline B ────── parent ────── result R
   tree = before                  tree = after
                                   ↑
                         refs/pi/checkpoint/.../<runId>
```

- baseline 的 parent 是 run 开始时的 `HEAD`；unborn HEAD 时 baseline 无 parent。
- result 总是以 baseline 为唯一 parent，即使 run 内 `HEAD` 已移动。result 捕获前重新解析 worktree root 与 common dir，二者必须与 baseline 相同；仓库被替换时记录错误，不向旧 ref 写入新仓库的快照。
- `git diff B R` 或 `git diff <ref>^1 <ref>` 是该 run 的净差异。
- `headBefore` / `headAfter` 另存于 session entry，供追溯 Git 状态，但不为了记录 headAfter 构造合成 merge commit。
- 即使 tree 没变化也创建 result commit，保持所有完成的 run 具有相同结构。
- baseline 捕获后先把 ref 指向 B，创建时要求 ref 原本不存在；result 创建后使用 expected-old=B 原子更新同一 ref 到 R，防止意外覆盖其他写入者。
- 正常 `git log`、branch 列表和当前分支历史不显示这些提交；`git log --all`、`for-each-ref`、mirror 等操作仍可能看到或复制它们。

进程在 settled 前退出时可能只留下指向 B 的 ref；不伪造 R，也不在下次启动时自动删除或补拍。

## 7. Git 捕获算法

捕获完全使用 plumbing 与临时 index：

```text
解析 worktree root、git common dir 与 HEAD
创建 common dir 下的临时目录及临时 index
GIT_INDEX_FILE=<temp> git read-tree HEAD       # 有 HEAD 时
GIT_INDEX_FILE=<temp> git add -A -- .           # 从 worktree root 执行
GIT_INDEX_FILE=<temp> git write-tree
git commit-tree <tree> [-p <parent>]
git update-ref <hidden-ref> <commit> [expected-old]
清理临时目录
```

具体要求：

- 使用 `node:child_process.spawn` 的参数数组形式，不经过 shell；Git 子进程支持自定义 env，不能依赖不含 env 选项的 `pi.exec()`。
- 每个子进程先移除继承的 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_COMMON_DIR`、`GIT_INDEX_FILE`、object directory/alternates/quarantine 等仓库选择变量，再显式设置当前捕获需要的变量。
- 临时 index 位于 `git rev-parse --path-format=absolute --git-common-dir` 下，兼容 linked worktree；真实 index 路径绝不作为写入目标。
- 从 `--show-toplevel` 返回的 worktree root 执行 `add -A -- .`，即使 Pi 从仓库子目录启动，也捕获整个当前 worktree。
- 禁用临时 index 的 fsmonitor、untracked cache 与 split index，避免读写真实 index 的辅助状态。
- `commit-tree` 使用固定的 `Pi Checkpoint` author/committer 身份，不读取或冒充用户 Git 身份，不要求用户配置 user.name/email，不触发普通 commit hooks 或 GPG 签名。
- ref 只在 commit/tree 对象完整写入后更新；任何失败都清理临时 index 与 lock 文件。
- 捕获包含 tracked 与未忽略 untracked 文件，遵循 Git ignore/exclude 规则；不读取或捕获 `.git` 内部文件。
- 不为大文件设置较低的大小上限，完整 tree 必须忠实保存。稀疏检出、assume-unchanged/skip-worktree 和嵌套未初始化仓库沿用普通 Git plumbing 的行为；无法可靠捕获时报告错误，不写伪快照。

## 8. 会话记录与查看接口

### 8.1 Custom entry

成功时在 `agent_settled` 后追加版本化 `pi-checkpoint` custom entry，至少包含：

```ts
{
  version: 1;
  status: "ok";
  runId: string;
  runNumber: number;
  previousLeafId: string | null;
  sourceEntryId: string | null;
  messageType: "user" | "custom";
  startedAt: string;
  settledAt: string;
  aborted: boolean;
  ref: string;
  baselineCommit: string;
  resultCommit: string;
  headBefore: string | null;
  headAfter: string | null;
  shortstat: string | null;
  patchPreview: string | null;
  previewTruncated: boolean;
  previewError: string | null;
}
```

`shortstat: null` 与 `patchPreview: null` 表示预览生成失败；空 shortstat/空 patch 表示已确认没有差异，`previewError` 保存清洗后的展示错误。捕获失败时追加同 `customType`、同版本但 `status: "error"` 的记录，包含 run 元数据、已获得的 baseline ref/OID 与简短错误。entry 是持久化审计数据，不进入 LLM 上下文。

### 8.2 时间线渲染

TUI entry renderer：

- 折叠：显示 `[checkpoint #N]`、shortstat；无变化显示 `No workspace changes`，中断显示 `aborted`。
- 展开：显示 baseline/result 短 OID、完整 ref 和有容量上限的 patch preview。
- patch 超过 **128 KiB** 时截断并明确标记；完整补丁始终可从 Git 对象读取。
- 错误记录显示失败阶段与简短错误，不显示 stack、env 或文件内容。
- 旧版本或数据不完整的 entry 降级为通用只读文本，不能使会话渲染崩溃。

### 8.3 命令

`/checkpoint <runNumber>` 在当前 session branch 中查找记录，通过 `ctx.ui.notify` 显示：

- run 编号、状态和完整 ref；
- baseline/result OID；
- 可直接执行的 `git diff <baselineCommit> <resultCommit>`，避免不同 shell 对 `^` 的转义差异。

无参数时显示用法；编号不存在时显示错误。预览截断提示引导用户使用该命令取得完整 diff 命令。首版没有独立 list/show overlay、restore 或 prune 命令；README 提供按完整 ref 删除检查点的 Git 命令，自动清理不在首版范围内。

## 9. 错误、模式与安全边界

- 非 Git worktree 或找不到 `git`：跳过捕获，每个 session 最多 best-effort 提醒一次；后续 run 重新探测，允许会话中初始化仓库后恢复工作。
- baseline 失败：记录错误，active run 不持有可完成快照，agent 继续运行；settled 不再捕获 result。
- result 失败：记录错误并保留已发布的 baseline ref，agent 会话不失败。
- diffstat/preview 失败：保留完整 baseline/result 与 ref，entry 标记预览不可用，不把展示故障升级为快照故障。
- `session_shutdown/new/resume/fork/reload` 清理 active 内存状态并取消该 generation 尚未完成的子进程；晚到的结果不得追加到新 session。
- TUI、RPC、print、json 的 Git 捕获与 session entry 持久化行为一致。entry renderer 仅 TUI 可见；`notify` 在其他宿主可能被丢弃，README 必须明确。
- 所有未忽略文件都会进入本地 Git object database，包括原本未跟踪的敏感文件。README 必须提醒用户先 ignore 敏感文件，并说明 hidden ref 不排除 mirror push、备份或对象库复制。
- 本包不输出 patch 到 stdout/stderr，不把密钥、完整 prompt 或环境变量写入 commit message 或错误日志。

## 10. 测试与验收

使用真实临时 Git 仓库和 mock extension 生命周期，遵循 `docs/guides/testing.md` 的 mkdtemp、环境恢复与跨平台路径规则。

### Git 核心

- baseline/result tree 与 diff 正确；无变化 run 仍有两个 commit。
- 真实 index 捕获前后字节一致，staged/unstaged 状态不变；HEAD 与当前 branch 不变；工作区文件内容与 mtime 不因捕获被重写。
- tracked、untracked、删除、mode 变化正确；ignored 文件不进入 tree。
- unborn HEAD、detached HEAD、仓库子目录与 linked worktree 可用。
- 已存在的 staged 新文件、部分暂存和真实 index lock 不被改写。
- update-ref 使用 expected-old，临时文件在成功与注入失败后都清理。
- 继承的 Git 仓库 env 不会把命令导向其他仓库。

### 生命周期与会话

- 一个 `before_agent_start` 到一个 `agent_settled` 只生成一个 run；不注册 `turn_end` 捕获。
- `previousLeafId` 在起始消息持久化前记录；user run 能在 settled 时解析正确的 `sourceEntryId`，custom/缺失锚点不误配。
- aborted 与 no-change run 都记录；custom message run 可识别。
- baseline/result/preview 各阶段失败不抛出到 agent loop，错误 entry 与降级行为正确。
- session 替换后旧 async 结果不会写入新 session；runNumber 重建考虑所有分支，命令查询只看当前 branch。
- renderer 覆盖折叠、展开、截断、aborted、error 与畸形旧数据；custom entry 不作为 LLM message 注入。

### 全仓验收

- 新包 test/typecheck/lint 通过，根全仓 test/typecheck/lint 通过。
- `check:dev-deps`、`check:host-deps`、`check:license` 通过，lockfile 同步。
- Ubuntu 与 Windows CI 路径均注册并通过。

## 11. 工程事项

- 目录 `pi-checkpoint/`：`index.ts`、`src/`、`tests/`、双语 README、`package.json`、`tsconfig.json`、`vitest.config.ts`、`.gitignore`，版本从 `0.1.0` 开始。
- peerDependencies：`@earendil-works/pi-coding-agent` 与 `@earendil-works/pi-tui` 均为 `>=1.5.0`；开发环境固定 1.5.0，标准开发依赖版本与根一致。
- 注册根 `package.json` workspaces 与 `test:windows`、根 `vitest.config.ts` projects、`.github/workflows/publish.yml` case、`.github/workflows/test.yml` paths-filter；更新 lockfile。
- README.md / README.zh.md 写明 run 语义、净差异归因边界、refs/commit graph、命令、敏感文件与保留策略，并分别包含 `## UI surface` / `## UI 能力`。
- 不注册工具，因此没有工具 prompt 三通道内容，不新增 `prompt-meta.test.ts`。
- 所有改动在 `.worktrees/pi-checkpoint` 中进行。

## 12. 留给实现者的细节

- `src/` 内 Git runner、capture、run coordinator、session schema、renderer 的具体模块划分。
- spawn 输出收集、UTF-8 截断和错误消息清洗的具体实现。
- shortstat 的获取与空 diff 文案生成方式。
- TUI 组件的具体排版与颜色，只要不改变上述信息层级。
- 测试 helper 的组织方式与 Git 可执行文件探测方式。
