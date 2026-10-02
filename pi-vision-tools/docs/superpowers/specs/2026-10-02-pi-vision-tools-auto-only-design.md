# Design: pi-vision-tools — 收敛为自动启停与 think-level 配置

**Date:** 2026-10-02
**Status:** draft
**取代：** [2026-06-25-pi-vision-tools-design.md](./2026-06-25-pi-vision-tools-design.md)（本文档描述变更后的目标状态；旧文档保留为历史记录）

## 背景与目标

现状（v0.2.1）：`describe_image` 的启停由 `effectiveEnabled(config, model)` 计算，配置字段 `enabled` 有三态 `auto | on | off`，对应 `/vision on`、`/vision off`、`/vision auto` 三条子命令；默认推理力度由 `config.defaultReasoning` 提供，命令为 `/vision config default-reasoning <level>`。

本次改动三个目标：

1. **删除强制启停**：`enabled` 三态与 `on`/`off`/`auto` 子命令全部删除，工具启停**只**由调用方模型的模态决定（原先的 `auto` 从"一种可选模式"变成唯一行为，不再是配置值）。
2. **术语改名**：命令参数 `default-reasoning` → `think-level`；配置键 `defaultReasoning` → `thinkLevel`；模块级标识符统一为 think level 术语。
3. **附带修复**（原任务外，已获确认）：`think-level` 在写盘前校验取值，堵住"非法值写入 → 下次 session 解析失败 → 静默回退默认配置 → 连 `model` 一起丢失"的既有隐患。

## 关键决策

| # | 决策 | 选择 | 理由 |
|---|------|------|------|
| 1 | 命令面最终形态 | 保留 `/vision`、`/vision status`、`/vision config model <m>`、`/vision config think-level <level>`；其余输入回 usage warning | 任务要求"只有 auto"；`/vision config` 因目标 2 必须保留 |
| 2 | 老配置键兼容 | **不做**兼容读取。`enabled`、`defaultReasoning` 由既有的"剥离未知键"逻辑自然丢弃 | 显式取舍：老用户若设置过 `defaultReasoning` 需重新设置一次；不引入回退分支 |
| 3 | 改名范围 | 模块级统一 think level 术语（见下方对照表）；工具参数 `reasoning` 与宿主字段 `reasoningEffort` **保持不变** | 工具参数是模型可见的公开接口，改名会额外扩大 breaking 面 |
| 4 | 测试结构 | `index.ts` handler 保持内联，新增 `tests/index-wiring.test.ts` 覆盖命令面 | 本次风险集中在命令分发与落盘，而这是原先唯一无测试的地方；抽 factory 对 ~40 行代码偏重 |
| 5 | think-level 取值校验 | 写盘前校验必须属于 `off \| minimal \| low \| medium \| high \| xhigh`，非法值只回 warning 且不写盘 | 修复既有隐患（见目标 3）；`THINK_LEVELS` 从 `config.ts` 导出以保证单一事实来源 |

## 数据模型（变更后）

```ts
// src/config.ts
export interface VisionConfig {
	/** "provider/modelId" or a fuzzy model name (e.g. "haiku", "qwen vl"). */
	model?: string;
	thinkLevel?: ThinkingLevel | "off";
}

export const DEFAULT_CONFIG: VisionConfig = {};

export const THINK_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
```

- 删除 `VisionEnabledState` 类型与 `ENABLED_STATES` 常量。
- `parseConfig` 删除 `enabled` 分支；`defaultReasoning` 分支改名 `thinkLevel`，错误信息同步为 `vision-tools config: thinkLevel must be one of ...`。
- `thinkLevel` 可省略，缺省时有效推理力度仍为 `off`（`effectiveThinkLevel(param, configDefault)` 返回 `param ?? configDefault ?? "off"`），与改动前一致。
- 写入端（`saveConfig`）不变：原子写 `.tmp` + `rename`，内容为紧凑 JSON。

### 迁移语义

| 老配置文件内容 | 变更后行为 |
|---|---|
| `{"model":"haiku"}` | 不变 |
| `{"model":"haiku","enabled":"auto"}` | `enabled` 被剥离 → `{"model":"haiku"}` |
| `{"model":"haiku","enabled":"on"}` | 同上（`on` 语义消失，自动启停接管） |
| `{"model":"haiku","enabled":"off"}` | 同上（失去强制禁用能力，这是本次改动的目的） |
| `{"model":"haiku","defaultReasoning":"high"}` | `defaultReasoning` 被剥离 → think level 回落 `off`（决策 2） |
| `{"model":"haiku","thinkLevel":"ultra"}` | `parseConfig` 抛错 → `loadConfig` 回退 `DEFAULT_CONFIG`（该路径仅在手写文件时可达；命令写入端已校验，见决策 5） |

## 命令面（变更后）

| 输入 | 行为 |
|---|---|
| `/vision`、`/vision status` | 显示状态（见下） |
| `/vision config model <m>` | 解析模糊名/精确 `provider/id` → 落盘 → 回显解析后的 `provider/id`（行为不变） |
| `/vision config think-level <level>` | 校验取值 → 落盘 → 回显 |
| 其余一切输入（含 `on`/`off`/`auto`、`config default-reasoning`、参数不全） | 回 usage warning，**不写盘** |

- 用法提示：`Usage: /vision [status | config model <m> | config think-level <level>]`
- `config` 子用法：`Usage: /vision config model <m> | /vision config think-level <level>`
- 命令 `description` 同步更新，不再提"on / off"。

### 状态输出

```
vision: <解析后 provider/id>            # 未配置 → "(unconfigured)"；解析失败 → "<name> (unresolved)" + 追加错误行
think level: <thinkLevel>               # 未设置 → "off (default)"
active: yes|no (calling model has vision: yes|no)
```

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
- `execute()` 守卫保留（可拦住排队中的陈旧调用），文案改为不再指向已删除命令：`describe_image is inactive: the calling model can see images itself.`

## 文件与符号改名对照表

| 旧 | 新 |
|---|---|
| `src/reasoning.ts` | `src/think-level.ts` |
| `tests/reasoning.test.ts` | `tests/think-level.test.ts` |
| `type VisionReasoning` | `type VisionThinkLevel` |
| `interface ReasoningOptions` | `interface ThinkLevelOptions` |
| `reasoningToOptions()` | `thinkLevelToOptions()` |
| `effectiveReasoning()` | `effectiveThinkLevel()` |
| `config.defaultReasoning` | `config.thinkLevel` |
| `REASONING_LEVELS`（模块私有） | `THINK_LEVELS`（导出） |
| `details.reasoning`（工具结果 details） | `details.thinkLevel` |
| `VisionEnabledState`、`ENABLED_STATES`、`effectiveEnabled()` | 删除 |
| 工具参数 `reasoning`、返回结构里的 `reasoningEffort` | **不变**（分别是模型可见参数与宿主 API 字段） |

import 路径需同步的位置：`index.ts`、`src/vision.ts`（`ReasoningOptions`）、`tests/think-level.test.ts`。

## 测试策略

沿用 `docs/guides/testing.md`：文件系统隔离用 `mkdtemp` + `tmpdir()` 并在 `afterEach` 清理；`getAgentDir` 通过 `vi.mock` + `vi.hoisted()` 指向临时目录；不读写真实 `~/.pi/`。

| 文件 | 改动 |
|---|---|
| `tests/config.test.ts` | 用例改为 `{ model, thinkLevel }`；新增"`enabled` 与 `defaultReasoning` 老键被剥离 → `{}`"；`rejects an invalid enabled value` 删除；非法值用例改为 `thinkLevel`；round-trip / save 用例去掉 `enabled`；`DEFAULT_CONFIG` 断言更新为空对象 |
| `tests/state.test.ts` | `footerLabel` 用例不变；新增 `callingModelHasVision` 三个用例（`["text","image"]` → true、`["text"]` → false、`undefined` → false）——它现在是唯一决定激活的谓词 |
| `tests/think-level.test.ts` | 由 `tests/reasoning.test.ts` 改名，标识符同步 |
| `tests/index-wiring.test.ts`（新增） | fake `ExtensionAPI` 捕获 `registerCommand("vision")` 的 handler 与 `registerTool`；fake ctx 提供 `model` / `modelRegistry` / `hasUI` / `ui.notify` / `ui.setStatus` / `getActiveTools` / `setActiveTools`。断言：`on`/`off`/`auto`/`config default-reasoning` 一律只回 warning 且**不产生文件**；`config think-level high` → 文件为 `{"thinkLevel":"high"}`；`config think-level ultra` → warning 且不写盘；`config model <模糊名>` → 经 fake registry 解析成功并落盘；`status` 文本含 `think level` 与 `active`；`session_start` 按 `ctx.model` 的视觉能力增删 `describe_image` |

## 文档

- `README.md` / `README.zh.md`：命令表收敛为三行（status、config model、config think-level），删除 `on`/`off`/`auto` 三行与"强制启用/禁用"表述；功能要点改为"始终按调用方模型模态自动启停"；配置示例改为 `{ "model": "haiku" }`；推理级别表与页脚指示器说明同步改名。
- 旧 spec 顶部加一行指向本文档的取代指针，正文不改。

## Out of Scope

- 为旧命令或旧配置键提供别名、兼容期或回退读取。
- 版本号变更与发布流程（`docs/guides/release.md`）——本次仅改代码，版本与发布另行决定。
- 重构 `model-resolver.ts`、`compress.ts`、`image.ts`、`vision.ts` 等与本次无关的模块。
- 修改本机真实配置 `~/.pi/agent/vision-tools.json`。

## 验收标准

1. `pi-vision-tools` 下 `npm test` 全绿（含新增 wiring 测试），`npm run typecheck`、`npm run lint` 通过。
2. `/vision on`、`/vision off`、`/vision auto`、`/vision config default-reasoning high` 均只回 usage warning，且不产生/不修改配置文件。
3. `/vision config think-level high` 写出紧凑 JSON `{"thinkLevel":"high"}`；`/vision config think-level ultra` 回 warning 且不写盘。
4. 老配置 `{"model":"haiku","enabled":"off","defaultReasoning":"high"}` 加载后等价于 `{"model":"haiku"}`。
5. `index.ts` 与 `src/` 下不再出现 `effectiveEnabled`、`VisionEnabledState`、`ENABLED_STATES`、`REASONING_LEVELS`、`defaultReasoning`、`reasoningToOptions`、`effectiveReasoning` 等旧标识符（测试与 spec 文档中为验证/记录迁移而出现的旧键字面量除外）；`src/reasoning.ts` 与 `tests/reasoning.test.ts` 已改名。
6. 两个 README 中不再出现 `/vision on`、`/vision off`、`/vision auto`、`default-reasoning` 与 `"enabled"`。
