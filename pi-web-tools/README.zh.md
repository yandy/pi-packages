# pi-web-tools

为编程 agent 提供网页搜索和网页抓取工具的 [pi](https://pi.dev/docs/latest/packages) 包。

## 工具

| 工具 | 描述 | Provider |
|------|------|----------|
| `websearch` | 纯网页搜索，返回原始结果（标题、URL、摘要） | Exa → DeepSeek → 阿里云回退 |
| `webfetch` | 抓取 URL 并把 HTML 转为可读 Markdown，或返回原始响应正文 | Local → DeepSeek 回退 |

## 快速开始

```bash
# 从 npm 安装
pi install npm:@yandy0725/pi-web-tools

# 或从本地仓库安装
pi install ./path/to/pi-web-tools

# 或直接运行
npm install
pi -e ./index.ts
```

### 前置条件

- `websearch`：无需配置——Exa MCP 免费层（150次/天）。可选：设置 `DEEPSEEK_API_KEY`（或在 pi 中配置 `deepseek` provider）启用 DeepSeek 回退位；设置 `ALIYUN_API_KEY`（或配置 `aliyun` provider）启用阿里云回退位。
- `webfetch`：无需配置——直接 HTTP 抓取。可选：设置 `DEEPSEEK_API_KEY`（或在 pi 中配置 `deepseek` provider）启用 DeepSeek 回退，服务端渲染 JS 重度页面。

## 配置

### API Key（环境变量或 pi provider 配置）

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `EXA_API_KEY` | Exa API key，不设则走 MCP 免费层（150次/天） | — |
| `DEEPSEEK_API_KEY` | DeepSeek API key，用于 websearch/webfetch 的 deepseek provider。也会自动从 pi 的 deepseek provider 配置解析 | — |
| `ALIYUN_API_KEY` | 阿里云百炼 API key，用于 websearch 回退。也会自动从 pi 的 aliyun provider 配置解析 | — |

### 配置文件（`web-tools.json`）

可选：为每个工具固定默认 provider。全局：`<agent-dir>/web-tools.json`；项目：`<cwd>/.pi/web-tools.json`（项目按段覆盖全局）。

```json
{
	"websearch": { "provider": "deepseek" },
	"webfetch": { "provider": "deepseek" }
}
```

- 合法值：`websearch` → `"exa" | "deepseek" | "aliyun"`；`webfetch` → `"local" | "deepseek"`。
- 优先级：工具调用 `provider` 参数 > 配置文件 > 内置回退链。
- 通过参数或配置指定的 provider 独占使用——失败不回退其他 provider。
- 配置值非法会得到明确报错（指明文件与期望值列表）。

## 工具参考

### websearch

搜索网页，自动回退到可用 provider。

**参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `query` | string | 是 | — | 搜索查询 |
| `numResults` | number | 否 | 10 | 结果数量（1-20） |
| `provider` | `"exa"` \| `"deepseek"` \| `"aliyun"` | 否 | — | 搜索 provider（指定即独占） |

**Provider：**

- **Exa**（默认首选）— AI 原生搜索 API。有 `EXA_API_KEY`：完整 REST API。无 key：MCP 免费层（150次/天，3 QPS）。无需 key 即可使用。
- **DeepSeek**（回退位 2）— [DeepSeek Search API](https://api-docs.deepseek.com/zh-cn/guides/search)，自研搜索引擎。中文查询效果好；query 支持搜索语法（`site:`、`lang:`、`after:`、`before:`、精确短语）；摘要字段面向模型阅读。需要 `DEEPSEEK_API_KEY` 环境变量或在 pi 中配置 `deepseek` provider。按成功请求计费（5元/1000次；空结果不计费）。
- **阿里云**（回退位 3）— [百炼 WebSearch MCP](https://bailian.console.aliyun.com/cn-beijing?tab=mcp#/mcp-market/detail/WebSearch)。需要 `ALIYUN_API_KEY` 环境变量或在 pi 中配置 `aliyun` provider。中文搜索效果更好。

某个 provider 失败时自动回退到下一个（exa → deepseek → aliyun）。未配置 key 的 provider 在链中快速失败并被跳过。

### webfetch

抓取 URL 内容：返回可读的 Markdown，或原样的响应正文。

**参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `url` | string | 是 | — | 要抓取的 URL |
| `format` | `"markdown"` \| `"origin"` | 否 | `"markdown"` | 输出格式 |
| `timeout` | number | 否 | 30 | 超时秒数（1-120） |
| `provider` | `"local"` \| `"deepseek"` | 否 | — | 抓取 provider（指定即独占） |

**格式：**

- `"markdown"`（默认）——按响应 content-type 分流：
  - **HTML**（`text/html`、`application/xhtml+xml`，或正文以 `<!doctype html` / `<html` 开头、即使服务端标成 `text/plain`）：先移除 `script`、`style`、`noscript`、`template`、`svg`、`iframe`、`canvas`，再按 `main` → `article` → `[role=main]` → `body` 的顺序定位正文容器。取第一个有非空匹配的选择器，把其中**全部**非空匹配转换为 Markdown 并以空行拼接。页面 `<title>` 不进正文，改放输出的 `Title:` 行。选中容器内的 `nav`/`aside`/`header`/`footer` 不会被删除——页面骨架仅靠容器选择排除。
  - **JSON**（`application/json`、`text/json`、任意 `*+json`）：按 2 空格缩进美化；解析失败则原样返回。
  - **其余文本类型**（源码、diff、纯文本、原始 Markdown 等）：原样返回，不做标签剥离或转换。
  - **二进制**：报错，见下。
- `"origin"`——除既有的 100,000 字符截断外，响应正文不做任何改动：不解析、不抽取、不美化，也不产生 `Title:` 行。二进制响应同样被拒绝。
- **两种格式都拒绝二进制响应**：`image/*`、`audio/*`、`video/*`、`font/*`、`model/*`，以及 PDF、ZIP、GZip、TAR、BZip2、7z、RAR、`application/octet-stream`、WASM、protobuf、EPUB 和任意 `application/vnd.*`。报错形如 `Unsupported content type: <媒体类型>[, <字节数> bytes]. webfetch only returns text; download the file with another tool.`
- 其他 `format` 值会报错：`Unknown format: <值>. Available: markdown, origin`。

**Provider：**

- **Local**（默认首选）— 直接 HTTP GET；`markdown` 做上节所述的抽取与转换，`origin` 原样透传正文。
- **DeepSeek**（回退）— [DeepSeek Fetch API](https://api-docs.deepseek.com/zh-cn/guides/search)，服务端抓取并返回 Markdown。能处理 local 搞不定的 JS 渲染页。需要 `DEEPSEEK_API_KEY` 环境变量或在 pi 中配置 `deepseek` provider。按成功请求计费（5元/1000次；失败不计费）。

回落触发条件（仅链式模式）：local 硬失败（网络错误/超时/非 2xx），或 local 成功但内容薄（空壳页或垃圾标签堆积页，有效文本 < 200 字符）。薄内容时若 DeepSeek 也失败，则返回 local 原结果。链式模式只在未指定 `provider` 且存在 DeepSeek key 时运行。`format: "origin"` 永不回落（DeepSeek 只返回 Markdown）。二进制响应与未知 `format` 是终态错误：永不触发 DeepSeek 回落，因为换 provider 也拿不到文本。显式指定 `provider`（参数或配置）时独占使用——唯一例外：`provider: "deepseek"` + `format: "origin"` 自动走 local。

## 开发

```bash
# 从仓库根目录：
npm ci                    # 安装全部依赖
npm run typecheck         # 全包类型检查
npm run lint              # Biome lint
npm test                  # 运行全部测试

# 包内：
pi -e ./index.ts          # 本地运行扩展（在包目录下）
```

## 许可证

MIT
