# pi-web-tools

A [pi](https://pi.dev/docs/latest/packages) package providing web search and web fetch tools for coding agents.

## Tools

| Tool | Description | Provider |
|------|-------------|----------|
| `websearch` | Pure web search, returns raw results (titles, URLs, snippets) | Exa → DeepSeek → Aliyun fallback |
| `webfetch` | Fetch a URL and convert HTML to readable markdown, or return the raw body | Local → DeepSeek fallback |

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

- `websearch`: No config needed — Exa MCP free tier (150 calls/day). Optional: set `DEEPSEEK_API_KEY` (or configure a `deepseek` provider in pi) for the DeepSeek fallback slot; set `ALIYUN_API_KEY` (or configure an `aliyun` provider) for the Aliyun fallback slot.
- `webfetch`: No config needed — direct HTTP fetch. Optional: set `DEEPSEEK_API_KEY` (or configure a `deepseek` provider in pi) to enable the DeepSeek fallback, which renders JS-heavy pages server-side.

## Configuration

### API Keys (environment variables or pi provider config)

| Variable | Description | Default |
|----------|-------------|---------|
| `EXA_API_KEY` | Exa API key. If not set, uses MCP free tier (150 calls/day) | — |
| `DEEPSEEK_API_KEY` | DeepSeek API key for websearch/webfetch providers. Also resolved from pi's deepseek provider config automatically | — |
| `ALIYUN_API_KEY` | Aliyun Bailian API key for websearch fallback. Also resolved from pi's aliyun provider config automatically | — |

### Config file (`web-tools.json`)

Optionally pin a default provider per tool. Global: `<agent-dir>/web-tools.json`; project: `<cwd>/.pi/web-tools.json` (project overrides global at section level).

```json
{
	"websearch": { "provider": "deepseek" },
	"webfetch": { "provider": "deepseek" }
}
```

- Valid values: `websearch` → `"exa" | "deepseek" | "aliyun"`; `webfetch` → `"local" | "deepseek"`.
- Precedence: tool-call `provider` parameter > config file > built-in fallback chain.
- A provider specified by parameter or config is used exclusively — no fallback to other providers on failure.
- An invalid config value produces an explicit error naming the file and the expected values.

## Tools Reference

### websearch

Search the web with automatic provider fallback.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | yes | — | Search query |
| `numResults` | number | no | 10 | Number of results (1-20) |
| `provider` | `"exa"` \| `"deepseek"` \| `"aliyun"` | no | — | Search provider (exclusive when specified) |

**Providers:**

- **Exa** (default first) — AI-native search API. With `EXA_API_KEY`: full REST API. Without: MCP free tier (150 calls/day, 3 QPS). Always available, no key needed for basic usage.
- **DeepSeek** (fallback slot 2) — [DeepSeek Search API](https://api-docs.deepseek.com/zh-cn/guides/search), self-developed search engine. Good for Chinese queries; supports search syntax in the query (`site:`, `lang:`, `after:`, `before:`, quoted phrases). Returns LLM-oriented summaries as snippets. Requires `DEEPSEEK_API_KEY` env var or a configured `deepseek` provider in pi. Billed per successful request (¥5/1000; empty results are free).
- **Aliyun** (fallback slot 3) — [Bailian WebSearch MCP](https://bailian.console.aliyun.com/cn-beijing?tab=mcp#/mcp-market/detail/WebSearch). Requires `ALIYUN_API_KEY` env var or a configured `aliyun` provider in pi. Better for Chinese-language queries.

When a provider fails, the tool automatically falls back to the next one (exa → deepseek → aliyun). Providers without a configured key fail fast and are skipped in the chain.

### webfetch

Fetch content from a URL as readable markdown, or as the raw response body.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `url` | string | yes | — | URL to fetch |
| `format` | `"markdown"` \| `"origin"` | no | `"markdown"` | Output format |
| `timeout` | number | no | 30 | Timeout in seconds (1-120) |
| `provider` | `"local"` \| `"deepseek"` | no | — | Fetch provider (exclusive when specified) |

**Formats:**

- `"markdown"` (default) — dispatched in this order (HTML first, then JSON, then verbatim):
  - **HTML** (checked first, for every body whose type is not recognised as binary): `text/html` or `application/xhtml+xml`, or a body whose first 1024 characters, after leading whitespace, start with `<!doctype html` / `<html`. The sniff is not limited to `text/plain`: a body labelled `text/markdown`, `application/json`, or anything else is treated as HTML when it looks like a full document. `script`, `style`, `noscript`, `template`, `svg`, `iframe` and `canvas` are dropped, then the content container is located in the order `main` → `article` → `[role=main]` → `body`. Every non-empty match of the first selector that has one is converted to markdown and joined with blank lines. The page `<title>` is returned on the output's `Title:` line instead of inside the body. `nav`/`aside`/`header`/`footer` inside the chosen container are kept — page chrome is excluded only by picking the container.
  - **JSON** (`application/json`, `text/json`, any `*+json`): pretty-printed with 2-space indentation; if the body cannot be parsed it is returned verbatim.
  - **Other text types** (source code, diffs, plain text, raw markdown, …): returned verbatim, with no tag stripping or conversion.
  - **Recognised binary types**: rejected, see below.
- `"origin"` — the response body unmodified apart from the 100,000-character truncation: no parsing, no extraction, no pretty-printing, and no `Title:` line. Recognised binary types are rejected exactly as with `markdown`.
- **Binary detection is a media-type blacklist, and it applies in both formats**: rejected are `image/*`, `audio/*`, `video/*`, `font/*`, `model/*`, `application/vnd.*` (except `*+json` / `*+xml`), and exactly these types: `application/pdf`, `application/zip`, `application/gzip`, `application/x-gzip`, `application/x-tar`, `application/x-bzip2`, `application/x-7z-compressed`, `application/x-rar-compressed`, `application/octet-stream`, `application/wasm`, `application/x-protobuf`, `application/protobuf`, `application/epub+zip`. Every other media type is not detected as binary and is returned as text — including `application/msword`, `application/ogg`, `application/zstd`, and the non-`x-` spellings `application/tar` / `application/bzip2`. The error reads `Unsupported content type: <media type>[, <bytes> bytes]. webfetch only returns text; download the file with another tool.`
- Any other `format` value is rejected with `Unknown format: <value>. Available: markdown, origin`.

**Providers:**

- **Local** (default first) — direct HTTP GET; `markdown` does the extraction and conversion described above, `origin` returns the body unmodified apart from that truncation.
- **DeepSeek** (fallback) — [DeepSeek Fetch API](https://api-docs.deepseek.com/zh-cn/guides/search), server-side fetch returning markdown. Handles JS-rendered pages that local fetch cannot. Requires `DEEPSEEK_API_KEY` env var or a configured `deepseek` provider in pi. Billed per successful request (¥5/1000; failures are free).

Fallback triggers (chain mode only): local hard failure (network error / timeout / non-2xx), or local success with thin content (empty shell or junk-tag pages, < 200 meaningful characters). If DeepSeek also fails after a thin-content local result, the local result is returned as-is. Without a `provider`, local always runs first; the DeepSeek leg runs only when a DeepSeek key is available, and only for `format: "markdown"`. `format: "origin"` never falls back (DeepSeek returns markdown only). Recognised binary types and unknown `format` values are terminal errors: they never trigger the DeepSeek fallback, because another provider cannot turn them into text either. With `provider` specified (parameter or config), that provider is used exclusively — except `provider: "deepseek"` + `format: "origin"`, which auto-routes to local.

## Development

```bash
# From repo root:
npm ci                    # Install all dependencies
npm run typecheck         # Type-check all packages
npm run lint              # Biome lint
npm test                  # Run all tests

# Package-specific:
pi -e ./index.ts          # Run the extension locally (from this dir)
```

## License

MIT
