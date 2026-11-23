# pi-context-insight 报告 v2 需求与设计（对标 dsh-context）

状态：待批准
取代：`2026-11-22-pi-context-insight-design.md` 中第 3 节的两条非目标（「逐类别还原每次历史请求的精确 prompt 组成」「完整 transcript/Markdown 浏览器、图片附件导出或工具输出导出」）与第 5 节「方案 B 不采用」的结论。本文件批准后，v1 规格中与本文件冲突处一律以本文件为准。

---

## 1. 意图

v1 报告能回答「花了多少 token、上下文大概由什么组成、工具/文件/命令做了多少」，但它把一切都压成了表格：上下文只有一个静态组成条，时间线只有一组柱，活动只有计数，没有一个地方能回答最关键的追问——**某一次请求，模型到底看到了什么；和上一次相比，多了什么、少了什么；为什么会涨到快满。**

本次升级的对标物是 `dsh-context`（DeepSeek Harness 插件）。它的报告是一套四层叙事：

1. **总账**：token 按 8 个语义类别拆分，实际计费与本地估算并列；
2. **演进**：每一次模型请求一根柱，全量/增量两种读法，压缩/剪枝/技能/子代理/提问等事件作为里程碑钉在对应那一步；
3. **内容**：任意一次请求都可以逐条展开到底——system prompt 原文、每个工具的定义 JSON、每条消息、每次工具调用及其输出；
4. **行为**：每个文件被读/写/搜索了多少次、每行变化如何估算；每条命令的状态、退出码、耗时与程序分布；整个 Agent 家族谁在干什么。

pi 的数据结构足以支撑这四层，甚至更准（pi 逐请求持久化了 system prompt 的 `sections` 与 `toolsAdded/toolsRemoved`，逐条记录了 `durationMs`、`nestedCalls`、`usage.cost` 分项）。本次要做的是把这套叙事移植到「单个 session + 它的子 Agent」这个范围里，产出的仍然是一个离线、可双击打开的 HTML。

## 2. 目标

- G1 报告从「表格集合」变成「可下钻的仪表板」：任何数字都能点到自己对应的明细。
- G2 逐请求还原每次模型请求的上下文组成（按语义类别），并能展开到真实内容（`--short` 模式除外）。
- G3 区分「供应商上报的实际用量」与「本地估算的组成」，任何混合口径的数值都要标注来源，禁止制造虚假精度。
- G4 时间线能直接看出上下文增长与回收：全量/增量、步骤/轮次、事件旗标、峰值标注。
- G5 文件、命令、工具活动从「计数表」升级为「可按类别/路径/状态筛选、可展开操作日志、可定位到对应请求」。
- G6 子 Agent 从「折叠的独立报告」升级为「Agent 家族」：家族总览 + 每个成员的上下文/用量/步数/耗时 + 委派关系与最终回报。
- G7 仍然是单文件、离线、确定性生成；生成过程不调用模型、不访问网络。
- G8 两种输出模式：默认含原文（与 dsh 一致）；`--short` 输出无原文版，结构与筛选完全一致。

## 3. 非目标

- N1 跨 session 的洞察页（KPI 条、7 天用量、8 周热力图、会话卡片、工作区分组）。理由见 §5.4。
- N2 实时/自动刷新、常驻 TUI dashboard、侧边栏面板。
- N3 通过模型生成叙事、评价或建议。
- N4 修改 session、控制子 Agent、自动打开浏览器、上传报告。
- N5 图片二进制导出。图片只呈现元数据（尺寸、存储大小、token 估算），不内嵌 base64。
- N6 供应商余额、订阅额度、高峰/谷时计价、models.dev 价格阶梯与模糊匹配（pi 的 `model.cost` 已含最终单价，无需自建价目册）。
- N7 Agent 之间的对等通讯（dsh 的 relay/mailbox 泳道）。pi-subagents 只有「委派 → 结算」两态，没有对等消息通道。

## 4. 反目标（做得再好看也算错）

- A1 把估算组成标成 provider 实际 token，或把两者混进同一个不标注的数字。
- A2 把子 Agent 已转发的用量与子报告用量重复计入父总量。
- A3 恢复旧 session 时把「无完成记录」的子会话断言为运行中或已完成。
- A4 `--short` 模式下 HTML 内出现任何 prompt / 消息正文 / 工具输出 / 命令输出 / 文件内容片段。
- A5 任何来自 session 的文本未经转义进入 HTML，或通过 `JSON.stringify` 直出导致 `</script>` 逃逸。
- A6 生成报告时发起模型请求、网络请求或读取 session 之外的无关文件。
- A7 明细被截断却不标注，让读者以为看到的是全部。
- A8 单个子 session 损坏就让父报告失败。

## 5. 对标结论：dsh-context 的能力取舍

### 5.1 采纳矩阵（区块级）

| dsh 区块 | dsh 的核心内容 | pi 判定 | pi 落地方式与差异 |
|---|---|---|---|
| Context Stats（上下文统计） | 轮次/步数/技能加载/模型回复四个可跳转数字；注入/压缩/剪枝事件 pill；工具调用 chip 泳道；命令执行 chip 泳道；家族 token/费用对；用户/读取/写入/搜索/图片 chip | **采纳** | 数字与 chip 同构；「技能加载」改为「技能注入」事件计数；家族改为「父 + 子 Agent」两行 |
| Token Stats | 环形图 + 分类行（`≈` 估算）+ 缓存命中角标 + 工具/思考/回复三分 | **采纳** | 分类从 7 类扩到 10 类（pi 的 system 有 6 个命名 section）；助手回复用 provider 的 `usage.reasoning` 精确切分思考 |
| Timing Stats | 模型等待 → 思考/回复/参数 → 工具执行 → 其他开销；TPS 角标；耗时时间轴 | **采纳（降级）** | pi 有逐请求 `durationMs` 与逐工具 `durationMs`，模型/工具两段比 dsh 更准；但 pi 没有 TTFT 与块级时间，**不拆**思考/回复/参数三段，模型侧只有一段；TPS 口径改为「输出 token / 请求耗时」并标注含排队与思考 |
| Current Context | 窗口占用 + 七类堆叠条 + 压缩预留/输出预留两块斜纹 + 自动压缩触发线 | **采纳** | 预留来自 pi 的 `compaction.reserveTokens`（默认 16384）与 `model.maxTokens`；触发线 = `window − reserveTokens` |
| Context Timeline | 逐请求堆叠柱；步骤/轮次；全量/增量；事件旗标带；悬停/固定；总览 ribbon；类别联动 | **采纳** | 旗标类型按 pi 事件重写（见 §7.7）；轮次由 user 输入边界推导（pi 无 provider turn id） |
| 请求详情（步简报） | 三行：User / In（新增内容）/ Response | **采纳** | 「In」直接由相邻步骤的条目差集给出，比 dsh 更准；chip 可点定位到浏览器 |
| Context Browser | 7 类可折叠 → 逐项 token → 展开真实内容；工具来源 chip；按类型筛选回复；工具结果带调用参数与 OK/error；附件卡；与上一轮差异；DNA 模式；矩形树图 | **采纳（核心价值）** | 10 类；工具来源 chip 用 `ctx.getAllTools().sourceInfo`（user/project/builtin + 包名）真实可得；附件只到元数据；树图降为可选增强 |
| Context Events | 5 类过滤 tab + 行（类型/文案/位置 T-S/带符号 token/时间）+ 可跳转 | **采纳** | 事件类型按 pi 重写（§7.9） |
| File Activity | 5 类 chip + 路径搜索 + 5 种排序 + 每文件 +/- 行数 + 展开操作日志 + 定位 | **采纳** | 工具映射见 §7.10；搜索结果按行解析归到各文件 |
| Command Executions | 4 类过滤 + 左栏摘要/值得注意/程序分布 + 行（状态/退出码/耗时/定位）+ 展开命令与结果 | **采纳（降级）** | 无「后台」分类（pi 无 job 模型）；结果正文在 `--short` 下不出现 |
| Fleet（Agent 网络） | 家族图、每 Agent 卡片（上下文/窗口/构成/时长/步数）、连线、泳道、协作任务、事件检查 | **降级采纳** | 采纳：家族总览卡 + 成员卡 + 委派表（任务简报 + 最终回报）。不采纳：泳道、协作任务、事件检查中对等通讯（pi 无此数据） |
| Insights（跨会话洞察页） | KPI、7 天用量、热力图、技能/工具/命令 tally、会话卡片、分组/归档 | **不采纳（本轮）** | 见 §5.4 |
| Plugin Info / Recom / Balance / UpdatePill | 插件设置、赞助卡、余额、新版本 | **不采纳** | 与包无关 |
| 系统提示词前缀/后缀设置 | 拼接 prompt | **不采纳** | pi 已有 append/override 机制，不是报告职责 |
| i18n（8 语言） | 宿主语言驱动，全量文案字典，缺键回落 | **降级采纳（运行时切换）** | pi 无 locale 服务，因此把 `en` + `zh` 两份字典内联进 HTML，页头语言按钮切换 + `localStorage` 记忆；首开语言 = `--lang` → `LANG`/`LC_ALL` 启发式 → `en`。时间格式固定 24 小时制（不随语言变），金额只显示记录值，不做汇率换算 |

### 5.2 值得照抄的细节（不是区块，是口径）

1. **估算密度固定且公开**：dsh 用 4 字符/token、role overhead 4、block overhead 4，并在页脚声明。pi 直接用宿主同一套 `@earendil-works/pi-ai/utils/estimate`（`estimateMessageTokens` 等），因此报告估算与输入框旁上下文环一致——比 dsh 更强的一致性保证，必须在页脚写明。
2. **「≈xx」与「实际 xx」两种前缀**：估算值前缀 `≈`，供应商上报值前缀「实际」；混合口径（把估算按比例锚定到实际总量）在悬停提示里说明。
3. **空闲剔除**：相邻事件间隔 ≥120s 视为用户离开，不计入活跃时长。
4. **缓存命中定义**：`cacheRead / (uncachedInput + cacheRead + cacheWrite)`，保留两位小数；分母为 0 显示 `—`。
5. **增量模式的语义**：增长堆叠在基线上方，压缩向下延伸；分类行给出 `+N 项 / ±Nk token` 的带符号徽章。
6. **DNA 模式**：把所有条目按模型读取顺序摊平成一维列表（最新在上），每行带位次、类别、进入步骤、token；点击定位。
7. **每个空态都有具体文案**，不是空白，也不是「No data」。
8. **截断必须可见**：`另有 n 条未显示` / `内容已截断` / `仅覆盖最近 n 次执行`。
9. **里程碑是 Top-1 峰值**（耗时最长一步、单步新增最多一步），不是四分位标记。

### 5.3 dsh 有、pi 做不了的（明确标注为不可用）

| 能力 | 原因 | 报告中的表现 |
|---|---|---|
| 工具定义的「注册插件」精确来源 | pi 的 `ToolInfo.sourceInfo` 给的是 `{path, source, scope, origin}`（user/project/builtin + 包名），不是任意运行时插件 id | 显示为 `builtin` / `user` / `project` + 包名或路径，不伪造插件名 |
| 计划模式切换事件 | pi transcript 无 plan mode 事件 | 不呈现 |
| 目标创建/完成、待办新增/完成 | pi 无会话内持久化（pi-todo 的看板不落 entry） | 由 transcript 里的 `todo` 工具调用推导（§7.9），标注为「由工具调用推导」 |
| 团队任务、邮箱、Agent 对等通讯 | pi-subagents 无此模型 | 不呈现 |
| DeepSeek 官方图片 token 换算 | pi 无官方换算表 | 用 pi 自己的图片估算（`estimateTextAndImageContentTokens`），标注为估算 |
| 上下文窗口权威投影（`contextPressure`） | pi 只有 `getContextUsage()` | 用 `getContextUsage()`；为 null 时按 §6.5 推导并标注 |

### 5.4 为什么本轮不做跨会话洞察页

dsh 的洞察页依赖宿主提供的东西：会话注册表（含归档状态、工作区分组、父子关系、运行态）、可增量补算的投影缓存、以及一个能容纳几十个会话卡片的长期页面。pi 只能靠扫描 `~/.pi/agent/sessions/` 重建这些信息，而这会把 `/insight` 从「当前会话的一条命令」变成「一次全库扫描」：耗时、隐私边界、增量缓存都完全不同，属于另一个产品。

先做单会话。若 v2 落地后仍需全局视图，作为独立命令（例如 `/insight:usage`）单独立项，届时再决定扫描范围与缓存策略。

## 6. 数据基座：pi → 报告的字段映射

### 6.1 来源清单

| 来源 | 用途 |
|---|---|
| `ctx.sessionManager.getEntries()` | 全量账本：usage、活动、事件、子 Agent 完成记录（含其他分支与已压缩历史） |
| `ctx.sessionManager.getBranch()` | 当前叶子路径：步骤重建与当前投影 |
| `ctx.sessionManager.buildSessionProjection()` / 导出函数 `buildSessionProjection(entries, leafId)` | 当前上下文组成；逐步骤重建时以 `leafId = 该 assistant entry 的 parentId` |
| `ctx.sessionManager.getTree()`、`getLabel()`、`getHeader()`、`getSessionId()`、`getSessionFile()` | 分支、书签、元数据 |
| `ctx.getContextUsage()` | 宿主口径的当前占用：`{tokens, contextWindow, percent}` |
| `ctx.getSystemPromptOptions()` | 命名 section 的语义来源（skills、contextFiles、toolSnippets、guidelines、append） |
| `ctx.getAllTools()` | 工具 `description/parameters` 与 `sourceInfo` |
| `ctx.model`、`ctx.thinkingLevel`、`ctx.getSettings()` | 窗口/最大输出/单价、思考级别、compaction 预留 |
| 子 session JSONL（现有 `loadSubagentSessions`） | 子 Agent 报告与家族卡 |

### 6.2 单条 entry 能给出的量

| entry / message | 可用字段 | 用于 |
|---|---|---|
| `message`(system) | `content`、`sections`（命名段落补丁，`null` = 删除）、`toolsAdded`（完整工具定义数组）、`toolsRemoved` | 逐步重建 system prompt 与工具集 |
| `message`(user) | `content`（text/image 块）、`timestamp` | 用户消息类、轮次边界、图片计数 |
| `message`(assistant) | `content`（text/thinking/toolCall 块）、`usage{input,output,cacheRead,cacheWrite,cacheWrite1h,reasoning,totalTokens,cost{input,output,cacheRead,cacheWrite,total,totalFromProvider}}`、`stopReason`、`timestamp`(请求开始)、`durationMs`、`provider/model/responseModel`、`thinkingLevel`、`errorMessage` | 步骤、实际用量、耗时、模型切换、正文 |
| `message`(toolResult) | `toolCallId`、`toolName`、`content`、`details`（各工具自定义：`truncation`、`diff`、`patch`、`fullOutputPath`）、`nestedCalls{status,durationMs,arguments|argumentsBytes}`、`isError`、`timestamp`、`durationMs` | 工具结果类、工具耗时、文件/命令操作来源、嵌套调用 |
| `message`(bashExecution) | `command`、`output`、`exitCode`、`cancelled`、`truncated`、`excludeFromContext` | 用户 `!` 命令（命令活动） |
| `custom_message` | `customType`、`content`、`display`、`details` | 注入上下文类；`customType` 含 `skill` 时归入技能注入 |
| `branch_summary` / `compaction` | `summary`、`tokensBefore`、`usage`、`systemMessage`（compaction 边界的完整 system 快照）、`fromHook` | 压缩/分支事件与边界快照 |
| `context_edit` | `targetId`、`replacement`（`null` = 从上下文移除） | 上下文编辑事件（prune/改写） |
| `model_change` / `thinking_level_change` | provider/modelId、thinkingLevel | 事件 |
| `custom` + `customType === "subagents:record"` | `id/type/description/status/result/error/startedAt/completedAt/toolUses/modelName/thinking/outputFile/lifetimeUsage/lifetimeCost` | Agent 家族与委派表 |
| `label` / `session_info` | `targetId`+`label` / `name` | 书签与标题 |

### 6.3 逐步骤重建（v1 已明确列为非目标，v2 的核心）

对当前分支按 order 走一遍，维护一份「模型可见状态」`S = {system, tools, messages}`：

1. `system` 的演进：`content` 累加；`sections` 按名覆盖，值 `null` 删除该段；`toolsAdded` 覆盖同名工具，`toolsRemoved` 移除。遇到 `compaction` entry 且其 `systemMessage` 存在时，以该快照重置 `system` 与 `tools`。
2. `messages` 的演进：`user/assistant/toolResult/custom_message/branch_summary` 直接追加（`compaction` 追加其摘要消息）；`context_edit` 记入编辑表，作用于 `targetId` 之后的所有步骤（与宿主 `projectContextEntry` 语义一致：`replacement === null` 表示该 entry 不再进入上下文）。
3. 遇到 `compaction` entry：`messages` 重置为 `[compactionSummary]`，随后从 `firstKeptEntryId` 开始重放被保留的 entry。
4. 每条 `assistant` entry：在追加它自己之前，把 `S` 的**结构快照**记为第 i 步（`stepItems[i]` 用「条目 id + 块索引」引用，不复制文本）。
5. 分类 token 只在条目首次出现时计算一次；每步的分类和用增量维护（追加加、压缩重置、编辑减），整体 O(n)。

当前分支上的**每一步都可以精确重建**：`getBranch()` 返回压缩前的全部 entry，压缩只改变投影、不删除 entry。因此不存在「压缩前步骤只能是近似值」的降级路径——压缩前步骤的构成与正文与当时一致，浏览器照常展开。（`当前上下文` 卡片仍只能用压缩后的投影，那是另一件事。）

必须存在的降级只有两条：

- 若某步拿不到 system（旧 session 从无 system entry，且其后也没有 compaction 快照）：`system` 类标为 `未知`（`—`，不是 0）并给出 warning；`toolDefinitions` 同样标未知。
- **请求时注入不可还原**：扩展可以在 `context` / `before_agent_start` hook 里对请求追加消息或改写 system prompt，这些内容不落 transcript。因此「估算合计」会系统性低于「实际 prompt」。报告不隐藏这一差值（见 §7.2 的 `unattributed` 类），并在当前上下文与数据说明里写明原因。

### 6.4 步骤与轮次

- **步骤（step）** = 一条 assistant entry = 一次模型请求。序号 `S1..Sn`，按当前分支顺序。
- **轮次（turn）** = 一次「用户侧输入」开启的一段：`user`、`custom_message`、`bashExecution`（`excludeFromContext !== true`）、`branch_summary` 都是轮次起点；其后直到下一个轮次起点前的所有步骤属于该轮。序号 `T1..Tm`，每轮内步骤 `S1..Sk`。
- 标签统一写作 `T{t} · S{s}`（全量序号）与「第 t 轮 · 第 s 步（共 n 步）」（相对序号）。pi 没有 provider 的 turn 标识，报告不得暗示这是供应商维度。

## 7. 报告规格

### 7.0 形态与总体结构

- 单文件 HTML：内联 CSS + 内联 JS + 内联 JSON 数据；无网络请求、无外部字体/图片/脚本；CSP 见 §10。
- 顶部固定工具条：报告标题 + 模式徽章（`完整` / `精简`）+ session 名 + 目录 + 10 个区块锚点（总览 / Token / 耗时 / 当前上下文 / 时间线 / 浏览器 / 事件 / 活动 / 家族 / 说明）+ 语言切换（`EN` / `中文`）+ 模式说明。
- 主体分区自上而下：
  1. 会话总览（元数据 + KPI 条 + 账本）
  2. Token 统计
  3. 耗时统计
  4. 当前上下文
  5. 上下文时间线 + 请求详情（两者联动，粘在一起）
  6. 上下文浏览器
  7. 上下文事件
  8. 文件活动 / 命令执行 / 工具（三卡）
  9. Agent 家族（无子 Agent 时整块隐藏）
  10. 数据说明与隐私
  11. 警告面板（warning 非空时固定出现在顶部工具条下方，最多展开 8 条，其余折叠；与数据说明里的截断清单分开：warnings 记「数据不可得/损坏」，截断清单记「数据被裁剪」）
- 联动是全报告同一份状态：`selectedStep`、`hoverCategory`、`eventFilter`、`fileFilter`、`commandFilter`、`browserMode`、`browserBase`、`dnaMode`。点时间线的柱 → 浏览器切到该步；点 Token 分类行 → 时间线高亮同类、浏览器展开同类；点文件操作 → 浏览器定位该工具结果。完整链路见 §9。

### 7.1 会话总览

| 单元格 | 内容 | 口径 |
|---|---|---|
| Session | `session_info.name` ?? `Session <id>` | — |
| Session ID / 文件 | `id` / `sessionFile` ?? `—`（内存 session） | — |
| 工作目录 | `cwd` | — |
| 模型 | `provider/model`，并显示 `responseModel` 若不同 | 取最后一条 assistant |
| 思考级别 | `thinkingLevel` | 当前投影 |
| 时间范围 | 首条 entry 时间 → 最后一条（含耗时） | 见 §8.4 |
| 分支 | 当前分支条目数 / 全量条目数；有其他分支时提示「统计含其他分支」 | `getBranch()` vs `getEntries()` |
| 生成时间 | `generatedAt`（ISO 本地时区偏移保留） | — |

KPI 条（6 格，每格 = 小标签 + 大数值 + 次行）：

1. **总 token**：`Σ(input+cacheRead+cacheWrite+output)`；次行 `prompt / output` 拆分。
2. **成本**：`Σ usage.cost.total`；次行口径（`供应商上报 n/m`、`目录估算`、`混合`）。
3. **缓存命中**：`ΣcacheRead / Σ(cacheRead+input+cacheWrite)`；次行 `缓存读 xx k / 缓存写 yy k`。
4. **模型调用**：assistant 条数；次行 `轮次 t · 工具调用 n`。
5. **活跃时长**：`wall − idle`；次行 `模型 x · 工具 y`。
6. **子 Agent**：数量；次行 `转发用量 / 独立账本` 两数并列（见 §7.11）。无子 Agent 时该格显示 `0`，次行留空。

账本卡（沿用 v1，收敛为一行摘要 + 可展开明细）：session 总量、`Parent direct`、`Subagents forwarded`、分模型表（模型 / prompt / output / 缓存命中 / 成本 / 口径）、逐条 usage 记录（时间 / 来源 / 模型 / prompt / output / 成本，最多 200 条，超出显示「另有 n 条」）。

### 7.2 Token 统计

**目的**：一眼看出计费 token 用在哪。

构成：

- 环形图（`≈` 中心总量 = `input+output`）。
- 右上角角标：`缓存命中 xx.xx%`，悬停提示「整个 session 累计的缓存读取占计费输入的比例」。
- 右侧分类行（固定顺序，0 也显示但变暗）：

| key | 标签（en / zh） | 来源 | 估算方式 |
|---|---|---|---|
| `system.base` | System prompt / 系统提示词 | system message 的 `content`（或首条 system 减去各 section） | 文本估算 |
| `system.tools` | Tool index / 工具索引 | `sections.tools`（工具名 + 一句 snippet）+ `sections.rules`（工具规则） | 文本估算 |
| `system.project` | Project context / 项目上下文 | `sections.project_context`（AGENTS.md 等 context files） | 文本估算 |
| `system.skills` | Skill catalog / 技能目录 | `sections.skills` | 文本估算 |
| `system.docs` | Harness docs / 宿主文档 | `sections.docs` | 文本估算 |
| `system.other` | Other sections / 其他段落 | 其余 section（`addendum`、扩展注入的命名 section、`cwd`） | 文本估算 |
| `toolDefinitions` | Tool definitions / 工具定义 | `toolsAdded` 中工具定义的 JSON | `JSON.stringify(tool)` 估算，逐工具可见 |
| `user` | User messages / 用户消息 | `user` 消息文本 + 图片 | 文本/图片估算 |
| `injected` | Injected context / 注入内容 | `custom_message`（非 skill 类）、`branch_summary` | 文本估算 |
| `skillInjections` | Skill injections / 技能注入 | `custom_message` 且 `customType` 含 `skill`；工具结果为 `read` 且路径命中技能文件 | 文本估算 |
| `compaction` | Compaction summaries / 压缩摘要 | `compactionSummary` 消息 | 文本估算 |
| `reasoning` | Model thinking / 模型思考 | assistant `thinking` 块 | 文本估算；行尾追加「实际 n」，取 `usage.reasoning` |
| `answers` | Model answers / 模型回复 | assistant `text` 块 | 文本估算 |
| `toolCalls` | Tool calls / 工具调用 | assistant `toolCall` 块（名称 + 参数） | 估算 |
| `toolResults` | Tool results / 工具结果 | `toolResult` 消息内容 | 估算 |
| `unattributed` | Unrecorded at request time / 请求时注入（未记录） | 无从还原：`实际 prompt − 该步估算合计` | 差值本身，仅在 > 0 且超过估算合计 2% 时显示，行尾加 `?` 悬浮说明 |

- 合计行：`≈ 估算合计` 与「实际计费 n」并列；两者差值在悬停时说明「provider 序列化、缓存、末尾估算差异，以及不落 transcript 的请求时注入」。
- `unattributed` 是唯一可以「只出现在部分步骤」的类别：没有 usage 的步骤不显示，差值为负或不足 2% 时不显示。它**不参与**估算合计，也不参与成本分摊；出现时必须同时给出解释文案。
- 每行右侧：占比 + 该类的实际成本分摊（见 §8.3），悬停显示「成本为按 token 占比分摊的估算」。
- `--short` 模式：行与数值完全一致，只是不能展开到正文。

### 7.3 耗时统计

- 环形图分段（顺序固定，共三段 + 一段余量）：**模型耗时 → 工具执行 → 其他开销**。pi 不提供 TTFT 也不提供块级时间，因此模型侧**不拆**思考/回复/参数；环图与图例里不得出现这三段（§5.1 已声明该降级）。
- 中心：活跃时长；角标：`输出速度 xx tok/s`（`Σoutput / Σ模型耗时`，悬停写清「含排队与思考，不是解码速度」）。
- 右侧行：占比 + 时长 + 次数（模型：n 次；工具：n 次）。「其他开销」行只显示占比与时长。
- 下方耗时时间轴：把每步的活跃时长按发生顺序紧凑铺成一条带（宽度为占比），5 个刻度（0/25/50/75/100%），悬停显示「第 t 轮 · 第 s 步 · 时长 · 开始时间」，点击选中该步。
- 工具段悬停若存在嵌套调用：提示「包含嵌套调用；嵌套调用时长不再重复计入合计」。
- 估算来源标注：任一数值来自「相邻条目时间差」而非 `durationMs` 时，加 `≈` 前缀并在悬停说明。

### 7.4 当前上下文

- 标题行右侧：`provider · model (thinking)`。
- 数字行：`实际/估算 tokens` / `窗口 tokens` · `占用率 %`。
  - `tokens` 取 `getContextUsage().tokens`；为 `null` 时用「最后一次请求的实际 prompt + (当前估算合计 − 该步估算合计)」，并加 `≈` 前缀与提示「compaction 后、下一次响应前宿主不提供占用值」。
- 堆叠条（高 16px，基准 = 窗口）：
  - 段为 §7.2 的类别（0 值不画），悬停显示「类别 · ≈tokens · 占已用上下文 % · 占窗口 %」。
  - 右侧留白 = 剩余窗口（悬停显示数值与占比）。
  - 斜纹预留区一：`压缩预留空间` = `settings.compaction.reserveTokens`（默认 16384）；悬停说明「`shouldCompact` 在 tokens > 窗口 − 预留 时触发」。
  - 斜纹预留区二：`模型最大输出预留` = `model.maxTokens`（大于窗口时按窗口截断并在悬停说明）。
  - 触发线：`窗口 − reserveTokens`；若落在预留区之前，额外画一条竖线，悬停显示阈值与占比。
  - 压力配色：占用 ≥90% 红、≥70% 琥珀、否则绿（用于边框与数字）。
  - `settings.compaction.enabled === false` 时：不画压缩预留与触发线，改为一行说明「自动压缩已关闭」。
- 图例行：每类一颗 chip（色点 + 标签 + `≈n` + 占已用 %），悬停联动堆叠条与时间线同类高亮，点击 → 浏览器展开该类。

### 7.5 上下文时间线

**柱状图**

- 每根柱 = 一步（或一轮，取决于粒度）。柱宽 14px、间距 2px、绘图高 112px；段高按该步总量归一。
- 左轴 5 档（`max`、`3/4`、`1/2`、`1/4`、`0`）；增量模式下轴值带符号。
- 开关（互斥关系明确）：
  - `步骤 / 轮次`（默认步骤）
  - `全量 / 增量`（默认全量）
  - `自适应`：按当前可视范围重算高度；切到增量时自动开启（可手动关）
  - `总览`：把全部步骤压到可视野宽度的连续堆叠带（ribbon），不横向滚动；与 `DNA`、`自适应` 互斥；步骤数 ≥100 时首次自动开启
  - `耗时`：叠加每步活跃时长曲线（右轴）
- 轮次色带：柱下方一行，每轮一个可点块（交替底色），块内显示轮次号；点击 → 切到轮次粒度并居中该轮。
- 每 5 根柱一个序号旗标（`S5`、`S10`…）。
- 悬停 tooltip（跟随滚动，固定在图表上方）：
  - 标题：`第 t 轮 · 第 s 步（共 n 步）`；轮次粒度：`第 t 轮 · 共 n 步`。
  - 指标：全量 `合计 ≈ n`；增量 `Δ +n`；开启耗时时追加 `耗时 x`。
  - 实际值：`实际 prompt n · 输出 n · 缓存 xx%`（该步有 usage 时）。
  - 事件：该步命中的事件名列表（≤3 条，超出 `+n`）。
- 点击柱：选中/取消，联动请求详情与浏览器。

**事件旗标带**

- 每个事件是「圆形图标 + 竖杆 + 脚点」，落在它所属的步骤上；同一目标点的多个事件合并为一枚（角标显示数量），相邻 <14px 的再打包为簇（悬停提示「已合并相邻旗标」）。
- 图标与语义（按 pi 事件重写）：

| 事件 | 图标语义 | 数据来源 |
|---|---|---|
| 压缩 | 剪刀（红） | `compaction` entry；悬停显示「压缩：移除 n 条消息、摘要替换后净减 x token」 |
| 上下文编辑 | 橡皮（violet） | `context_edit` entry；目标被移除或替换，显示 ±token |
| 分支摘要 | 分叉（灰蓝） | `branch_summary` entry |
| 技能注入 | 橙 | §7.9 的技能注入事件 |
| 委派子 Agent | 绿（`+`） | `subagents:record` 中该步附近的创建记录（`startedAt` 落点） |
| 子 Agent 完成 | 绿点（`✓`） | 同上，`completedAt` 落点 |
| 模型切换 | 灰（⇄） | `model_change` entry；悬停 `旧 → 新` |
| 思考级别切换 | 灰（◐） | `thinking_level_change` entry |
| 向用户提问 | 琥珀（`?`） | `ask_user` 工具调用 |
| 待办变更 | 靛（☑） | `todo` 工具调用（`set` 计新增、`update` 计完成），标注「由工具调用推导」 |
| 耗时最长 | 蓝（⏱） | Top-1 `activeMs` |
| 单步新增最多 | teal（↗） | Top-1 正增量 |

- 悬停旗标：标题 + 逐条事件（`压缩 −12.3k` / `模型：a → b` / `向用户提问 · ×2`）+ 「点击查看该步」。
- 点击旗标：选中该步、关闭总览、切回步骤粒度并滚动到时间线。

**请求详情**（时间线卡下方，随悬停 > 选中 > 最新而变）

1. 头行：`第 t 轮 · 第 s 步（共 n 步）`；若该步是压缩/编辑边界，附 `✂ T t S s` 标签；增量模式加 `增量` 标签；右侧时间 `HH:MM:SS`。
2. 指标行：增量 `Δ +n`；全量 `实际 n · 输出 n · 缓存 xx%`。
3. 步简报三行（每行可点，定位到浏览器）：
   - `用户`：开启该轮的那条消息（标签 + 文本预览，≤120 字）。
   - `输入`：上一步回复之后、本步发出之前新进入上下文的条目（工具结果、注入消息等），最多 3 个 chip，超出 `+n`；无新增显示「（无新增）」。
   - `回复`：本步产出的内容（文本 / 工具调用名 `a › b` / 思考），最多 3 个 chip。
4. 细堆叠条（高 10px，无 tooltip）+ 图例（增量模式显示带符号）。

### 7.6 上下文浏览器（核心）

**头部控件**

- 步骤选择器：默认为 `当前`（下一次请求）；可选任意历史步骤（搜索框过滤，最多 500 项，超出以选中项为中心截取）。选项文案 `T3 · S2`。
- `全量 / 增量`：增量展示相对基线的新增条目。
- 对比基线：`比前步` / `比前轮`（默认前步）。
- `DNA 模式`：平铺列表。
- 元信息行：`第 t 轮 · 第 s 步（共 n 步）`、时间、`估算合计 ≈ n`（增量模式改「新增 ≈ a / 合计 n」）、`实际 n`（该步 `usage.prompt`）、加载中省略号不需要（静态报告）。
- 迷你堆叠条（高 10px）：与分类行联动，DNA 模式按条目绘制（极小条目给最小宽度）。

**分类列表**（固定顺序 = §7.2 的类别顺序，`system.*` 全并成一行 `系统提示词`，但展开后按 section 分组）

| 行 | 计数列 | token 列 | 展开后 |
|---|---|---|---|
| 系统提示词 | 段落数 | `≈n`（占比） | 每个 section 一段：名称、`≈n`、正文（`原文 / Markdown` 切换、复制、查找）；`--short` 下只显示名称与 token |
| 工具定义 | 工具数 | `≈n` | 工具行：名称、`≈n`、来源 chip（`builtin` / `user` / `project` + 包名或路径）、调用次数；展开显示描述、参数表（名称/类型/必填/描述）、原始 JSON（折叠） |
| 用户消息 | 条数 | `≈n` | 每条：时间、`T/S` 首次进入步、预览、`≈n`；展开显示正文与图片卡 |
| 注入内容 | 条数 | `≈n` | 同上；tag 显示 `customType` 或 `分支摘要` |
| 技能注入 | 条数 | `≈n` | 同上；tag 显示技能名（从内容首个标题或路径推导） |
| 压缩摘要 | 条数 | `≈n` | 摘要正文 |
| 模型思考 | 条数 | `≈n` | 每个 thinking 块 |
| 模型回复 | 条数 | `≈n` | 每个 text 块；kind chip：`思考 / 工具 / 回答` 带计数，可单击筛选 |
| 工具调用 | 次 | `≈n` | 每次调用：工具名、参数（JSON 折叠）、配对结果状态 |
| 工具结果 | 条 | `≈n` | 每条：工具名 + 参数摘要 + `正常/失败` + 输出正文（`原文 / Markdown`）+ 图片卡；行首插「← 调用卡」显示参数与状态 |
| 请求时注入（未记录） | — | `n` | 无条目可展开：只显示差值 + 解释「实际 prompt 比可还原内容多 n token：扩展在请求时注入的内容不落 session」；<2% 或无 usage 时该行不渲染 |

- 增量模式：每行显示 4 个带符号徽章（`+2 项`、`−1 项`、`+1.2k`、`−340`），有变动的行加左侧竖线。
- 每类有独立搜索框（占位文案按类别：`按消息内容过滤…` / `按工具或参数过滤…` / `按回复、调用或思考过滤…`）；工具类还有排序（按调用次数 / token 大小 / 名称）。
- 条目行结构：展开箭头 + 类别色点 + tag chips + 预览（≤120 字）+ 次行（时间 + `T/S` + `≈n`）。
- `--short` 模式：条目行只保留结构字段（类别 · tag · `≈n` · `T/S` · 配对关系 · OK/error），正文位置显示「精简模式未包含原文」。short 模式的白名单与黑名单见 §10.1，**数据模型里不存在正文字段**。

**近似与缺失提示**（必须显式）

- 步骤超出报告的内容窗口：「该步骤的条目明细超出本次报告窗口，仅提供合计（步骤 n/共 m）」→ 该步的分类行只有 token 与占比，不展开。
- 条目正文被裁剪：「内容已截断（原文 n 字符）」。
- 旧 session 无 system entry：「该会话未记录系统提示词，系统提示词与工具定义无法还原」。
- 存在 `unattributed` 差额：「该步实际 prompt 比可还原内容多 n token：扩展在请求时注入的内容不落 session」。

**DNA 模式**

- 全量条目按读取顺序摊平，列表倒排（最新在上），每行：类别 chip + 位次 `#37` + tag + 预览 + `≈n`。
- 搜索一次过滤全部条目；命中工具名或系统提示词文本时，尾部补两行组行（`工具定义 · n 项` / `系统提示词`）。
- 悬停行点亮时间线同类段与堆叠条同一条目；点击定位该行并展开。

**矩形树图（可选增强，不阻塞验收）**

- 两级：外层类别（面积 = 该类 token 和），内层条目（同 tag 合并，标注 `×n`）。
- 悬停显示 `类别 · ≈n · 占比 · n 项`；点击分类头展开该分类，点击块直接展开该条目。
- 空间不足或条目 <5 时退化为分类列表（不画空树图）。

### 7.7 上下文事件

- 过滤 tab：`全部 / 压缩 / 编辑 / 分支摘要 / 模型 / 注入 / 工具推导`，每个 tab 带全量计数。
- 行：图标 + 类型 chip + 文案 + 位置（`T3 S2`，压缩/编辑显示 `T3 S2→S5` 区间）+ 带符号 token（注入 `+n`，压缩/编辑 `−n`，且 `gross ≠ net` 时悬停显示「移除 gross / 净减 net」）+ 时间。
- 文案模板：
  - 压缩：`压缩上下文（摘要替换 n 条消息）`
  - 编辑：`改写上下文条目（目标 T t S s）` / `移除上下文条目`
  - 分支摘要：`分支摘要（来自 T t S s）`
  - 模型：`模型切换：a → b`；`思考级别：high → low`
  - 技能：`技能注入 · <name>`
  - 注入：`注入 · <customType>`
  - 委派：`委派子 Agent · <description>`
  - 完成：`子 Agent 完成 · <status>`
  - 提问：`向用户提问 · ×n`（附问题前 60 字）
  - 待办：`新增待办 · ×n` / `完成待办 · ×n`（附条目名）
- 可点行：压缩/编辑/分支 → 选中对应步并滚动时间线；注入/技能 → 浏览器展开对应条目。
- 空态：`暂无上下文事件（压缩、注入、模型切换会出现在这里）`。

### 7.8 工具卡

v1 已有，按 v2 补两项：

- 每行可展开「按步骤分布的迷你条形 + 首次/最近使用步」。
- 列：工具 / 来源（`builtin`/`user`/`project`）/ 调用 / 正常 / 失败 / 缺结果 / 未完成 / 累计耗时（含估算标记）/ `≈token 占比`（工具调用参数 + 结果）。

### 7.9 文件活动

- 分类 chip（带操作次数）：`全部 / 读取 / 写入 / 搜索 / 图片`；路径搜索；排序（按次数 / 按行数 / 按最新 / 按路径 / 按文件名）。
- 每文件一行：图标（按扩展名）+ 路径（目录灰、文件名亮）+ 三类徽章（读/写/搜索，>0 才显示）+ `+新增 −删除` 行数 + 最近操作时间。
- 展开：操作日志（按时间倒序）——工具名、命中数或读取范围（`>>12–40` / `≈40`）、`+a −r`、错误标记、`T/S · HH:MM:SS`、`在浏览器中查看` 按钮。
- 行数估算规则（与 dsh 对齐、按 pi 工具参数改写）：

| 工具 | added | removed |
|---|---|---|
| `edit` | `Σ lines(edits[].newText)` | `Σ lines(edits[].oldText)` |
| `write` | `lines(content)` | 0 |
| 其它 | 0 | 0 |

- 搜索归属：`grep` 结果按 `path:line: text` 解析归到各文件（`hits = 匹配行数`）；`find` 结果每个路径一条（`hits = 0`）；`ls` 归到目标目录一条。解析失败则整条记为 `grep` 目标路径一条并标注「未按文件拆分」。
- 图片：`read` 结果为图片、或 `user` 消息含 `image` 块时计入；图片只显示尺寸/大小/token 估算。
- 联动：从 Token 卡片的「读取/写入/搜索/图片」chip 点入时自动切到该类并滚动到本卡。
- 空态：`该范围内没有文件读取、写入或搜索操作` / `没有匹配当前过滤条件的文件`。

### 7.10 命令执行

- 过滤 tab（带计数）：`全部 / 失败 / 慢（≥10s）/ 嵌套`；搜索框（命令、说明、工作目录、程序名）。
- 左栏（整段会话累计，不随右侧筛选变化）：
  - 摘要：运行记录 / 合计耗时 / 失败数（+占比）/ 嵌套调用数。
  - 值得注意（可点击应用对应筛选）：最慢、失败最多（程序）、重复最多（命令）、最长输出。
  - 程序分布：程序名 + `×n` + `· n 条记录` + 占比条；点击筛选该程序，再次点击取消。
- 主列行：展开箭头 + 状态字形（`✓` 完成 / `✕` 失败 / `⏹` 取消 / `⏳` 无结果）+ 工具徽章（`bash` / `pwsh` / `用户 !` / `嵌套`）+ 预览（完整模式：命令单行 ≤80 字；精简模式：程序名 + `n 行`，不出现命令文本）+ 徽章（`n 行` / `heredoc`）+ 耗时（`≈` 表示由时间差派生）+ `T/S · HH:MM:SS`（可点定位）。
- 展开：命令全文（等宽、可复制、可查找；超过 2000 字截断并标注）、结果正文（`--short` 下不出现）、事实行（退出码、退出码推断标记、耗时、目录、超时设置、输出字符数、stderr、被截断、沙箱拒绝）。
- 状态与退出码推导：
  - `bashExecution`：`exitCode`/`cancelled` 直读。
  - `bash`/`powershell` 工具：结果文本含 `Command exited with code N` → `failed, exit=N`；含 `Command terminated without an exit code` → `failed, exit=—`；`isError` 且无标记 → `failed`；否则 `ok, exit=0`（标注「推断」）。
  - 无对应 `toolResult` → `missing`；结果未完成（`stopReason` 中断）→ `unfinished`。
- 空态：`本会话没有执行过命令` / `没有匹配当前过滤条件的命令`。

### 7.11 Agent 家族

无子 Agent 时整块隐藏（不占位、不显示空态标题）。

**家族总览**

- 摘要条：Agent 数 / 运行中（无法判断时 `—`）/ 步数合计 / 委派数 / token 合计 / 成本合计。
- 成员卡（父 + 每个子）：
  - 名称（`description` 或 `id`）、类型、状态徽章、模型 + 思考级别、`当前` 徽章（父）。
  - 上下文：`tokens / window · 占用率%`（子 agent 用自己的 session 计算；无法算出时显示 `—`）。
  - 构成迷你条（10 类压缩成 5 段：系统 / 工具 / 消息 / 回复 / 结果）。
  - 计费 token、成本、步数、墙钟时长（`startedAt → completedAt`，运行中显示 `进行中`）。
  - 委派提示词前 60 字（子 agent）。
- 关系：父 → 子 → 孙……按真实层级递归画（用子 session header 的 `parentSession` 校验血缘，realpath 去重，环路保护，单父最多 200 个后代；超过时截断并 warning）。悬停成员高亮整条链；点击成员卡滚动到该成员的完整报告。

**递归包含孙级的口径**

- 发现方式：从当前 session 开始，沿「`subagents:record.outputFile` + 子 session header.parentSession」双向校验，逐层递归；任一环节校验失败就不纳入（并计入 warning），不靠目录猜测。
- 家族 token/成本：**只用父 session 自己的账本**（其中已含全部层级的转发用量）。成员卡显示各自独立账本，两者**不叠加**。
- 每个后代一份完整子报告；报告体积随前景数量线性增长，受 §8.6 上限约束。

**委派表**

| 列 | 内容 |
|---|---|
| 子 Agent | 名称 + 类型 |
| 状态 | `subagents:record.status`（`completed` / `error` / `stopped` / `aborted` / 无记录 → `未跟踪`） |
| 任务简报 | 子 session 首条 user 消息（≤160 字，可展开全文；精简模式不显示） |
| 最终回报 | `record.result`（≤600 字，可展开；`error` 则显示错误；精简模式不显示） |
| 用量 | `lifetimeUsage`（input/output/cacheRead/cacheWrite）+ `lifetimeCost` |
| 工具调用 | `toolUses` |
| 时间 | `startedAt → completedAt`，耗时 |
| 模型 | `modelName` + `thinking` |

`未跟踪` 的说明沿用 v1：可能是前台运行、已完成无记录或被打断，报告不猜测。

**子 Agent 报告**

- 每个子 Agent 一份与父同构的报告（总览 / Token / 耗时 / 当前上下文 / 完整时间线与浏览器 / 活动 / 事件），默认折叠，展开状态可记住（同一页面内）。
- 子报告的成本/用量**不再**计入父总量；页首与子报告头都要写这一句。

### 7.12 数据说明与隐私

固定四段，措辞固定：

1. 估算与实际的边界：估算用宿主同一套 4 字符/token 密度；实际值来自 provider 上报。
2. 统计范围：用量/活动/事件聚齐全量 entries（含其他分支与已压缩历史）；当前组成与逐步骤重建只走当前分支。
3. 截断清单：本次报告实际触发的裁剪（条目上限、正文上限、步骤上限、旧步骤仅汇总）逐条列出，没有就写「本次无截断」。
4. 隐私：`完整` 模式含原始 prompt、工具输出、命令输出与文件内容预览，**分享前必须审查**；`精简` 模式不含任何原文。

### 7.13 渲染与数据内嵌架构

采用「生成时服务端渲染 + 客户端只做交互」的渐进增强结构，不把渲染搬到浏览器：

| 层 | 内容 | 测试方式 |
|---|---|---|
| 静态层（生成时写死） | 所有卡片、表格、图表的 SVG/HTML；每个步骤的请求详情条（预渲染全部步骤，用 `hidden` 切换）；当前步骤的浏览器内容 | HTML 字符串快照（vitest） |
| 筛选层（CSS 属性） | 文件/命令/事件/分类行的筛选与搜索：行上带 `data-cat` / `data-status` / `data-kind` / `data-path` 等，JS 只切 class 与 `hidden` | 状态机单测 |
| 交互层（内联 JSON + JS） | 切换步骤、全量/增量、步骤/轮次、DNA、总览、tooltip、图例联动、定位滚动 | 状态机单测 + 人工清单 |

内嵌 JSON 只放**交互真正需要**的东西（不重复静态层已有的内容）：

```jsonc
{
  "schema": 2,
  "mode": "full",          // full | short
  "lang": "en",            // 首次打开的语言
  "dicts": { "en": { "…": "…" }, "zh": { "…": "…" } },
  "steps": [{ "i": 12, "turn": 3, "step": 2, "t": 1760000000000,
              "sums": { "system": 4200, "toolDefinitions": 8100, "user": 300, "injected": 0,
                        "skillInjections": 0, "compaction": 0, "reasoning": 900, "answers": 1200,
                        "toolCalls": 400, "toolResults": 5200, "unattributed": 1800 },
              "total": 22100, "delta": 1400, "prompt": 24000, "output": 1500,
              "cacheRead": 18000, "cacheWrite": 0, "durMs": 8200, "activeMs": 8100,
              "ev": [3, 7], "items": [[0, 42]] }],   // items: [起, 止] 条目 id 区间
  "items": [{ "id": 41, "cat": "toolResults", "kind": "bash", "src": "bash",
              "tok": 320, "t": 1760000000000, "st": 1, "body": 0 }],
  "bodies": ["…"],       // 正文表；short 模式为空，body 为 null
  "warnings": [], "truncation": []
}
```

- 正文（prompt / 工具 schema / 消息 / 输出）只存于 `bodies`，`items` 用索引引用；同一 entry 的正文只存一次。
- `items[].items` 用区间编码（entry 顺序单调递增），避免逐步复制 id 列表撑大文件。
- 每个静态区块与关键元素必须带稳定属性供测试断言：`data-card="tokens"`、`data-cat="toolResults"`、`data-step="12"`、`data-empty="files"`、`data-flag="compaction"`、`data-sentinel` 不用于生产。
- 无 JS 时：静态部分（含当前步骤的完整浏览器）仍可阅读；交互控件显示为 inert，并在页尾 `noscript` 提示「交互需要 JavaScript，静态内容不受影响」。

### 7.14 语言与格式化

- **字典**：平铺点号 key + `{p}` 插值（与 dsh 同构），`en` 为参考语言；`zh` 必须覆盖全部可见文案（标题、标签、空态、悬停提示、截断与 warning 文案）。构建时对账：任何 `data-i18n` key 在任一字典缺失即测试失败。
- **服务端渲染 + 属性标记**：静态文本按首次语言渲染，同时带 `data-i18n="key"`；含插值的节点额外带 `data-i18n-params`（JSON）。切换时 JS 遍历 `[data-i18n]` 重写 `textContent`，不做整页重渲染。
- **不随语言变的**：时间戳（固定 `HH:MM:SS`，当地时区；页脚声明时区）、数字单位（`k`/`M`/`B`）、百分比、金额（只看记录值，不做汇率换算，不做币种切换）。
- **随语言变的**：所有标签与自然语句，包括「第 t 轮 · 第 s 步」这类句式（英文为 `T3 · S2` 与 `Turn 3 · Step 2`）。
- **切换按钮**：`EN` / `中文` 两个状态，置于顶部工具条；切换写入 `localStorage` 并同步 `<html lang>`；无 JS 时永远显示首次语言版本。

## 8. 口径（唯一权威定义，测试按此断言）

### 8.1 估算 vs 实际

- 估算：`@earendil-works/pi-ai/utils/estimate` 的 `estimateMessageTokens` / `estimateTextTokens` / `estimateTextAndImageContentTokens`，与宿主上下文环同源。
- 实际：`usage.input`、`usage.cacheRead`、`usage.cacheWrite`、`usage.output`、`usage.reasoning`。
- 任何「把估算缩放到实际总量」的数值（环形拆分、分类成本）必须在悬停提示里说明「按 token 占比分摊」。

### 8.2 缓存命中

`cacheHit = ΣcacheRead / (Σinput + ΣcacheRead + ΣcacheWrite)`；分母 0 → `—`。显示保留两位小数。

### 8.3 成本

- 总量：`Σ usage.cost.total`；`costBasis` = 全部 `totalFromProvider` → `provider`；全否 → `estimate`；混合 → `mixed`。
- 分类分摊：该类 token / 该步估算合计 × 该步 `cost.total`。只对**该步存在于快照中的类别**分摊，和为 100%。
- 单价表（悬停提示）：仅当模型可从 `ctx.model` 解析时列出 `input/output/cacheRead/cacheWrite` 每百万 token 单价；历史模型不可解析时显示「该模型单价未知，成本取自行记录」。

### 8.4 计时

| 量 | 定义 | 精度标记 |
|---|---|---|
| 步骤耗时 | `assistant.durationMs` | 精确 |
| 步骤耗时（回退） | 相邻条目 `timestamp` 差 | `≈` |
| 工具耗时 | `toolResult.durationMs`（含嵌套，嵌套不重复计） | 精确 |
| 工具耗时（回退） | `toolCall` 所在 assistant 的 `timestamp` → `toolResult.timestamp` | `≈` |
| 模型等待合计 | `Σ` 步骤耗时 | — |
| 工具执行合计 | `Σ` 顶层工具耗时 | 有回退值则整列标 `≈` |
| 墙钟 | 首条 entry `timestamp`（取整点）→ 最后一条 entry `timestamp`（assistant 加 `durationMs`，toolResult 加 `durationMs`） | — |
| 空闲 | 相邻事件 `timestamp` 间隔 ≥ 120 s 的部分 + `ask_user` 工具耗时 | — |
| 活跃 | `墙钟 − 空闲`，下限 0 | — |
| 其他开销 | `活跃 − 模型等待 − 工具执行`，下限 0 | — |
| TPS | `Σ output / Σ 步骤耗时`，标签为「含排队与思考」 | — |

### 8.5 增量与峰值

- 增量（相邻两步）：`Δtotal = total[i] − total[i−1]`；分类增量 = 该类 token 差（正负都保留）；条目级差集 = 集合差。
- 峰值：`耗时最长` = max 步骤耗时；`单步新增最多` = max 正 `Δtotal`。只取 Top-1。

### 8.6 截断与上限（默认值，均可通过内部常量调整）

| 项 | 上限 | 表现 |
|---|---|---|
| 时间线柱数 | 4000（超出只渲染最后 4000 根 + 顶部提示） | 提示「仅显示最后 n 步」 |
| 浏览器条目明细窗口 | 最近 300 步 + 含事件的全部步骤；其余步骤**只有分类和/合计/事件**，条目行与正文不构造 | 步骤选择器中变暗并标注「仅汇总」；该步浏览器显示「仅提供合计」 |
| 请求详情步简报 | **全部步骤**都构造（每步最多 3 个 chip × 每 chip ≤80 字，体积可控） | 窗口外步骤的 chip 不可点（无条目可定位） |
| DNA 模式与正文 | 与「浏览器条目明细窗口」完全同一窗口 | 窗口外步骤的 DNA 入口禁用并标注 |
| 每类条目行 | 渲染 200 条，其后「显示更多」每次 +200，硬上限 2000 | 行尾「另有 n 条」 |
| 单条正文 | 8000 字符 | 「内容已截断（原文 n 字符）」 |
| 工具结果正文 | 4000 字符 | 同上 |
| 命令正文 | 2000 字符 | 同上 |
| 命令输出正文 | 4000 字符 | 同上 |
| usage 记录行 | 200 | 「另有 n 条」 |
| 工具/文件/命令行 | 各 500 | 「另有 n 个」 |
| 子 Agent 正文 | 与父同规则（独立预算） | — |
| HTML 总体积 | 16 MB 软上限 | 超出时按「先砍工具结果、再砍命令输出、再砍回复正文」顺序降级，并在数据说明的截断清单逐项列出 |

## 9. 交互链路（必须全部实现，缺一即不算完成）

| 触发 | 结果 |
|---|---|
| 时间线柱 悬停 / 点击 | 请求详情切换 / 选中并让浏览器切到该步 |
| 时间线旗标 点击 | 关闭总览、切步骤粒度、选中该步并滚动 |
| 轮次色带块 点击 | 切轮次粒度并居中该轮 |
| 总览 ribbon 悬停 / 点击 | 显示该步 tooltip / 选中该步（命中类别时让浏览器展开该类别） |
| Token 分类行 点击 | 浏览器展开该类；时间线点亮同类段 |
| Token 卡「读取/写入/搜索/图片」chip | 文件活动切该类并滚动 |
| 当前上下文 图例 chip | 时间线同类高亮 + 浏览器同类行高亮 |
| 步简报 chip 点击 | 浏览器定位到该条目并展开 |
| 浏览器分类行 点击 | 展开/收起该类 |
| 浏览器 DNA 条目 / 堆叠条 DNA 段 点击 | 定位并展开该条目 |
| 事件行 点击 | 压缩/编辑/分支 → 选中该步；注入/技能 → 浏览器定位 |
| 文件行 / 文件操作行 点击 | 展开日志 / 浏览器定位该工具结果 |
| 命令行定位按钮 点击 | 浏览器定位该命令结果 |
| 家族成员卡 点击 | 滚动到该成员的完整报告 |
| 委派表行 点击 | 展开该子报告的头部（不滚动） |
| 锚点导航 | 滚动到对应区块并高亮当前区块 |

## 10. 安全与隐私

- 所有来自 session 的字符串在构建数据模型时统一经 `escapeHtml` 处理；正文只以 textContent 写入 DOM，禁止 `innerHTML`。
- 内联 JSON 通过 `JSON.stringify(payload).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")` 输出，防止 `</script>` 逃逸。
- CSP：`default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'`。`--short` 模式额外去掉 `img-src data:`（无图片）。
- 不加载任何外部资源、不发起 fetch/WebSocket、不使用 `eval`/`new Function`。
- `完整` 模式页首横幅：`此报告含会话原始内容（prompt、工具输出、命令输出），分享前请审查。`
- `精简` 模式：数据模型里根本不存在正文字段（不是渲染时隐藏），因此不存在「隐藏但仍可查看源码」的伪脱敏。

### 10.1 `--short` 的允许与禁止清单（数据模型层）

允许保留（白名单）：

- 路径：文件路径、目录、session 文件路径、技能/SKILL 文件路径。
- 标识：工具名、命令的**程序名**（如 `git`、`npm`）、模型与 provider 名、`customType`、事件类型、子 Agent 的 `id` 与 `type`。
- 数值与状态：token、成本、时长、计数、时间戳、`status`/`exitCode`/`ok|error`、缓存命中、占比、`stopReason`。

禁止构造（黑名单，一个字段都不进 payload）：

- 任何消息正文：user / assistant text / thinking / toolResult 内容 / bashExecution output。
- 任何调用参数：`edit` 的 `oldText|newText`、`write` 的 `content`、`bash` 的 `command`、`grep|find` 的 `pattern`、其它工具的参数字符串。只保留参数**键名与字节数**。
- 系统提示词及其 section 文本、工具描述与参数 schema、压缩/分支摘要正文。
- 子 Agent 的 `description`、任务简报、最终回报/错误文本（用 `id` + `type` + 状态代替）。
- `todo` 条目名、`ask_user` 问题文本等工具自由文本。

断言方式：见 §14 第 11 项（用带哨兵字符串的 fixture 断言全文搜索不到）。

## 11. 兼容与降级
| 场景 | 行为 |
|---|---|
| 旧 session（无 system entry） | 系统提示词/工具定义标 `—` + warning；其余照常 |
| 旧 session（entry 无 `usage`） | 该步只显示估算；账本按 available 求和，costBasis = `estimate` |
| 无 `durationMs`（旧消息） | 用时间差并标 `≈` |
| `getContextUsage()` 返回 null | 用推导值并标 `≈` |
| compaction 后当前投影很小 | 当前上下文与时间线可能出现「大头在压缩摘要」，属正确结果，加一行说明 |
| 单条子 session 损坏 | warning + 跳过该子；父报告不失败 |
| 内存 session（无文件） | 正常生成；文件名用 session id |
| 空 session | 保持 v1 行为：拒绝并报 `Nothing to report yet - start a conversation first` |
| RPC / 非 TUI | 仅 `notify` 使用，fire-and-forget；HTML 生成不依赖通知 |
| `--short` | 数据结构无正文；`完整` 专属区块（矩形树图、正文展开）降级为结构视图 |

## 12. 命令与参数

```text
/insight                       # 默认完整模式，写到 pi-insight-<session>.html
/insight --short               # 精简模式（不含任何原文）
/insight report.html           # 自定义路径（相对 cwd）
/insight --lang zh             # 首次打开语言（默认：LANG/LC_ALL 含 zh 则 zh，否则 en）
/insight --short --lang zh out.html
```

- 覆盖语义、不自动建父目录、不自动打开浏览器、空 session 拒绝：全部沿用 v1。
- 参数解析：未知参数报错并打印用法，不静默忽略。
- 生成结束通知：`Insight report written to <path>`（精简模式追加 `(short: no raw content)`）。

## 13. 性能预算

| 场景 | 预算 |
|---|---|
| 生成耗时（2000 entries / 300 步） | ≤ 3 s |
| 生成耗时（10000 entries / 1500 步） | ≤ 12 s，且必须打印进度或至少不阻塞 UI 超过 1s（命令在后台执行时不受此限） |
| 文件体积（常见会话，300 步以内，完整模式） | ≤ 6 MB |
| 首次渲染（Chromium，2000 行列表） | ≤ 1.5 s |
| 交互（切步骤 / 展开分类） | ≤ 100 ms |

达不到时按 §8.6 的顺序有损降级并记录到截断清单。

## 14. 验收标准

### 14.1 测试环境约束

仓库硬约束，不可协商：`docs/guides/pi-package-spec.md` 与 `scripts/check-dev-deps.mjs` 限定扩展包只能使用共享的 4 个 devDependencies，CI 也不安装浏览器。因此**不引入 Playwright / jsdom / happy-dom**，验收按下列三层拆：

- 纯函数单测（vitest）：数据层全部口径。
- HTML 字符串快照（vitest）：渲染层。
- 交互层：把交互逻辑写成不依赖 DOM 的纯状态机（`reduce(state, action)`），用单测断言状态迁移；DOM 绑定代码不写单测，另附一份人工核对清单（见 §14.3）。

### 14.2 断言清单

数据层（单测）：

1. 逐步骤重建：构造含 2 次 compaction、1 次 context_edit、1 次 toolsRemoved 的 session，断言每一步的类别和与手工计算一致；压缩后步骤的 system 类来自快照；**压缩前步骤的构成与正文同样精确**（与压缩无关）。
2. 增量：相邻步骤正负增量之和等于总量差；条目差集与集合差一致。
3. 会话切分：轮次边界按 user/custom/bashExecution/branch_summary 切分，步内序号连续。
4. Token 口径：估算用宿主 estimate 函数；实际值等于 usage 字段和；缓存命中公式分母为 0 时返回 null；`unattributed = 实际 prompt − 估算合计`（负值或 <2% 不入类）。
5. 成本：`costBasis` 三态判定；分类分摊之和等于该步成本（±1e-9）；`unattributed` 不分摊成本。
6. 计时：`durationMs` 优先、回退带 `≈`；空闲 ≥120s 被剔除；`活跃 = 墙钟 − 空闲`；嵌套调用不重复计；**耗时只有模型/工具/其他三段**。
7. 文件行数：`edit` 多段累加、`write` 单向；`grep` 结果按文件拆分并计数。
8. 命令状态：五种结果文本标记 → 对应状态与退出码；`bashExecution` 直读。
9. 事件：12 类旗标各自的来源、位置与合并规则；Top-1 峰值只标一处。
10. 子 Agent：`subagents:record` 解析、`未跟踪` 不推断状态、子报告不计入父总量；递归发现遇环/校验失败时跳过并产出 warning。

渲染层（快照 + 断言）：

11. `--short` 模式下 HTML 全文不包含任一采样正文片段：fixture 在 prompt、工具参数、工具输出、命令文本、子 Agent description/result、todo 标题各埋一个哨兵字符串，逐个断言 `html.includes(sentinel) === false`（含 base64/JSON 转义形式）。
12. `完整` 模式含页首横幅、含全部哨兵字符串、CSP 含 `img-src data:`。
13. 内联 JSON 中不存在裸 `</script`（大小写与空格变体均查）；含 `<script>`、`&`、`"`、`\u003c` 字样的 fixture 渲染后作为文本节点呈现。
14. 所有空态文案存在（逐卡断言 `data-empty` 节点文案）。
15. 截断清单在有损降级时非空且条目数与实际裁剪一致；无裁剪时输出「本次无截断」。
16. 体积预算：固定 fixture（300 步 + 1000 条工具结果）生成结果 ≤ 6 MB，超出即失败。
17. warning 面板：构造无 system 的旧 session、损坏的子 session、`getContextUsage() = null` 三个 fixture，断言三条 warning 同时出现且不影响其余区块渲染。

交互状态机（单测）：

18. `selectStep(i)` 后：详情步号、浏览器步选择器、时间线选中态三者取值一致；`unattributed` 行随之重算。
19. `focusCategory(c)` 后：时间线高亮集合与浏览器展开集合都包含 `c`。
20. `setMode(delta)` 后：分类行带符号徽章总数 = 总差；`总览` 与 `DNA`/`自适应` 互斥（开一个自动关另一个）；自动总览在 ≥100 步时只触发一次。
21. 窗口外步骤：`selectStep` 到无明细的步骤时，浏览器进入「仅汇总」态且 DNA 入口禁用。
22. 语言：HTML 中每个 `data-i18n` key 在 `en` 与 `zh` 两份字典中都存在；含插值的节点在切换后无残留 `{p}`；切换后 `<html lang>` 与按钮 `aria-pressed` 同步变化，`localStorage` 写入被调用（注入 fake storage 断言）。
23. 格式化不随语言变：中英文两版的 `HH:MM:SS`、`12.3k`、`$0.0123`、`12.34%` 字符串完全一致（用同一 fixture 对比）。

### 14.3 人工核对清单（不入 CI）

浏览器打开生成的样例报告，逐项确认：点柱→详情与浏览器同步；点分类行→浏览器展开且时间线高亮；点文件操作行→滚动到该工具结果并可展开；点事件行→选中该步；锚点导航高亮正确；两个模式（完整/精简）的横幅与禁令表现符合预期。结果记入 PR 描述。

## 15. 工作拆分建议（供后续计划使用，非本文件承诺）

1. **数据层重写**：`steps` 重建 + 分类 + 增量 + 事件 + 家族（纯函数，先测后写）。
2. **渲染层**：静态骨架 + 内联数据 + 客户端渲染器（分区块，逐块对快照）。
3. **活动层**：文件 / 命令 / 工具三个分析器按新口径重做。
4. **交互层**：联动状态机 + 下钻链路。
5. **降级与预算**：截断清单、体积降级、`--short` 双模式。

## 16. 未决问题

1. **「仅汇总」步骤窗口的默认值**（现取 300）。若真实会话常在 300 步以上，浏览器会失去历史下钻能力；需要真实会话统计后再定。
2. **技能识别规则**：现有环境用「`customType` 含 skill」+「`read` 路径命中 `SKILL.md`/skills 目录」两条启发式。是否改用 `ctx.getSystemPromptOptions().skills` 的路径列表做精确匹配（会在报告里引入对已安装 skill 的耦合，但更准）待定。
3. **矩形树图**是否进入首版：默认按「可选增强」处理，若 DOM 预算紧张可直接砍掉，不影响验收项。
4. **中文字典的覆盖度**：首版目标为全部可见文案（标题、标签、空态、悬停提示、截断提示）都有 `zh` 条目；`dict` 用平铺 key + `{p}` 插值（与 dsh 同构），缺键时回落英文并在构建时报告缺键清单。

## 17. 已关闭的设计决议（供实现时直接引用，不再回议）

| 议题 | 决议 | 理由 |
|---|---|---|
| 渲染架构 | **生成时服务端渲染 HTML + 客户端只做交互**（切换、筛选、展开、滚动），客户端渲染器依赖内联 JSON 中的「步骤汇总 + 条目表」 | 快照可测、首屏不依赖 JS、体积可控；避免把全部渲染逻辑搬到浏览器 |
| 交互测试 | 写成纯 `reduce(state, action)` 状态机 + 单测；不引入浏览器/DOM 依赖；DOM 绑定走人工清单 | 仓库 devDependencies 与 CI 无浏览器 |
| 估算是否锚定到实际 prompt | **不锚定**；差值单独归入 `unattributed` 类并解释 | 锚定会把不可见内容均匀摊到所有类别，制造虚假分布；残差更诚实 |
| `--short` 的原文边界 | 按 §10.1 白名单（路径/标识/数值）构造，其余字段根本不进 payload | 「渲染时隐藏」不是脱敏；A4 要求结构上不可能泄露 |
| 耗时细分 | 只保留模型/工具/其他三段，**不拆思考/回复/参数** | pi 无 TTFT 与块级时间，拆出来只能是 token 占比伪装的时长（违反 A1） |
| 孙级 Agent | 递归发现并各自出报告；家族总量只用父账本，不叠加 | 递归是现有目录扫描的自然延伸；叠加会违反 A2 |
| 压缩前步骤 | 精确重建，不作近似 | `getBranch()` 保留压缩前全部 entry，近似值没有必要 |
| 明细窗口 | 浏览器条目明细/正文/DNA 受窗口限制（近 300 步 + 含事件步骤）；请求详情 chip 全步骤都有 | 体积预算与「可下钻」的折中点；详情 chip 体积可忽略 |
| warning 位置 | 顶部固定面板（与截断清单分开：warning 记「不可得」，截断清单记「被裁剪」） | 两者语义不同，读者需要区分 |
| i18n | 两份字典（`en`/`zh`）内联 + 页头切换 + `localStorage` 记忆；生成时 `--lang` 只决定首开语言 | 报告会被转发给别人看，收件人语言不可预设；两份字典体积可忽 |
