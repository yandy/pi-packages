# pi-web-tools

A [pi](https://pi.dev/docs/latest/packages) package providing web search and web fetch tools for coding agents.

## Tools

| Tool | Description | Source |
|------|-------------|--------|
| `web_search` | Pure web search, returns raw results (titles, URLs, snippets) | Exa (REST + MCP free tier) |
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

## Configuration

Configuration uses environment variables for API keys.

### API Keys (environment variables only)

| Variable | Description | Default |
|----------|-------------|---------|
| `EXA_API_KEY` | Exa API key. If not set, uses MCP free tier (150 calls/day) | — |

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
