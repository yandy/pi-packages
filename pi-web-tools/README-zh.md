# pi-web-tools

为编程 agent 提供网页搜索和图片搜索工具的 [pi](https://pi.dev/docs/latest/packages) 包。

## 工具

| 工具 | 描述 | 来源 |
|------|------|------|
| `web_search` | 纯网页搜索，返回原始结果（标题、URL、摘要） | Exa（REST + MCP 免费层） |
| `deep_search` | 深度研究，LLM 合成答案并附来源 | 阿里云百炼 Responses API |
| `image_search` | 文搜图 / 图搜图 | 阿里云百炼 Responses API |
| `web_fetch` | 抓取网页并转换为文本、Markdown 或原始 HTML | — |

## 快速开始

```bash
# 从本地仓库安装
pi install ./path/to/pi-web-tools

# 或用 -e 参数测试
pi -e ./index.ts
```

### 前置条件

- `web_search`：无需配置——Exa MCP 免费层（150次/天）。设置 `EXA_API_KEY` 可获得更高限额。
- `deep_search` / `image_search`：设置 `ALIYUN_API_KEY` 或在 pi 中使用 `/login` 认证阿里云。

## 配置

配置分两层：API Key 仅通过环境变量，其他设置支持项目配置文件。

### API Key（仅环境变量）

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `EXA_API_KEY` | Exa API key，不设则走 MCP 免费层（150次/天） | — |
| `ALIYUN_API_KEY` | 阿里云百炼 API key | — |

阿里云也支持通过 pi 的 `/login` 获取 key——如果在 pi 中登录过阿里云，无需设置环境变量。

### 项目配置（`.pi/agent/web-tools.json`）

在项目根目录创建 `.pi/agent/web-tools.json` 进行项目级配置：

```json
{
  "aliyun": {
    "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "searchModel": "qwen3.7-plus"
  }
}
```

环境变量的优先级高于配置文件。

| 配置项 | 环境变量（覆盖） | 默认值 | 说明 |
|--------|-----------------|--------|------|
| `aliyun.baseUrl` | `ALIYUN_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 阿里云 API 地址 |
| `aliyun.searchModel` | `ALIYUN_SEARCH_MODEL` | `qwen3.7-plus` | 阿里云搜索模型 |

> **安全说明：** API Key 绝不会从配置文件读取——仅从环境变量或 pi 内置凭据存储（`/login`）获取。

## 工具参考

### web_search

搜索网页，自动回退到可用源。

**参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `query` | string | 是 | — | 搜索查询 |
| `numResults` | number | 否 | 10 | 结果数量（1-20） |
| `source` | `"exa"` | 否 | — | 搜索源 |

**搜索源：** **Exa** — AI 原生搜索 API。有 `EXA_API_KEY`：完整 REST API。无 key：MCP 免费层（150次/天，3 QPS）。无需 key 即可使用。

### deep_search

使用阿里云百炼 LLM 进行深度搜索，结合网页抓取。模型会搜索网页、提取页面内容，并合成带来源的全面答案。

**参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `query` | string | 是 | — | 研究问题 |

> 需要 `ALIYUN_API_KEY` 或在 pi 中 `/login` 阿里云。

### image_search

根据文本描述搜索图片，或根据图片 URL 搜索相似图片。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | string | 否 | 文本描述，用于文搜图 |
| `imageUrl` | string | 否 | 公网图片 URL，用于图搜图 |

> 至少提供 `query` 或 `imageUrl` 之一。两者可以同时提供。
> 图片 URL 必须是公网可访问的。需要 `ALIYUN_API_KEY`。

### web_fetch

抓取 URL 内容并返回文本、Markdown 或原始 HTML。

**参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `url` | string | 是 | — | 要抓取的 URL |
| `format` | `"text"` \| `"markdown"` \| `"html"` | 否 | `"markdown"` | 输出格式 |
| `timeout` | number | 否 | 30 | 超时秒数（1-120） |

## 开发

```bash
npm install              # 安装依赖
npm run typecheck        # tsc --noEmit
npm run lint             # biome lint
npm test                 # vitest run
```

## 许可证

MIT
