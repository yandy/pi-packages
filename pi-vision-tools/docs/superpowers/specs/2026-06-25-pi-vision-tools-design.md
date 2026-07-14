# Design: pi-vision-tools — 让非多模态模型调用视觉模型

**Date:** 2026-06-25
**Status:** draft

## 定位

让**不具备图像能力**的模型（如 DeepSeek V4 Pro、Mimo V2.5 Pro 等纯文本模型）也能"看懂图片"。提供一个 `describe_image` 工具，把图片 + 指令委托给一个**已配置的视觉模型**（如 Qwen VL、GPT-4o），把视觉模型的文本回答作为工具结果返回给调用模型。

核心设计原则：**调用模型完全掌控每次调用的成本/质量权衡**——压缩与否、推理深度、提问内容都由模型按需决定，无需预配置。就像开发者自己决定用 `cat` 快速扫一眼还是 `git bisect` 深挖一样。

工具自动按调用模型的模态启停：当前会话模型本身有视觉能力（`input` 含 `"image"`）则默认关闭工具（用不着），否则默认开启。一个 `/vision` 命令做配置与开关，footer 显示 👁 指示器。

### 关键决策摘要

| 决策 | 结论 | 理由 |
|------|------|------|
| 模型调用方式 | **复用 pi 自己的客户端** `complete()`（`@earendil-works/pi-ai/compat`） | 不手写 fetch；自动适配各 api 类型（openai-completions / openai-responses / anthropic-messages）；与 `summarize.ts` 官方示例一致 |
| 鉴权 | `ctx.modelRegistry.getApiKeyAndHeaders(model)` | 复用 pi 的 API key 解析（含 OAuth、env 引用、command-backed key） |
| 配置存储 | 文件 `~/.pi/agent/vision-tools.json`（`getAgentDir()`） | 跨 session 持久、立即可改、不污染 session 历史；区别于 pi-todo 把状态存 tool result details（那是 session 内临时状态，本包是用户偏好配置） |
| 图片内容块形状 | `{ type: "image", data, mimeType }` | 实测 `@earendil-works/pi-ai` 类型；**不是**部分文档片段里的 `source: { type:"base64", mediaType }`（该形状过时/错误） |
| 压缩依赖 sharp | **可选**，动态 `import("sharp")` | 不强依赖原生模块；缺失则发原图；`compress:false` 可逐次关掉 |
| reasoning 映射 | `reasoningEffort` 选项，`"off"` 时省略 | `complete()` 接 `ThinkingLevel`（minimal..xhigh，无 off）；off=不传 |
| 自动启停依据 | `ctx.model.input` 是否含 `"image"` | 调用模型能看图就不需要本工具 |
| 工具数 | **1**（`describe_image`） | 单一职责；行为差异靠参数（compress / reasoning）表达 |
| 开发方式 | **git worktree 隔离开发** | 与本 monorepo 既有 `.worktrees/` 约定一致，避免干扰主分支 |

## 数据模型

### 配置（持久化）

```ts
type VisionEnabledState = "auto" | "on" | "off";

interface VisionConfig {
  provider?: string;                       // 视觉模型 provider，如 "openai"
  model?: string;                          // 视觉模型 id，如 "gpt-4o"
  enabled: VisionEnabledState;             // auto=按调用模型模态自动；on/off=强制
  defaultReasoning?: VisionReasoning;      // 默认推理深度，省略=off
}

type VisionReasoning = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
```

### 解码后的图片

```ts
interface DecodedImage {
  data: Buffer;      // 原始字节
  mimeType: string;  // image/png | image/jpeg | image/gif | image/webp | image/bmp
}
```

## 文件结构

```
pi-vision-tools/
├── index.ts                  # 入口：注册工具 + /vision 命令 + 生命周期 + footer
├── src/
│   ├── config.ts             # VisionConfig 类型 + 默认/解析/校验 + load/save
│   ├── image.ts              # 解码图片源（路径 / data URL / base64）→ DecodedImage
│   ├── compress.ts           # 可选 sharp 压缩 + 环境变量读取
│   ├── reasoning.ts          # reasoning 级别 → complete() 选项映射
│   ├── state.ts              # 有效启停计算 + footer 文案（纯函数）
│   └── vision.ts             # 解析视觉模型 + 调用 complete()（依赖注入）
├── tests/
│   ├── config.test.ts
│   ├── image.test.ts
│   ├── compress.test.ts
│   ├── reasoning.test.ts
│   └── vision.test.ts
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── README.md
└── RELEASE.md
```

总计 6 个源文件（index + 5 src 模块）。纯逻辑模块（config/image/compress/reasoning/vision）无 pi 导入，可独立单测；`complete()` 调用通过依赖注入测试，无需网络。

## 工具设计：`describe_image`

唯一工具。调用模型决定何时用、怎么用。

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `image_path` | string | ✅ | 文件路径 / `data:` URL / 原始 base64（>100 字符） |
| `prompt` | string | ✅ | 给视觉模型的自由指令：描述、提文字、找 bug、给坐标… |
| `compress` | boolean | ❌ | 默认 `true`：压缩加速；`false` 用于像素级精度（读坐标、找小元素） |
| `reasoning` | `"off"\|"minimal"\|"low"\|"medium"\|"high"\|"xhigh"` | ❌ | 视觉模型推理深度，默认 `off` |

### 执行流程

1. 工具被禁用（effective enabled = false）→ 返回错误结果，提示 `/vision on`
2. `resolveVisionModel(ctx.modelRegistry, config)`：`find(provider, model)`，校验 `model.input` 含 `"image"`，否则返回带 `/vision config` 引导的错误
3. `getApiKeyAndHeaders(model)`：`!auth.ok || !auth.apiKey` → 错误结果
4. `decodeImage(image_path)`：分类解码（见下）
5. `compress !== false` → `compressImage(image, readCompressionSettings())`（sharp 缺失则原样返回）
6. `callVision({ model, auth, prompt, images, reasoning, signal }, complete)` → 视觉模型文本
7. 返回 `{ content: [{type:"text", text}], details: { model, usage, compressed, mimeType, reasoning } }`

### 渲染

- `renderCall`：`describe_image` + 截断的图片源 + prompt 前 30 字
- `renderResult`：默认显示前 6 行 + `… N more lines · ctrl+o to expand`；展开显示全文（沿用 pi-web-tools 的渲染模式）

### Prompt 注入

直接在工具定义声明，由 pi 自动注入系统提示词，零胶水：

```
promptSnippet: "describe_image: delegate image analysis to a vision model (non-multimodal models)."
promptGuidelines:
  - "Use describe_image when you need to understand an image you cannot see (the calling model lacks vision)."
  - "Set compress:false when you need pixel-perfect accuracy (reading coordinates, tiny UI elements)."
  - "Set reasoning:'high'/'xhigh' for complex visual analysis (architecture diagrams, bug hunting)."
```

## 图片解码（`image.ts`）

按 `image_path` 字符串分类：

| 输入 | 识别规则 | 行为 |
|------|----------|------|
| `data:` URL | `^data:([^;]+)?;base64,(.*)$` | 校验 mime 在支持集内，base64 解码 |
| 文件路径 | `/`、`./`、`../`、`~` 开头，或带支持扩展名且 ≤100 字符 | `readFile` + 按扩展名推断 mime |
| 原始 base64 | 长度 > 100 字符（非上述两者） | base64 解码，mime 默认 `image/png`（无法从裸 base64 判定；压缩阶段会重编码为 JPEG） |
| 其他 | — | 报错：必须是路径/data URL/base64 |

支持格式：PNG、JPEG、GIF、WebP、BMP。

## 压缩（`compress.ts`，可选 sharp）

`compress: true`（默认）时，动态 `import("sharp")`；可用则：

- 最长边缩到 ≤ `maxDim`（仅缩小不放大）
- 去 alpha 通道（RGBA → RGB）
- 转 JPEG（quality `jpegQuality`）

| 环境变量 | 默认 | 说明 |
|----------|------|------|
| `PI_VISION_MAX_DIM` | `1568` | 缩放最长边像素上限 |
| `PI_VISION_JPEG_QUALITY` | `85` | JPEG 质量 1-100 |

sharp 缺失或压缩出错 → 原图原样返回（优雅降级）。**`sharp` 不进 `dependencies`**，仅按需安装。

## 视觉模型调用（`vision.ts`）

### 解析模型

```ts
function resolveVisionModel(registry, config): ResolveResult
```

- provider/model 未配置 → 错误：`Vision model not configured. Run: /vision config ...`
- `registry.find(provider, model)` 未命中 → 错误：`not found`
- 命中但 `model.input` 不含 `"image"` → 错误：`does not support image input`

### 调用

```ts
async function callVision(input: VisionCallInput, completeFn: CompleteFn): Promise<VisionCallResult>
```

构造单条 user message：`[{type:"text",text:prompt}, {type:"image", data:base64, mimeType}, ...]`，调用注入的 `complete(model, { messages }, { apiKey, headers, ...reasoning, signal })`，抽取所有 `type:"text"` 内容用 `\n` 拼接。`completeFn` 可注入（测试用 mock，生产用 `complete` from `@earendil-works/pi-ai/compat`）。

reasoning 映射：`off`/`undefined` → `{}`（不传 `reasoningEffort`）；其余 → `{ reasoningEffort: level }`。

## `/vision` 命令

单命令，按 `args` 解析子命令：

| 调用 | 行为 |
|------|------|
| `/vision` 或 `/vision status` | 通知当前配置：provider/model、enabled、effective、调用模型是否有视觉能力 |
| `/vision config provider <p>` | 设置 provider，保存，刷新 |
| `/vision config model <m>` | 设置 model，保存，刷新 |
| `/vision config default-reasoning <level>` | 设置默认推理深度，保存，刷新 |
| `/vision on` / `off` / `auto` | 设置 `enabled`，保存，刷新 |
| 其他 | 通知用法 |

配置改完 `saveConfig` 立即落盘，`refresh` 重算有效启停 + 同步活动工具 + 刷新 footer，**无需 `/reload`**。

## 持久化（`config.ts`）

- 路径：`getAgentDir() + "/vision-tools.json"`（≈ `~/.pi/agent/vision-tools.json`）
- `loadConfig`：文件缺失或 JSON 损坏 → 返回 `DEFAULT_CONFIG`（`{ enabled: "auto" }`）；`parseConfig` 校验类型、剥离未知键、非法值抛错
- `saveConfig`：`mkdir -p agentDir` + 写临时文件 + `rename`（原子写）
- 内存缓存一份，命令修改后立即更新缓存 + 落盘

> 与 pi-todo 的区别：pi-todo 把 session 内 todo 状态存 tool result `details` 以支持分支还原；本包存的是**用户偏好配置**（跨 session 持久、与对话历史无关），用文件持久化更合适。

## 状态与启停（`state.ts` + 生命周期）

有效启停：

```
effectiveEnabled(config, model):
  enabled === "on"  → true
  enabled === "off" → false
  enabled === "auto"→ !model.input.includes("image")   // 调用模型没视觉能力才开
```

生命周期：

| 事件 | 行为 |
|------|------|
| `session_start` | `loadConfig` → `refresh` |
| `model_select` | `refresh`（auto 模式下换模型可能翻转启停） |

`refresh(ctx)`：算 `effectiveEnabled` → 用 `pi.setActiveTools` 增删 `describe_image` → `ctx.ui.setStatus("pi-vision", label)`。有效开启且配了模型时 footer 显示 `👁 provider/model`，否则清空。

## 错误处理

| 场景 | 行为 |
|------|------|
| 工具被禁用时被调用 | 返回 `isError` 结果 + `/vision on` 引导 |
| 视觉模型未配置 / 未找到 / 不支持图片 | 返回 `isError` + `/vision config` 引导 |
| 无 API key | 返回 `isError` + provider/model 提示 |
| 图片解码失败（路径错/格式不支持/base64 非法） | 返回 `isError` + 具体原因 |
| sharp 缺失 / 压缩出错 | 降级发原图（不报错） |
| 视觉模型调用抛错 | 返回 `isError` + `errorMessage` |
| 全部场景 | 永不抛到外层，优雅返回错误结果 |

## 测试策略

| 层 | 内容 | 方式 |
|----|------|------|
| 纯单元 | config 解析/默认/校验/读写 | 真实 tmpdir 文件系统（仿 web_fetch 风格） |
| 纯单元 | image 解码：data URL / 文件 / base64 / 错误分支 | tmpdir + magic bytes |
| 纯单元 | reasoning 映射：off/undefined→`{}`，其余→`{reasoningEffort}` | 直接断言 |
| 纯单元 | compress 环境变量解析 + clamp；sharp 缺失原样返回 + fake sharp 管道 | 注入 sharp loader |
| 纯单元 | vision：resolveVisionModel 各分支；callVision 构造消息 + 抽取文本 + reasoningEffort 透传 + 抛错捕获 | 注入 `CompleteFn` mock，无网络 |
| 集成（手动） | 真实视觉模型端到端 | `pi -e ./pi-vision-tools/index.ts` + 真实 API key |

`complete()` 不直连，全部走注入的 `CompleteFn`，测试零网络依赖。

## 入口接线（`index.ts`）

```typescript
export default function (pi: ExtensionAPI) {
  let config: VisionConfig = { enabled: "auto" };
  let enabled = false;

  const refresh = (ctx) => { /* effectiveEnabled → setActiveTools → setStatus(👁) */ };

  pi.on("session_start", async (_e, ctx) => { config = await loadConfig(getAgentDir()); refresh(ctx); });
  pi.on("model_select",   async (_e, ctx) => refresh(ctx));

  pi.registerTool({ name: "describe_image", ... execute() { … decode → compress → callVision(complete) … } });
  pi.registerCommand("vision", { handler(args, ctx) { /* 解析子命令 → 改 config → saveConfig → refresh */ } });
}
```

## 依赖

| 依赖 | 用途 | 类型 |
|------|------|------|
| `@earendil-works/pi-ai` | `complete()` 客户端 + 内容/模型类型 | dependencies（`^0.80.2`，沿用 pi-coding-tools 惯例） |
| `@earendil-works/pi-coding-agent` | `ExtensionAPI` / `getAgentDir` | peerDependencies（`>=0.74.0`） |
| `@earendil-works/pi-tui` | `Text` 渲染 | devDependencies |
| `typebox` | 工具参数 schema | devDependencies |
| `sharp` | 图片压缩 | **不入依赖**，按需 `npm install sharp` + 动态 import |

`@earendil-works/pi-ai` 虽被 pi 官方文档列为可作 peerDep（`"*"`），但本 monorepo 的 `pi-coding-tools` 已确立将其作 `dependencies` 的先例，沿用之以保证类型/运行时解析一致。

## Out of Scope

- 多图批量调用（当前单次单图，多图由调用模型多次调用表达）
- 视觉模型调用结果缓存
- 流式返回（当前 `complete()` 非流式，足够；流式留 P1）
- 自动选择视觉模型（需用户显式 `/vision config`，不做猜测）
- 图片来源为 URL 时自动下载（当前仅路径/data URL/base64；URL 由调用模型先用 webfetch 下载）
- 自定义 renderResult 富文本渲染（P2）
- `/vision` 命令的参数自动补全（P2）

## 参考借鉴

| 来源 | 借鉴点 |
|------|--------|
| pi-web-tools | 工具 `renderResult` 折叠/展开渲染模式、`onUpdate` 进度、错误结果结构 |
| pi-todo | `registerCommand` + 生命周期 `session_start`/状态刷新、`setStatus` footer、文件结构约定 |
| `summarize.ts` 官方示例 | `complete()` + `getApiKeyAndHeaders()` 调用模式、`reasoningEffort` 用法 |
| 原始需求 `docs/prompts/pi-vision-tools.md` | 功能定义、参数设计、压缩策略、自动启停语义、env 变量 |
