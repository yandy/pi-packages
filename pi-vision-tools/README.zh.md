# pi-vision-tools

让非多模态模型通过委托给配置好的视觉模型来分析图像。提供一个 `describe_image` 工具 + `/vision` 命令。

## 功能

- **一个工具**（`describe_image`），将图像 + 提示词发送给支持视觉的模型，并将文本结果返回给调用方模型
- **调用方模型按需控制成本/质量**：`compress`（开关）、`reasoning`（从 off 到 xhigh）以及提示词本身——无需预配置
- **按调用方模型模态自动开关**：如果当前模型已支持图像输入，工具自动禁用；否则启用
- **页脚指示器**（`👁 provider/model`），在工具激活且视觉模型已配置时可见
- **无需 `/reload`**：配置更改即时生效

## 工作原理

```
调用方模型  →  describe_image  →  视觉模型  →  文本返回给调用方模型
（无视觉能力）     （图像+提示词）      （能看图像）
```

1. 调用方模型调用 `describe_image`，传入图像和提示词
2. 工具解码图像，可选使用 sharp 压缩，然后调用配置好的视觉模型
3. 视觉模型的文本回答作为工具结果返回

## 前缀缓存

切换模型时自身的 prefix cache 已因 model 变化而失效，`setActiveTools` 增删 `describe_image` 只是新 model 系统提示的正常组成部分，不会额外造成 cache 抖动。

对同一个 model，tool 列表是确定的（无视觉一定带 `describe_image`，有视觉一定不带），所以中间切换到其他 model 再切回来时，前缀内容与先前一致，仍然能命中原有缓存。

## 安装

```bash
pi install npm:@yandy0725/pi-vision-tools
```

或在 `~/.pi/agent/settings.json` 中添加：

```json
{
  "packages": ["npm:@yandy0725/pi-vision-tools"]
}
```

## 配置

### `/vision` 命令

| 命令 | 功能 |
|---------|------|
| `/vision` 或 `/vision status` | 显示当前配置：provider/model、启用状态、生效开关、调用方模型是否支持视觉 |
| `/vision config provider <p>` | 设置视觉模型提供商（如 `openai`、`anthropic`） |
| `/vision config model <m>` | 设置视觉模型 ID（如 `gpt-4o`、`claude-sonnet-4-20250514`） |
| `/vision config default-reasoning <level>` | 设置默认推理深度：`off`、`minimal`、`low`、`medium`、`high`、`xhigh` |
| `/vision on` | 强制启用工具（即使调用方模型支持视觉） |
| `/vision off` | 强制禁用工具 |
| `/vision auto` | 自动模式：仅当调用方模型不支持图像输入时启用（默认） |

配置持久化到 `~/.pi/agent/vision-tools.json`，即时生效——无需 `/reload`。

### 可选：sharp

安装 sharp 以在发送前自动压缩图像：

```bash
npm install sharp
```

sharp 是可选的。没有它，图像将原样发送（不报错）。压缩会将最长边降采样至 ≤1568px，去除 alpha 通道，并转换为 JPEG 格式。

#### 环境变量

| 变量 | 默认值 | 说明 |
|----------|---------|------|
| `PI_VISION_MAX_DIM` | `1568` | 最长边像素上限（1–10000） |
| `PI_VISION_JPEG_QUALITY` | `85` | JPEG 质量（1–100） |

在任何调用中设置 `compress: false` 可跳过压缩，用于需要像素级精度的场景（读取坐标、检查微小 UI 元素）。

## 工具参考

```
describe_image(image_path: string, prompt: string, compress?: boolean, reasoning?: string)
```

| 参数 | 必填 | 默认值 | 说明 |
|-----------|:--:|---------|------|
| `image_path` | 是 | — | 文件路径、`data:` URL 或原始 base64（>100 字符） |
| `prompt` | 是 | — | 给视觉模型的指令 |
| `compress` | 否 | `true` | 发送前是否压缩；设为 `false` 以获取像素级精度 |
| `reasoning` | 否 | `off` | 推理力度：`off`、`minimal`、`low`、`medium`、`high`、`xhigh` |

### 示例工具调用

```json
{
  "image_path": "/home/user/screenshot.png",
  "prompt": "请描述这张截图中看到的内容。",
  "compress": true,
  "reasoning": "high"
}
```

### 示例提示词

| 用途 | 提示词 |
|------|--------|
| 描述图像 | `"请详细描述这张图片。"` |
| 读取坐标/位置 | `"提交按钮的像素坐标是多少？"` |
| 提取文字（OCR） | `"提取这张图片中所有可见的文字。"` |
| 查找 UI 缺陷 | `"检查这张截图中是否存在布局、对齐或文字溢出问题。"` |
| 解释图表 | `"请逐步解释这个架构图。"` |
| 分析错误 | `"这个错误信息是什么意思，如何修复？"` |

### 推理级别

| 级别 | 适用场景 |
|-------|------|
| `off` | 简单描述、文字提取、基础问答 |
| `minimal` | 快速浏览，"这是什么？" |
| `low` | 略多思考、中等细节 |
| `medium` | 详细描述、UI 检查 |
| `high` | 复杂分析、架构图、代码截图 |
| `xhigh` | 深度推理、bug 排查、多步骤视觉谜题 |

## 支持的图像格式

支持：PNG、JPEG、GIF、WebP、BMP。

输入可以是：
- 文件路径（`/path/to/image.png`、`./relative.png`，支持 `~` 前缀）
- `data:` URL（`data:image/png;base64,...`）
- 原始 base64（字符串 >100 字符，自动检测）

## 许可证

MIT
