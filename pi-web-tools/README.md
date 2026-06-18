# pi-web-tools

A [pi](https://pi.dev/docs/latest/packages) package providing web and image search tools for coding agents.

## Tools

| Tool | Description | Source |
|------|-------------|--------|
| `web_search` | Pure web search, returns raw results (titles, URLs, snippets) | Exa (REST + MCP free tier) |
| `deep_search` | Deep research with LLM-synthesized answers and sources | Aliyun (Bailian) Responses API |
| `image_search` | Search images by text or find similar images by URL | Aliyun (Bailian) Responses API |
| `web_fetch` | Fetch and convert web pages to text, markdown, or raw HTML | — |

## Quick Start

```bash
# Install from a local checkout
pi install ./path/to/pi-web-tools

# Or test with -e flag
pi -e ./index.ts
```

### Prerequisites

- `web_search`: No config needed — Exa MCP free tier (150 calls/day). Set `EXA_API_KEY` for higher limits.
- `deep_search` / `image_search`: Set `ALIYUN_API_KEY` or use `/login` in pi to authenticate with Aliyun.

## Configuration

Configuration uses two layers: environment variables for API keys, and a project config file for other settings.

### API Keys (environment variables only)

| Variable | Description | Default |
|----------|-------------|---------|
| `EXA_API_KEY` | Exa API key. If not set, uses MCP free tier (150 calls/day) | — |
| `ALIYUN_API_KEY` | Aliyun (Bailian) API key | — |

Aliyun also supports key resolution via pi's `/login` — if you've logged into Aliyun through pi, no env var needed.

### Project Config (`.pi/agent/web-tools.json`)

Create `.pi/agent/web-tools.json` in your project root for per-project settings:

```json
{
  "aliyun": {
    "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "searchModel": "qwen3.7-plus"
  }
}
```

Environment variables take precedence over the config file.

| Config Key | Env Variable (overrides) | Default | Description |
|------------|--------------------------|---------|-------------|
| `aliyun.baseUrl` | `ALIYUN_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | Aliyun API base URL |
| `aliyun.searchModel` | `ALIYUN_SEARCH_MODEL` | `qwen3.7-plus` | Aliyun search model |

> **Security:** API keys are NEVER read from config files — only from environment variables or pi's built-in credential store (`/login`).

## Tools Reference

### web_search

Search the web with automatic source fallback.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | yes | — | Search query |
| `numResults` | number | no | 10 | Number of results (1-20) |
| `source` | `"exa"` | no | — | Search source |

**Source:** **Exa** — AI-native search API. With `EXA_API_KEY`: full REST API. Without: MCP free tier (150 calls/day, 3 QPS). Always available, no key needed for basic usage.

### deep_search

Deep research using Aliyun's LLM-powered search with web content extraction. The model searches the web, extracts page content, and synthesizes a comprehensive answer with sources.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | yes | — | Research question |

> Requires `ALIYUN_API_KEY` or pi `/login` with Aliyun.

### image_search

Search images by text description or find visually similar images by URL.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | no | Text description for text-to-image search |
| `imageUrl` | string | no | Public image URL for image-to-image search |

> At least one of `query` or `imageUrl` must be provided. Both can be combined.
> The image URL must be publicly accessible. Requires `ALIYUN_API_KEY`.

### web_fetch

Fetch content from a URL and return as text, markdown, or raw HTML.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `url` | string | yes | — | URL to fetch |
| `format` | `"text"` \| `"markdown"` \| `"html"` | no | `"markdown"` | Output format |
| `timeout` | number | no | 30 | Timeout in seconds (1-120) |

## Development

```bash
npm install              # Install dependencies
npm run typecheck        # tsc --noEmit
npm run lint             # biome lint
npm test                 # vitest run
```

## License

MIT
