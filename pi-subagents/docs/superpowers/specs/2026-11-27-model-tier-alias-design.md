# pi-subagents `model` 参数接受能力档位别名设计

日期：2026-11-27
状态：已批准，待实现

## 意图

`subagents.json` 的 `modelTiers` 把 `fast` / `standard` / `advanced` 映射到真实模型，
但 `subagent` 工具的 `model` 参数目前只接受真实模型引用。工具参数描述展示
`fast → deepseek-flash` 这类映射时，调用方会自然地把档位名当作 `model` 的值；该值却会直接
进入普通模型 fuzzy match，导致解析失败，或在特定模型注册表里命中非预期模型。

目标是把 `model` 定义为统一的模型选择器：精确模型 ID、模糊模型名和已配置 tier 名都通过
同一个参数表达，并由执行层保证 tier 语义，而不是依赖调用方从提示词复制映射右侧的值。

## 目标

- `model: "fast"` 等工具调用直接选择 `modelTiers.fast` 配置的真实模型。
- tier 名匹配支持大小写不敏感和首尾空白归一化。
- tier 映射值继续支持精确 `provider/modelId` 与 fuzzy 模型名。
- 未配置的 tier、失效的 tier 映射都产生明确错误，不静默继承父模型。
- 普通模型解析、agent frontmatter 固定模型的优先级保持不变。
- 工具描述与中英文 README 准确表达可直接传 tier 名的新契约。

## 非目标

- 不新增 `model_tier` 工具参数。
- 不把 tier 别名扩展为 agent frontmatter `model:` 的语法；frontmatter 仍描述真实模型引用。
- 不修改跨扩展 `SubagentsService.spawn()` 的 `SpawnOptions.model` 契约。
- 不修改现有 fuzzy match 评分算法、可用模型过滤规则与父模型继承规则。
- 不引入自动档位回退，例如 `advanced` 未配置时改选 `standard` 或父模型。
- 不支持 tier 映射到另一个 tier；映射值只按真实模型引用解析。

## 反目标

- 仅通过提示词禁止 `model: "fast"`，而执行层仍拒绝该调用。
- 同时提供 `model` tier 别名与 `model_tier` 两种 tier 选择入口。
- tier 解析失败后继续对原始档位名做 fuzzy match。
- 为兼容真实模型 ID 与 tier 重名的极端情况而引入第二套参数或隐式回退；完整
  `provider/modelId` 是明确的消歧方式。

## 方案比较

| 方案 | 取舍 | 结论 |
|---|---|---|
| 只改提示词，要求复制映射右侧模型名 | 不改变执行契约，但正确性仍依赖 LLM 遵循自然语言提示 | 不选 |
| 新增 `model_tier`，与 `model` 互斥 | schema 可枚举 tier，但同一模型选择决策出现两个入口，也要求调用方改变自然的 `model: "fast"` 形式 | 不选 |
| `model` 同时接受真实模型引用和 tier 别名 | 保持单一入口，直接承接自然调用，并由执行层保证语义；需要保留 tier 名并定义确定优先级 | **采用** |

## 工具契约

`model` 仍是可选字符串，接受的输入分为三类：

```jsonc
// 精确模型
{ "model": "ark/deepseek-v4-1-flash-261017" }

// 模糊模型名
{ "model": "haiku" }

// 能力档位别名
{ "model": "fast" }
```

工具参数描述把映射表称为 **Configured tier aliases**，条目直接展示调用形式，例如：

```text
model: "fast" → deepseek-flash (cheapest, fastest, least capable)
```

prompt guideline 只保留行为规则：按成本或能力选择时，把已配置 tier 名本身传给 `model`。
工具定义仍不暴露 `model_tier`。

## 解析契约

### 来源与优先级

1. agent frontmatter 固定了 `model` 时，该配置继续优先于工具调用参数。
2. 只有实际来自工具调用的 `model` 字符串参与 tier 别名识别。
3. 工具调用未提供 `model` 时，沿用现有 agent 配置与父模型继承逻辑。

### 工具参数解析顺序

对实际生效的工具参数 `model`：

1. 对完整输入做 `trim + lowercase`；若结果是 `fast`、`standard` 或 `advanced`，它就是 tier
   请求，不进入普通模型 fuzzy match。
2. tier 已配置时，取出映射字符串并调用现有 `resolveModel()`；精确模型 ID 与 fuzzy 模型名
   因此复用同一套真实模型解析规则。
3. tier 未配置时立即返回配置错误。
4. 非 tier 输入原样调用现有 `resolveModel()`。

因为 tier 识别要求完整输入等于档位名，`provider/fast` 不会被解释为 tier；它仍按真实模型
引用处理。裸模型 ID `fast` 则被保留为 tier 名，需要消歧时必须写完整 `provider/fast`。

### 映射解析

- tier 映射只解析一层。若 `fast` 映射到字符串 `standard`，后者会作为真实模型引用传给
  `resolveModel()`，不会再次查找 `modelTiers.standard`。
- 映射值解析失败时返回错误，不继承父模型，也不退回对原始 tier 名做 fuzzy match。
- `modelTiers` 的全局/项目分层合并、固定档位白名单和空值清洗逻辑不变。

## 错误契约

未配置 tier：

```text
Model tier "fast" is not configured. Configure it in .pi/subagents.json or ~/.pi/agent/subagents.json, e.g. {"modelTiers": {"fast": "provider/modelId"}}.
```

映射值无法解析：

```text
Model tier "fast" maps to "deepseek-flash", but that model could not be resolved.

Model not found: "deepseek-flash".

Available models:
...
```

错误必须同时指出 tier 名与映射值；可用模型列表继续由现有 `resolveModel()` 提供。

## 代码边界

- `src/config/model-tiers.ts` 拥有 tier 名归一化、tier 映射查找和未配置错误，避免把固定档位
  词汇散落到 spawn 流程。
- `src/tools/spawn-config.ts` 在 invocation 配置合并之后识别工具参数中的 tier：此时已经知道
  frontmatter 是否固定模型，也已有 `modelFromParams` 区分输入来源。解析成功后仍通过
  `resolveInvocationModel()` 得到真实模型实例。
- `src/session/model-resolver.ts` 保持只解析真实模型引用，不读取设置，也不感知 tier。
- `src/tools/agent-tool.ts` 只修改 LLM-facing 参数描述与 guideline，不承担模型解析。
- `README.md` 与 `README.zh.md` 同步描述同一契约。

## 测试策略

### tier 纯函数

- 三种合法 tier 的归一化；大小写与首尾空白。
- 非 tier、空字符串和非字符串输入不被识别为 tier。
- 已配置 tier 返回原配置模型引用。
- 未配置 tier 返回包含档位名与配置路径的错误。

### spawn 配置

- `model: "fast"` 解析到映射模型；映射值分别覆盖精确 ID 与 fuzzy name。
- 未配置的保留 tier 明确报错，不调用父模型继承或普通 fuzzy fallback。
- 映射值失效时，错误包含 tier、映射值和底层模型解析错误。
- 映射值不递归解释为另一个 tier。
- 普通 fuzzy match 与精确模型 ID 行为不变。
- `provider/fast` 按真实模型解析，不进入 tier 映射。
- frontmatter 固定模型继续优先，并忽略工具参数中的 tier。
- 未提供 `model` 时继续继承父模型。

### 工具定义与文档

- `model` 参数描述明确接受 configured tier name，并展示 `model: "fast" → …` 形式。
- guideline 明确传 tier 名本身；未配置任何 tier 时不出现 tier 指引。
- schema 仍无 `model_tier`。
- 中英文 README 的工具参数表、模型分层说明、错误与消歧规则一致。

## 验收

- pi-subagents 相关测试全部通过，新增测试先证明旧实现不能满足上述契约。
- pi-subagents TypeScript 类型检查与 lint 通过。
- 仓库完整测试、类型检查与 lint 通过；若基线本身存在失败，必须与本次改动失败分开报告。
- 不发布版本；发布由单独流程发起。
