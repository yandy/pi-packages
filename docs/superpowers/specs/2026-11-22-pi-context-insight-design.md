# pi-context-insight 设计

## 1. 意图

新增 `pi-context-insight` extension package，提供 `/insight [output.html]`。命令像 `/export` 一样把当前 session 写成一个可直接用浏览器打开的独立 HTML，但内容不是逐条 transcript，而是帮助用户回答：

- 当前上下文由哪些部分组成，距离模型窗口上限还有多远；
- session 的 token、成本、缓存和模型调用如何随时间变化；
- 工具、文件和命令活动发生在哪里、结果如何；
- compaction、上下文编辑、模型切换等事件何时发生；
- 子 Agent 各自消耗了多少资源、携带了多少上下文、做了哪些工作。

报告在本地确定性生成，不调用模型、不访问网络。恢复旧 session 后仍可使用。

## 2. 目标

- 一个 `/insight` 命令生成单个离线 HTML；无参数时采用与 `/export` 类似的默认文件名。
- 覆盖 session 概览、当前上下文组成、实际用量时间线、工具/文件/命令活动和上下文事件。
- 发现当前 session 关联的子 Agent session，并为每个子 Agent 提供同口径的折叠报告。
- 正确区分 provider 实际用量与本地估算组成，明确数据口径，不制造虚假精度。
- 所有模式都只依赖文件生成作为功能正确性的落点；通知只负责报告结果。
- 遵循 monorepo 的 package、测试、依赖、License、CI 和双语文档规范。

## 3. 非目标

- 跨 session 的 7 天/30 天统计、活动热力图或全局管理页面。
- 自动刷新、实时监控面板或交互式 TUI dashboard。
- 通过模型生成叙事性总结、评价或建议。
- 逐类别还原每次历史请求的精确 prompt 组成。
- 完整 transcript/Markdown 浏览器、图片附件导出或工具输出导出。
- 修改 session、控制子 Agent、自动打开浏览器或上传报告。
- 首版不追求跨 Agent 任务依赖图；只呈现当前 session 可发现的直接子 Agent。

## 4. 反目标与正确性边界

以下行为即使页面好看也视为错误：

- 把父 session 已转发的子 Agent 用量与子 session 用量再加一次，造成双重计费。
- 把估算的上下文组成标成 provider 实际 token。
- 没有完成记录就把磁盘上的子 session 断言为 `running`；它也可能已结束、在前台运行过或被中断。
- 为生成报告发起模型请求、网络请求或读取无关文件。
- 把用户/模型/工具控制的文本未经转义插入 HTML。
- 因子 Agent 文件缺失或损坏而让整个父 session 报告失败。

## 5. 方案选择

### 方案 A：离线静态报告（采用）

在命令执行时读取 `ctx.sessionManager` 和关联子 session JSONL，聚合成报告模型，再渲染独立 HTML。

优点：无额外模型成本、结果可测试、旧 session 可用、没有运行时缓存和持久化负担。历史条目可精确提供 usage、活动与事件；当前投影可提供估算组成。限制是无法精确重建历史每次请求的逐类别组成。

### 方案 B：持续捕获 provider 请求

通过扩展 hook 保存每次 provider payload 的组成快照。

优点：安装后产生的数据可精确还原历史组成。缺点：旧数据缺失，需要额外存储、版本迁移和隐私边界，且不同 provider payload 会显著增加适配成本。首版不采用；后续增强不得改变现有报告对静态数据即可工作的保证。

### 方案 C：轻量上下文报告

只生成用量、当前组成和事件，不分析工具/文件/命令及子 Agent。实现较小，但不能覆盖本次需要的完整会话活动洞察，不采用。

## 6. 数据来源与口径

### 6.1 父 session

从 `ExtensionCommandContext` 获取：

- `sessionManager.getHeader()/getSessionId()/getSessionName()/getSessionFile()/getSessionDir()`：元数据；
- `sessionManager.getEntries()`：session 全量账本、活动、事件及子 Agent 完成记录；
- `sessionManager.getBranch()`：当前分支及 compaction 位置；
- `sessionManager.buildSessionProjection()`：应用当前分支、compaction 和 `context_edit` 后的模型可见内容；
- `getContextUsage()`：宿主对当前上下文 token/window 的最佳估计；
- `model`、`thinkingLevel`、`cwd`：当前选择。

用量与活动统计使用全量 entries，包含被 compaction 汇总的历史和已离开的分支；当前组成只使用当前投影。页面必须明确这一差异。

### 6.2 用量账本

逐项纳入以下 usage，与 Pi `/session` 的聚合范围一致：

- assistant message 的 `usage`；
- `usage` entry（包括 `kind: "subagent"` 等辅助用量）；
- compaction / branch summary 的 `usage`；
- tool result 自带的 `usage`。

每个 ledger item 保留 input、output、cacheRead、cacheWrite、成本、时间、模型和来源类型。衍生口径：

- `prompt = input + cacheRead + cacheWrite`；
- `total = prompt + output`；
- `cache hit rate = cacheRead / prompt`，分母为 0 时显示 `—`；
- 顶部 session total 使用父 session 的全部 ledger item，包含已转发的子 Agent 用量；
- 另显示 `Parent direct`（排除 `kind: "subagent"`）和 `Subagents forwarded`（只含该 kind）作为拆分；
- 子 Agent 卡片统计自己的 JSONL，只用于卡片内部，**不再加回顶部 session total**。

成本采用条目中的 `usage.cost.total`，保留 provider 已报告/目录估算的语义，不自行重定价。缺少必需数值或包含非有限数值的畸形 usage 不进入账本，并以 entry id 生成 warning，不能静默当作 0。

### 6.3 当前上下文组成

使用投影中的每条模型可见消息，按以下互斥类别估算：

1. System prompt；
2. Tool definitions（system message 的 toolsAdded/toolsRemoved schema）；
3. User messages（包括用户 bash execution）；
4. Injected context（custom message 与 branch summary）；
5. Compaction summaries；
6. Assistant reasoning；
7. Assistant answers；
8. Tool calls（名称与参数，不含结果）；
9. Tool results。

文本使用 Pi 的 token 估算工具；图片按同一估算工具处理，不嵌入图片数据。assistant 的 text/thinking/toolCall 分块归类。system message 的总估算减去工具定义估算得到 prompt 部分，避免重复计算。

同时展示 `getContextUsage()` 的 tokens/contextWindow/percent。组成条使用分类估算值，当前占用数字使用宿主值；两者可能因 provider 序列化、缓存和尾消息估算而不同，页面必须标注组成是估算，不能强制把分项缩放到实际总量。

旧 session 若没有 system message，使用 `ctx.getSystemPrompt()` 作为 system prompt 的降级估算；无法取得的工具定义显示为 unknown，而不是 0。

### 6.4 用量时间线

每个带 usage 的 ledger item 是一个点，展示 uncached input、cacheWrite、cacheRead、output 的堆叠柱及成本。assistant、subagent、compaction、branch summary、tool、cache warming 等来源用标签区分。

时间线使用实际 usage，不尝试把当前组成反推到历史。compaction、model change、thinking change、context edit、branch summary、子 Agent 完成记录作为事件标记。柱图使用内联 SVG/CSS，容器横向滚动；聚合覆盖全部条目。

### 6.5 工具、文件与命令

从 assistant toolCall 与 toolResult 的 `toolCallId` 关联执行记录：

- 工具：名称、调用数、成功/错误/无结果数、累计耗时；`durationMs` 优先，缺失时用 message 时间戳差作为 wall-clock 近似并标记。嵌套调用单独计数和标记，不与顶层调用混为一谈。
- 文件：从 read/write/edit 以及常见搜索工具参数提取路径或搜索根，按 read/written/edited/searched 聚合；write/edit 只根据参数估算增删行数。没有可靠路径时不猜测。文件内容不进入报告。
- 命令：记录 bash/powershell 工具与用户 bashExecution 的命令文本、状态、exit code、耗时；不记录 stdout/stderr。程序分布不做复杂 shell 解析。

聚合适配未知工具时保留通用工具统计，但不能因为不认识参数而丢掉整个 session。所有聚合基于全量数据；为避免长 session 生成失控 DOM，每类明细最多展示 200 条并注明省略数量，单条命令最多展示 1000 字符。

### 6.6 上下文事件

从 entries 生成统一时间序列：compaction、branch summary、context edit、model change、thinking-level change、subagent completion record。展示时间、类型和关键元数据（例如 tokensBefore、targetId、provider/model），不展开 summary 正文。

耗时卡片区分：

- session wall time：首末 entry 时间差；
- cumulative model time：assistant `durationMs` 之和；
- cumulative tool time：工具执行耗时之和。

累计耗时可能因并行而重叠，不能标成真实墙钟活跃时长。

## 7. 子 Agent 支持

### 7.1 数据契约

读取当前 Pi 子 Agent 持久化形状，不导入或实例化另一个扩展：

- 父 entry：`type: "custom"`、`customType: "subagents:record"`；data 包含 id/type/description/status/startedAt/completedAt/modelName/outputFile/lifetimeUsage 等；
- 默认目录：`<parent-dir>/<parent-basename>/tasks/*.jsonl`；
- 父 session 未持久化时：`<tmpdir>/pi-subagents-<uid>/<encoded-cwd>/tasks/*.jsonl`，并用子 header 的 `parentSession === 当前 sessionId` 过滤；
- 子 JSONL 是标准 Pi session，可直接用 `SessionManager.open()` 建立 branch/projection。

该适配只依赖持久化数据形状，不调用子 Agent service，也不要求子 Agent 仍在内存中。

### 7.2 发现与合并

- 完成记录与目录扫描取并集，按规范化 outputFile 去重；
- 有 outputFile 的记录可指向当前或祖先 session 的 tasks 文件，以支持 fork/resume 后读取历史子 session；祖先关系由当前 session header 的 `parentSession` 文件链证明；
- 无记录的文件也可能属于前台、仍在运行或曾被中断的子 Agent，状态显示 `No completion record`，并解释不能仅凭磁盘区分；
- 无 outputFile 的旧记录只在约定 tasks 路径存在时采用兼容回退；
- 记录提供类型、描述、状态等元数据；扫描发现的额外文件以 session id/basename 标识，可从 `<active_agent name="…">` 尽力补充类型；
- 文件缺失、越界或解析失败转为该卡片的 warning 和页面 warning 列表，父报告继续生成。

### 7.3 路径安全与血缘校验

只读取 session 数据明确允许的 `.jsonl`。允许的 tasks 根不是简单等同于当前 `sessionDir`，而是按 session 血缘构造：

- 当前 session 文件提供一个 tasks 根，并绑定当前 sessionId；沿当前 header 的 `parentSession` 文件链读取祖先 header，每个祖先提供自己的 tasks 根并绑定其 header.id；链设置深度上限，循环或损坏时停止并记录 warning；
- 扫描只读这些派生 tasks 目录的直接子文件；记录中的 outputFile 也必须是其中一个根的直接 `.jsonl` 子文件；
- 对根和文件都规范化并解析 realpath，再次检查直接子文件边界，拒绝目录穿越、符号链接逃逸和非 JSONL 路径；
- 通过路径检查后，子 header 的 `parentSession` 必须等于该根绑定的 session ID；只有路径形状而没有血缘证明的 JSONL 不读取为子 Agent 报告；
- 临时目录模式只允许当前 session 的派生根，并同时通过 realpath 边界与当前 sessionId 身份检查。

因此，祖先 tasks 文件可以位于当前 `sessionDir` 之外，但必须同时具有当前 header 链、完成记录或目录发现、允许的文件位置、子 header 四者之间的明确关系。

### 7.4 子 Agent 卡片

每个子 session 使用同一分析器生成独立折叠区块：元数据、状态、usage、当前估算组成、用量时间线、工具/文件/命令和事件。卡片里的 current context 只标为估算；没有可靠模型 window 时不显示百分比。

顶部 `Subagents forwarded` 来自父账本；卡片用量来自子账本。两种口径并列展示，不相加、不要求强制对账为同值（例如辅助摘要用量可能只存在于子账本）。

## 8. 命令与文件输出

```text
/insight
/insight path/to/report.html
```

- handler 先 `await ctx.waitForIdle()` 取得稳定的父 session 快照；后台子 Agent 的文件只是执行时快照，不等待其结束。
- 无参数：当前工作目录下 `pi-insight-<session-file-basename>.html`；内存 session 使用 `pi-insight-<session-id>.html`。
- 有参数：trim 后作为输出路径，与 `/export` 一样允许覆盖目标文件；不自动创建父目录、不自动打开浏览器。
- 成功：`ctx.ui.notify("Insight written to: <path>", "info")`。
- 失败：通知明确错误，不把异常吞成成功。
- 只调用 `notify`，不使用终端组件或对话框；RPC 下通知可转发或被客户端丢弃，但 HTML 生成本身不依赖 UI。

## 9. HTML 设计

单文件包含语义化 HTML、内联 CSS 和 SVG；无外部字体、脚本、图片、CDN 或网络请求。首版不需要 JavaScript，展开/筛选使用原生 `<details>` 与锚点导航。

页面结构：

```text
Session Insight
metadata / generated at / model / cwd / warnings
[Total tokens] [Cost] [Cache hit] [Messages] [Tools] [Subagents]
Usage ledger: Session total / Parent direct / Subagents forwarded / by model
Current context: host usage + estimated composition bar + category table
Recorded usage timeline + event markers + timing summary
Subagents: one collapsible full report per discovered child
Tools / Files / Commands / Context events
Data notes & privacy reminder
```

视觉采用深色高对比卡片、响应式网格、可打印样式和横向滚动表格。颜色不是状态的唯一载体；所有数值有文本形式。

所有动态文本经过 HTML escape；动态 attribute 单独转义。报告不包含原始 prompt、assistant 正文、工具结果或命令输出，但仍包含 cwd、文件路径、命令文本和子 Agent 描述，页面与 README 都要提醒分享前审查。

## 10. 代码结构

```text
pi-context-insight/
├── index.ts                 # 注册 /insight
├── src/
│   ├── command.ts           # 参数、等待、路径、通知、错误边界
│   ├── report.ts            # 采集并组装父/子报告
│   ├── usage.ts             # 纯 usage ledger、总量与模型聚合
│   ├── activity.ts          # 纯工具/文件/命令/耗时聚合
│   ├── events.ts            # 纯上下文事件提取
│   ├── context.ts           # 当前投影的分类估算
│   ├── subagents.ts         # 发现、身份/路径校验、子 session 加载
│   ├── model.ts             # 报告数据结构与少量持久化形状类型
│   ├── html.ts              # 语义化 HTML/SVG 渲染
│   ├── style.ts             # 内联 CSS
│   └── format.ts            # 数字、时间、转义、路径等纯函数
├── tests/
└── package/tsconfig/vitest/README 等标准文件
```

分析器接受普通 entries/projection，渲染器只接受报告模型，文件发现注入路径与读取边界，便于在临时目录中测试。运行时不依赖 `@yandy0725/pi-subagents`；仅 peer 依赖 Pi core/ai，估算函数来自 Pi 公共导出。

## 11. 测试策略

先写失败测试，再实现：

1. **usage**：覆盖所有 usage 来源、prompt/total/cache 公式、父账本 direct/forwarded 拆分、by-model、零分母及子卡片不重复计入顶部。
2. **context**：system/tools 不重复、assistant 三类块、custom/branch/compaction、图片、context edit 与 compaction 投影、无 system 的降级。
3. **activity**：call/result 配对、错误/缺失结果、嵌套调用、duration 优先级、文件操作与行数、命令状态且不纳入输出。
4. **subagents**：记录与扫描并集、resume/fork 的祖先 tasks 根（包括当前 sessionDir 之外）、header 血缘不匹配拒绝、无记录的未知状态、前台 session、临时父 session 身份过滤、缺失/损坏文件 warning、目录穿越和 symlink 逃逸拒绝。
5. **render**：关键区块与数值、HTML/attribute 注入、无外链/无脚本、明细上限、空 session、长 session、子卡片。
6. **command**：默认/自定义路径、waitForIdle、成功/失败 notify、覆盖语义、RPC/无 UI 时文件仍生成。
7. **规范**：空工具列表的 prompt hygiene、typecheck、Biome、License/host/dev deps、lockfile、跨平台路径断言。

测试文件系统全部使用 `mkdtemp` 隔离；不读真实 session/config/credential 路径。异步副作用按条件等待，不用单 tick 猜时序。浏览器人工 smoke 只打开临时生成的 fixture，不访问真实用户 session。

## 12. 仓库集成与文档

- 根 `package.json`：workspace 和 `test:windows`；
- 根 `vitest.config.ts`、`.github/workflows/test.yml`、`.github/workflows/publish.yml`；
- `package-lock.json` 通过 `npm install` 更新；
- 根 README/README.zh 增加 package 行；
- 包 README/README.zh 包含安装、命令、报告内容、用量口径、子 Agent 状态语义、隐私说明、License；
- 因使用 `ctx.ui.notify`，双语文档各加 `UI surface` / `UI 能力` 表：`Guard = none`，非 TUI 下通知可能转发或被丢弃，文件生成不依赖通知。

## 13. 验收标准

- 在空、普通、compaction 后、带分支、带多个子 Agent、子文件损坏的 fixture 上均能生成报告；
- `/insight` 无参数和显式路径都落盘，内容离线可打开；
- 顶部 usage 与相同 entries 下 Pi `/session` 的聚合口径一致；
- 子 Agent 不被重复计费，无完成记录的状态不伪装成 running；
- 动态文本不能突破 HTML 结构，报告无网络请求；
- 新包及全仓测试、typecheck、lint、规范检查在 Linux 通过，路径与文件测试兼容 Windows。
