# `auto-memory` 基础层拆分设计（pi-memory → 中立 core + pi 适配层）

日期：2026-11-08
状态：**已批准**（2026-11-08）
范围：新包 `@yandy0725/auto-memory`（先作为本 monorepo 的第 11 个 workspace 开发，再搬到独立 repo）；`pi-memory`（2.5.2 → 3.0.0）
不在范围：任何 dsh 插件代码、opencode 适配、发布动作

---

## 1. 背景与问题

`pi-memory` 现在把三件性质完全不同的事写在一个包里：

1. **磁盘上的记忆库**——一条 memory 一个 Markdown 文件、`MEMORY.md` 单行索引、两级锁、快照回滚、按 git remote 归一化的项目目录、Windows 安全命名。这部分不含任何 LLM 调用，也不含任何 UI。
2. **围绕记忆库的 LLM 编排**——`/dream` 的整轮合并、每轮 `extract` 的对话渲染与提取、auto-surfacing 的侧查询选择。这部分难写对的地方在于它与 (1) 的锁/快照边界的配合，而不是模型调用本身。
3. **pi 的装配与宿主补丁**——extension 事件、`/memory` `/dream` 命令、typebox schema 与 pi-tui 渲染、`createAgentSession` 跑 headless、以及为 pi 的 prompt cache 服务的 system prompt section 冻结与 transcript 重放。

只有 (3) 是 pi 专属的。因为三者同包，第二个 harness（`@deepseek-ai/dsh`，cordis 插件体系）要用同一套记忆，只能整体重写 (1) 与 (2)——而这两部分恰好是 pi-memory 里最难复现正确行为的部分。

目标：把 (1) 与 (2) 抽成一个**不依赖任何 harness 的独立 npm 包**，pi-memory 变成它的第一个适配层，从而让 dsh（及以后的 harness）能共享**同一份磁盘数据**与**同一套编排逻辑**。

---

## 2. 已确认决策

| 编号 | 决策 | 理由 |
|---|---|---|
| **D1** | 分层边界取 **B**：core = 存储层 + LLM 编排（prompt 文本、dream/extract/surfacing 的流程）+ 中立工具契约；**注入时机与 session 内状态留在适配层** | A（只搬存储层）会让 dream/extract 在两个 harness 各写一遍，而它们的难点是与锁/快照边界的配合，重写必然退化。C（连注入状态机进 core）会把 pi 的「索引按 session 冻结以保 prompt cache」与 dsh 的「section provider 每次 assembly 重新求值」这两种互斥语义塞进同一状态机，在 core 里长出 harness 分支 |
| **D2** | 交付边界 = **core 包 + pi 适配层跑通现有全部测试**。dsh 只作为端口设计的对照（按它的真实 API 设计端口），**本轮不写 dsh 插件** | 抽象需要对齐真实宿主能力才不会跑偏；但 dsh 插件是独立工作量，且其 cordis 装配、schemastery 转换、profile 打包都需要单独验证 |
| **D3** | 共享数据根 = **`$XDG_DATA_HOME/auto-memory`**（未设置时 `~/.local/share/auto-memory`），其下沿用现有 `<git\|local>/<project>/` 结构 | 数据必须住在中立位置，否则「跨 harness 共享」无从谈起；与包名 `auto-memory` 同名，一眼对得上 |
| **D4** | **不自动迁移**旧数据。core 对 `~/.pi/memory` **一无所知**；旧目录存在的提示逻辑只写在 pi 适配层 | 自动 mv 要处理两个 harness 同时启动、中途失败、`.lock`/`.backups` 被搬走等情况；提示逻辑属于宿主的升级路径，不属于中立基础层 |
| **D5** | npm 包名 `@yandy0725/auto-memory`，最终形态是独立 repo `auto-memory`、**单包**（不开 workspaces） | core 必须发 npm：pi-memory 要依赖它，而 dsh 的 out-of-tree 插件解析不到宿主包、只能把它当自己的真依赖。pi 适配层留在本 monorepo 继续叫 `@yandy0725/pi-memory`；未来的 dsh 插件进已有的 `dsh-plugins` repo，所以 core repo 没有第二个包 |
| **D6** | **两阶段交付**：阶段 1 在本 monorepo 里以第 11 个 workspace `auto-memory/` 开发，pi-memory 用 workspace 依赖，全部测试与真机验证在一个 PR 里跑通；阶段 2 再把它搬到独立 repo、发布、把 pi-memory 的依赖翻成 npm 版本 | 先发 core 就意味着在 pi 适配层还没实测之前把 core 的公开 API 对外定格，之后要改就是 breaking；先在 monorepo 内跑通，发布时 API 已经被两个真实调用方（pi 适配层 + §9.5 的中立脚本）压过 |
| **D7** | 阶段 1 里 core **以 TS 源码为入口**（`main`/`exports` → `./src/index.ts`），**不带 build 步骤**；`dist/`（ESM + `.d.ts`）在阶段 2 搬出时加入并翻转 `exports` | monorepo 内所有消费方都原生吃 TS（pi 的扩展加载器、vitest、`tsc --noEmit`），加 build 只会引入「测试前必须先 build」的顺序依赖。`dist/` 是**发布**要求（dsh 插件跑在用户自己的 Node 上，`dsh-plugins` 声明 `engines.node >=20.16.0`，不能假设类型剥离），正好在需要它的那一步加 |
| **D8** | `pi-memory` 版本 **3.0.0**；core 首发 **1.0.0**（不发 rc） | D3 移动了数据根，对现有用户是破坏性变更。core 是新 lineage，且按 D6 发布时已被实测，磁盘格式与工具语义都是从 2.x 继承的稳定行为 |
| **D9** | 两个阶段各自**到 PR 为止**；`npm publish` 与 GitHub Release 都不在本设计范围内，单独决策 | npm publish 基本不可逆 |

**明确排除（非目标）**：dsh 插件实现、opencode 适配、把记忆库改成 SQLite/向量检索、改动 memory 的磁盘格式（frontmatter 字段、索引行格式、`.backups` 布局全部逐字不变）、改动 `memory` 工具的语义与 action 集合、把 `index-source.ts` 的 section 冻结机制推广到 core、任何自动数据迁移代码。

### 2.1 阶段划分

| | 阶段 1（本轮） | 阶段 2（本轮之后） |
|---|---|---|
| core 住在哪 | `pi-packages/auto-memory/`，根 `workspaces` 第 11 项 | 独立 repo `github.com/yandy/auto-memory` |
| core 入口 | `./src/index.ts`，无 build | `./dist/index.js` + `.d.ts`，`tsc` 构建 |
| pi-memory 怎么依赖 | `dependencies: {"@yandy0725/auto-memory": "^1.0.0"}`，npm workspaces 本地 link（版本满足即不外求 registry） | 同一个 range，解析到 registry 上已发布的 1.0.0 |
| 交付物 | 一个 PR：新增 workspace + pi-memory 3.0.0 改造 + 测试拆分 + §9 全部验证 | 建 repo → 发布 core 1.0.0 → 删掉 monorepo 里的 `auto-memory/` 并翻依赖 → 发布 pi-memory 3.0.0 |
| 破坏性 | 对 monorepo 有（根 `package.json`、CI filter），对用户无 | 对用户有（D3 的数据根迁移） |

阶段 1 结束时，`auto-memory/` 必须已经满足「独立 repo 的全部要求」——零 harness 依赖、自带 `README.md`/`README.zh.md`/`LICENSE`/`biome.json`/`tsconfig.json`/`vitest.config.ts`、测试自足——搬出去只是 `mv` 加一次 `git init`，不需要重构。

---

## 3. 前置事实（勘察结论）

### 3.1 pi-memory 现状（2.5.2）

`src/` 3603 行 + `index.ts` 646 行 + `tests/` 8819 行（31 个测试文件）。

| 分组 | 文件 | 行数 |
|---|---|---|
| 存储层 | `memory-store`(521) `entry-file`(81) `entry-index`(112) `filename`(54) `fs-lock`(286) `fs-retry`(51) `process-lock`(122) `snapshot`(91) `sanitize`(36) `windows-names`(39) `paths`(245) | **1638** |
| LLM 编排 | `dream`(132) `extract`(422) `inject`(344) | **898** |
| 工具 | `memory-tool`(319) | **319** |
| pi 专属 | `agent-runner`(153) `agent-config`(2) `model-resolver`(69) `index-source`(186) `nudge`(48) `session-search`(65) | **523** |
| 配置 | `config`(225) | 225 |

**存储层 11 个文件的全部外部 import 只有 1 处**：`memory-store.ts:3` 的 `withFileMutationQueue`（来自 `@earendil-works/pi-coding-agent`，一个按路径串行的进程内队列）。其余只有 `node:*` 与本组内部互相 import。也就是说这 1638 行**现在就已经是中立的**，断开成本 ≈ 自己实现一个 20 行的按 key 串行队列。

存储层的公开面（`MemoryStore`）：

- 读：`listEntries()` `readEntry(ref)` `readIndex()` `searchEntries(query)`
- 写：`addEntry` `replaceEntry` `removeEntry` `renameEntry` `rebuildIndex`
- 并发：`withLogicalLock` `tryWithLogicalLock` `logicalLockActive`
- 配置：`StoreConfig { memoryDir, indexMaxLines, indexMaxBytes, lock: { timeoutMs, snapshotKeep }, platform? }`

### 3.2 dsh 的真实能力（`@deepseek-ai/dsh` 0.2.0-rc.2，读本机 npx 缓存内 277 个包的 `.d.ts`）

| pi-memory 需要 | pi 现在的机制 | dsh 的对应物（实证） |
|---|---|---|
| `memory_index` 进 system prompt | `event.systemPromptOptions.sections["memory_index"]` + transcript 重放冻结 | `ctx.systemPrompt.section({ name, order, text })`，`text` 可为 `(ctx) => string` |
| 每轮注入 `<relevant_memories>` | `before_agent_start` 改写 systemPrompt / 注入 message | `ctx.systemPrompt.context({ name, order, text })`——`.d.ts` 原文「dynamic model context materialized as a **durable user-role snapshot**」 |
| `memory` 工具 | `pi.registerTool` + typebox + pi-tui 渲染 | `ctx.tools.register(defineTool({ name, description, parameters, output, execute }))`，参数用 `@deepseek-ai/schemastery` DSL（**既不是 zod 也不是 typebox**）；模型侧线格式 `dsh-llm` 的 `ToolSchema.parameters` 是纯 JSON Schema |
| dream / extract / 侧查询跑 headless | `createAgentSession`（`agent-runner.ts`） | `ctx.subagents.start(name, request)` / `.prompt(request, signal)`；或裸 `ctx.llm.stream(options: GenerateOptions)`，其 `tools?: ToolSchema[]` + `system?: string` 明确支持一次性调用 |
| `search scope=sessions` | `SessionManager.list` + `truncateHead` | `dsh-session-query`（sqlite）、`dsh-session-persistence-jsonl`；`turn/*`、`user/message` 等是 `SessionEventMap`（会话日志事件），**不是** cordis Events，须经 `session/event` 或 `ctx.sessionQuery` |
| 存储根 | `~/.pi/memory/...`（来自 `CONFIG_DIR_NAME`） | `ctx.storage`（`dsh-storage`）/ `$DSH_HOME` |
| 通知 | `ctx.ui.notify(msg, level)` | `ctx.logger.info` / client-ui |

插件形态是 cordis：`export const name` / `export const inject = [...]` / `export async function apply(ctx, config)`，经 profile 的 `package.json → dsh.profile.bundles` + `cordis.patch.yml` 行配置装配，`dsh plugin --profile <p> add '<spec>'` 安装。

**两条对 core 设计有约束力的事实**：

- **out-of-tree 插件静态 import 解析不到宿主包**（装在 profile 目录），顶层只能 `import 'node:…'`，宿主包要用 `createRequire` 从 `process.argv[1]` 向上找 `node_modules`；也因此不能导出 schemastery `Config`。→ core 必须是插件自己的真依赖，且**顶层不得 import 任何宿主包**（D6 的另一半理由）。
- **`index-source.ts` 那 186 行纯粹是 pi 的 prompt-cache 补丁**：dsh 的 section provider 每次 assembly 重新求值，不存在「按 session 冻结 + resume/fork 重放录制值」这个概念。它一行都不能进 core。

### 3.3 本机数据

`~/.pi/memory/` 下 52 个 `.md` 文件，且 `~/.pi/memory/git/` 内有一个 `.git`（记忆已纳入版本控制）。迁移方式必须对「整个目录是一个 git 仓库」这种情况友好——`mv` 整个根即可，D4 的一行提示正好覆盖。

---

## 4. 分层与职责边界

```
┌─────────────────────────────────────────────────────────────┐
│ 适配层（每个 harness 一个）                                     │
│  pi-memory 3.0            │  dsh-auto-memory（本轮不做）        │
│  ─ extension 事件装配      │  ─ cordis apply(ctx, config)      │
│  ─ /memory /dream 命令     │  ─ cordis.patch.yml 行配置         │
│  ─ typebox schema + 渲染   │  ─ schemastery DSL + output.render │
│  ─ section 冻结/重放        │  ─ systemPrompt.section/context   │
│  ─ createAgentSession      │  ─ ctx.subagents / ctx.llm        │
│  ─ SessionManager 搜索     │  ─ ctx.sessionQuery               │
│  ─ 旧目录提示（D4）         │                                   │
└───────────────┬─────────────────────────┬───────────────────┘
                │  实现 2 个端口            │
┌───────────────▼─────────────────────────▼───────────────────┐
│ core：@yandy0725/auto-memory（零 harness 依赖）                │
│  ① 存储层 1638 行：格式 / MemoryStore / 两级锁 / 快照 / 路径    │
│  ② LLM 编排：dream · extract · surfacing 的流程 + prompt 文本  │
│  ③ 注入纯策略：截断 / capacity / 格式化 / scanEntries          │
│  ④ 工具中立契约：JSON Schema + 文案 + action→store 的 handler   │
│  ⑤ 配置：DEFAULT_CONFIG / deepMerge / expandTilde / XDG 根     │
└─────────────────────────────────────────────────────────────┘
```

**判据**：一个东西进 core，当且仅当它在 pi 与 dsh 上的**语义相同**。语义不同的（注入时机、prompt cache 优化、命令、UI 渲染、模型解析）一律留适配层。

### 4.1 端口（只有两个）

比最初设想少两个：`PromptInjectionPort` 与 `NotifyPort` 都不需要——注入的**机制**与**通知**本来就留在适配层，适配层直接调 core 的纯函数即可；core 的编排只返回数据（选中的文件名、dream 摘要文本、`{skipped, result}`），由适配层决定怎么呈现。

```ts
/** 跑一轮受限工具的 headless 会话，返回 assistant 文本；null = 本轮未执行（宿主拒绝/超时）。 */
export interface HeadlessRunRequest {
  /** prompt 全文，由 core 的 prompts.ts 生成 */
  task: string;
  /** 子会话 cwd；dream/extract/surfacing 一律传 memoryDir */
  cwd: string;
  /** 宿主自己的模型标识。core 不解释、不校验（校验在适配层启动时做） */
  model: string;
  /** 宿主的思考/推理档位。core 不解释，原样透传 */
  effort?: string;
  maxTurns?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 子会话可用的 builtin 工具：'none' = 零工具（侧查询）；'file-io' = 读写类 */
  builtinTools: "none" | "file-io";
  /**
   * 需要给子会话注入的 `memory` 工具；null = 不注入。
   * 适配层据此用 core 的 createMemoryActionHandler + 自己的 schema/渲染包装出真实工具对象。
   */
  memoryTool: {
    actions: readonly MemoryAction[];
    skipLogicalLock?: boolean;
    skipSnapshot?: boolean;
    onWrite?: (info: { action: MemoryAction; name?: string }) => void;
  } | null;
  /** 宿主自己的持久化开关，core 原样透传 */
  sessionPersistence?: { enabled: boolean; sessionDir?: string };
}

export interface HeadlessAgentPort {
  run(req: HeadlessRunRequest): Promise<string | null>;
}

/** 宿主的会话历史：既供 `search scope=sessions`，也供 extract 的对话渲染。 */
export interface HostTranscriptPort {
  /** 搜历史会话，返回已格式化好的文本（宿主决定格式与截断） */
  searchSessions(cwd: string, query: string, cfg: { maxSessions: number; maxMatches: number }): Promise<string>;
  /** 把宿主的原始消息序列转成中立的 ExtractMessage；形状不认识的消息按「尽量保留文本」处理 */
  toExtractMessages(raw: unknown[]): ExtractMessage[];
}
```

`ExtractMessage` 是 core 定义的中立形状（现有 `extract.ts:13` 的定义原样搬过去）：

```ts
export interface ExtractMessage {
  role: "user" | "assistant" | "toolResult";
  text?: string;
  toolCalls?: Array<{ name: string; args: string }>;
  toolName?: string;
  isError?: boolean;
}
```

**为什么 `model` 与 `effort` 是 opaque string**：pi 的 `ThinkLevel` 是 6 值枚举，dsh 是 `ReasoningEffortId`；pi 的模型 id 要经 `ModelRegistry` 解析，dsh 是 `provider` + `model` 两段。core 一旦解释它们就必须认识两个宿主的类型。把它们当不透明字符串透传后，`model-resolver.ts` 与 `ModelRegistry` 彻底留在 pi 适配层，core 的启动校验（`modelConfigErrors`）继续用**注入的** `resolve: (value: string) => boolean`（现有签名已经如此，无需改）。

---

## 5. core 的模块布局与公开 API

```
auto-memory/
├── package.json                @yandy0725/auto-memory · type:module · 阶段1 入口 src/index.ts · 无任何 harness 依赖
├── tsconfig.json               阶段1 只做 --noEmit 类型检查；阶段2 加 tsconfig.build.json 编译到 dist/
├── biome.json  vitest.config.ts
├── README.md / README.zh.md
├── LICENSE                     MIT
├── src/
│   ├── index.ts                公开 API 汇总（唯一入口）
│   ├── store/
│   │   ├── memory-store.ts     ← 原样搬，只改 withFileMutationQueue → ./mutation-queue
│   │   ├── mutation-queue.ts   ← 新：按 key 串行的进程内队列（替换 pi 的实现）
│   │   ├── entry-file.ts  entry-index.ts  filename.ts
│   │   ├── fs-lock.ts  fs-retry.ts  process-lock.ts  snapshot.ts
│   │   └── sanitize.ts  windows-names.ts  paths.ts
│   ├── orchestration/
│   │   ├── ports.ts            HeadlessAgentPort / HostTranscriptPort / ExtractMessage
│   │   ├── prompts.ts          buildDreamTask / buildExtractTask / buildSideQueryTask 的 prompt 文本
│   │   ├── dream.ts            runDream（withLogicalLock + 入口整目录快照 + 端口调用）
│   │   ├── extract.ts          renderConversation / runExtract（tryWithLogicalLock + 端口调用）
│   │   └── surfacing.ts        scanEntries / runSideQuery / parseSelectedFiles
│   ├── tool/
│   │   ├── actions.ts          MemoryAction / MAIN_AGENT_ACTIONS / DREAM_ACTIONS / WRITE_ACTIONS
│   │   ├── schema.ts           memoryToolSchema(actions) → 纯 JSON Schema
│   │   ├── texts.ts            description / snippet / guidelines 文案常量
│   │   └── handler.ts          createMemoryActionHandler(deps, options) → (params) => {text, details}
│   ├── injection.ts            truncateForInjection / truncateIndexForInjection / indexInjectionCapacity
│   │                           / buildIndexSection / ENTRY_TRUNCATION_MARKER / INDEX_TRUNCATION_MARKER
│   │                           / SIDE_QUERY_* 常量
│   └── config.ts               MemoryConfig / DEFAULT_CONFIG / deepMerge / expandTilde
│                               / defaultMemoryRoot() / loadConfigFrom(files, opts) / taskModel
│                               / requiredModels / modelConfigErrors / requiredModel
└── tests/                      现有存储层 + 编排测试搬过来（编排测试改用假端口）
```

### 5.1 `mutation-queue.ts`（新，唯一需要新写的存储层代码）

替换 `withFileMutationQueue(path, fn)`。语义要求：同一 key 的调用**串行**、不同 key 并行、异常不打断队列、不持有对已完成 promise 的引用（避免泄漏）。实现 ≈ 20 行（`Map<string, Promise<unknown>>` + tail chain + 空则 delete）。

**等价性断言（不可协商）**：`MemoryStore` 的现有测试（`memory-store-{read,write,retry,index}.test.ts`）全部原样通过，只允许改 import 路径。

### 5.2 `defaultMemoryRoot()`

```ts
export function defaultMemoryRoot(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const xdg = env.XDG_DATA_HOME?.trim();
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "share");
  return join(base, "auto-memory");
}
```

**我的决定（minor）**：所有平台走同一条 XDG 规则，不为 darwin/win32 加分支。理由：单一代码路径与单一测试矩阵；`XDG_DATA_HOME` 相对路径按规范忽略；Windows 用户得到 `C:\Users\<u>\.local\share\auto-memory`，功能正确，且 `memoryDir` 配置项始终可以覆盖。`env` 与 `home` 做成参数以便单测（沿用 `paths.ts` 的注入缝风格）。

### 5.3 `loadConfigFrom()`

core 不认识任何宿主的配置文件路径：

```ts
export async function loadConfigFrom(files: string[], opts?: { platform?: NodeJS.Platform }): Promise<MemoryConfig>;
```

按顺序 `deepMerge` 到 `DEFAULT_CONFIG` 上，最后 `expandTilde(memoryDir)`。跳过不存在与 JSON 损坏的文件（沿用现有 `readJsonSafe` 行为）。适配层负责决定 `files`：

- pi：`[<agentDir>/memory.json]`，项目受信任时追加 `[<cwd>/.pi/memory.json]`（现有 `config.ts:211-219` 的逻辑原样搬到适配层）
- dsh：profile 的 cordis 行 `config` 落成临时对象，或直接 `[]` + 用行配置覆盖

`DEFAULT_CONFIG.memoryDir` 改为 `defaultMemoryRoot()`。其余默认值（`memIndexMaxLines: 200`、`memIndexMaxBytes: 25600`、`memIndexInjectMaxLines: 50`、`memIndexInjectMaxBytes: 16384`、`lock: { timeoutMs: 5000, snapshotKeep: 5 }`、`dream.nudgeAfterSessions: 5` / `nudgeAfterHours: 24`、`sessionSearch`、`autoSurfacing`、`extractMemories`）**逐字不变**。

### 5.4 工具契约

`tool/schema.ts` 输出**纯 JSON Schema**（`{ type:"object", properties:{...}, required:[...] }`），由 `actions` 动态构建——不在集合里的 action 不出现在 `enum` 里，`new_name` 只在含 `rename` 时存在（这是现有 D12 注册范围约束的执行点，必须原样保留）。

`tool/texts.ts` 持有现有 `memory-tool.ts` 的三段文案（`description`、`promptSnippet`、7 条 `promptGuidelines`）为纯字符串常量。适配层自行决定落到哪：pi 有 `promptSnippet`/`promptGuidelines` 两个专属通道；dsh 没有对应通道，可把它们并进 `ctx.systemPrompt.section()` 或只保留 `description`（本轮不决策）。

`tool/handler.ts` 持有现有 `execute()` 的整个 `switch`（7 个分支 + `WRITE_ACTIONS` 回调 + capacity 警告文案），签名：

```ts
export interface MemoryHandlerDeps {
  getStore(): MemoryStore | null;
  getConfig(): { memIndexMaxLines: number; memIndexMaxBytes: number; sessionSearch: {...} };
  getUnavailableMessage(): string | null;
  searchSessions(cwd: string, query: string, cfg: {...}): Promise<string>;
  cwd(): string;
}
export function createMemoryActionHandler(
  deps: MemoryHandlerDeps,
  options?: { actions?: readonly MemoryAction[]; skipLogicalLock?: boolean; skipSnapshot?: boolean;
              onWrite?: (info: { action: MemoryAction; name?: string }) => void },
): (params: unknown) => Promise<{ text: string; details: Record<string, unknown> }>;
```

**留适配层的**：`ctx.ui.notify("Saved: …")`（pi 专属通道，且现有实现要包 try/catch 防宿主 dispose 后抛错）、`renderCall` / `renderResult`（pi-tui `Text`）、typebox `StringEnum` 包装、dsh 的 `output.render`。

**JSON Schema → 宿主 schema 的桥**：
- pi：`Type.Unsafe<T>(jsonSchema)` 得到合法 `TSchema`，`action` 的 enum 仍需 `StringEnum(actions)` 以获得 pi-ai 的枚举渲染——适配层用 `schema.properties.action` 的 `enum` 数组重建即可。
- dsh：schemastery DSL 与 JSON Schema 不同源。schema 只有 8 个属性、形状稳定，dsh 适配层手写 DSL 即可；core **不**提供 JSON Schema→schemastery 转换器（那会把宿主的 schema 库变成 core 的依赖）。

---

## 6. 数据落点与迁移

| | 现在（2.5.2） | 3.0.0 |
|---|---|---|
| 数据根 | `~/.pi/memory/` | `$XDG_DATA_HOME/auto-memory`（默认 `~/.local/share/auto-memory`） |
| 项目子路径 | `<git\|local>/<projectDirName>/` | **不变** |
| 目录内布局 | `MEMORY.md` · `*.md` · `.lock` · `.backups/` · `.dream-meta.json` · `sessions/` | **不变** |
| 全局配置 | `~/.pi/agent/memory.json` | 不变（pi 适配层拥有），但 `memoryDir` 默认值改了 |
| 项目配置 | `<cwd>/.pi/memory.json` | 不变 |

**迁移动作 = 用户手动一行**（README「Migrating from 2.x」一节）：

```sh
mkdir -p "${XDG_DATA_HOME:-$HOME/.local/share}" && mv ~/.pi/memory "${XDG_DATA_HOME:-$HOME/.local/share}/auto-memory"
```

pi 适配层的提示（**不在 core**，D4）：`session_start` 之后，若解析出的记忆目录不存在**且** `~/.pi/memory/<kind>/<projectDirName>` 存在，则 `/memory` 的输出末尾追加一行：

```
Note: found pre-3.0 memories at ~/.pi/memory/<kind>/<project>. Move them with:
  mkdir -p ~/.local/share && mv ~/.pi/memory ~/.local/share/auto-memory
```

只提示、不读写、不搬动。判定用现有的 `projectIdentity` + `projectDirName`，不新增路径逻辑。

`.dream-meta.json`（nudge 计数）随目录一起搬，nudge 状态自然延续；不搬则重新计数，可接受。

---

## 7. pi 适配层改造清单（逐文件）

| 文件 | 动作 |
|---|---|
| `index.ts`(646) | **保留**。import 改指 `@yandy0725/auto-memory`；新增旧目录提示（§6）；`loadConfig` 调用改为组装文件列表后调 core 的 `loadConfigFrom` |
| `src/agent-runner.ts`(153) | **保留**，改为实现 `HeadlessAgentPort`：把 `HeadlessRunRequest` 翻译成 `createAgentSession` 参数（`builtinTools:'none'` → `tools: []`；`'file-io'` → `FILE_IO_TOOLS`；`memoryTool` → 用 core 的 handler + pi schema 建 `ToolDefinition`，并按 `builtinTools` 决定 `noTools: "builtin"`）。**现有那条警告必须继续成立**：`tools: []` 是白名单会连 customTools 一起滤掉，所以「关 builtin、留 memory 工具」只能走 `noTools: "builtin"` |
| `src/agent-config.ts`(2) | **保留**（`FILE_IO_TOOLS` 是 pi 的 builtin 工具名） |
| `src/model-resolver.ts`(69) | **保留**（`ModelRegistry` 解析是 pi 专属） |
| `src/index-source.ts`(186) | **保留**（§3.2：pi 的 prompt-cache 补丁） |
| `src/nudge.ts`(48) | **保留**（`SessionManager.list` 数会话数是 pi 专属）；`.dream-meta.json` 的读写是纯 fs，可留可搬——**我的决定：留在适配层**，因为「数 session」这件事本身就不中立，拆开反而两半都残 |
| `src/session-search.ts`(65) | **保留**，成为 `HostTranscriptPort.searchSessions` 的 pi 实现 |
| `src/config.ts`(225) | **瘦身**：只留 pi 的配置文件路径组装 + `LoadConfigContext`（`getAgentDir` / `CONFIG_DIR_NAME` / `isProjectTrusted`），类型与默认值全部改为从 core 重导出 |
| `src/memory-tool.ts`(319) | **重写为薄包装**：core 的 schema+texts+handler → pi `ToolDefinition`（typebox、`renderCall`/`renderResult`、`ctx.ui.notify`）。预计 <120 行 |
| `src/inject.ts`(344) | **拆分**：纯策略（`truncateForInjection` `truncateIndexForInjection` `indexInjectionCapacity` `buildIndexSection` `scanEntries` `buildSideQueryTask` `parseSelectedFiles` 与三个常量）→ core；机制（`buildInjection` 拼 pi 的 systemPrompt、`applyIndexSection` 写 `systemPromptOptions.sections`、`injectSurfacedContent` 注入 message）→ 留适配层，改名 `src/inject-pi.ts`。`runSideQuery` 的编排在 core（`surfacing.ts`），但**返回 `string[]` 文件名**，注入由适配层做 |
| `src/dream.ts`(132) | **搬走**，pi 侧不再有对应文件；`customTools` 参数消失，改由端口请求里的 `memoryTool.actions` 表达 |
| `src/extract.ts`(422) | **拆分**：`renderConversation` `buildExtractTask` `runExtract` `ExtractMessage` `ConversationLimits` → core；`toExtractMessages`（认 pi 的 `AgentMessage` 形状）→ 适配层，成为 `HostTranscriptPort.toExtractMessages` 的 pi 实现 |
| 存储层 11 文件 | **删除**（搬到 core） |
| `tests/`(8819) | 按同一边界拆分。存储层与编排测试搬到 `auto-memory/`（编排测试把 `runHeadlessAgent` 的 stub 换成假端口）；pi 专属测试留在 `pi-memory/`。**拆分后两个包的测试文件数之和不得少于 31 个**，且不允许删用例 |

---

## 8. 依赖方向、monorepo 集成点与构建

### 8.1 依赖方向

```
@yandy0725/pi-memory@3.0.0
  dependencies:        @yandy0725/auto-memory ^1.0.0     ← 新增（阶段1 = workspace link，阶段2 = registry）
  peerDependencies:    @earendil-works/pi-coding-agent, pi-ai, pi-tui, typebox   ← 不变

@yandy0725/auto-memory@1.0.0
  dependencies:        （空）
  peerDependencies:    （空）
  devDependencies:     @biomejs/biome, typescript, @types/node, vitest（版本串与根逐字一致）
```

`@yandy0725/auto-memory` **不属于** `check-host-deps.mjs` 的 `HOST_PROVIDED_PACKAGES`，所以把它放在 pi-memory 的 `dependencies`（而不是 `peerDependencies`）是合规的，也正是应该的：它不是宿主提供的运行时，而是本包自己带的库。

### 8.2 阶段 1 的 package.json（core）

```jsonc
{
  "name": "@yandy0725/auto-memory",
  "version": "1.0.0",
  "private": true,                    // 阶段1 不发布；阶段2 搬出时删掉这一行并改 publishConfig
  "description": "Harness-agnostic file-system memory layer: one memory = one Markdown file, a MEMORY.md index, two-level locking, snapshots, and the LLM orchestration around them.",
  "license": "MIT",
  "type": "module",
  "main": "./src/index.ts",           // 阶段2 → ./dist/index.js + types + exports + files
  "keywords": ["agent-memory", "memory", "harness-agnostic"],
  "scripts": {
    "test": "vitest run", "test:watch": "vitest",
    "typecheck": "tsc --noEmit", "lint": "biome lint .", "format": "biome format --write ."
  },
  "devDependencies": { /* 与根逐字一致的 4 项 */ }
}
```

**对 `docs/guides/pi-package-spec.md` 的两处刻意偏离**（阶段 1 有效，搬出后自然消失）：

1. 目录名不是 `pi-<name>`，`keywords` 里**没有** `"pi-package"`。core 不是 pi package——它不认识任何 harness，把它标成 pi package 是错的。
2. `package.json` 里**没有** `pi` 字段，所以 `check-dev-deps.mjs` 会把它归为 `unclassified` 并**跳过**（只打印提示，不算失败，见该脚本的「其他 workspace 跳过」分支）。共享的 4 个 devDependencies 仍按根版本声明，保持一致。

阶段 2 搬出时补：`publishConfig: {"access": "public"}`、`repository`、`build` 脚本、`exports`/`files` 指向 `dist/`（`src/` 一并发布，便于 source map 对齐与调试）。

### 8.3 monorepo 集成点（穷举）

| 位置 | 改动 |
|---|---|
| 根 `package.json` → `workspaces` | 追加 `"auto-memory"`（按字母序放最前） |
| 根 `package.json` → `scripts.test:windows` | 追加 `-w auto-memory`：`fs-retry.win32` / `windows-names` / `paths` 的 win32 分支必须在 windows runner 上真跑，否则阶段 2 搬出去才暴露 |
| `.github/workflows/test.yml` → `dorny/paths-filter` 的 `filters` | 追加 `auto-memory: - "auto-memory/**"`，否则改动 core 不会触发 `test-packages` |
| `.github/workflows/test.yml` → `test-packages.exclude` | **不加**排除项：core 是平台中立的，ubuntu 与 windows 都跑 |
| `package-lock.json` | 新增 workspace 必然改动它 → `lockfile-sync` job 要求提交后的 lockfile 与 `npm install --package-lock-only` 结果零 diff |
| `scripts/check-host-deps.mjs` | 无需改。core 不 import 任何宿主包；pi-memory 新增的 `dependencies` 项不在 `HOST_PROVIDED_PACKAGES` 里 |
| `scripts/check-dev-deps.mjs` | 无需改（见 8.2 的 `unclassified` 分支） |
| `docs/guides/pi-package-spec.md` | 本轮**不改**。core 是临时住户，为它改规范会在阶段 2 再改回来；偏离项记在本文件 8.2 |
| `.gitignore` / `tsconfig.base.json` / `biome.json` / `vitest.config.ts` | core 沿用根的 `tsconfig.base.json` 与 `biome.json`（阶段 1）；搬出时自带一份 |

**CI 影响**：动到根 `package.json` 与 `package-lock.json` → `has_root == true` → 走 `test-full`（全 workspace，ubuntu + windows），`test-packages` 被跳过。已知后果：pi-memory 有两个时序敏感用例（`index-wiring.test.ts` 的 notify 断言、`fs-retry.win32.test.ts` 的 Windows EBUSY）会随机红，`gh run rerun <run> --failed` 重跑即绿；ubuntu 若报 `The strategy configuration was canceled because "test-full.windows-latest" failed`，说明 ubuntu 并未真失败。

---

## 9. 验证计划

1. **core（阶段 1，workspace 内）**：`npm test -w auto-memory`、`npm run typecheck -w auto-memory`、`npm run lint -w auto-memory` 全绿；中立性断言 `grep -rn "@earendil-works\|typebox\|pi-tui\|schemastery" auto-memory/src/` **零命中**（阶段 2 搬出后这条进 core 自己的 CI）。
2. **core 中立性的机器验证**：`npm pack -w @yandy0725/auto-memory` 得到 tarball，在一个**没有安装任何 harness 包**的干净临时目录里装它并 `node -e "import('@yandy0725/auto-memory').then(m => console.log(Object.keys(m).length))"` 成功。阶段 1 的 tarball 装的是 `src/*.ts`（无 `dist/`），所以这一步只能验证「依赖声明中立」（package.json 里没有 harness 包）；**真正的可 import 验证必须在阶段 2 加上 build 后重跑一次**，它是阶段 2 的发布前门槛。
3. **pi-memory**：`npm test -w pi-memory` 全绿，测试文件数不少于拆分前该留的数量；`npm run typecheck -w pi-memory`。
4. **行为等价（不可协商）**：在一个真实 repo 里，用 3.0.0 跑一遍 `/memory`、写一条 memory、`/dream`、`memory search scope=sessions`，与 2.5.2 的输出逐项对照。索引行格式、frontmatter 字段、`.backups/<ts>-<label>/` 命名必须逐字节一致。
5. **共享性验证（本轮的验收核心）**：写一个 **不 import 任何 harness 包**的 30 行脚本，直接 `import { MemoryStore, resolveMemoryDir } from "@yandy0725/auto-memory"`，对同一个 repo 解析出与 pi-memory 3.0.0 **完全相同**的目录，读到 pi 刚写的那条 memory。这就是「dsh 侧能共享」的最小可执行证明——不需要真的写 dsh 插件。
6. **旧目录提示**：造一个只有 `~/.pi/memory/<kind>/<proj>` 的环境，确认 `/memory` 打出提示且**没有**任何文件被创建/移动/修改（`find -newer` 断言）。
7. **迁移一行命令**：在临时 HOME 上执行 §6 的 `mv`，确认 pi 3.0.0 随后能读到全部 52 条。
8. **阶段 2 额外验收**（本轮不执行，列出以免遗忘）：搬出后的 repo 里 `npm run build && npm test` 全绿；§9.2 的可 import 验证通过；`npm pack` 的 tarball 里确实包含 `dist/`；pi-memory 删掉 workspace link、改吃 registry 1.0.0 后 `npm ci && npm test -w pi-memory` 仍全绿；§9.5 的中立脚本在只装了发布版 core 的目录里仍能读到 pi 刚写的 memory。

---

## 10. 风险与回滚

| 风险 | 处理 |
|---|---|
| 用户升级后「记忆全丢了」（实际是没迁移） | D4 的提示 + README 迁移一节 + 3.0.0 的 release note。**不**自动搬数据：静默搬动用户数据比提示更危险 |
| `mutation-queue` 自实现与 pi 的 `withFileMutationQueue` 语义有细微差异（错误传播、并发顺序） | §5.1 的等价性断言：现有 4 个 memory-store 测试文件原样通过；另加针对「同 key 串行 / 异 key 并行 / 抛错不断链」的专项用例 |
| 端口设计对 dsh 不够用（本轮不写 dsh 插件，无实测） | §3.2 的对照表已按 dsh 真实 `.d.ts` 逐项落点；`HeadlessRunRequest` 的字段全部是 dsh `GenerateOptions` / `subagents.start` 能表达的量（`model`/`effort` 为 opaque string 正是为此）。残留风险：dsh 的 `output.render` 与工具结果形状可能需要 handler 返回结构化 `details`——已经返回了 |
| core 的公开 API 面过大，日后难改 | 1.0.0 只导出适配层实际用到的符号；`src/index.ts` 是唯一入口，子路径不导出（`exports` 里没有 `./store/*`） |
| 拆分把测试拆丢 | §7 末行的硬约束：两个包的测试文件数之和 ≥ 31，不允许删用例 |
| 阶段 1 的 core 因为住在 monorepo 里而意外沾上宿主依赖（比如图方便 import 一个 pi 工具函数） | §9.1 的 grep 断言是硬门，且 core 的 `package.json` 里根本没有任何 harness 包可 import（monorepo 的 hoisting 会让 `node_modules` 里看得到它们，所以光靠「编译不过」拦不住，必须靠 grep） |
| 阶段 2 搬迁丢掉 `auto-memory/` 的开发历史 | **我的决定（minor）**：新 repo 用单个 initial commit，不用 `git filter-repo` 保留历史，README 里给一行指回 pi-packages 的拆分 PR。理由：filter-repo 抽子目录后 commit SHA 全变，两边的交叉引用（spec 里的 `2026-09-30-pi-sandbox-package-split-design.md` 这类）一样对不上；而新包的 lineage 确实从发布那一刻开始，版本历史由 npm 与 GitHub Release 承担 |
| 回滚 | 阶段 1：PR 不合即回滚，零外部影响（core 是 `private: true`，不可能误发）。阶段 2：已发布后回滚 = pi-memory 发 3.0.1 把 `memoryDir` 默认值改回 `~/.pi/memory`（磁盘格式从未变过，所以两个方向的迁移都只是 `mv`） |

---

## 11. 留给建造者的部分

以下是本设计刻意不定死的实现细节，建造者按现有代码风格决定即可：

- core 内部的 import 路径组织（`store/` `orchestration/` `tool/` 三分是约束，文件内的符号分组不是）
- `prompts.ts` 是否把三段 prompt 文本拆成独立文件（现有 `buildDreamTask` 41 行、`buildExtractTask` 68 行、`buildSideQueryTask` 37 行，合起来约 150 行）
- 假端口在测试里的构造方式（现有测试已有大量 stub 先例可沿用）
- 31 个测试文件逐个归哪个 repo：按 §7 的模块归属表推导（例：`index-wiring` `prompt-meta` `agent-*` `model-resolver` `index-source` `nudge` `session-search` `memory-tool` 留 pi；其余跟着自己的模块走）
- core repo 的 CI 具体形态（阶段 2；建议：`build + test + typecheck + lint + 中立性 grep`，ubuntu 单 runner，加一个 windows job 只跑 `fs-retry.win32` / `windows-names` / `paths` 的 win32 分支）
- README 的语言与结构（建议沿用 pi-memory 现有的双语 + 章节顺序，删掉所有 pi 专属章节，新增「Adapting to a new harness」一节讲两个端口）

以下是我已定的 minor（可在评审时推翻）：

- **数据根的平台策略**：所有平台统一走 XDG 规则，不加 darwin/win32 分支（§5.2）
- **`nudge.ts` 留在适配层**，不拆成「纯 fs 读写进 core + 数 session 留适配层」（§7）
- **core 不提供 JSON Schema→schemastery 转换器**（§5.4）
- **`runExtract` 经端口拿 `ExtractMessage`**：新签名为 `runExtract(opts, ports: { headless, transcript })`，`opts.messages` 仍是宿主原始形状，core 内部调 `ports.transcript.toExtractMessages(raw)`（§4.1）
- **surfaced 条目的渲染也是 core 的纯函数**：`renderSurfacedBlock(entries, limits) → string`（读正文、按 `maxEntryBytes`/`maxInjectionBytes` 截断、拼 `<relevant_memories>` 形状）进 core；适配层只负责「把这段字符串放进哪个通道」与「本 session 已注入过哪些文件」的去重状态
- **新 repo 用单个 initial commit**，不用 `git filter-repo` 保留子目录历史（§10）
- **包名 `auto-memory` 与数据目录 `auto-memory` 同名**，两者都来自 D3/D5；`XDG_DATA_HOME` 下的目录名与包名一致是刻意的，便于用户从 `ls ~/.local/share` 反查是哪个包写的
