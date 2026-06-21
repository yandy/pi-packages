# pi-web-tools

A [pi](https://pi.dev/docs/latest/packages) package providing web search and web fetch tools for coding agents.

## Tools

| Tool | Description | Source |
|------|-------------|--------|
| `web_search` | Pure web search, returns raw results (titles, URLs, snippets) | Exa → Aliyun fallback |
| `web_fetch` | Fetch and convert web pages to text, markdown, or raw HTML | — |

## Quick Start

```bash
# Install from npm
pi install npm:@yandy0725/pi-web-tools

# Or install from a local checkout
pi install ./path/to/pi-web-tools

# Or run directly
npm install
pi -e ./index.ts
```

### Prerequisites

- `web_search`: No config needed — Exa MCP free tier (150 calls/day). Set `EXA_API_KEY` for higher limits. Optional: set `ALIYUN_API_KEY` or configure an `aliyun` provider in pi for [Bailian WebSearch](https://bailian.console.aliyun.com/cn-beijing?tab=mcp#/mcp-market/detail/WebSearch) fallback (better Chinese search results).

## Configuration

Configuration uses environment variables for API keys.

### API Keys (environment variables only)

| Variable | Description | Default |
|----------|-------------|---------|
| `EXA_API_KEY` | Exa API key. If not set, uses MCP free tier (150 calls/day) | — |
| `ALIYUN_API_KEY` | Aliyun Bailian API key for web_search fallback. Also available via pi's aliyun provider config | — |

## Tools Reference

### web_search

Search the web with automatic source fallback.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | yes | — | Search query |
| `numResults` | number | no | 10 | Number of results (1-20) |
| `source` | `"exa"` \| `"aliyun"` | no | — | Search source |

**Sources:**

- **Exa** (default) — AI-native search API. With `EXA_API_KEY`: full REST API. Without: MCP free tier (150 calls/day, 3 QPS). Always available, no key needed for basic usage.
- **Aliyun** (fallback) — [Bailian WebSearch MCP](https://bailian.console.aliyun.com/cn-beijing?tab=mcp#/mcp-market/detail/WebSearch). Requires `ALIYUN_API_KEY` env var or a registered `aliyun` provider in pi's `models.json`. Better for Chinese-language queries. When Exa fails, the tool automatically falls back to Aliyun.

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
