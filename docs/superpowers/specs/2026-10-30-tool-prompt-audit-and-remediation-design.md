# pi-packages 工具提示词整改设计（三通道定位 · 去重 · 预算闸门）

日期：2026-10-30
状态：**已定稿，待实施**（D1/D2/D2a/D3 已于 2026-10-30 全部拍板；W1–W3 均可开工）
范围：`pi-coding-tools`、`pi-sandbox`、`pi-container-sandbox`、`pi-subagents`、`pi-memory`、`pi-ask-user`、`pi-web-tools`、`pi-todo`、`pi-vision-tools`（`pi-superpowers` 不注册工具，仅注入 skills，不在范围内）
落点：上述包的 tool 定义文件 + 各包 `tests/` + `docs/guides/pi-package-spec.md`

## 1. 背景与问题

pi 的自定义 tool 有三处内容会进模型上下文，性质完全不同：

| 通道 | 落点（宿主事实） | 成本形态 |
|---|---|---|
| `description` | 工具 schema，随 API `tools[]` 每请求发送（`dist/core/extensions/types.d.ts:341`） | **每工具各一份，不跨工具共享** |
| `promptSnippet` | system prompt 的 `Available tools`，渲染为 `- <name>: <snippet>`（`dist/core/system-prompt.js:44-46`） | 每请求一份，仅工具 active 时出现 |
| `promptGuidelines` | system prompt 的 `Guidelines`，扁平追加、**按精确字符串去重**、无工具名前缀（`agent-session.js:626-640` + `system-prompt.js:74-80`） | 每请求一份，跨工具去重 |

另有两条宿主约束决定了"该放哪"：

1. 用自定义 system prompt（SYSTEM.md / `--system-prompt`）时，`promptSnippet` 与 `promptGuidelines` 会被**整体丢弃**（`system-prompt.js:22-45` 早退），只有 `description` 存活；
2. `label` / `renderCall` / `renderResult` / 返回值的 `details` **完全不进 LLM**。

审计（2026-10-30，方法见 §10）发现的全部问题归为三类：**位置错配**、**事实错误**、**重复浪费**。实测基线（9 包全装，排除与 pi-sandbox 互斥的 container 版）：

| 通道 | 字符 | 占比 |
|---|---|---|
| description | 6114 | 24.5% |
| 参数 schema | 11218 | 45.0% |
| promptSnippet | 1371 | 5.5% |
| promptGuidelines（去重后） | 6233 | 25.0% |
| **合计** | **24936 ≈ 6.2k tokens / 请求** | |

按包：coding-tools 5399、sandbox 4778、subagents 4249、memory 2814、ask-user 2599、web-tools 2376、todo 1445、vision 1276。
整体 6-gram 重复率 **15.2%**（system prompt 部分 **24.7%**，且这是在宿主已完成精确去重之后剩下的"同一句话换个写法"）。

## 2. 目标与非目标

**目标**

- 修掉 1 个真实缺陷（`pi-container-sandbox` 静默吞掉 4 个工具的提示词元数据）；
- 修掉 8 处会误导模型的事实错误；
- 在不削弱行为约束的前提下回收 **≈3.4k 字符/请求（-13.7%）**；
- 把三通道分工与预算写成可执行的约定，并加回归闸门防止再次腐烂。

**非目标**

- 不改任何工具的功能、参数名、返回值形状、渲染逻辑；
- 不动 `pi-sandbox` 的提权协议语义与 `pi-todo` 的 id 收归设计（两者都是已拍板的决定，本方案只做措辞精确化）；
- 不做 `pi-memory` 的 `extract` / `dream` 子会话精简（`2026-10-03-memory-tool-prompt-trim-design.md` 的方案 1，本轮不做，理由见 §9）；
- 不追求"prompt 越短越好"：本项目多数文本在 prefix-cache 覆盖内，字面节省 ≠ 账单节省（同见该 spec §4）。真正的收益在正确性、注意力密度与漂移风险。

## 3. 三通道契约（本方案的规范条款）

实现与 review 一律按此判定；后续新增工具同样适用。

| # | 条款 |
|---|---|
| **R1** | `description` 只写**工具与其参数的事实**：它做什么、语法、允许值、默认值、返回值形状。"何时该用 / 何时不该用 / 与别的工具怎么分工"不属于这里。 |
| **R2** | `description` 与参数 `description` **不得互相复述**。同一事实只留一处：参数级细节放参数，整体语义放工具 description。 |
| **R3** | `promptSnippet` 是**目录行**：≤80 字符、**不写工具名**（宿主已渲染 `- <name>:`）、不含祈使句、不以句号结尾、不复述 `description`。 |
| **R4** | `promptGuidelines` 是**行为纪律**：必须点名工具（pi 文档强制，`extensions.md:1740`）；不写参数细节；不写工具语法。 |
| **R5** | 同一事实在 `description` 与 `promptGuidelines` 之间**只能有一份**；确需强化时，强化只允许发生在 guidelines 一侧。 |
| **R6** | 跨工具共享的规则必须来自**同一个字符串常量**（pi 按精确字符串去重，措辞漂移 = 去重失效 = 付两份）。 |
| **R7** | 覆盖内置工具时必须用 `create*ToolDefinition`，或从 definition 显式继承 `promptSnippet` / `promptGuidelines`。**`create*Tool` 返回的 `AgentTool` 不透传提示词元数据**（`tool-definition-wrapper.js:3-12`）。 |
| **R8** | 不进 LLM 的字段（`label` / `renderCall` / `renderResult` / `details`）不得承载规则或事实。 |

预算闸（每条为包内测试断言，见 §7）：`snippet ≤ 80`；单条 guideline `≤ 700`；同一包内 `description` 与参数描述的 6-gram 重合 `≤ 15%`；包内三通道合计不超 §6 表中上限。

## 4. 审计发现

### 4.1 P0 缺陷：`pi-container-sandbox` 丢失提示词元数据

`index.ts:51-54` 用 `createReadTool()` / `createWriteTool()` / `createEditTool()` / `createBashTool()`（返回 `AgentTool`），再 `pi.registerTool({...localRead, ...})`。`wrapToolDefinition()` 只透传 `name/label/description/parameters/prepareArguments/executionMode`，而 `_refreshToolRegistry` 按名字覆盖后**只从覆盖后的 definition 读提示词**（`agent-session.js:1849-1877`），没有回落到内置定义。

后果（实测）：

- `Available tools` 里 **read / write / edit / bash 四条目录项全部消失**；
- 内置 `edit` 的 4 条 disciplines（`oldText` 精确匹配、不要发重叠/嵌套 edit、`oldText` 尽量小）——共 496 字符——消失；
- `read` / `write` 的两条内置纪律消失；
- 合计 **779 字符 + 4 条目录项**凭空丢失。

对照：`pi-sandbox` 用 `create*ToolDefinition` 并写了 Ruling 15 注释（`src/tools.ts:383-385`）与测试（`tests/tools.test.ts:140-150`）。`pi-container-sandbox` 既无实现也无测试。

### 4.2 位置错配

| 位置 | 现状 | 违反 |
|---|---|---|
| `pi-subagents/src/tools/agent-tool.ts:143-153` | 893 字符的 `Guidelines:` 块（**10 条**）内联在 `description` 里 | R1 / R3 语义（应为 guidelines）+ R2（其中 **6 条被参数描述完全覆盖，516 字符**） |
| `agent-tool.ts:138-139` | "Launch a new agent…" 与 "The subagent tool launches specialized agents…" 同义反复 | R2 |
| `pi-ask-user/index.ts:1538` | description 尾部两句与 guideline[0]/[2] **逐字相同**（6-gram 重合 75% / 33%，164 字符） | R5 |
| `pi-ask-user/index.ts:1545-1546` | 两条 guideline 表达同一条规则（"一问一题"） | R6 |
| `pi-web-tools/index.ts:19-21, 98` | snippet 自带工具名（渲染成 `- websearch: websearch: …`）+ 逐字复述 description + 面向人的 "LLM synthesizes the answer" | R3 |
| `pi-memory/src/memory-tool.ts:172-173` | snippet 第二句是**指令**（= guideline 2 的复述） | R3 |
| `pi-vision-tools/index.ts:44` | description 复述 4 个参数（`image_path` 甚至用词镜像），参数里已写全 | R2 |
| `pi-coding-tools/src/tools/ast-grep-search.ts:52`、`ast-grep-replace.ts:59` | guideline 整条复述 `description` / `pattern` 参数已写全的 `$VAR` / `$$$` 语法（175 / 197 字符） | R4 / R5 |
| `ast-grep-replace.ts:57-60` | "先 dry-run 再 apply" 一条规则出现 **4 次**（description 两句 + `apply` 参数 + g[0] + g[2]） | R2 / R5 |
| `lsp-tools.ts:31/64/106` + 各 guideline | "需要 language server" 在 3 个 description 各一次、guideline 又 2 次（措辞不同 → 去重失效）；`line/character` 的基准已由参数描述给出，guideline 又写 2 次 | R2 / R6 |
| `pi-subagents/src/tools/get-result-tool.ts:95`、`helpers.ts:buildTypeListText`（渲染进 `agent-tool.ts` 的 description） | "Use the agent ID returned by Agent" 这种读不通的表述；"Project-level agents override global ones" 属面向用户的文档 | R1 |
| `pi-sandbox/src/tools.ts:293` | `SANDBOX_NOTE` 的规则部分与 `ESCALATION_GUIDELINE` 重复，且因在 description 里无法去重 → 付 3 份 | R5（可接受的例外，需缩短，见 §6） |

### 4.3 事实错误（与实现不符）

| 位置 | 现状 | 事实 |
|---|---|---|
| `pi-ask-user/index.ts:1538, 1542` | "gather context with tools (read/web/ref)" | `ref` 工具**不存在**（本仓与 pi 0.80.2 都没有）；`web` 也不是工具名 |
| `get-result-tool.ts:95` | "returned by Agent" | 工具已改名 `subagent` |
| `agent-tool.ts:144` | "Foreground calls run sequentially — only one executes at a time." | 该 tool **无 `executionMode`**，pi 默认 `toolExecution: "parallel"`（`pi-agent-core/dist/agent.js:128`）；前台 spawn 还**绕过** `maxConcurrent` 队列（`subagent-manager.ts:180-183`）。真实差别是"阻塞父轮次 vs 不阻塞" |
| `pi-todo/index.ts:79` | "so never pass an id" | 只对 `set` 的 `items` 成立；紧接的下一句要求 `update` 用精确 id，读作全局会直接踩 `id is required for update` |
| `ast-grep-search.ts:26` | "Omit to infer from path extension." | 推断失败时**静默按 typescript 搜**（同文件 `:65,70`）。传目录（`src/`）属高频误用 |
| `pi-sandbox/src/tools.ts:293` | "already allows the workspace and /tmp" | win32 的 tmp 根只有 `os.tmpdir()`，没有 `/tmp`（`fence.ts:175-176`） |
| `pi-vision-tools/index.ts:66` | thinkLevel "Default off." | 实际 `param ?? config.defaultThinkLevel ?? "off"`（`think-level.ts:19-25`） |
| `agent-tool.ts` 的 `thinking` | 纯 `Type.String()`，文档列 `off/minimal/…` | pi 的 `ThinkingLevel` 不含 `off`；非法值不报错、靠 clamp 兜，静默失效 |

### 4.4 缺口

- `pi-todo` 的 schema 有 **7 个参数、0 条描述**（527 字符全是裸类型），而 `blockedBy` 的语义（依赖门控 + ack 里的 `(blocked by #x)` + `next` 跳过阻塞项）在提示词里**任何通道都没解释**；
- `pi-sandbox` / `pi-coding-tools` 的 guideline 点名 "use grep"，但 `grep` 可能根本没激活（本仓 `pi-coding-tools` 不再提供 ls/find/grep）。该条已被 `2026-10-03-pi-coding-tools-scope-and-tool-enable-design.md:102` 记为 parked，本方案正式处置（见 §6）。

### 4.5 重复与浪费清单（可回收量）

| # | 项 | 位置 | 现状 | 回收 |
|---|---|---|---|---|
| 1 | description 内 Guidelines 块：6 条完全被参数描述覆盖（删）+ 4 条独有信息迁往 guidelines（无净变化）+ “Guidelines:” 标题 | `agent-tool.ts:143-153` | 1485→~690 | 780 |
| 2 | preamble 同义反复句 + 面向用户的 override 说明 | `agent-tool.ts:138-141` | ~285 | （已计入上行） |
| 3 | description 尾部两句与 guidelines 逐字重复 | `pi-ask-user/index.ts:1538` | 256→72 | 184 |
| 4 | 两条"一问一题" guideline 合并 | `index.ts:1545-1546` | 144→128 | 16 |
| 5 | 3 个外观参数从模型可见 schema 整体移除（D2 方案 B） | `index.ts:1575-1595` | 外观三件 schema 782 | 782 |
| 6 | snippet 重名 + 复述 | `pi-web-tools/index.ts:19-21` | 169→70 | 99 |
| 7 | `provider` 参数复述 description | `index.ts:26-30` | 188→93 | 95 |
| 8 | snippet 重名 + 复述 | `index.ts:98` | 81→44 | 37 |
| 9 | `provider` 参数偏长 | `index.ts:120-128` | 247→171 | 76 |
| 10 | snippet 指令句 | `memory-tool.ts:172-173` | 152→58 | 94 |
| 11 | `description` 参数（第 4 份 self-contained） | `memory-tool.ts:132-137` | 185→108 | 77 |
| 12 | description 复述全部 4 个参数 | `pi-vision-tools/index.ts:44-50` | 357→106 | 251 |
| 13 | snippet 重名 | `index.ts:50` | 82→64 | 18 |
| 14 | description 过长 + 事实错误 | `get-result-tool.ts:94-95` | 117→102 | 15 |
| 15 | snippet 重名 + 复述 | `get-result-tool.ts:92` | 79→56 | 23 |
| 16 | description 复述 `message` 参数 | `steer-tool.ts:86-88` | 225→54 | 171 |
| 17 | snippet 重名 | `steer-tool.ts:84` | 78→53 | 25 |
| 18 | g[1] 语法复述 + 另两条压缩 | `ast-grep-search.ts:50-53` | 629→398 | 231 |
| 19 | 语法复述 + dry-run 四份 → 两条 | `ast-grep-replace.ts:57-60` | 636→218 | 418 |
| 20 | 三工具重复句合并 + 删 3× "Requires a language server." | `lsp-tools.ts`（desc 562 / guidelines 875） | 1437→997 | 440 |
| 21 | SANDBOX_NOTE ×3（缩短 + 修 /tmp 措辞） | `pi-sandbox/src/tools.ts:293` | 156×3→130×3 | 78 |

毛回收 **3910 字符/请求（-15.7%）**。为正确性必须**新增**的内容：todo 参数描述 +180、`lang` 静默默认说明 +120×2 = +240、`thinking` 枚举 +30、vision `thinkLevel` 默认值说明 +43 = **+493**。

**净回收 3417 字符/请求（-13.7%，≈850 tokens）**；另 `pi-container-sandbox` 需**加回** 779 字符（185 snippet + 594 guidelines，修缺陷，非浪费）。

口径说明：第 1 项的 780 = 删掉 6 条完全重复的 516 + 迁移后 preamble 冗余 270 + 标题 12 − 重写并行条目 +24；迁移到 guidelines 的 4 条不产生净变化，故不计入毛回收。第 2 项并入第 1 项（preamble 冗余即 270）。第 5 项只计外观三件；`timeout` 按 D2a 的决定**保留**（其 73 字符不计入回收）。

## 5. 整改方案（按波次）

### W1 正确性（与任何决策无关，可直接开工）

1. `pi-container-sandbox`：改用 `create*ToolDefinition`（见 §6.1）；
2. 修 §4.3 全部 8 条事实错误（`ref`、`Agent`、`Foreground calls run sequentially`、`never pass an id` 限域、`lang` 默认为 typescript、`/tmp` → OS temp dir、thinkLevel 默认、`thinking` 加 `StringEnum`）；
3. 补 §4.4 两处缺口（todo 参数描述 + `blockedBy` 语义；`grep` 措辞改为 "grep（或用 bash 的 rg）"）。

### W2 零风险去重（事实在另一通道已保留）

§4.5 除第 5 项外的全部条目：snippet 重写、description 删复述、guideline 合并、LSP 三件套收敛。

### W3 已拍板（2026-10-30）

- **D1 = 迁移**：`subagent` 的 Guidelines 块——删 6 条与参数重复的（516 字符），把 4 条独有的迁到 `promptGuidelines`（并行条目重写以修事实错误）；
- **D2 = 方案 B**：`ask_user` 的 `displayMode` / `overlayToggleKey` / `commentToggleKey` 从模型可见 schema 移除（-782），只从 env/config 读；**`timeout` 保留**（D2a）——它没有 env/config 兜底，移除即删能力，而它是模型唯一能给自己设等待上限的手段。

实施注意（D2）：`pi-ask-user` 只导出 `export default`，无程序化 API，所以移除声明后 per-call 入参只剩测试在用。本方案**保留**内部优先级链（代码不动，测试全部保持绿），只改 `parameters` 声明——避免为了删死代码而重写 8 处测试。若日后加 RPC/SDK 入口，该链路自动可用。README（EN+ZH）的「参数表」与「优先级表」需同步：per-call 一档改为“仅 SDK/内部调用”，模型调用不再可见。

### W4 约定与闸门

- `docs/guides/pi-package-spec.md` 增补"提示词三通道"一节（§3 的 R1–R8 + 预算）；
- 每包新增 `tests/prompt-meta.test.ts`（§7）。

## 6. 逐包改动清单

以下为需要逐字替换的内容（未列出的参数/描述保持原样）。箭头右侧为新文本。

### 6.1 `pi-container-sandbox/index.ts`（W1，P0）

```ts
// 现在
const localRead = createReadTool(localCwd);          // AgentTool：无 promptSnippet/promptGuidelines
pi.registerTool({ ...localRead, async execute(id, params, signal, onUpdate, _ctx) { ... } });

// 改成（与 pi-sandbox 同款，Ruling 15）
const localRead = createReadToolDefinition(localCwd);
pi.registerTool({ ...localRead, async execute(id, params, signal, onUpdate, ctx) {
  ...
  return tool.execute(id, params, signal, onUpdate, ctx);   // 第 5 参必须透传
} });
```

四个工具（read / write / edit / bash）全部替换；`execute` 内的实现逻辑不改，只补第 5 个参数与 definition 工厂。回填后 `Available tools` 恢复 4 条目录项，内置纪律（read 1 条 / write 1 条 / edit 4 条）回归。

### 6.2 `pi-subagents`

| 位置 | 现在 | 改成 |
|---|---|---|
| `agent-tool.ts:136-153` | 1485 字符（含 893 字符 Guidelines 块：10 条） | ①**删** 6 条完全被参数描述覆盖的（`run_in_background` 通知、`resume`、`model`、`thinking`、`timeout`、`inherit_context`，共 516 字符）；②**迁** 4 条独有的到 `promptGuidelines`（见下）；③删 preamble 的同义反复句与 override 说明 |
| 新 description（整段替换后） | —— | `Launch a subagent that works autonomously on a task.\n\nAvailable agent types:\n<typeList>\n\nCustom agents live in .pi/agents/<name>.md (project) or <agentDir>/agents/<name>.md (global); a file with a default agent's name overrides it.`（~350，随 agent 类型数量浮动） |
| `promptGuidelines`（W3/D1） | 仅动态 tier 一条 | 追加 5 条：①`Use subagent for work that needs its own context or a different model; finish inline work yourself.` ②`For parallel work set run_in_background: true on each agent — sibling foreground calls run concurrently anyway, but they block the current turn and bypass the concurrency limit.` ③`Give each subagent a self-contained prompt; it cannot see the parent conversation unless inherit_context is true.` ④`Subagent results come back as text — summarize them for the user.` ⑤`Use steer_subagent to redirect a running background agent, and get_subagent_result with wait: true to block for one result.` |
| `thinking` 参数 | `Type.String({description: "Thinking level: off, minimal, low, medium, high, xhigh. Overrides agent default."})` | 加 `StringEnum(["off","minimal","low","medium","high","xhigh"] as const)`，描述改为 `Thinking level override. Default: inherit the agent type's setting.` |
| `get-result-tool.ts:94-95` | "…from a background agent. Use the agent ID returned by Agent with run_in_background." | `Check status and retrieve the result of a background subagent (agent_id comes from the subagent tool).` |
| `get-result-tool.ts:92` snippet | `get_subagent_result: Check status and retrieve results from a background agent.` | `Check status and retrieve a background subagent's result` |
| `steer-tool.ts:86-88` | `Send a steering message to a running agent. The message will interrupt the agent after its current tool execution and be injected into its conversation, allowing you to redirect its work mid-run. Only works on running agents.` | `Send a mid-run steering message to a running subagent.` |
| `steer-tool.ts:84` snippet | `steer_subagent: Send a mid-run message to redirect a running background agent.` | `Send a mid-run message to redirect a running subagent` |

### 6.3 `pi-ask-user`

| 位置 | 现在 | 改成 |
|---|---|---|
| description | 256（含两句重复规则 + `read/web/ref`） | `Ask the user one focused question with optional multiple-choice answers.` |
| guideline[0] | "…with tools (read/web/ref)…" | `Before calling ask_user, gather context with your read/search/web tools and pass a short summary via the context field.` |
| guideline[2]+[3] | 两条同义 | 合并为 `Ask exactly one focused question per ask_user call — never combine multiple, numbered, or unrelated questions in one prompt.` |
| 新增 guideline | — | **不新增**（外观三件已从 schema 移除，不需要“别设”提示） |
| `displayMode` / `overlayToggleKey` / `commentToggleKey` | schema 里各 200 / 196 / 201 字符 | **从 `parameters` 删除这三个键**（-782）；内部 `AskParams`、`buildCustomUIOptions`、`resolveShortcut` 与优先级链全部保留。README（EN+ZH）参数表与优先级表同步改口径 |
| `timeout` | 73 | **保留不动**（D2a 已定），仅把描述澄清为 `Auto-dismiss after N ms; returns null when expired.` |

### 6.4 `pi-web-tools`

| 位置 | 改成 |
|---|---|
| `websearch` snippet（169） | `Search the web via Exa/DeepSeek/Aliyun; returns titles, URLs, snippets`（70，含 "DeepSeek" 以满足既有测试） |
| `provider` 参数（188） | `Provider override: exa, deepseek, or aliyun. Default: fallback chain exa → deepseek → aliyun.` |
| `webfetch` snippet（81） | `Fetch a URL as readable markdown or raw body` |
| `webfetch` 的 `provider` 参数（247） | `Fetch provider: local (default) or deepseek (server-side render for JS-heavy pages; needs DEEPSEEK_API_KEY). Default: local with deepseek fallback on thin/failed response.` |

注意：`tests/tools.test.ts:45` 断言 snippet 含 "DeepSeek"，新 snippet 仍满足；若进一步压缩需同步改测试。

### 6.5 `pi-memory`

| 位置 | 改成 |
|---|---|
| snippet（152） | `Read/write persistent project memory (one memory per file)`（58） |
| `description` 参数（185） | `One self-contained line; future sessions select memories from it. Defaults to the first sentence of content.` |

7 条 guideline **不动**（`2026-10-03-memory-tool-prompt-trim-design.md` 已论证：刻意重复是有意的行为强化，且都在 prefix cache 内）。

### 6.6 `pi-coding-tools`

| 位置 | 现在 | 改成 |
|---|---|---|
| `ast-grep-search.ts` g[0] | 178，点名 "built-in grep" | `Use ast_grep_search to find code by syntax structure — it ignores comments/strings and matches across lines. For plain text use grep (or rg via bash).` |
| `ast-grep-search.ts` g[1] | 175（复述语法） | **删除**（语法已在 description + `pattern` 参数） |
| `ast-grep-search.ts` g[2] | 143 | `Patterns are AST nodes, not regex: \w, .*, [a-z], a bare alternation bar, and a trailing ':' never match; the tool hints when it detects them.` |
| `ast-grep-search.ts` g[3] | 133 | `Definitions: 'function $NAME($$$) { $$$ }' (ts/js), 'def $NAME($$$)' (py). Pass lang in mixed-language repos.` |
| `ast-grep-replace.ts` g[0]+g[1]+g[2] | 131+197+141 | 合并为两条：①`Use ast_grep_replace for structural rewrites (same $VAR/$$$ pattern rules as ast_grep_search).` ②`Every $VAR used in rewrite must be captured by the pattern — unbound ones substitute to empty and vanish silently.`（dry-run 纪律只留在 description 与 `apply` 参数） |
| `ast-grep-search.ts` / `replace.ts` 的 `lang` 参数 | 96（"Omit to infer from path extension."） | `Language: typescript/tsx/javascript/python/java/kotlin/c/cpp. Inferred from the path extension; when the path has no usable extension this falls back to typescript, so pass lang explicitly for directories.`（+120，正确性） |
| `lsp-*.ts` description | 三条各带 "Requires a language server." | 删掉该句（改为共用 guideline） |
| `lsp-*.ts` guidelines | 875 | 三条收敛：`lsp_symbols`：`Use lsp_symbols to skim an unfamiliar file's structure before reading details.`；`lsp_hover`：`Use lsp_hover to get a symbol's type or docs without reading surrounding code.`；`lsp_navigate`：`Use lsp_navigate with operation='definition'/'references' for exact cross-file resolution (resolves overloads/inheritance/typedefs; no same-name false positives).` + 一条共用：`lsp_symbols, lsp_hover and lsp_navigate need a language server; without one they return an install hint.` |
| `lsp-*.ts` 参数 | `line`/`character` 已写基准 | 保持；guideline 里的基准说明删除（R2） |

`pattern` / `lang` 的参数描述被两个工具共用 → 抽成 `src/tools/shared-params.ts` 的常量（R6）。

### 6.7 `pi-sandbox`

| 位置 | 现在 | 改成 |
|---|---|---|
| `SANDBOX_NOTE`（`tools.ts:293`） | `Sandbox: confined to the current mode; workspace-write already allows the workspace and /tmp. Unless retrying a denial, omit these fields or send JSON null.`（156×3 = 468） | `Sandbox: escalation only — omit (or JSON null) unless retrying a denial; workspace-write covers the workspace and the OS temp dir.`（130×3 = 390，回收 78；`/tmp` → OS temp dir 同时修 win32 事实错误） |

两条 guideline（`ENV_REDIRECT_GUIDELINE` / `ESCALATION_GUIDELINE`）**不动**：它们是跨工具去重的正面样板，且已有测试钉住措辞与顺序。注意其"协议行最后一条"的意图只在本工具列表内成立（宿主会按注册顺序继续追加别的工具的 guideline），这条事实写进注释即可，不改文案。

### 6.8 `pi-todo`

- description 第 3 句改为 `…so never include an id in set's items.`；
- 新增一句 `blockedBy lists ids that must be done before this task; the ack's next skips blocked tasks.`；
- 补参数描述（+180）：`action`（`set` 整表替换并重编号 / `update` 改单个 / `list` 只读）、`items`（**仅 set**，按位置分配 id）、`id`（**仅 update**，精确匹配，如 `3` 而非 `#3`）、`status`、`title`、`blockedBy`。

### 6.9 `pi-vision-tools`

| 位置 | 改成 |
|---|---|
| description（357） | `Analyze an image by delegating to a vision-capable model, so callers without vision can understand images.` |
| snippet（82） | `Analyze an image via a vision model (for callers without vision)` |
| `thinkLevel` 参数（42） | `Vision model thinking effort. Default: the /vision config default, else off.` |

3 条 guideline 保留（`compress:false` / `thinkLevel:'high'` 是决策建议，参数描述里没有 → 不违反 R2）。

## 7. 验证

1. **缺陷回归闸（W1 必做）**：新增 `pi-container-sandbox/tests/prompt-metadata.test.ts`，用最小 `ExtensionAPI` stub（需 `registerTool` / `registerFlag` / `registerCommand` / `on` / `getFlag`，参考 `pi-sandbox/tests/tools.test.ts:140-150`）捕获注册的 4 个工具，断言：
   - `read.promptSnippet === "Read file contents"`、`bash.promptSnippet === "Execute bash commands (ls, grep, find, etc.)"`；
   - `edit.promptGuidelines` 含 "Use edit for precise changes"，`write.promptGuidelines` 含 "Use write only for new files or complete rewrites."；
   - `edit.parameters.additionalProperties === false`（definition 工厂保留 base schema options）。
2. **样式闸（W2/W4）**：每包 `tests/prompt-meta.test.ts` 断言 R3/R4/R8 与预算：
   - 每个 snippet ≤80、不以 `name:` 开头、不以句号结尾、不含 `Use |Do not |Always |Never `；
   - 每条 guideline 点名所属工具（或 `sandbox` / `lsp_*` 这类明确主语），长度 ≤700；
   - 本包内 `description` 与参数描述 6-gram 重合 ≤15%；
   - 包内三通道合计 ≤ 下表上限。
3. **逐包**：`npm test -w pi-<name>`；全仓 `npm run typecheck && npm run lint`；`npm test`（`pi-container-sandbox` 的 1 条 `No container runtime available` 为本机环境性失败，与改动无关）。
4. **手工复核**：用 §10 的配方在改前/改后各 dump 一次三通道文本，确认 (a) 表中回收量对得上、(b) 没有事实在删除过程中丢失、(c) `pi-container-sandbox` 的 4 条目录项回归。

## 8. 决策记录

| # | 问题 | 结论 | 备注 |
|---|---|---|---|
| **D1** | `subagent` 的 Guidelines 块是否迁到 `promptGuidelines`？ | ✅ **已定（2026-10-30）：迁** | 删 6 条与参数重复的（516），4 条独有的迁入 guidelines，并行条目重写以修事实错误；净省 ~780。已知代价：自定义 system prompt 下这 4 条不再可见 |
| **D2** | `ask_user` 的 UI 旋钮 | ✅ **已定（2026-10-30）：方案 B**——外观三件从模型可见 schema 移除，只从 env/config 读（-782） | 内部优先级链保留，测试不改 |
| **D2a** | `timeout` 怎么处理？（它**没有** env/config 兜底：`ask-user.json` 只支持 3 个字段） | ✅ **已定（2026-10-30）：保留**——模型唯一能给自己“别无限等”设上限的手段，仅 73 字符 | 全移除需新增 `ask-user.json` 的 `timeout` 键与 `PI_ASK_USER_TIMEOUT`（-900），本轮不做 |
| **D3** | 是否顺带做 memory 的 extract 子会话精简（旧 spec 方案 1） | ✅ **已定（2026-10-30）：本轮不做** | 单开一轮时先按旧 spec §5 重建量取脚本 |
| **D4** | 是否加 per-package 预算测试 | **加**（W4） | 只写约定、不加闸门（漂移风险回到现状） |
| **D5** | 发布粒度 | **每包一个 patch release**，改完一包发一包 | 攒成一批（需求侧无收益，且 prompt 变更与功能变更混在一起难回溯） |

版本策略：本条全部是提示词文本 / 提示词元数据，无 API 与行为契约变化 → **patch**（`pi-container-sandbox` 1.2.0 → 1.2.1 属缺陷修复）。Release notes 按三节写：破坏性变更（无）/ 其它 / 验证；`pi-container-sandbox` 的修复要单独点名（用户可感知：read/write/edit/bash 重新出现在工具目录、内置编辑纪律回归）。

## 9. 被否掉的替代

1. **把所有纪律统一搬到 `promptGuidelines`**：参数级语义（默认值、取值、`edits[].oldText` 规则）会与 schema 脱节；且自定义 system prompt 下 guidelines 整体失效，硬约束会全丢。只迁"何时用/如何配合"这一类。
2. **删掉 `memory` 的四处 self-contained 重复**：`2026-10-03-memory-tool-prompt-trim-design.md` 已评估——那是刻意的行为强化，收益主要在 `extract` 子会话（每轮一次、无缓存），需先做行为确认。本轮只删 snippet 里的那一份（目录行不该承载规则）。
3. **用脚本正则扫源码做预算闸门**：脆（拼装字符串、条件拼接都可能命中不了）。每包用真实定义对象断言才可靠。
4. **把 `subagent` 的 agent 类型清单挪进 guideline**：它是 schema 数据（`subagent_type` 的取值范围），必须与 schema 同处。
5. **彻底去掉 `SANDBOX_NOTE`**：能省 468，但提权参数就失去了 schema 旁的唯一说明，模型会在没读到 guideline 的场景（自定义 system prompt）里瞎填。改为缩短 + 修正平台措辞。
6. **统一缩短全部 description 以追求最小 token**：会让模型的参数构造质量下降；本方案只删"重复"与"面向人的文案"，不删事实。

## 10. 附录：测量与复现

一次性配方（不提交进仓库；本文所有数字由此得出）：

1. 用 Node 24 直接加载 TS：`node --experimental-transform-types --import /tmp/ts-resolve-hook.mjs measure.ts`，其中 resolve hook 负责 `.js → .ts` 与省略扩展名的解析；
2. `measure.ts` 用最小 `ExtensionAPI` stub 捕获各包 `registerTool` 的定义（`pi-memory` 直接调 `createMemoryTool`，`pi-sandbox` 调 `createSandboxTools`，`pi-subagents` 调三个 `toToolDefinition()`），把 `description` / `promptSnippet` / `promptGuidelines` / `JSON.stringify(parameters)` 落到 JSON；
3. 分析脚本按通道求和、算 6-gram 重复率与跨通道重合度，并按 §3 的规则逐条比对。

测量时注意三点（否则会得出错误结论）：

- `pi-sandbox` 与 `pi-container-sandbox` 互斥装配，**不能相加**（本文基线为 sandbox 装配）；
- 指南针是"每请求"，`details` / `label` / 渲染函数都不计入；
- guideline 必须按**去重后**计（`pi-sandbox` 两条规则写进 3 个工具，raw 3567 → 实际 1551）。

基线数字（sandbox 装配，便于改后对照）：

| 包 | 工具数 | desc | params | snippet | guidelines(去重) | 合计 | 改后上限 |
|---|---|---|---|---|---|---|---|
| pi-coding-tools | 5 | 1008 | 1927 | 330 | 2134 | 5399 | 4700 |
| pi-sandbox | 3 | 1175 | 1885 | 167 | 1551 | 4778 | 4800 |
| pi-subagents | 3 | 1827 | 2198 | 224 | 0 | 4249 | 3300 |
| pi-memory | 1 | 522 | 1003 | 152 | 1137 | 2814 | 2750 |
| pi-ask-user | 1 | 256 | 1846 | 107 | 390 | 2599 | 1650 |
| pi-web-tools | 2 | 532 | 1290 | 250 | 304 | 2376 | 2150 |
| pi-todo | 1 | 437 | 527 | 59 | 422 | 1445 | 1700 |
| pi-vision-tools | 1 | 357 | 542 | 82 | 295 | 1276 | 1150 |
| **合计** | 17 | 6114 | 11218 | 1371 | 6233 | **24936** | **21519** |
| pi-container-sandbox（单独装配，W1 修复后） | 4 | 999 | 1580 | 0→**185** | 0→**594** | 2579→**3358** | 3500 |
