# Design: pi-vision-tools — 收敛为自动启停与 default think level 配置

**Date:** 2026-10-02
**Status:** draft
**取代：** [2026-06-25-pi-vision-tools-design.md](./2026-06-25-pi-vision-tools-design.md)（本文档描述变更后的目标状态；旧文档保留为历史记录）

## 背景与目标

现状（v0.2.1）：

- `describe_image` 的启停由 `effectiveEnabled(config, model)` 计算，配置字段 `enabled` 有三态 `auto | on | off`，对应 `/vision on`、`/vision off`、`/vision auto` 三条子命令。
- think level 有**两个来源**：工具参数 `reasoning`（可选，每次调用由模型决定）优先，配置项 `defaultReasoning`（持久化默认值）兜底，再兜底 `off`。`default` 前缀即表示"调用未显式传参时使用"，实现见 `src/reasoning.ts:22` 的 `param ?? configDefault ?? "off"`。
- 命令为 `/vision config default-reasoning <level>`，且**写入时不校验取值**。

本次改动三个目标：

1. **删除强制启停**：`enabled` 三态与 `on`/`off`/`auto` 子命令全部删除，工具启停**只**由调用方模型的模态决定（原先的 `auto` 从"一种可选模式"变成唯一行为，不再是配置值）。
2. **术语改名**：命令参数、配置键、模块级标识符、工具参数统一为 think level 术语，并保留"默认值"语义。
3. **附带修复**（原任务外，已获确认）：默认 think level 在写盘前校验取值，堵住"非法值写入 → 下次 session 解析失败 → 静默回退默认配置 → 连 `model` 一起丢失"的既有隐患。

### 任务范围修订（用户确认）

原始任务第 2 条为「`/vision config default-reasoning` 改为 `/vision config think-level`」，经确认修订为：

| 面向 | 原名 | 新名 |
|---|---|---|
| 命令参数 | `default-reasoning` | `default-think-level`（保留 `default` 语义） |
| 配置文件键 | `defaultReasoning` | `defaultThinkLevel` |
| 工具参数（追加，模型可见） | `reasoning` | `thinkLevel` |

工具参数 `reasoning` 仍在改动范围内，因为它是配置项"默认值"语义的另一半：只要参数链路存在，配置项就是 default。

## 关键决策

| # | 决策 | 选择 | 理由 |
|---|------|------|------|
| 1 | 命令面最终形态 | 保留 `/vision`、`/vision status`、`/vision config model <m>`、`/vision config default-think-level <level>`；其余输入回 usage warning | 任务要求"只有 auto"；`/vision config` 因目标 2 必须保留 |
| 2 | 老配置键兼容 | **不做**兼容读取。`enabled`、`defaultReasoning` 由既有的"剥离未知键"逻辑自然丢弃 | 显式取舍：老用户若设置过 `defaultReasoning` 需重新设置一次；不引入回退分支 |
| 3 | 改名范围 | 模块级统一 think level 术语 + 工具参数改名（见对照表）；宿主 API 字段 `reasoningEffort` **保持不变** | 统一术语；`reasoningEffort` 是 pi-ai 的字段名，不属于本包 |
| 4 | 测试结构 | `index.ts` handler 保持内联，新增 `tests/index-wiring.test.ts` 覆盖命令面与工具 schema | 本次风险集中在命令分发、落盘与参数改名，而这是原先唯一无测试的地方；抽 factory 对 ~40 行代码偏重 |
| 5 | 默认 think level 取值校验 | 写盘前校验必须属于 `off \| minimal \| low \| medium \| high \| xhigh`，非法值只回 warning 且不写盘 | 修复既有隐患（目标 3）；`THINK_LEVELS` 从 `config.ts` 导出以保证单一事实来源 |

## 数据模型（变更后）

```ts
// src/config.ts
export interface VisionConfig {
	/** "provider/modelId" or a fuzzy model name (e.g. "haiku", "qwen vl"). */
	model?: string;
	defaultThinkLevel?: ThinkingLevel | "off";
}

export const DEFAULT_CONFIG: VisionConfig = {};

export const THINK_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const satisfies readonly VisionThinkLevel[];
```

- 删除 `VisionEnabledState` 类型与 `ENABLED_STATES` 常量。
- `parseConfig` 删除 `enabled` 分支；`defaultReasoning` 分支改名 `defaultThinkLevel`，错误信息同步为 `vision-tools config: defaultThinkLevel must be one of ...`。
- `defaultThinkLevel` 可省略，有效力度仍为 `effectiveThinkLevel(toolParam, config.defaultThinkLevel)` → `param ?? configDefault ?? "off"`，与改动前完全一致（只是参数与配置键改名）。
- 写入端（`saveConfig`）不变：原子写 `.tmp` + `rename`，紧凑 JSON。

### 迁移语义

| 老配置文件内容 | 变更后行为 |
|---|---|
| `{"model":"haiku"}` | 不变 |
| `{"model":"haiku","enabled":"auto"}` | `enabled` 被剥离 → `{"model":"haiku"}` |
| `{"model":"haiku","enabled":"on"}` | 同上（`on` 语义消失，自动启停接管） |
| `{"model":"haiku","enabled":"off"}` | 同上（失去强制禁用能力，这是本次改动的目的） |
| `{"model":"haiku","defaultReasoning":"high"}` | `defaultReasoning` 被剥离 → 默认 think level 回落 `off`（决策 2） |
| `{"model":"haiku","defaultThinkLevel":"ultra"}` | `parseConfig` 抛错 → `loadConfig` 回退 `DEFAULT_CONFIG`（该路径仅在手写文件时可达；命令写入端已校验，见决策 5） |

## 命令面（变更后）

| 输入 | 行为 |
|---|---|
| `/vision`、`/vision status` | 显示状态（见下） |
| `/vision config model <m>` | 解析模糊名/精确 `provider/id` → 落盘 → 回显解析后的 `provider/id`（行为不变） |
| `/vision config default-think-level <level>` | 校验取值 → 落盘 → 回显 |
| 其余一切输入（含 `on`/`off`/`auto`、`config default-reasoning`、参数不全） | 回 usage warning，**不写盘** |

- 用法提示：`Usage: /vision [status | config model <m> | config default-think-level <level>]`
- `config` 子用法：`Usage: /vision config model <m> | /vision config default-think-level <level>`
- 命令 `description` 同步更新，不再提"on / off"。

### 状态输出

```
vision: <解析后 provider/id>                  # 未配置 → "(unconfigured)" + 追加引导行；解析失败 → "<name> (unresolved)" + 追加错误行
default think level: <defaultThinkLevel|off (built-in)>
active: yes|no (calling model has vision: yes|no)
```

未设置配置项时显示 `off (built-in)`，与"显式设置成 off"区分开。

## 状态与启停（变更后）

```ts
// index.ts
let config: VisionConfig = {};
let toolActive = false;

const refresh = (ctx: ExtensionContext) => {
	toolActive = !callingModelHasVision(ctx.model);
	const current = pi.getActiveTools();
	if (toolActive && !current.includes(TOOL_NAME)) {
		pi.setActiveTools([...current, TOOL_NAME]);
	} else if (!toolActive && current.includes(TOOL_NAME)) {
		pi.setActiveTools(current.filter((t) => t !== TOOL_NAME));
	}
	if (ctx.hasUI) {
		ctx.ui.setStatus(STATUS_KEY, footerLabel(toolActive, resolveVisionModel(ctx.modelRegistry, config)));
	}
};
```

- `src/state.ts` 的 `effectiveEnabled` 删除（唯一调用点即此处）；`callingModelHasVision`、`footerLabel` 保留。
- 局部变量 `enabled` → `toolActive`（避免与刚删除的配置字段同名而误导），`pi.getActiveTools()` 的局部名 `active` → `current`。
- 生命周期不变：`session_start` 加载配置后 `refresh`，`model_select` 时 `refresh`。
- `execute()` 守卫保留（可拦住排队中的陈旧调用），文案不再指向已删除命令：`describe_image is inactive: <reason>.`，其中 `<reason>` 按**实时** `ctx.model` 取 `the calling model can see images itself` 或 `the tool is not active for the current model`

## 工具接口变更

`describe_image` 参数由 `reasoning?` 改为 `thinkLevel?`（可选，枚举 `off|minimal|low|medium|high|xhigh`，语义与优先级不变）。连带同步：

| 位置 | 变更 |
|---|---|
| 工具 `parameters` schema | 属性键 `reasoning` → `thinkLevel` |
| 工具 `description` | `` `thinkLevel` controls the vision model's thinking effort (off/minimal/low/medium/high/xhigh) `` |
| `promptGuidelines` | `Set thinkLevel:'high'/'xhigh' for complex visual analysis ...` |
| `execute()` | 读取 `p.thinkLevel`，调用 `effectiveThinkLevel(p.thinkLevel, config.defaultThinkLevel)` |
| 工具结果 `details` | `reasoning` → `thinkLevel`（值为本次实际生效的力度） |
| 两个 README | 工具参数表、示例、推理级别说明 |

## 文件与符号改名对照表

| 旧 | 新 |
|---|---|
| `src/reasoning.ts` | `src/think-level.ts` |
| `tests/reasoning.test.ts` | `tests/think-level.test.ts` |
| `type VisionReasoning` | `type VisionThinkLevel` |
| `interface ReasoningOptions` | `interface ThinkLevelOptions` |
| `reasoningToOptions()` | `thinkLevelToOptions()` |
| `effectiveReasoning()` | `effectiveThinkLevel()` |
| `config.defaultReasoning` | `config.defaultThinkLevel` |
| `REASONING_LEVELS`（模块私有） | `THINK_LEVELS`（导出） |
| 工具参数 `reasoning` | 工具参数 `thinkLevel` |
| `details.reasoning` | `details.thinkLevel` |
| `VisionEnabledState`、`ENABLED_STATES`、`effectiveEnabled()` | 删除 |
| 宿主 API 字段 `reasoningEffort`（`ThinkLevelOptions.reasoningEffort`） | **不变** |

import 路径需同步的位置：`index.ts`、`src/vision.ts`（`ThinkLevelOptions`）、`tests/think-level.test.ts`。

## 测试策略

沿用 `docs/guides/testing.md`：文件系统隔离用 `mkdtemp` + `tmpdir()` 并在 `afterEach` 清理；`getAgentDir` 通过 `vi.mock` + `vi.hoisted()` 指向临时目录；不读写真实 `~/.pi/`。

| 文件 | 改动 |
|---|---|
| `tests/config.test.ts` | 用例改为 `{ model, defaultThinkLevel }`；新增"`enabled` 与 `defaultReasoning` 老键被剥离 → `{}`"；`rejects an invalid enabled value` 删除；非法值用例改为 `defaultThinkLevel`；round-trip / save 用例去掉 `enabled`；`DEFAULT_CONFIG` 断言更新为空对象 |
| `tests/state.test.ts` | `footerLabel` 用例不变；新增 `callingModelHasVision` 三个用例（`["text","image"]` → true、`["text"]` → false、`undefined` → false）——它现在是唯一决定激活的谓词 |
| `tests/think-level.test.ts` | 由 `tests/reasoning.test.ts` 改名，标识符同步 |
| `tests/index-wiring.test.ts`（新增） | fake `ExtensionAPI` 捕获 `registerCommand("vision")` 的 handler 与 `registerTool`；fake ctx 提供 `model` / `modelRegistry` / `hasUI` / `ui.notify` / `ui.setStatus` / `getActiveTools` / `setActiveTools`。断言：`on`/`off`/`auto`/`config default-reasoning` 一律只回 warning 且**不产生文件**；`config default-think-level high` → 文件为 `{"defaultThinkLevel":"high"}`；`config default-think-level ultra` → warning 且不写盘；`config model <模糊名>` → 经 fake registry 解析成功并落盘；`status` 文本含 `default think level` 与 `active`；`session_start` 按 `ctx.model` 的视觉能力增删 `describe_image`；**工具 schema 的参数键为 `thinkLevel` 而非 `reasoning`**（锁住参数改名） |

## 文档

- `README.md` / `README.zh.md`：命令表收敛为三行（status、config model、config default-think-level），删除 `on`/`off`/`auto` 三行与"强制启用/禁用"表述；功能要点改为"始终按调用方模型模态自动启停"；工具参数表 `reasoning` → `thinkLevel`；配置示例改为 `{ "model": "haiku" }`；推理级别表与页脚指示器说明同步改名。
- 旧 spec 顶部已加指向本文档的取代指针，正文不改。

## Out of Scope

- 为旧命令、旧配置键或旧工具参数提供别名、兼容期或回退读取。
- 版本号变更与发布流程（`docs/guides/release.md`）——本次仅改代码，版本与发布另行决定。
- 重构 `model-resolver.ts`、`compress.ts`、`image.ts`、`vision.ts` 中与本次无关的逻辑。
- 修改本机真实配置 `~/.pi/agent/vision-tools.json`。

## 验收标准

1. `pi-vision-tools` 下 `npm test` 全绿（含新增 wiring 测试），`npm run typecheck`、`npm run lint` 通过。
2. `/vision on`、`/vision off`、`/vision auto`、`/vision config default-reasoning high` 均只回 usage warning，且不产生/不修改配置文件。
3. `/vision config default-think-level high` 写出紧凑 JSON `{"defaultThinkLevel":"high"}`；`/vision config default-think-level ultra` 回 warning 且不写盘。
4. 老配置 `{"model":"haiku","enabled":"off","defaultReasoning":"high"}` 加载后等价于 `{"model":"haiku"}`。
5. `index.ts` 与 `src/` 下不再出现 `effectiveEnabled`、`VisionEnabledState`、`ENABLED_STATES`、`REASONING_LEVELS`、`defaultReasoning`、`reasoningToOptions`、`effectiveReasoning` 等旧标识符（测试与 spec 文档中为验证/记录迁移而出现的旧键字面量除外）；`src/reasoning.ts` 与 `tests/reasoning.test.ts` 已改名。
6. 工具 schema 的属性键为 `thinkLevel`；`description`、`promptGuidelines`、工具结果 `details`、两个 README 中作为**参数名**的 `reasoning` 已全部替换（宿主字段 `reasoningEffort` 保留，不算残留）。
7. 两个 README 中不再出现 `/vision on`、`/vision off`、`/vision auto`、`default-reasoning` 与 `"enabled"`。
