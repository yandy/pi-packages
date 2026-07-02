# pi-memory 设计规格

> 基于 `.superpowers/pi-memory-prd.md`（v0.1.0-draft）+ brainstorming 阶段确认的三处设计决策。本文档在 PRD 基础上修正了与 pi 实际能力的偏差，并细化为可实现的设计。

## 定位

给 pi 一个**文件系统驱动、零外部依赖**的持久记忆层，让 agent 跨会话记住项目事实、用户偏好、工作经验。

**不是**：多用户系统、知识库、团队协作工具、后台 daemon。

### 非目标（沿用 PRD 第七节）

不做多用户/多 profile、自动后台 dream、语义向量检索、自动改 AGENTS.md、记忆分享/同步/云存储、任何 daemon。

---

## 与 PRD 的三处确认决策

| # | 议题 | 决策 | 理由 |
|---|------|------|------|
| 1 | 配置机制 | **独立配置文件** `pi-memory.json`（非 settings.json） | pi 无扩展自定义 settings API，`ctx` 不暴露 settings；独立文件是 pi 官方惯例（`preset.ts` 等） |
| 2 | System prompt 注入 | **snapshot**（session_start 缓存，每轮注入同一值） | prefix cache 友好：system 是请求最前缀、单 block 单断点，内容一变全链失效；snapshot 全程稳定 → 缓存最优。详见「System Prompt 注入」节 |
| 3 | `add` 主题路由 | **LLM 驱动**（LLM 提供 topic+title，工具只做 I/O） | 工具 execute 是纯代码无法智能路由；LLM 本就在推理且 prompt 里有索引，由它指定 topic 可靠得多 |

另有 2 处技术修正（无需决策）：
- **Session 搜索**：用公开 API `SessionManager.list(ctx.cwd)`，不自拼路径（那个目录名是 `--<cwd>--` 路径编码，非哈希）。
- **project-hash**：git 仓库取 `git rev-parse --show-toplevel`，非 git 用 `cwd`，SHA256 前 12 位 hex。

---

## 架构与文件布局

### 记忆目录

```
~/.pi/memory/<project-hash-12>/
├── MEMORY.md              # 指针索引（注入 system prompt，≤200 行 / 25KB）
├── architecture.md        # LLM 自主创建/维护的主题文件
├── builds.md
├── debugging.md
├── conventions.md
├── user.md
└── ...
```

- 根目录派生自 pi 品牌名：`join(homedir(), CONFIG_DIR_NAME, "memory")`。rebrand（如 `myagent`）时自动变 `~/.myagent/memory/`。可用配置项 `memoryDir` 覆盖。
- `<project-hash-12>`：`sha256(projectKey).slice(0,12)`，`projectKey` = git 仓库 `git rev-parse --show-toplevel`（失败回退 `cwd`）。

### MEMORY.md — 指针索引

**不存实际内容**，每行一个指向主题文件的钩子：

```markdown
- [Go API Setup](architecture.md) — Go 1.22, sqlc, chi, Postgres 16 at ~/code/api
- [Build Commands](builds.md) — make test, make lint, make build for linux/amd64
- [SSH Gotcha](debugging.md) — staging server uses port 2222, key at ~/.ssh/staging_ed25519
```

- 行格式：`- [<title>](<topic-file>) — <description>`
- 容量硬限：`memIndexMaxLines`（默认 200）/ `memIndexMaxBytes`（默认 25600），取先到达者。
- 注入 system prompt 时按此上限截断（超限部分不注入，并在末尾标注截断）。

### 主题文件 — 实际知识存储

Markdown + YAML frontmatter：

```markdown
---
name: go-api-setup
description: Go project structure, build commands, and local dev setup for ~/code/api
type: project
updated: 2026-07-05
---

# Go API Project

## Commands
- `make test` — run all tests with race detector
```

- `description` 字段是 MEMORY.md 索引行的来源，必须写具体。
- LLM 可用内置 `read` 工具按需读取主题文件（路径在索引行里）。**主题文件内容不注入 system prompt**，只有 MEMORY.md 索引注入。

### 与 AGENTS.md 的关系

| | AGENTS.md | MEMORY.md |
|--|-----------|-----------|
| 谁维护 | 用户手写 | Agent 自动 + 用户纠正 |
| 内容 | 项目指令、规范、约束 | 积累的知识、发现的事实 |
| 生命周期 | 随版本控制 | 机器本地，跨 session 积累 |
| 加载时机 | 会话启动（pi 内置） | 会话启动（本扩展） |
| 容量 | 无硬限 | 硬限 200 行 / 25KB |

互补：AGENTS.md 说"怎么做"，memory 说"做了什么发现"。本扩展**绝不**修改 AGENTS.md。

---

## 配置机制（决策 1）

### 配置文件位置

- 全局：`join(getAgentDir(), "pi-memory.json")` → `~/.pi/agent/pi-memory.json`
- 项目：`join(ctx.cwd, CONFIG_DIR_NAME, "pi-memory.json")` → `<cwd>/.pi/pi-memory.json`
- 项目覆盖全局（深合并）。读项目级前用 `ctx.isProjectTrusted()` 守卫。
- 文件不存在 → 用默认值，不报错。

### Schema（沿用 PRD 第六节）

```json
{
  "enabled": true,
  "memoryDir": "~/.pi/memory",
  "memIndexMaxLines": 200,
  "memIndexMaxBytes": 25600,
  "dream": {
    "nudgeAfterSessions": 5,
    "nudgeAfterHours": 24,
    "model": "auto"
  },
  "sessionSearch": {
    "maxSessions": 10,
    "maxMatches": 5
  }
}
```

- `memoryDir`：默认 `join(homedir(), CONFIG_DIR_NAME, "memory")`，支持 `~` 展开。
- `dream.model`：`"auto"`（跟随当前 session 模型）或完整 `"provider/model-id"`（不支持模糊 pattern）。

### 配置加载模块 `src/config.ts`

```ts
interface MemoryConfig {
  enabled: boolean;
  memoryDir: string;
  memIndexMaxLines: number;
  memIndexMaxBytes: number;
  dream: { nudgeAfterSessions: number; nudgeAfterHours: number; model: string };
  sessionSearch: { maxSessions: number; maxMatches: number };
}
function loadConfig(ctx: { cwd: string; isProjectTrusted(): boolean }): MemoryConfig;
```

`enabled=false` 时：不注入 system prompt、不注册 memory 工具的 promptSnippet/guidelines、不显示 nudge。`/memory` 命令仍可用（用于重新启用）。

---

## System Prompt 注入（决策 2：snapshot）

### 缓存分析（为何选 snapshot）

经源码核查（`pi-ai/api/anthropic-messages.js`、`pi-coding-agent/dist/core/system-prompt.js`、`agent-session.js`）：

1. pi 默认启用 prefix cache（Anthropic 显式 `cache_control` 断点；OpenAI/Google 隐式前缀缓存），命中均要求**前缀逐字节稳定**。
2. system prompt 在 payload 层是**单个 text block + 末尾单个断点**，pi 把身份/tools/guidelines/AGENTS.md/skills/date/cwd 拼成一个字符串。
3. system 处于请求**最前缀**——一变一个字节，system 断点 miss，且其后 tools 断点、对话历史断点的前缀全变 → **全链失效**，整个会话历史按全价重算。
4. base system prompt **不每条用户消息重建**（仅工具/资源变更时重建），会话内稳定。**稳定性瓶颈完全在本扩展 append 的内容**。

→ snapshot（注入值全程稳定）= 缓存最优；fresh（memory 变则下一轮全链 miss）= 缓存敌对。故选 snapshot。

### 实现流程

```
session_start(reason: startup|reload|new|resume|fork)
  └─ 读 MEMORY.md（≤ memIndexMaxLines/Bytes 截断）→ 缓存到闭包变量 memoryIndexText
  └─ （session 计数 / nudge 检测，见「启动 Nudge」）

before_agent_start(event, ctx)
  └─ if enabled && memoryIndexText:
       return { systemPrompt: event.systemPrompt + "\n\n# Memory Index\n" + memoryIndexText }
```

- session 替换（new/resume/fork/reload）会重新触发 `session_start` → 自动重读最新 MEMORY.md。
- **会话中通过 `memory` 工具写入后不更新注入值**（贴合 PRD；写入内容已在对话上下文里，agent 本就知道；下次会话启动加载最新）。
- 注入段格式固定头部 `# Memory Index`，便于 LLM 识别。

---

## `memory` 工具（决策 3：LLM 驱动）

注册一个 `memory` 工具，4 个 action。LLM 承担"智能"部分（选 topic、写 title/description），工具负责确定性 I/O + 容量校验 + 并发安全。

### 工具元数据

- `name`: `memory`
- `promptSnippet`: `"Read/write project memory across sessions (add/replace/remove/search)."`
- `promptGuidelines`:
  - `"Use memory to persist project facts, user preferences, and lessons learned across sessions."`
  - `"Use memory action 'add' with an explicit topic filename when you discover something worth remembering long-term."`
  - `"Use memory action 'search' with scope='sessions' to find past work in history sessions."`

### 参数 schema

```ts
Type.Object({
  action: StringEnum(["add", "replace", "remove", "search"]),
  // add
  content: Type.Optional(Type.String({ description: "Knowledge text to store (add) or replacement text (replace)" })),
  topic: Type.Optional(Type.String({ description: "Target topic filename, e.g. 'debugging.md'. Auto-created if new (add)." })),
  title: Type.Optional(Type.String({ description: "Short title for the MEMORY.md index line (add). Defaults to topic stem." })),
  description: Type.Optional(Type.String({ description: "One-line description for the MEMORY.md index line (add). Defaults to first line of content truncated ~80 chars." })),
  // replace / remove
  old_text: Type.Optional(Type.String({ description: "Substring to locate (replace/remove). Matched against topic files and MEMORY.md index lines." })),
  // search
  query: Type.Optional(Type.String()),
  scope: Type.Optional(StringEnum(["memory", "sessions"])),
})
```

### action: `add`

参数：`content`（必填）、`topic`（必填，文件名）、`title`（可选，默认 topic 词干）、`description`（可选，默认取 content 首行截断 ~80 字符）。

行为：
1. 解析 topic 文件路径（限制在 memoryDir 内，禁止 `..` 路径穿越）。
2. 若 topic 文件已存在 → 追加内容（以 `\n\n## <timestamp 或 title>\n` 分节）；若不存在 → 创建，写 frontmatter（`name`=title slug、`description`、`type`=project、`updated`=今日）+ 内容。
3. upsert MEMORY.md 索引行：`- [<title>](<topic>) — <description>`。若该 topic 已有索引行（按 `(topic)` 链接匹配）→ 更新该行；否则追加。
4. 容量校验：若 upsert 后 MEMORY.md 超 `memIndexMaxLines`/`memIndexMaxBytes` → **回滚写入**，返回错误 + 当前所有索引条目列表，提示 LLM 在本轮 consolidate 后重试。
5. 返回成功 + 更新后的索引条目数。
6. **文件并发安全**：对 MEMORY.md 和目标 topic 文件的读-改-写整体包在 `withFileMutationQueue(absolutePath, async () => {...})` 内，避免与内置 `edit`/`write` 或并行 tool call 冲突。

> 注：`add` 写入文件后，**不**更新当前会话已注入的 system prompt（snapshot 语义）。LLM 若需立即确认可调 `search scope=memory`。

### action: `replace`

参数：`old_text`（必填）、`content`（必填，替换文本）、`topic`（可选）。

行为：
1. 若指定 `topic` → 仅在该 topic 文件内子串匹配 `old_text`，替换为 `content`。
2. 若未指定 `topic` → 先在所有 topic 文件 + MEMORY.md 索引行中搜索 `old_text`：
   - 恰好 1 处匹配 → 替换。
   - 0 处 → 返回错误"未找到"。
   - 多处 → 返回错误 + 匹配位置列表，提示 LLM 指定 `topic` 或提供更长的 `old_text`。
3. 若替换的是 MEMORY.md 索引行，`content` 应为合法索引行格式；若替换 topic 文件内容，`content` 为正文。
4. 同样走 `withFileMutationQueue`。

### action: `remove`

参数：`old_text`（必填）、`topic`（可选）。

行为：
1. 同 `replace` 的定位逻辑（指定 topic 或全局子串匹配 + 歧义处理）。
2. 删除匹配的索引行 或 topic 文件中的匹配段落。
3. 若 topic 文件删除后变空 → 删除该文件 + 其 MEMORY.md 索引行（若有）。
4. 走 `withFileMutationQueue`。

### action: `search`

参数：`query`（必填）、`scope`（必填，`memory` | `sessions`）。

- `scope=memory`：grep 所有主题文件 + MEMORY.md 索引，返回匹配文件 + 上下文行（`-C 2`）。结果用 `truncateHead` 截断到 50KB。
- `scope=sessions`：见「Session 搜索」节。

### 渲染

- `renderCall`：显示 `action` + 关键参数（topic/query）。
- `renderResult`：成功显示条目数/匹配数；错误红色显示；search 展开显示匹配摘要。

---

## Session 搜索（scope=sessions，pi 独有能力）

### 流程

```
search scope=sessions, query
  └─ sessions = await SessionManager.list(ctx.cwd)   // 取最近 maxSessions 个，按 modified 降序
  └─ 对每个 session JSONL 文件：
       └─ 逐行 grep query（大小写不敏感，词项 AND）
       └─ 命中行 ± 50 条消息作为上下文
  └─ 取前 maxMatches 个命中
  └─ 结构化返回：{ sessionFile, date, matchedLine, contextSummary }
```

### 实现要点 `src/session-search.ts`

- 用 `SessionManager.list(ctx.cwd)`（公开 API，内部处理 `--<cwd>--` 路径编码）。**不自拼 session 目录路径**。
- JSONL 解析：第 1 行是 header（`type:"session"`），其余是 entry。只解析 `type:"message"` 的 entry，提取 `message.content` 的文本（`role: user/assistant/toolResult` 的 text 内容）。跳过 thinking/image。
- 命中上下文：命中 entry 的前后各取若干条 message entry 的文本摘要（每条截断 ~200 字符），拼成上下文。
- 结果用 `truncateHead` 截断到 50KB，超限写入临时文件并告知路径。
- 并发：用 `Promise.all` 并发读多个 session 文件。
- PRD 提到"并发 fork 独立 session 做查询导向摘要（≤3 个）"——**v0.1 暂不实现 LLM 摘要**，仅返回 grep + 上下文（保持零额外 LLM 调用、与 snapshot 的"零阻塞"一致）。后续版本可基于 `createAgentSession` 扩展。

### 返回格式（给 LLM）

```
Found 3 matches in 2 sessions:

## Session 2026-06-28 (~/code/api)
…matched: "deadlock in payment processor"…
context: [user] 记得我们修过 deadlock… [assistant] 找到了，goroutine 锁顺序…

## Session 2026-06-25 (~/code/api)
…
```

---

## `/memory` 命令

```
/memory
```

显示当前项目记忆状态面板：

```
Memory: enabled
Dir: ~/.pi/memory/a1b2c3d4e5f6/
Index: 12 entries (12/200 lines, 4.2/25KB)
Topic files: architecture.md, builds.md, debugging.md, conventions.md, user.md
Last dream: 2026-07-01 14:30 (2 sessions ago)
```

- 可选交互：选择条目打开文件编辑（`ctx.ui.editor` 或 `pi.exec` 调 `$EDITOR`）。
- 切换 `enabled`：`/memory off` / `/memory on`（写回全局配置文件）。
- `ctx.mode === "tui"` 守卫交互部分；非 TUI 模式仅 `notify` 文本摘要。

---

## `/dream` 命令（决策 D：自研 headless agent）

### 定位

用户手动触发。fork 一个**独立的 in-memory headless agent**，读取全部记忆文件，去重、合并矛盾、更新过时、重组索引，完成后显示改动摘要。用户全程留在原 session。

### 流程

```
/dream
  └─ ctx.ui.confirm("Dream", "整理全部记忆？将读取 N 个文件并重写...") → 取消则退出
  └─ 解析 dream 模型：
       - config.dream.model === "auto" → ctx.model
       - 否则 ctx.modelRegistry.find(provider, id)；找不到 → notify 错误退出
  └─ ctx.ui.setStatus("dream", "Consolidating memory...")
  └─ summary = await runDream({ model, memoryDir, cwd: memoryDir, signal: ctx.signal })
  └─ ctx.ui.setStatus("dream", undefined)
  └─ 记录 lastDreamAt（写 memoryDir/.dream-meta.json）
  └─ ctx.ui.notify(summary, "info") 或显示改动摘要
```

### `runDream` 实现 `src/dream.ts`

用 SDK `createAgentSession` 起一个隔离的 headless agent：

```ts
import { createAgentSession, SessionManager, DefaultResourceLoader, AuthStorage } from "@earendil-works/pi-coding-agent";

async function runDream(opts: { model; memoryDir; cwd; signal; createSession? }): Promise<string> {
  const createSession = opts.createSession ?? createAgentSession;  // DI：测试可注入假实现
  // 1. 隔离的 ResourceLoader：空 settings + 空 agentDir 发现 → 不加载任何扩展/skill（避免递归加载 pi-memory 自身）
  const loader = new DefaultResourceLoader({
    cwd: opts.memoryDir,
    agentDir: opts.isolatedAgentDir,        // 隔离目录（见下），仅用于发现，不用于 auth
    settingsManager: SettingsManager.inMemory({}),
    systemPromptOverride: () => DREAM_SYSTEM_PROMPT,
  });
  await loader.reload();

  // 2. in-memory session，工具限制为 read/edit/write（cwd=memoryDir，只能动记忆文件）
  const authStorage = AuthStorage.create();
  const { session } = await createSession({
    model: opts.model,
    authStorage,
    modelRegistry: ModelRegistry.create(authStorage),
    tools: ["read", "edit", "write"],
    cwd: opts.memoryDir,
    sessionManager: SessionManager.inMemory(opts.memoryDir),
    resourceLoader: loader,
  });

  // 3. 收集最后一条 assistant 消息作为摘要
  let summary = "";
  const unsub = session.subscribe((e) => {
    if (e.type === "agent_end") {
      const last = [...session.messages].reverse().find(m => m.role === "assistant");
      summary = extractText(last);
    }
  });

  // 4. 发送 dream 任务
  const task = buildDreamTask(opts.memoryDir);  // 列出文件 + 整理指令
  try {
    await session.prompt(task);
  } finally {
    unsub();
    session.dispose();
  }
  return summary || "Dream completed.";
}
```

### DREAM_SYSTEM_PROMPT（要点）

```
You are a memory consolidation agent. Your job: read all memory files in <dir>,
deduplicate entries, merge contradictions, update outdated info, and reorganize
the MEMORY.md index to be concise and accurate. Rules:
- Only modify files under <dir>. Never touch anything else.
- Preserve all valuable knowledge; only remove true duplicates/outdated facts.
- Keep MEMORY.md ≤ <maxLines> lines; each line: - [Title](file.md) — description.
- Write specific descriptions so the index alone tells what each file holds.
- When done, output a concise summary of changes (merged N, removed N, updated N).
```

### dream task（用户消息）

列出 memoryDir 下所有文件路径 + 当前 MEMORY.md 内容 + 整理指令。

### 隔离要点

- **不加载项目扩展**：通过空 settings + 隔离 agentDir 的 DefaultResourceLoader，确保 dream agent 不递归加载 pi-memory（否则 dream agent 的 `before_agent_start` 会注入 memory、注册 memory 工具，造成噪声/递归）。具体做法：`isolatedAgentDir` 指向一个不含 `extensions/`/`settings.json` 的临时或固定空目录（如 `join(memoryDir, '.dream-agent')` 或 `os.tmpdir()` 子目录）；auth 经由显式传入的 `authStorage`/`modelRegistry` 独立解析，不依赖该 agentDir。实现时需验证 DefaultResourceLoader 在空 agentDir + 空 settings 下确实不发现任何扩展。
- **auth 独立传入**：`authStorage`/`modelRegistry` 显式创建（读 `~/.pi/agent/auth.json`），不依赖 loader 的 agentDir。
- **工具受限**：仅 `read`/`edit`/`write`，`cwd=memoryDir`，无法越界。
- **in-memory session**：`SessionManager.inMemory()`，不污染用户 session 文件。
- **取消**：`ctx.signal` 监听 → `session.abort()`。
- **错误**：模型无 API key / 请求失败 → `ctx.ui.notify(error, "error")`。

### lastDreamAt 记录

写 `memoryDir/.dream-meta.json`：`{ lastDreamAt: ISO, sessionCountAtDream: N }`。供 nudge 判断使用。

---

## 启动 Nudge

### 触发条件（`session_start` 中检测）

满足任一：
- 距上次 dream ≥ `nudgeAfterHours`（默认 24h）**且** 自上次 dream 后 ≥ `nudgeAfterSessions`（默认 5）个 session
- 或 MEMORY.md 行数 > 150

### 展示

零阻塞静态文本。在 `session_start` 中用 `ctx.ui.notify` 或 `setHeader` 展示：

```
💡 8 sessions, 3 new entries since last dream. /dream
```

- `ctx.hasUI` 守卫（print/json 模式跳过）。
- 不自动执行任何操作。

### session 计数

通过 `SessionManager.list(ctx.cwd)` 的数量 + `.dream-meta.json` 的 `sessionCountAtDream` 比较得出"自上次 dream 后的 session 数"。

---

## 包结构与发布

### 目录结构

```
pi-memory/
├── index.ts                  # 入口：extension factory，注册 tool/commands/hooks
├── src/
│   ├── config.ts             # 配置加载 (pi-memory.json)
│   ├── paths.ts              # memoryDir 解析 + project-hash
│   ├── index-file.ts         # MEMORY.md 读写/解析/upsert/容量校验
│   ├── topic-file.ts         # 主题文件读写/创建/frontmatter
│   ├── memory-tool.ts        # memory 工具 (add/replace/remove/search)
│   ├── session-search.ts     # search scope=sessions
│   ├── inject.ts             # system prompt snapshot 注入
│   ├── dream.ts              # /dream headless agent
│   └── nudge.ts              # 启动 nudge
├── tests/
│   ├── paths.test.ts
│   ├── index-file.test.ts
│   ├── topic-file.test.ts
│   ├── config.test.ts
│   └── memory-tool.test.ts
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── README.md
├── README.zh.md
└── RELEASE.md
```

### package.json（关键字段）

```json
{
  "name": "@yandy0725/pi-memory",
  "publishConfig": { "access": "public" },
  "version": "0.1.0",
  "description": "File-system driven persistent memory layer for pi coding agent",
  "license": "MIT",
  "repository": { "type": "git", "url": "https://github.com/yandy/pi-packages", "directory": "pi-memory" },
  "type": "module",
  "keywords": ["pi-package"],
  "files": ["index.ts", "src/"],
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "lint": "biome lint .",
    "format": "biome format --write ."
  },
  "pi": { "extensions": ["./index.ts"] },
  "peerDependencies": {
    "@earendil-works/pi-ai": ">=0.80.2",
    "@earendil-works/pi-coding-agent": ">=0.80.2",
    "@earendil-works/pi-tui": ">=0.80.2",
    "typebox": "*"
  },
  "devDependencies": { "typebox": "^1.1.38" }
}
```

- peerDependencies 与同仓其他包一致（`@earendil-works/pi-*` + `typebox`，`>=0.80.2`）。
- 无 runtime dependencies（零外部依赖）。`typebox` 作 devDependency（类型）+ peerDependency。
- tsconfig 继承 `../tsconfig.base.json`，include `index.ts` + `src/**/*.ts`。
- vitest.config.ts 同 pi-todo。

### RELEASE.md

tag 格式 `pi-memory-v*`，流程同 pi-todo（`npm version --workspace=pi-memory` + `gh release create pi-memory-v<X.Y.Z>`，GitHub Actions 自动 publish）。

### 发布目标

`@yandy0725/pi-memory@0.1.0`（public access），`pi install npm:@yandy/pi-memory`。

---

## 错误处理

| 场景 | 处理 |
|------|------|
| memoryDir 不存在 | `add` 时自动 `mkdir -p`；注入/nudge 时视为空（不报错） |
| MEMORY.md 不存在 | 注入空；`add` 时创建 |
| 容量超限 | `add` 回滚 + 返回错误 + 现有条目列表（LLM 同轮 consolidate 重试） |
| `replace`/`remove` 0 匹配 | 返回错误"未找到 old_text" |
| `replace`/`remove` 多匹配 | 返回错误 + 匹配位置列表，要求指定 topic 或更长 old_text |
| topic 路径穿越（`..`） | 拒绝，返回错误 |
| dream 模型无 API key | `ctx.ui.notify` 错误，退出 |
| dream 请求失败 | `ctx.ui.notify` 错误 + dispose |
| dream 取消（Esc） | `ctx.signal` → `session.abort()` → dispose |
| session 文件解析失败 | 跳过该文件，继续其他 |

工具错误统一通过 **throw**（设置 `isError: true`），不靠返回值。

---

## 测试策略

### 单元测试

- `paths.test.ts`：project-hash 计算（git / 非 git 回退）、memoryDir 解析（CONFIG_DIR_NAME 派生 + memoryDir 覆盖 + `~` 展开）。
- `index-file.test.ts`：MEMORY.md 解析、upsert（新增/更新同 topic）、容量校验（超限不写入并返回条目列表）、截断。
- `topic-file.test.ts`：frontmatter 生成/解析、追加分节、空文件删除、路径穿越拒绝。
- `config.test.ts`：默认值、项目覆盖全局、`isProjectTrusted` 守卫、`~` 展开。
- `memory-tool.test.ts`：各 action 的纯逻辑分支（用临时目录 mock 文件系统）。

### 集成测试

- `memory` 工具 add → replace → remove 全流程（临时 memoryDir）。
- search scope=memory（造文件 + grep）。
- search scope=sessions（造 JSONL fixture + SessionManager.list mock）。

### dream 测试

- **纯函数直接测**（无 mock）：`buildDreamTask(memoryDir)`（prompt 含文件列表+整理指令）、`resolveDreamModel(config, ctx)`（auto→ctx.model / explicit→registry.find）、`extractSummary(messages)`（取最后一条 assistant 文本）。
- **`runDream` 编排用依赖注入**：`runDream({ ..., createSession })` 接受可选 `createSession`（默认真实 `createAgentSession`），测试注入假 `createSession` 返回可控假 session，验证：传入的 model/tools/cwd/loader 配置正确、摘要提取、`dispose` 被调用、`signal` abort 触发取消路径。**避免脆弱的模块 mock（vi.mock）**。
- **LLM 实际整理质量不可单元测试** → 仅手动 smoke test（真实便宜模型跑一次 `/dream` 验证端到端）。真实 dream 不进 `npm test`（需 API key、花钱、非确定、慢；RELEASE.md 要求每次发布跑 `npm test`）。

### 注入测试

- 验证 `session_start` 读到的值与 `before_agent_start` 注入的值一致（snapshot）。
- 验证 `add` 后注入值不变（同一 session 内）。

---

## 关键依赖与导入

```ts
import {
  CONFIG_DIR_NAME, getAgentDir,           // 品牌目录
  SessionManager,                          // session 搜索
  createAgentSession, DefaultResourceLoader, // dream headless agent
  AuthStorage, ModelRegistry,              // dream auth
  withFileMutationQueue,                   // 文件并发安全
  truncateHead, formatSize,                // 输出截断
  defineTool, type ExtensionAPI, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
```

---

## 实现顺序提示（供 writing-plans）

建议分 5 个增量批次，每批可独立验证：

1. **骨架 + 配置 + 路径**：包结构、package.json、config.ts、paths.ts、index.ts 注册空 factory + session_start 日志。`pi -e ./pi-memory` 能加载。
2. **索引与主题文件 + 注入**：index-file.ts、topic-file.ts、inject.ts。session_start 读 MEMORY.md → before_agent_start 注入 snapshot。
3. **memory 工具**：memory-tool.ts（add/replace/remove/search scope=memory）+ 渲染。端到端可 add/search。
4. **session 搜索 + /memory 命令 + nudge**：session-search.ts、/memory 命令、nudge.ts。
5. **/dream**：dream.ts（headless agent）+ /dream 命令 + .dream-meta.json。

每批完成后跑 `npm run typecheck && npm run lint && npm test`，并用 `pi -e` 做手动 smoke test。

---

## 开放问题（留待 writing-plans / 实现）

- dream agent 的 ResourceLoader 隔离确切配置（空 agentDir 路径选择）需实现时验证 DefaultResourceLoader 行为。
- `/memory` 打开文件编辑的交互细节（`ctx.ui.editor` vs `$EDITOR`）。
- `replace`/`remove` 对 MEMORY.md 索引行 vs topic 文件内容的区分：默认全局子串匹配，多处命中时返回匹配位置列表要求 LLM 指定 `topic`。若 `topic` 指定则仅在该文件内匹配。无需额外参数——歧义由「返回列表 + 要求指定 topic」解决。
