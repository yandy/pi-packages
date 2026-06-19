# Remove deep_search and image_search tools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `deep_search` and `image_search` tools and all Aliyun infrastructure code exclusively used by them.

**Architecture:** Pure deletion/modification — no new code. After removal, the package contains only `web_search` (Exa-based) and `web_fetch` tools.

**Tech Stack:** TypeScript, Biome (lint), tsc (typecheck), vitest (test)

---

### Task 1: Delete deep_search source files

**Files:**
- Delete: `src/deep_search/aliyun.ts`
- Delete: `src/deep_search/index.ts`
- Delete: `src/deep_search/types.ts`

- [ ] **Step 1: Delete the directory**

```bash
rm -rf src/deep_search
```

---

### Task 2: Delete image_search source files

**Files:**
- Delete: `src/image_search/aliyun.ts`
- Delete: `src/image_search/index.ts`
- Delete: `src/image_search/types.ts`

- [ ] **Step 1: Delete the directory**

```bash
rm -rf src/image_search
```

---

### Task 3: Delete Aliyun infrastructure files

**Files:**
- Delete: `src/provider.ts`
- Delete: `src/openai_client.ts`

- [ ] **Step 1: Delete infrastructure files**

```bash
rm src/provider.ts src/openai_client.ts
```

---

### Task 4: Delete test files

**Files:**
- Delete: `tests/deep_search.test.ts`
- Delete: `tests/image_search.test.ts`
- Delete: `tests/provider.test.ts`

- [ ] **Step 1: Delete test files**

```bash
rm tests/deep_search.test.ts tests/image_search.test.ts tests/provider.test.ts
```

---

### Task 5: Modify index.ts — remove tool registrations and imports

**Files:**
- Modify: `index.ts`

- [ ] **Step 1: Remove deep_search and image_search imports**

Replace:
```typescript
import { deepSearch } from "./src/deep_search/index";
import { imageSearch } from "./src/image_search/index";
import { webFetch } from "./src/web_fetch";
```
With:
```typescript
import { webFetch } from "./src/web_fetch";
```

- [ ] **Step 2: Remove unused imports**

Replace:
```typescript
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadConfig } from "./src/config";
```
With:
```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
```

- [ ] **Step 3: Remove deep_search pi.registerTool block**

Delete lines:
```
	// -------------------------------------------------------------------
	// deep_search
	// -------------------------------------------------------------------
	pi.registerTool({
		...entire deep_search block...
	});

	// -------------------------------------------------------------------
	// image_search
	// -------------------------------------------------------------------
	pi.registerTool({
		...entire image_search block...
	});
```
(The block to remove starts at `// deep_search` comment and ends at the closing `});` before `// web_fetch`)

---

### Task 6: Modify src/config.ts — remove model config fields

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Remove deepSearchModel and imageSearchModel from interface**

Replace:
```typescript
interface WebToolsConfig {
	aliyun?: {
		baseUrl?: string;
		aliyunProviderKey?: string;
		deepSearchModel?: string;
		imageSearchModel?: string;
	};
}
```
With:
```typescript
interface WebToolsConfig {
	aliyun?: {
		baseUrl?: string;
		aliyunProviderKey?: string;
	};
}
```

---

### Task 7: Modify package.json — update description and remove openai dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update description**

Replace:
```json
"description": "pi package providing web_search, deep_search, image_search and web_fetch tools"
```
With:
```json
"description": "pi package providing web_search and web_fetch tools"
```

- [ ] **Step 2: Remove openai dependency**

Delete:
```json
"openai": "^6.26.0"
```
from `dependencies`. Since it was the only dependency, remove the entire `"dependencies"` block.

---

### Task 8: Modify README.md — remove deep_search and image_search documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update description line 3**

Replace:
```
A [pi](https://pi.dev/docs/latest/packages) package providing web and image search tools for coding agents.
```
With:
```
A [pi](https://pi.dev/docs/latest/packages) package providing web search and web fetch tools for coding agents.
```

- [ ] **Step 2: Remove deep_search and image_search rows from tools table (lines 10-11)**

Replace:
```
| `web_search` | Pure web search, returns raw results (titles, URLs, snippets) | Exa (REST + MCP free tier) |
| `deep_search` | Deep research with LLM-synthesized answers | Aliyun (Bailian) Chat Completions API |
| `image_search` | Search images by text or find similar images by URL | Aliyun (Bailian) Responses API |
| `web_fetch` | Fetch and convert web pages to text, markdown, or raw HTML | — |
```
With:
```
| `web_search` | Pure web search, returns raw results (titles, URLs, snippets) | Exa (REST + MCP free tier) |
| `web_fetch` | Fetch and convert web pages to text, markdown, or raw HTML | — |
```

- [ ] **Step 3: Update Prerequisites (lines 26-27)**

Replace:
```
- `web_search`: No config needed — Exa MCP free tier (150 calls/day). Set `EXA_API_KEY` for higher limits.
- `deep_search` / `image_search`: Set `ALIYUN_API_KEY` or use `/login` in pi to authenticate with Aliyun.
```
With:
```
- `web_search`: No config needed — Exa MCP free tier (150 calls/day). Set `EXA_API_KEY` for higher limits.
```

- [ ] **Step 4: Remove Aliyun env vars from API Keys table (lines 38-41)**

Replace:
```
| `EXA_API_KEY` | Exa API key. If not set, uses MCP free tier (150 calls/day) | — |
| `ALIYUN_API_KEY` | Aliyun (Bailian) API key | — |
| `ALIYUN_BASE_URL` | Aliyun API base URL | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `ALIYUN_DEEP_SEARCH_MODEL` | Model for deep_search | `deepseek-v4-flash` |
| `ALIYUN_IMAGE_SEARCH_MODEL` | Model for image_search | `qwen3.7-plus` |
```
With:
```
| `EXA_API_KEY` | Exa API key. If not set, uses MCP free tier (150 calls/day) | — |
```

- [ ] **Step 5: Remove Aliyun login note (line 43)**

Delete:
```
Aliyun also supports key resolution via pi's `/login` — if you've logged into Aliyun through pi, no env var needed.
```

- [ ] **Step 6: Remove Project Config section (lines 45-73)**

Delete the entire "Project Config" section (from `### Project Config` heading through the two `>` note lines after the config table). Remove everything from:
```
### Project Config (`.pi/agent/web-tools.json`)
```
through to just before:
```
## Tools Reference
```

- [ ] **Step 7: Remove deep_search reference section (lines 91-106)**

Delete from:
```
### deep_search
```
through to the closing `> Requires ...` line. Keep `web_fetch` section intact.

- [ ] **Step 8: Remove image_search reference section (lines 107-119)**

Delete from:
```
### image_search
```
through to the closing `> At least one of ...` line. Keep `web_fetch` section intact.

---

### Task 9: Modify README-zh.md — remove deep_search and image_search documentation

**Files:**
- Modify: `README-zh.md`

- [ ] **Step 1: Update description line 3**

Replace:
```
为编程 agent 提供网页搜索和图片搜索工具的 [pi](https://pi.dev/docs/latest/packages) 包。
```
With:
```
为编程 agent 提供网页搜索和网页抓取工具的 [pi](https://pi.dev/docs/latest/packages) 包。
```

- [ ] **Step 2: Remove deep_search and image_search rows from tools table (lines 10-11)**

Replace:
```
| `web_search` | 纯网页搜索，返回原始结果（标题、URL、摘要） | Exa（REST + MCP 免费层） |
| `deep_search` | 深度研究，LLM 合成答案 | 阿里云百炼 Chat Completions API |
| `image_search` | 文搜图 / 图搜图 | 阿里云百炼 Responses API |
| `web_fetch` | 抓取网页并转换为文本、Markdown 或原始 HTML | — |
```
With:
```
| `web_search` | 纯网页搜索，返回原始结果（标题、URL、摘要） | Exa（REST + MCP 免费层） |
| `web_fetch` | 抓取网页并转换为文本、Markdown 或原始 HTML | — |
```

- [ ] **Step 3: Update Prerequisites (lines 26-27)**

Replace:
```
- `web_search`：无需配置——Exa MCP 免费层（150次/天）。设置 `EXA_API_KEY` 可获得更高限额。
- `deep_search` / `image_search`：设置 `ALIYUN_API_KEY` 或在 pi 中使用 `/login` 认证阿里云。
```
With:
```
- `web_search`：无需配置——Exa MCP 免费层（150次/天）。设置 `EXA_API_KEY` 可获得更高限额。
```

- [ ] **Step 4: Remove Aliyun env vars from API Keys table (lines 38-41)**

Replace:
```
| `EXA_API_KEY` | Exa API key，不设则走 MCP 免费层（150次/天） | — |
| `ALIYUN_API_KEY` | 阿里云百炼 API key | — |
| `ALIYUN_BASE_URL` | 阿里云 API 地址 | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `ALIYUN_DEEP_SEARCH_MODEL` | deep_search 模型 | `deepseek-v4-flash` |
| `ALIYUN_IMAGE_SEARCH_MODEL` | image_search 模型 | `qwen3.7-plus` |
```
With:
```
| `EXA_API_KEY` | Exa API key，不设则走 MCP 免费层（150次/天） | — |
```

- [ ] **Step 5: Remove Aliyun login note (line 43)**

Delete:
```
阿里云也支持通过 pi 的 `/login` 获取 key——如果在 pi 中登录过阿里云，无需设置环境变量。
```

- [ ] **Step 6: Remove Project Config section (lines 45-73)**

Delete the entire "项目配置" section from:
```
### 项目配置（`.pi/agent/web-tools.json`）
```
through to just before:
```
## 工具参考
```
This includes the JSON example, the config table, the aliyunProviderKey note, and the two `>` notes.

- [ ] **Step 7: Remove deep_search reference section (lines 91-106)**

Delete from:
```
### deep_search
```
through to the `> 需要 ...` line.

- [ ] **Step 8: Remove image_search reference section (lines 107-119)**

Delete from:
```
### image_search
```
through to the `> 至少提供 ...` line.

---

### Task 10: Annotate historical spec files

**Files:**
- Modify: `docs/superpowers/specs/2026-06-18-pi-web-tools-design.md`
- Modify: `docs/superpowers/specs/2026-06-19-deep-image-search-config-split-design.md`

- [ ] **Step 1: Prepend obsoletion notice to 2026-06-18-pi-web-tools-design.md**

Add the following as the very first lines of the file (after the `#` title):

```markdown
> **OBSOLETED 2026-06-19:** `deep_search` and `image_search` tools have been removed from pi-web-tools.
> The sections below referencing these tools are no longer valid and are kept for historical reference only.
```

- [ ] **Step 2: Prepend obsoletion notice to 2026-06-19-deep-image-search-config-split-design.md**

Add the following as the very first lines of the file (after the `#` title):

```markdown
> **OBSOLETED 2026-06-19:** `deep_search` and `image_search` tools have been removed from pi-web-tools.
> This whole spec is no longer valid and is kept for historical reference only.
```

---

### Task 11: Verify

- [ ] **Step 1: Run typecheck**

```bash
npm run typecheck
```
Expected: passes with no errors.

- [ ] **Step 2: Run lint**

```bash
npm run lint
```
Expected: no new warnings (pre-existing `noExplicitAny` warnings in remaining tests are acceptable).

- [ ] **Step 3: Run tests**

```bash
npm run test
```
Expected: all remaining tests pass.

- [ ] **Step 4: Commit all changes**

```bash
git add -A
git commit -m "feat: remove deep_search and image_search tools"
```
