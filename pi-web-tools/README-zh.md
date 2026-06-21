# pi-web-tools

为编程 agent 提供网页搜索和网页抓取工具的 [pi](https://pi.dev/docs/latest/packages) 包。

## 工具

| 工具 | 描述 | 来源 |
|------|------|------|
| `web_search` | 纯网页搜索，返回原始结果（标题、URL、摘要） | Exa → 阿里云回退 |
| `web_fetch` | 抓取网页并转换为文本、Markdown 或原始 HTML | — |

## 快速开始

```bash
# 从 npm 安装
pi install npm:@yandy0725/pi-web-tools

# 或从本地仓库安装
pi install ./path/to/pi-web-tools

# 或直接运行
pi -e ./index.ts
```

### 前置条件

- `web_search`：无需配置——Exa MCP 免费层（150次/天）。设置 `EXA_API_KEY` 可获得更高限额。可选：设置 `ALIYUN_API_KEY` 或在 pi 中配置 `aliyun` provider，启用[百炼 WebSearch](https://bailian.console.aliyun.com/cn-beijing?tab=mcp#/mcp-market/detail/WebSearch) 回退（中文搜索效果更好）。

## 配置

API Key 通过环境变量配置。

### API Key（仅环境变量）

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `EXA_API_KEY` | Exa API key，不设则走 MCP 免费层（150次/天） | — |
| `ALIYUN_API_KEY` | 阿里云百炼 API key，用于 web_search 回退。也支持通过 pi 的 aliyun provider 配置获取 | — |

## 工具参考

### web_search

搜索网页，自动回退到可用源。

**参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `query` | string | 是 | — | 搜索查询 |
| `numResults` | number | 否 | 10 | 结果数量（1-20） |
| `source` | `"exa"` \| `"aliyun"` | 否 | — | 搜索源 |

**搜索源：**

- **Exa**（默认）— AI 原生搜索 API。有 `EXA_API_KEY`：完整 REST API。无 key：MCP 免费层（150次/天，3 QPS）。无需 key 即可使用。
- **阿里云**（回退）— [百炼 WebSearch MCP](https://bailian.console.aliyun.com/cn-beijing?tab=mcp#/mcp-market/detail/WebSearch)。需要配置 `ALIYUN_API_KEY` 环境变量或在 pi 的 `models.json` 中注册 `aliyun` provider。中文搜索效果更好。Exa 失败时自动回退到阿里云。

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
