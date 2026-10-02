# pi-sandbox：提权审批 denial-first 硬化（拒绝门禁 / 参数归一化 / Deny 理由）设计

日期：2026-10-02
状态：已与用户逐节确认（in-chat 设计 + 两轮追加需求：参数归一化、Deny 可选理由），已落地（PR #157）
前置设计：
- `2026-09-29-process-sandbox-design.md` §7（提权审批：schema、拒绝标记、approveEscalation 校验顺序）
- `2026-09-30-escalation-approval-forwarding-design.md` §4.3/§4.6（通道解析与 FIFO 车道）

## 1. 背景与问题

现象（用户报告）：安装 pi-sandbox 后，有些 LLM 调用 bash 时"上来就带提权参数"，导致大量本不会被沙箱拦截的操作也弹审批窗，用户被迫逐条 Allow。

三个独立来源：

1. **批准后的过度推广**（09-29 §7 记录的 2026-10-01 事故复盘）：46 条工具调用里 35 条带 `danger-full-access`——模型把"批准过一次"当成"档位已放宽"；
2. **先发制人的习惯**：部分模型在第一次调用就带参数（防御式地"预判"需要权限），即使命令（`ls`、`git status`）在 workspace-write 下完全合法；
3. **占位符噪声**：LLM 常把可选字段填成 `null` / `"null"` / 空白；现有配对校验把 `justification: null` 判为"提供了 justification 但缺 sandbox_permissions"→ malformed 错误、命令不执行（nothing ran）。而 09-29 §7 第 1 步的动机原文正是"模型把 malformed 错误误判为沙箱拒绝，进而要求最大档"——占位符噪声会反向制造真提权。

现状语义是**模型声明式**：`resolveCall` 只检查"参数是否带了、目标是否严格更宽"，不检查"这个会话是否真的被拒绝过"。提示词里虽写了 "Pass neither escalation field unless you are retrying a denial"，但这是软约束。

目标：

- 把 denial-first 从提示词软约束升级为**运行时硬门禁**（无前置拒绝不提权）；
- 消除占位符噪声（不再误报 malformed）；
- 用户拒绝时能留下**可选理由**，理由回传模型（减少"换个写法反复试探"）。

非目标：改变一次性提权语义；改变同档免审批/非法目标的既有行为；引入配置开关（用户在方案 1/2/3 中明确未选方案 3）；跨进程转发（09-30 D1 不变）；一体式富弹窗（`ui.custom` 路线被否决，见 §3.3）。

## 2. 已确认决策（用户逐条拍板，不得擅自变更）

| 编号 | 决策 |
|---|---|
| **D1** | **denial-first 硬门禁**：严格更宽的提权请求，必须命中本会话、同工具类的未消费拒绝记录；否则忽略参数、按当前 effective 档位执行 |
| **D2** | **一次性消费**：进入审批对话前消费记录（Allow / Deny / 取消都算用掉）；一次拒绝 = 一笔提权重试机会 |
| **D3** | **kind 隔离**：bash 的拒绝只放行 bash 提权（`command`），write/edit 的只放行其自身（`operation`） |
| **D4** | 门禁**只作用于严格更宽的请求**；同档免审批与"非法目标报 not-strictly-wider 错误"逐字不变 |
| **D5** | **参数归一化**：`null` / `"null"`（trim、大小写无关）/ 空串 / 纯空白 → 视为未提供、按普通调用执行；真正的畸形（如只给 justification）仍报既有 malformed 错误（pi ≥0.80.2 下可达性按字段不同，见 §4.3 修订注记） |
| **D6** | **Deny 可选理由**（用户追加）：两步式 `select → input`；理由可选（回车跳过）、sanitize（折叠空白、截断 500 字符）、随拒绝错误回传模型 |
| **D7** | 忽略提权时**不弹窗、不报错**：按当前档位执行，结果附 `[sandbox: escalation fields were ignored …]`（原位反馈） |
| **D8** | **无配置开关**：不引入 escalation policy 配置项（用户明确未选方案 3） |

## 3. 方案选择

### 3.1 为什么门禁放在 resolveCall（运行时）而不是提示词或审批 UI

- 提示词强化（本设计同时包含，见 §4.6）是软约束——用户报告的正是"有些 LLM 不遵守"；软约束不能消除弹窗；
- 审批 UI 层（弹窗时再判断）不行：门禁的目的是**不产生弹窗**，必须在到达 UI 之前拦截；
- `resolveCall` 是三个工具提权路径的唯一汇聚点（`src/tools.ts`），且已有 effective mode、subject（command/operation）、ctx（sessionId）——门禁所需信息齐备。

### 3.2 忽略 vs 直接报错

被忽略的请求按 effective 档位执行（fail-closed 方向）：

- 命令若真需要更宽权限 → 沙箱/围栏会真实拒绝 → 模型拿到 denial marker + hint，重试时已有记录 → 正常弹窗（一次额外往返）；
- 若直接报错，模型会困惑于"参数格式没问题为什么失败"，且与 D7 的原位反馈目标冲突。

用户明确接受"预判型提权多一轮失败重试"的代价（换取弹窗只出现在真实拒绝场景）。

### 3.3 两步式 vs `ui.custom` 一体式弹窗

用户提出"pi 的 UI 本来就支持选项+额外输入？"，经核实：

- pi 内置 `ctx.ui.select` 的底层是 `ExtensionSelectorComponent`（`dist/modes/interactive/components/extension-selector.js`）——纯字符串列表 + 上下键，**无输入处理**；`ExtensionUIDialogOptions` 只有 `signal`/`timeout`；
- "选项 + 自由输入"是 **pi-ask-user 扩展自建**的效果（`ctx.ui.custom<AskUIResult>(...)`，RPC/headless 下 `askViaDialogs` 降级为 select/input 组合）；
- pi **确实有**独立文本输入 `ctx.ui.input(title, placeholder, opts)`（`showExtensionInput`：Enter 提交——空值提交返回 `""`；Esc / signal abort 返回 `undefined`）。

结论（用户拍板）：走**两步式** `select → input`，不引入 `ui.custom`（避免为安全组件背上 RPC 降级、键位/主题/IME、overlay 的 UI 债务）。

## 4. 架构

### 4.1 事实基础（均已核实，标注出处）

| 事实 | 出处 |
|---|---|
| pi 宿主 `select` 底层是纯列表组件，无内嵌输入；`input` 是独立对话框，Enter 提交（空值 `""`）、Esc/abort 得 `undefined` | pi `dist/modes/interactive/components/extension-selector.js`、`extension-input.js` 的 `handleInput`、`interactive-mode.js` 的 `showExtensionSelector`/`showExtensionInput` |
| 三个工具的提权解析汇聚于 `resolveCall`；subject 恰为 `command`/`operation`，与账本 kind 一一对应 | `src/tools.ts` 的 bash/write/edit `execute` |
| 两个真实拒绝来源：(a) bash 沙箱拒绝（`classifyDenial` 命中后写 denial marker）；(b) fs 围栏拒绝（`FenceDenialError` 抛出） | `src/bash-ops.ts` 的 `close` 分支；`src/fence.ts` 的 `assertWriteAllowed` |
| pi 的 bash tool 在进程非零退出时 **throw**（错误文本含我们注入的 marker），不走 `execute` 返回值 | pi `dist/core/tools/bash.js` 的 `Command exited with code` 分支（真机自检观察到） |
| 父/子会话是独立 jiti 实例，模块单例不共享；`globalThis` 是唯一共享点 | 09-29 §9、`src/permission.ts`、`src/escalation-broker.ts` |
| 宿主对话框只有一个槽位（Ruling 17），对 `input` 同样成立 | 09-30 §4.3 |
| `ask` 的第三参（理由提示）只在 Deny 分支使用；`ctx.ui.input` 不存在的宿主必须能降级 | `src/escalation.ts` 的 `approveEscalation`、`src/tools.ts` 的 `approvalChannelFor` |

### 4.2 新增 `src/denial-ledger.ts`（纯内存、零 fs / 零定时器）

```ts
type DenialKind = "command" | "operation";
interface DenialLedger {
  record(sessionId: string, kind: DenialKind): void;      // 幂等
  consume(sessionId: string, kind: DenialKind): boolean;  // 一次性（消费即清除）
  forget(sessionId: string): void;                        // 会话销毁清理
}
```

- 挂 `globalThis[Symbol.for("@yandy0725/pi-sandbox:denial-ledger")]`（与 `processPermissionState`、`escalation-broker` 同构，跨 jiti 实例共享）；
- 内部 `Map<string, Set<DenialKind>>`（每会话每 kind 至多一条待消费记录）；
- 不设 TTL：拒绝与提权重试在对话中天然相邻；会话销毁时 `forget` 防长进程 Map 泄漏（`index.ts` 的 `session_shutdown` 与 `subagents:child:disposed` 两处接线）。

### 4.3 `src/tools.ts`：归一化 + 门禁

`resolveCall` 的新顺序（相对 09-29 §7 的 6 步流程）：

1. `normalizeEscalationValue` × 2（占位符 → `undefined`）
2. `validateEscalationArgs`（D5：真畸形才报错）
3. effective mode 解析（不变，`/permission` 覆盖 > config）
4. `requested === undefined` → 无提权路径（不变）
5. **门禁**：`isStrictlyWider(effective, requested)` 且未命中未消费记录 → 返回 `{ mode: effective, escalated: false, ignoredEscalation: true }`
6. `approveEscalation`（同档免审批、非法报错、通道解析、审批对话——原样）

`ResolvedCall` 增加 `ignoredEscalation`；三个 `execute` 在 ignored 时对结果追加 `escalationIgnoredMarker`。

> **2026-10-02 修订注记（宿主参数校验层：占位符归一化按字段可达）**：第 1 步仍必需，但**可达性不同**——pi ≥0.80.2（本包 peer floor；1.0.0 实测同）在 extension `execute` 之前跑 `validateToolArguments`，而它校验的是 **declared schema**（不是下发给模型的 strict wire schema；0.80.2 尚无 strict 转换与 `normalizeOptionalNulls`，但**有**这项校验）。实测结论：
> - `justification` 的字符串臂是 `Type.String()`（字段本身为 `string | null`）：字符串占位符 `"null"` / `""` / 空白都是合法值，**真的会到达 `execute`** → 归一化是 load-bearing 的。删掉它，一笔普通调用会被误判成 `justification was sent without sandbox_permissions`；真提权还会带着 `Reason: null` 进审批弹窗。
> - `sandbox_permissions`（两个字面量枚举）：字符串形态在 pi 的参数校验期就被拒（`execute` 不会跑）——**0.80.2 与 1.0.0 实测同**；只有“省略”和 schema 显式声明的 JSON `null` 会到达；后者是本次新增的（§4.6 与 09-29 §“工具 schema 扩展”）。
> - 校验对 declared schema 做 → “省略”永远放行，与 strict wire schema 的 `required` 无关；JSON `null` 之所以曾“没事”，是 `normalizeOptionalNulls` 把 optional 且不允许 null 的字段直接删键。声明 `Type.Null()` 后它不再被删，而是原样送达归一化——这条分支从“靠 pi 的补丁”变成契约内行为。
>
> 第 2–6 步与 `ResolvedCall` 契约不变。

> **2026-10-02 三次修订（`prepareArguments` 占位符剥离：噪声在校验前出局）**：上一条把 `Type.Null()` 当作“不提权”的合法取值，但实测（deepseek-flash，strict 提供商）它**降低不了**模型写字符串 `"null"` 的概率——三个机制叠加：
> 1. strict 转换把所有 property 塞进 `required`，模型在协议上无法省略；
> 2. schema 文本里 `null` 只以带引号的 `{"type":"null"}` 出现（JSON Schema 的类型名本身是字符串），模型逐 token 生成时照抄成字符串；
> 3. `"null"` 在 `sandbox_permissions` 的两字面量枚举上被 pi 的参数校验硬拒，而错误消息把原参数 JSON 回放（`Received arguments: … "sandbox_permissions": "null" …`）进上下文，成为下一轮最强的模仿样本 → 自我强化。
>
> 因此新增 `stripEscalationPlaceholders`（`src/escalation.ts`）并挂在三个工具的 `prepareArguments` 上（`src/tools.ts` 的 `withPlaceholderStripping`）。pi 的 `prepareToolCallArguments` 在 `validateToolArguments` **之前**执行，于是字符串占位符在校验前出局：普通调用照常执行，第 3 条的回放循环被掐断。
>
> - **与 `Type.Null()` 正交，二者都保留**：`Type.Null()` 管“裸 null 的合法性/自证”（不依赖 pi 的 strict 包裹与 `normalizeOptionalNulls` 剥键），钩子管“错误字符串的容错”。删掉 `Type.Null()` 会让裸 null 的正确性重新依赖宿主实现细节，故不删。
> - **只剥占位符字符串**（判定复用 `normalizeEscalationValue`）：JSON `null`、省略、真提权（合法档位 + 非空理由）原样通过；非法值（非法档位、数字、对象等）原样保留，交给宿主校验 / `validateEscalationArgs` 报错（注意 pi 的 `Value.Convert` 会把数字/布尔强转成字符串、拒掉对象/数组，所以“保留”不等于“原样到达 execute”）；真畸形仍由 `validateEscalationArgs` 报既有 MALFORMED。
> - **必须串联 base 钩子**：pi 内置 edit 的 `prepareEditArguments`（legacy `oldText`/`newText` → `edits`）不得被覆盖——`withPlaceholderStripping` 先跑 base 再剥离；bash/write 在 pi 侧暂无钩子，串联写法对未来新增的 base 钩子自动生效。
> - **可达性更新**：`sandbox_permissions` 的字符串占位符不再“在 pi 校验期硬拒”（先被钩子剥掉）；`normalizeEscalationValue` 保留为未走钩子的调用路径的兜底。
> - 测试：`tests/escalation.test.ts`（纯函数语义：剥占位符 / 不碰裸 null 与真提权 / 非对象防御 / 不 mutation / 无占位符同引用）与 `tests/tools.test.ts`（三工具接线 + edit legacy 回归 + 剥后走 `resolveCall` 的普通调用断言）。
> - **版本适用面**：钩子在 peer floor 0.80.2 上就是 load-bearing 的——0.80.2 的 `validateToolArguments` 同样硬拒 `"null"`（实测），只是 0.80.2 无 strict wire schema 转换，模型“被迫给值”的动机比 1.0.0 弱。
> - **宿主级验证配方（手工跑；CI 盖不住这类漂移）**：包自己的 vitest 不 import 宿主校验器（`check:host-deps` 要求 import 宿主提供包必须在 `peerDependencies` 声明），因此“raw 被拒 → 钩子后通过”只能手工复现。把下面内容存为**仓库内**的脚本（不能在 `/tmp`：否则解析不到宿主包），`node <file>.mjs`：
>   ```js
>   import { validateToolArguments } from "@earendil-works/pi-ai/compat"; // 0.80.2 与 1.0.0 同
>   const tool = { name: "bash", parameters: { type: "object", required: ["command"], properties: {
>     command: { type: "string" },
>     sandbox_permissions: { anyOf: [ { type: "string", const: "workspace-write" },
>       { type: "string", const: "danger-full-access" }, { type: "null" } ] },
>     justification: { anyOf: [{ type: "string" }, { type: "null" }] } } } };
>   validateToolArguments(tool, { name: "bash", arguments: { command: "ls", sandbox_permissions: "null" } });
>   // 期望抛出：sandbox_permissions: must be equal to constant（0.80.2 与 1.0.0 实测同）
>   ```
>   再把同一参数过一遍 `stripEscalationPlaceholders`（`src/escalation.ts`）后重跑校验：应通过且参数为 `{command:"ls"}`。宿主若改为按 strict wire schema 校验，本钩子的“删键”反而会让普通调用失败（strict 下 required 全含）——配方此时会变成反向信号。

### 4.4 记账点

- **bash**：`SandboxBashOpts.onDenial?: () => void`，在 `classifyDenial` 命中分支调用（runner failure 不触发——那是沙箱不可用，不是拒绝）；`tools.ts` 注入 `record(sessionId, "command")`；
- **write / edit**：`createFencedWriteOps` / `createFencedEditOps` 的 guard 捕获 `FenceDenialError` → `record(sessionId, "operation")` → 原错误重抛（模型可见文本不变）。

### 4.5 `ask` 原语与两步式（含 broker FIFO 原子性）

- `EscalationUI` 从 `{ hasUI, select }` 收敛为 `{ hasUI, ask(title, options, denialReason?) → { choice, reason? } }`；
- **直连通道**：`select` → 若 `Deny` 且 `ctx.ui.input` 存在 → `input(DENIAL_REASON_PROMPT)`；同一条异步链上串行 await，天然原子；
- **broker 通道**：`ParentApprovalChannel` 增加可选 `input`；`request` 在**同一个 FIFO 任务**内完成 select+input（否则排队中的下一个审批会顶掉正开着的理由弹窗——Ruling 17 的槽位约束对 input 同样成立）；
- 理由 `sanitizeDenialReason`：折叠空白、trim、截断 500 字符；空 / 占位符 → 无后缀（拒绝文案逐字回退原样）；
- Deny 文案追加 `. The user's reason: <reason>`（前缀文案逐字不变，既有判例正则继续匹配）。

### 4.6 提示词面（软约束同步强化）

- `SANDBOX_NOTE`（每工具，付 3 份）：`Pass escalation fields only when retrying a denial (never null); others are ignored.`
- `ESCALATION_GUIDELINE`（system prompt rules，付 1 份）：新增 `Never send escalation fields before a denial — such requests are ignored and the call runs confined.`，并写明 Deny 可附理由。
- 提示预算闸（β′）：`tool.description` 中 `Sandbox:` 行三工具合计 ≤ 560 字符（不变）。

> **2026-10-02 修订注记（原文案与 strict schema 自相矛盾）**：`SANDBOX_NOTE` 第二句改为 `Unless retrying a denial, omit these fields or send JSON null.`（同日二次修订：去掉首稿的负向子句 `— never the string "null"`，只留正向表述，三工具合计预算从 546 降到 468）。原文案 `Pass escalation fields only when retrying a denial (never null); others are ignored.` 的问题：strict 提供商下模型看到的 schema 把两个字段列为 `required`，“省略”在协议上不可表达，而 `(never null)` 又禁止了唯一合法的“不提权”取值——模型只能去写字符串 `"null"`，那在 pi 的参数校验期就硬失败（错误文案与沙箱无关，反而把模型推向真提权）。“先发制人会被忽略”的语义删去不丢信息：`ESCALATION_GUIDELINE`（付 1 份）里已写明 “such requests are ignored and the call runs confined” 与 `escalationIgnoredMarker`。三工具合计预算仍 ≤ 560（实测 468）。

## 5. 时序

**先发制人（被忽略）**：模型带 `danger-full-access` + justification → 归一化 → 门禁（无记录）→ ignored → 按 effective 执行 → 成功则结果附 ignored 标记；失败则 denial marker + hint（bash 走 throw，见 §8）。

**真实拒绝后重试（放行）**：命令被拒 → 记账 → 模型原样重试 → 门禁命中并消费 → 审批对话（Allow once / Deny + 可选理由）→ 一次性更宽执行 → 结果附 one-shot 标记。

**占位符**：工具侧 `prepareArguments` 先把字符串占位符（`"null"` / `""` / 纯空白）剥成“未提供”（三次修订，见 §4.3）；随后 JSON `null`（或省略）→ 归一化 `undefined` → 普通调用（无弹窗、无报错）；`justification` 的字符串占位符在未走钩子的调用路径上走同一条归一化。

**子代理**：子会话各记各的账；子被拒 → 记账 → 重试 → 门禁命中 → 转发父会话弹窗（09-30 链路不变）；子会话 disposed 时账本 `forget`。

## 6. 失败模式矩阵

| 情况 | 行为 |
|---|---|
| 无记录 + 更宽请求 | 忽略 → 当前档执行 + ignored 标记（不弹窗） |
| 无记录 + 更宽请求 + 命令真被拒 | 正常 denial 流程（记账）→ 重试可弹窗 |
| 有记录 + 更宽请求 | 消费记录 → 审批对话 |
| 有记录 + 更宽请求 + 用户 Deny | 消费记录；错误文案含可选理由；再提权因无记录被忽略（模型被告知 stop and explain） |
| 同档请求（含 `/permission` 已放宽） | 免审批，不触达门禁（不受记录影响） |
| 非法目标（更窄 / 未知） | 既有 not-strictly-wider 错误（不进门禁、不静默降级） |
| 占位符参数（可达者） | `prepareArguments` 在校验前剥掉字符串形态；JSON `null` / 省略走归一化 → 普通调用（三次修订，见 §4.3） |
| 真畸形（只给一个字段 / 空 justification） | 既有 malformed 错误（nothing ran + 修复配方） |
| 读不到 sessionId（窄 ctx / 异常宿主） | 无记录可证 → 忽略（不抛 TypeError，fail-closed 方向） |
| headless（有会话身份、无通道） | 有记录时走既有 no approval channel 错误；无记录时忽略 |
| bash 非零退出（throw 路径） | ignored 标记不下发（已知边界，§8）；denial marker + hint 仍引导正确重试 |
| 子会话 disposed | `forget` 清账本，防 Map 泄漏 |
| 宿主无 `ctx.ui.input`（旧版本） | 登记通道时 `input` 为 `undefined`；broker 跳过理由追问，Deny 语义不变 |

## 7. 安全与信任边界

- 账本只决定"是否进入审批对话"，**不放宽任何 mode**；实际权限仍由 runner / fence 强制；
- 忽略方向是 fail-closed：无记录 → 按当前（更窄）档执行，绝不静默放宽；
- 一次拒绝只兑付一次重试；审批本身仍是一次性（09-29 §7 语义不变）；
- 账本挂 `globalThis`，可被同进程扩展篡改——与 09-30 broker 的威胁模型相同（能在同进程执行代码的扩展本就能绕过沙箱），不在本包威胁模型内；
- Deny 理由是**用户输入**，经折叠/截断后进模型上下文，内容由用户自己决定。

## 8. 已知取舍

- **多一轮往返**：预判型提权（真需要更宽权限）会先以当前档失败一次再重试（D1 的固有代价，用户已接受）；
- **bash throw 路径不下发 ignored 标记**：失败路径上模型少一次"参数被忽略"的正反馈，但 denial marker + hint 会引导正确重试（重试链路有判例覆盖）；
- **理由只在 Deny 分支收集**：Allow once 不带理由（非目标）；
- **账本无 TTL**：长会话中旧拒绝记录理论上可被很晚的提权消费——但审批仍会弹窗（用户可见可拒），且模型通常紧邻重试。

## 9. 未来扩展点

- **配置开关**（本设计未做，D8）：若将来需要"先发制人提权"模式，在 config schema 增加字段、门禁判断处单点接入即可；
- **账本粒度收紧**：当前按会话 + kind；若观察到误用可收紧到命令指纹匹配（`Map<sessionId, {kind, fingerprint}>`）；
- **Deny 理由的一体式弹窗**：`ask` 原语不变，只换通道实现（`ui.custom`）。

## 10. 文档改动清单

| 文件 | 改动 |
|---|---|
| 本文件 | 新增 |
| `2026-09-29-process-sandbox-design.md` §7 | 校验顺序小节追加"2026-10-02 增补"段（归一化位置、门禁位置、Deny 理由），原 1–6 步编号保留（不破坏跨文档引用） |
| `2026-09-30-escalation-approval-forwarding-design.md` §4.4 | "escalation.ts 零改动"加修订注记（ask 原语；六步顺序与返回路径映射本身不变） |
| 同上 §9 | seam 描述 `{ hasUI, select }` → `{ hasUI, ask }` |
| 同上 §11 | "现有 escalation 语义不回归"行补注：Deny 文案追加可选理由后缀、用例因 ask 重构适配 |
| `README.md` / `README.zh.md` 提权审批一节 | denial-first 语义 + Deny 理由（已随 PR #157 落地） |
| `src/denial-ledger.ts` 头注释 | 引用本文件的 §4.2 |

## 11. 测试计划

| 用例 | 断言 | 文件 |
|---|---|---|
| 账本单例 / 一次性 / 幂等 / kind 隔离 / 会话隔离 / forget | 见用例 | `tests/denial-ledger.test.ts`（新增） |
| 无记录 + 更宽请求 | ignored、不弹窗、按 effective 执行 | `tests/tools.test.ts` |
| 消费一次性 | 首次放行、二次忽略 | 同上 |
| kind 隔离（operation 记录不放行 command） | 同上 | 同上 |
| 同档 / 非法请求不受门禁影响 | 免审批 / not-strictly-wider | 同上 |
| 归一化（JSON `null` 值 / 省略 / `justification` 的 `"null"`・空白） | 普通调用、不抛 malformed | 同上 |
| write 围栏内 + 无记录提权 | 落地成功 + ignored 标记 + 零弹窗 | 同上 |
| 全链路：忽略 → fence 拒绝 → 重试弹窗 → 落盘 | 真实拒绝后恢复标准审批 | 同上 |
| bash `onDenial` 记账（命中 / runner failure 不触发） | 调用次数断言 | `tests/bash-ops.test.ts` |
| `ask` 原语（Allow / Deny / 取消 / 无通道） | 既有判例适配 + 理由后缀 | `tests/escalation.test.ts` |
| 理由 sanitize（折叠 / 空 / 截断 / 非字符串）、归一化、`isStrictlyWider` | 逐值断言 | 同上 |
| FIFO：select 与 input 同一任务 | A 的理由输入未 settle 前 B 不弹 select | `tests/escalation-broker.test.ts` |
| 通道 `input` 透传 / 旧宿主无 input | 透传 opts；缺失时为 `undefined` | `tests/index-smoke.test.ts` |
| 端到端转发：拒绝 → 重试 → 父弹窗 → 落盘 → disposed 后 fail-closed | 09-30 Ruling 18 判例适配 + 记账 | `tests/forwarding-integration.test.ts` |

真实 runner 自检（临时脚本，跑完删除）：

1. 先发制人带提权 + 无记录 → 零弹窗、真 bwrap 执行、ignored 标记；
2. write 真被拒 → 重试弹窗（select 1 次 + Deny 理由 input 1 次）；
3. 真 bwrap 拒绝（写 workspace 外）→ 重试弹窗 → `danger-full-access` 真实执行成功。

### 真机验证（人工，需交互式 TUI）

配方同 09-30 §11（临时 agent dir，`PI_CODING_AGENT_DIR` 隔离，父子加载同一份构建）。观察点：

1. 模型第一次带提权参数（若它带）→ **不弹窗**，结果含 ignored 标记；
2. 真实被拒后原样重试 → 弹窗；选 `Deny` 后**弹出理由输入框**，留空回车 = 无理由；
3. 填理由后 → 模型错误文本含 `The user's reason: ...`；
4. 占位符：模型传 `null` 参数的命令正常执行（不报 malformed）。

## 12. 交付范围

- worktree `.worktrees/pi-sandbox-denial-first`，分支 `feat/pi-sandbox-denial-first`（PR #157）；
- 交付物：`src/denial-ledger.ts` 新增；`src/escalation.ts`、`src/escalation-broker.ts`、`src/tools.ts`、`src/bash-ops.ts`、`index.ts` 改动；测试 14 files / 211 例；本文件与 §10 的文档改动；
- **不含** npm 发版（若发版按 `docs/guides/release.md`，minor：`1.2.0` → `1.3.0`）——由用户另行决定。
