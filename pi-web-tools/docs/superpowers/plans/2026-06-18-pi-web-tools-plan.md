# pi-web-tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `pi-web-tools`, a pi package providing `web_search`, `deep_search`, `image_search`, and `web_fetch` tools.

**Architecture:** Extension entry (`index.ts`) registers 4 tools via `pi.registerTool()`. Each tool's backend lives in its own directory under `src/`. Search tools use a fallback orchestrator pattern. Aliyun-based tools share auth/resolution via `ctx.modelRegistry`.

**Tech Stack:** TypeScript, `@earendil-works/pi-coding-agent`, `typebox`, `@earendil-works/pi-tui`, Node 22 built-in `fetch`

---

## File Structure

```
pi-web-tools/
├── index.ts                     # Extension entry, registers 4 tools
├── src/
│   ├── web_search/
│   │   ├── types.ts             # SearchSource, SearchResponse
│   │   ├── exa.ts               # Exa REST + MCP free tier
│   │   ├── duckduckgo.ts        # DuckDuckGo Instant Answer API
│   │   └── index.ts             # Fallback orchestrator
│   ├── deep_search/
│   │   ├── types.ts             # DeepSearchSource, DeepSearchResponse
│   │   ├── aliyun.ts            # Aliyun Responses API
│   │   └── index.ts             # Entry
│   ├── image_search/
│   │   ├── types.ts             # ImageResult, ImageSearchResponse
│   │   ├── aliyun.ts            # Aliyun Responses API (文搜图+图搜图)
│   │   └── index.ts             # Entry
│   └── web_fetch.ts             # URL fetcher + HTML→MD
├── tests/
│   ├── web_search.test.ts
│   ├── deep_search.test.ts
│   ├── image_search.test.ts
│   └── web_fetch.test.ts
├── package.json
├── tsconfig.json
├── biome.json
├── vitest.config.ts
└── .gitignore
```

---

### Task 1: Project Scaffold

**Files:**
- Create: `pi-web-tools/package.json`
- Create: `pi-web-tools/tsconfig.json`
- Create: `pi-web-tools/biome.json`
- Create: `pi-web-tools/vitest.config.ts`
- Create: `pi-web-tools/.gitignore`
- Create: `pi-web-tools/tests/` (empty dir)

- [ ] **Step 1: Create package.json**

```json
{
	"name": "pi-web-tools",
	"version": "0.1.0",
	"description": "pi package providing web_search, deep_search, image_search and web_fetch tools",
	"license": "MIT",
	"type": "module",
	"keywords": ["pi-package"],
	"files": ["index.ts", "src/"],
	"scripts": {
		"test": "vitest run",
		"test:watch": "vitest",
		"typecheck": "tsc --noEmit",
		"lint": "biome lint .",
		"format": "biome format --write .",
		"check": "biome check ."
	},
	"pi": { "extensions": ["./index.ts"] },
	"peerDependencies": { "@earendil-works/pi-coding-agent": ">=0.74.0" },
	"devDependencies": {
		"@biomejs/biome": "^2.5.0",
		"@earendil-works/pi-coding-agent": "^0.74.0",
		"@types/node": "^22.0.0",
		"typescript": "~5.7.0",
		"vitest": "^3.0.0"
	}
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
	"compilerOptions": {
		"target": "ES2022",
		"module": "ES2022",
		"moduleResolution": "bundler",
		"strict": true,
		"noEmit": true,
		"esModuleInterop": true,
		"skipLibCheck": true,
		"forceConsistentCasingInFileNames": true,
		"resolveJsonModule": true,
		"isolatedModules": true,
		"lib": ["ES2022"]
	},
	"include": ["index.ts", "src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 3: Create biome.json**

```json
{
	"$schema": "https://biomejs.dev/schemas/2.5.0/schema.json",
	"formatter": {
		"enabled": true,
		"indentStyle": "tab",
		"indentWidth": 1,
		"lineWidth": 120,
		"lineEnding": "lf"
	},
	"javascript": {
		"formatter": {
			"quoteStyle": "double",
			"trailingCommas": "all",
			"semicolons": "always",
			"arrowParentheses": "always"
		}
	},
	"linter": {
		"enabled": true,
		"rules": {
			"preset": "recommended",
			"style": { "noUnusedTemplateLiteral": "off" },
			"correctness": {
				"noUnusedVariables": "error",
				"noUnusedImports": "error"
			},
			"suspicious": {
				"noExplicitAny": "warn",
				"noEmptyBlockStatements": "off"
			}
		}
	},
	"files": { "includes": ["**/*.ts", "**/*.json"], "ignoreUnknown": true }
}
```

- [ ] **Step 4: Create vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: { include: ["tests/**/*.test.ts"] },
});
```

- [ ] **Step 5: Create .gitignore**

```
node_modules/
.opencode/
*.log
.DS_Store
```

- [ ] **Step 6: Create dirs and install**

```bash
mkdir -p pi-web-tools/src/web_search pi-web-tools/src/deep_search pi-web-tools/src/image_search pi-web-tools/tests
cd pi-web-tools && npm install
```

- [ ] **Step 7: Commit**

```bash
git add pi-web-tools/
git commit -m "chore: scaffold pi-web-tools project"
```

---

### Task 2: web_search/types.ts

**Files:**
- Create: `pi-web-tools/src/web_search/types.ts`

- [ ] **Step 1: Write types**

```typescript
export interface SearchSource {
	title: string;
	url: string;
	snippet: string;
}

export interface SearchResponse {
	answer: string;
	sources: SearchSource[];
	sourceLabel: string;
}
```

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit --project pi-web-tools/tsconfig.json
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add pi-web-tools/src/web_search/types.ts
git commit -m "feat(web_search): add shared types"
```

---

### Task 3: web_search/exa.ts

**Files:**
- Create: `pi-web-tools/src/web_search/exa.ts`
- Create: `pi-web-tools/tests/web_search.test.ts` (exa tests only)

- [ ] **Step 1: Write the test file (exa section)**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// We import after mocking so the module uses our mock
let exaSearch: typeof import("../src/web_search/exa.js").exaSearch;

beforeEach(async () => {
	vi.resetModules();
	mockFetch.mockReset();
	const mod = await import("../src/web_search/exa.js");
	exaSearch = mod.exaSearch;
});

describe("exaSearch", () => {
	it("throws when EXA_API_KEY not set", async () => {
		delete process.env.EXA_API_KEY;
		await expect(exaSearch("test", 5)).rejects.toThrow("EXA_API_KEY");
	});

	it("calls REST API when EXA_API_KEY is set", async () => {
		process.env.EXA_API_KEY = "test-key";
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					results: [
						{ title: "Test Page", url: "https://example.com", text: "Sample content" },
						{ title: "Another", url: "https://example.org", text: "More" },
					],
				}),
		});

		const result = await exaSearch("test query", 5);

		expect(mockFetch).toHaveBeenCalledWith(
			"https://api.exa.ai/search",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({ "x-api-key": "test-key" }),
			}),
		);
		expect(result.sourceLabel).toBe("exa");
		expect(result.sources).toHaveLength(2);
		expect(result.sources[0].title).toBe("Test Page");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd pi-web-tools && npx vitest run tests/web_search.test.ts 2>&1
```
Expected: FAIL (module not found)

- [ ] **Step 3: Write exa.ts implementation**

```typescript
import type { SearchResponse } from "./types";

const EXA_REST_URL = "https://api.exa.ai/search";
const EXA_MCP_URL = "https://api.exa.ai/api/mcp";
const TIMEOUT_MS = 60_000;

export async function exaSearch(query: string, numResults: number, signal?: AbortSignal): Promise<SearchResponse> {
	const apiKey = process.env.EXA_API_KEY;

	const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);
	const s = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

	if (apiKey) {
		return exaRestSearch(query, numResults, apiKey, s);
	}
	return exaMcpSearch(query, numResults, s);
}

async function exaRestSearch(
	query: string,
	numResults: number,
	apiKey: string,
	signal: AbortSignal,
): Promise<SearchResponse> {
	const resp = await fetch(EXA_REST_URL, {
		method: "POST",
		headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
		body: JSON.stringify({
			query,
			numResults,
			type: "auto",
			contents: { text: { maxCharacters: 3000 } },
		}),
		signal,
	});

	if (!resp.ok) {
		const detail = await resp.text().catch(() => resp.statusText);
		throw new Error(`Exa API ${resp.status}: ${detail}`);
	}

	const data = (await resp.json()) as {
		results?: Array<{ title?: string; url?: string; text?: string }>;
	};
	const results = data.results || [];

	const sources = results.map((r) => ({
		title: r.title || "Untitled",
		url: r.url || "",
		snippet: (r.text || "").slice(0, 500),
	}));

	const answer =
		sources
			.map((s, i) => `${i + 1}. [${s.title}](${s.url})\n   ${s.snippet}`)
			.join("\n\n") || `No results found for: ${query}`;

	return { answer, sources, sourceLabel: "exa" };
}

async function exaMcpSearch(query: string, numResults: number, signal: AbortSignal): Promise<SearchResponse> {
	const initResp = await fetch(EXA_MCP_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			method: "initialize",
			params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pi-web-tools", version: "1.0" } },
			id: 1,
		}),
		signal,
	});

	if (!initResp.ok) {
		throw new Error(`Exa MCP initialize failed: ${initResp.status}`);
	}

	const searchResp = await fetch(EXA_MCP_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			method: "tools/call",
			params: {
				name: "web_search",
				arguments: { query, numResults, type: "auto", contents: { text: { maxCharacters: 3000 } } },
			},
			id: 2,
		}),
		signal,
	});

	if (!searchResp.ok) {
		throw new Error(`Exa MCP search failed: ${searchResp.status}`);
	}

	const data = (await searchResp.json()) as {
		result?: { content?: Array<{ text?: string }> };
	};

	const text = data.result?.content?.map((c) => c.text || "").join("\n\n") || "";

	const sources = parseMcpResults(text);

	const answer =
		sources
			.map((s, i) => `${i + 1}. [${s.title}](${s.url})\n   ${s.snippet}`)
			.join("\n\n") || `No results found for: ${query}`;

	return { answer, sources, sourceLabel: "exa" };
}

function parseMcpResults(text: string): Array<{ title: string; url: string; snippet: string }> {
	const results: Array<{ title: string; url: string; snippet: string }> = [];
	const lines = text.split("\n");
	let current: { title: string; url: string; snippet: string } | null = null;

	for (const line of lines) {
		const titleMatch = line.match(/^Title:\s*(.+)/);
		const urlMatch = line.match(/^URL:\s*(.+)/);
		const textMatch = line.match(/^Text:\s*(.+)/);

		if (titleMatch) {
			if (current) results.push(current);
			current = { title: titleMatch[1].trim(), url: "", snippet: "" };
		} else if (urlMatch && current) {
			current.url = urlMatch[1].trim();
		} else if (textMatch && current) {
			current.snippet = textMatch[1].trim().slice(0, 500);
		}
	}
	if (current?.url) results.push(current);
	return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd pi-web-tools && npx vitest run tests/web_search.test.ts 2>&1
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pi-web-tools/src/web_search/exa.ts pi-web-tools/tests/web_search.test.ts
git commit -m "feat(web_search): implement exa source with REST + MCP fallback"
```

---

### Task 4: web_search/duckduckgo.ts

**Files:**
- Create: `pi-web-tools/src/web_search/duckduckgo.ts`
- Modify: `pi-web-tools/tests/web_search.test.ts` (add DDG tests)

- [ ] **Step 1: Add DDG tests**

```typescript
// Add after existing imports in tests/web_search.test.ts:

let duckduckgoSearch: typeof import("../src/web_search/duckduckgo.js").duckduckgoSearch;

beforeEach(async () => {
	// ... existing mockFetch setup ...
	const ddgMod = await import("../src/web_search/duckduckgo.js");
	duckduckgoSearch = ddgMod.duckduckgoSearch;
});

describe("duckduckgoSearch", () => {
	it("returns formatted results from DDG API", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					Abstract: "Abstract text",
					AbstractText: "Abstract description",
					AbstractURL: "https://example.com",
					RelatedTopics: [
						{ Text: "Topic 1 - Description", FirstURL: "https://one.com" },
						{ Text: "Topic 2", FirstURL: "https://two.com" },
					],
				}),
		});

		const result = await duckduckgoSearch("test query", 5);

		expect(result.sourceLabel).toBe("duckduckgo");
		expect(result.sources.length).toBeGreaterThan(0);
		expect(result.answer).toContain("example.com");
	});

	it("handles empty response", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({}),
		});

		const result = await duckduckgoSearch("rare query", 5);
		expect(result.answer).toContain("No results");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd pi-web-tools && npx vitest run tests/web_search.test.ts 2>&1
```
Expected: FAIL (module not found for duckduckgo)

- [ ] **Step 3: Write duckduckgo.ts**

```typescript
import type { SearchSource, SearchResponse } from "./types";

const DDG_URL = "https://api.duckduckgo.com/";
const TIMEOUT_MS = 30_000;

interface DdgResponse {
	Abstract?: string;
	AbstractText?: string;
	AbstractURL?: string;
	RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
}

export async function duckduckgoSearch(
	query: string,
	numResults: number,
	signal?: AbortSignal,
): Promise<SearchResponse> {
	const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);
	const s = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

	const url = `${DDG_URL}?q=${encodeURIComponent(query)}&format=json&no_html=1`;
	const resp = await fetch(url, { signal: s });

	if (!resp.ok) {
		throw new Error(`DuckDuckGo API ${resp.status}: ${resp.statusText}`);
	}

	const data = (await resp.json()) as DdgResponse;
	const sources: SearchSource[] = [];

	if (data.Abstract && data.AbstractURL) {
		sources.push({
			title: data.Abstract,
			url: data.AbstractURL,
			snippet: data.AbstractText || "",
		});
	}

	for (const topic of data.RelatedTopics || []) {
		if (topic.FirstURL && topic.Text) {
			const parts = topic.Text.split(" - ");
			sources.push({
				title: parts[0] || topic.Text,
				url: topic.FirstURL,
				snippet: parts.slice(1).join(" - ") || topic.Text,
			});
		}
		if (sources.length >= numResults) break;
	}

	const answer =
		sources
			.map((s, i) => `${i + 1}. [${s.title}](${s.url})\n   ${s.snippet}`)
			.join("\n\n") || `No results found for: ${query}`;

	return { answer, sources, sourceLabel: "duckduckgo" };
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd pi-web-tools && npx vitest run tests/web_search.test.ts 2>&1
```
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add pi-web-tools/src/web_search/duckduckgo.ts pi-web-tools/tests/web_search.test.ts
git commit -m "feat(web_search): implement duckduckgo source"
```

---

### Task 5: web_search/index.ts (orchestrator)

**Files:**
- Create: `pi-web-tools/src/web_search/index.ts`
- Modify: `pi-web-tools/tests/web_search.test.ts` (add orchestrator tests)

- [ ] **Step 1: Add orchestrator tests**

```typescript
let search: typeof import("../src/web_search/index.js").search;
// add to beforeEach:
const wsMod = await import("../src/web_search/index.js");
search = wsMod.search;

describe("search orchestrator", () => {
	beforeEach(() => {
		delete process.env.EXA_API_KEY;
	});

	it("falls back from exa to duckduckgo when exa not configured", async () => {
		// Exa not configured → skips
		// DDG should be called
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					RelatedTopics: [{ Text: "Result", FirstURL: "https://example.com" }],
				}),
		});

		const result = await search("test", 5);
		expect(result.sourceLabel).toBe("duckduckgo");
	});

	it("throws when all sources unavailable", async () => {
		// Both exa and ddg fail
		mockFetch.mockRejectedValue(new Error("network error"));

		await expect(search("test", 5)).rejects.toThrow("All search sources failed");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd pi-web-tools && npx vitest run tests/web_search.test.ts 2>&1
```
Expected: FAIL for orchestrator tests

- [ ] **Step 3: Write orchestrator**

```typescript
import type { SearchResponse } from "./types";
import { exaSearch } from "./exa";
import { duckduckgoSearch } from "./duckduckgo";

type SearchFn = (query: string, numResults: number, signal?: AbortSignal) => Promise<SearchResponse>;

const SOURCES: Array<{ name: string; fn: SearchFn; checkConfigured: () => boolean }> = [
	{
		name: "exa",
		fn: exaSearch,
		checkConfigured: () => !!process.env.EXA_API_KEY,
	},
	{
		name: "duckduckgo",
		fn: duckduckgoSearch,
		checkConfigured: () => true,
	},
];

export async function search(
	query: string,
	numResults: number,
	signal?: AbortSignal,
	onProgress?: (msg: string) => void,
	specifiedSource?: string,
): Promise<SearchResponse> {
	const errors: string[] = [];
	const sources = specifiedSource ? SOURCES.filter((s) => s.name === specifiedSource) : SOURCES;

	for (const source of sources) {
		if (!source.checkConfigured()) {
			errors.push(`${source.name}: not configured`);
			continue;
		}
		try {
			onProgress?.(`Trying ${source.name}...`);
			const resp = await source.fn(query, numResults, signal);
			return resp;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			errors.push(`${source.name}: ${msg}`);
		}
	}

	throw new Error(`All search sources failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd pi-web-tools && npx vitest run tests/web_search.test.ts 2>&1
```
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add pi-web-tools/src/web_search/index.ts pi-web-tools/tests/web_search.test.ts
git commit -m "feat(web_search): add fallback orchestrator"
```

---

### Task 6: deep_search/types.ts + deep_search/aliyun.ts + deep_search/index.ts

**Files:**
- Create: `pi-web-tools/src/deep_search/types.ts`
- Create: `pi-web-tools/src/deep_search/aliyun.ts`
- Create: `pi-web-tools/src/deep_search/index.ts`
- Create: `pi-web-tools/tests/deep_search.test.ts`

- [ ] **Step 1: Write deep_search types**

```typescript
// src/deep_search/types.ts
export interface DeepSearchSource {
	title: string;
	url: string;
}

export interface DeepSearchResponse {
	answer: string;
	sources: DeepSearchSource[];
}
```

- [ ] **Step 2: Write tests**

```typescript
// tests/deep_search.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

let deepSearch: typeof import("../src/deep_search/index.js").deepSearch;

beforeEach(async () => {
	vi.resetModules();
	mockFetch.mockReset();
	process.env.ALIYUN_API_KEY = "test-key";
	const mod = await import("../src/deep_search/index.js");
	deepSearch = mod.deepSearch;
});

describe("deepSearch", () => {
	it("calls aliyun responses API", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					output: [
						{
							type: "web_search_call",
							action: { query: "test query" },
							sources: [{ type: "web", url: "https://example.com" }],
						},
						{
							type: "message",
							role: "assistant",
							content: [{ type: "output_text", text: "Answer text" }],
						},
					],
				}),
		});

		const result = await deepSearch("test query");
		expect(mockFetch).toHaveBeenCalledWith(
			expect.stringContaining("/responses"),
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining("web_search"),
			}),
		);
		expect(result.answer).toBe("Answer text");
		expect(result.sources).toHaveLength(1);
	});

	it("throws when ALIYUN_API_KEY not configured", async () => {
		delete process.env.ALIYUN_API_KEY;
		await expect(deepSearch("test")).rejects.toThrow("ALIYUN_API_KEY");
	});
});
```

- [ ] **Step 3: Run test to verify fail**

```bash
cd pi-web-tools && npx vitest run tests/deep_search.test.ts 2>&1
```
Expected: FAIL

- [ ] **Step 4: Write aliyun.ts**

```typescript
// src/deep_search/aliyun.ts
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DeepSearchResponse } from "./types";

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL = "qwen3.7-plus";
const TIMEOUT_MS = 60_000;

export async function aliyunDeepSearch(
	query: string,
	signal?: AbortSignal,
	ctx?: ExtensionContext,
): Promise<DeepSearchResponse> {
	const apiKey = await resolveApiKey(ctx);
	const baseUrl = process.env.ALIYUN_BASE_URL || DEFAULT_BASE_URL;
	const model = process.env.ALIYUN_SEARCH_MODEL || DEFAULT_MODEL;

	const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);
	const s = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

	const resp = await fetch(`${baseUrl}/responses`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model,
			input: query,
			tools: [{ type: "web_search" }, { type: "web_extractor" }],
		}),
		signal: s,
	});

	if (!resp.ok) {
		const detail = await resp.text().catch(() => resp.statusText);
		throw new Error(`Aliyun API ${resp.status}: ${detail}`);
	}

	const data = (await resp.json()) as AliyunResponse;

	const sources = parseSources(data.output);
	const answer = parseAnswer(data.output);

	return { answer, sources };
}

async function resolveApiKey(ctx?: ExtensionContext): Promise<string> {
	if (ctx) {
		const key = await ctx.modelRegistry.getApiKeyForProvider("aliyun");
		if (key) return key;
	}
	const env = process.env.ALIYUN_API_KEY;
	if (env) return env;
	throw new Error("ALIYUN_API_KEY not configured. Set ALIYUN_API_KEY or use /login in pi.");
}

interface AliyunResponse {
	output?: Array<AliyunOutputItem>;
}

type AliyunOutputItem =
	| { type: "web_search_call"; action?: { query?: string }; sources?: Array<{ type?: string; url?: string }> }
	| { type: "web_extractor_call"; urls?: string[]; output?: string }
	| { type: "message"; content?: Array<{ type?: string; text?: string }> }
	| { type: string; [key: string]: unknown };

function parseSources(output: AliyunOutputItem[] = []): Array<{ title: string; url: string }> {
	const searchCalls = output.filter((item) => item.type === "web_search_call") as Array<{
		type: "web_search_call";
		sources?: Array<{ type?: string; url?: string }>;
	}>;
	const sources: Array<{ title: string; url: string }> = [];

	for (const call of searchCalls) {
		for (const src of call.sources || []) {
			if (src.url) {
				const domain = extractDomain(src.url);
				sources.push({ title: domain, url: src.url });
			}
		}
	}
	return sources;
}

function parseAnswer(output: AliyunOutputItem[] = []): string {
	const messages = output.filter((item) => item.type === "message") as Array<{
		type: "message";
		content?: Array<{ type?: string; text?: string }>;
	}>;
	const texts = messages.flatMap((m) => (m.content || []).filter((c) => c.type === "output_text").map((c) => c.text || ""));
	return texts.join("\n") || "No results";
}

function extractDomain(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}
```

- [ ] **Step 5: Write index.ts**

```typescript
// src/deep_search/index.ts
export { aliyunDeepSearch as deepSearch } from "./aliyun";
```

- [ ] **Step 6: Run tests to verify pass**

```bash
cd pi-web-tools && npx vitest run tests/deep_search.test.ts 2>&1
```
Expected: all PASS

- [ ] **Step 7: Commit**

```bash
git add pi-web-tools/src/deep_search/ pi-web-tools/tests/deep_search.test.ts
git commit -m "feat(deep_search): implement aliyun responses API search"
```

---

### Task 7: image_search/types.ts + image_search/aliyun.ts + image_search/index.ts

**Files:**
- Create: `pi-web-tools/src/image_search/types.ts`
- Create: `pi-web-tools/src/image_search/aliyun.ts`
- Create: `pi-web-tools/src/image_search/index.ts`
- Create: `pi-web-tools/tests/image_search.test.ts`

- [ ] **Step 1: Write types**

```typescript
// src/image_search/types.ts
export interface ImageResult {
	index: number;
	title: string;
	url: string;
}

export interface ImageSearchResponse {
	answer: string;
	images: ImageResult[];
}

export interface ImageSearchParams {
	query?: string;
	imageUrl?: string;
}
```

- [ ] **Step 2: Write tests**

```typescript
// tests/image_search.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

let imageSearch: typeof import("../src/image_search/index.js").imageSearch;

beforeEach(async () => {
	vi.resetModules();
	mockFetch.mockReset();
	process.env.ALIYUN_API_KEY = "test-key";
	const mod = await import("../src/image_search/index.js");
	imageSearch = mod.imageSearch;
});

describe("imageSearch", () => {
	it("uses web_search_image tool when only query provided", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					output: [
						{
							type: "web_search_image_call",
							output: JSON.stringify([
								{ index: 1, title: "Image 1", url: "https://img.com/1.jpg" },
							]),
						},
						{
							type: "message",
							content: [{ type: "output_text", text: "Found images" }],
						},
					],
				}),
		});

		const result = await imageSearch({ query: "find cats" });
		expect(mockFetch).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				body: expect.stringContaining("web_search_image"),
			}),
		);
		expect(result.images).toHaveLength(1);
	});

	it("uses image_search tool when imageUrl provided", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					output: [
						{
							type: "image_search_call",
							output: JSON.stringify([
								{ index: 1, title: "Similar", url: "https://img.com/2.jpg" },
							]),
						},
						{
							type: "message",
							content: [{ type: "output_text", text: "Similar images found" }],
						},
					],
				}),
		});

		const result = await imageSearch({ imageUrl: "https://example.com/photo.jpg" });
		expect(mockFetch).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				body: expect.stringContaining("image_search"),
			}),
		);
		expect(mockFetch).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				body: expect.stringContaining("input_image"),
			}),
		);
	});

	it("throws when neither query nor imageUrl provided", async () => {
		await expect(imageSearch({})).rejects.toThrow("query or imageUrl");
	});
});
```

- [ ] **Step 3: Run test to verify fail**

```bash
cd pi-web-tools && npx vitest run tests/image_search.test.ts 2>&1
```
Expected: FAIL

- [ ] **Step 4: Write aliyun.ts**

```typescript
// src/image_search/aliyun.ts
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ImageResult, ImageSearchParams, ImageSearchResponse } from "./types";

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL = "qwen3.7-plus";
const TIMEOUT_MS = 60_000;

export async function aliyunImageSearch(
	params: ImageSearchParams,
	signal?: AbortSignal,
	ctx?: ExtensionContext,
): Promise<ImageSearchResponse> {
	const { query, imageUrl } = params;

	if (!query && !imageUrl) {
		throw new Error("At least one of query or imageUrl must be provided");
	}

	const apiKey = await resolveApiKey(ctx);
	const baseUrl = process.env.ALIYUN_BASE_URL || DEFAULT_BASE_URL;
	const model = process.env.ALIYUN_SEARCH_MODEL || DEFAULT_MODEL;

	const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);
	const s = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

	let input: unknown;
	let tools: Array<{ type: string }>;

	if (imageUrl) {
		tools = [{ type: "image_search" }];
		const content: Array<{ type: string; [key: string]: unknown }> = [];
		if (query) {
			content.push({ type: "input_text", text: query });
		}
		content.push({ type: "input_image", image_url: imageUrl });
		input = [{ role: "user", content }];
	} else {
		tools = [{ type: "web_search_image" }];
		input = query!;
	}

	const resp = await fetch(`${baseUrl}/responses`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ model, input, tools }),
		signal: s,
	});

	if (!resp.ok) {
		const detail = await resp.text().catch(() => resp.statusText);
		throw new Error(`Aliyun API ${resp.status}: ${detail}`);
	}

	const data = (await resp.json()) as AliyunImageResponse;

	const images = parseImages(data.output);
	const answer = parseAnswer(data.output);

	return { answer, images };
}

interface AliyunImageResponse {
	output?: Array<{
		type: string;
		output?: string;
		content?: Array<{ type?: string; text?: string }>;
	}>;
}

function parseImages(output: AliyunImageResponse["output"] = []): ImageResult[] {
	for (const item of output) {
		if (item.type === "web_search_image_call" || item.type === "image_search_call") {
			try {
				const parsed = JSON.parse(item.output || "[]") as ImageResult[];
				return parsed;
			} catch {
				return [];
			}
		}
	}
	return [];
}

function parseAnswer(output: AliyunImageResponse["output"] = []): string {
	const messages = output.filter((item) => item.type === "message");
	const texts = messages.flatMap((m) =>
		(m.content || []).filter((c) => c.type === "output_text").map((c) => c.text || ""),
	);
	return texts.join("\n") || "No results";
}

async function resolveApiKey(ctx?: ExtensionContext): Promise<string> {
	if (ctx) {
		const key = await ctx.modelRegistry.getApiKeyForProvider("aliyun");
		if (key) return key;
	}
	const env = process.env.ALIYUN_API_KEY;
	if (env) return env;
	throw new Error("ALIYUN_API_KEY not configured. Set ALIYUN_API_KEY or use /login in pi.");
}
```

- [ ] **Step 5: Write index.ts**

```typescript
// src/image_search/index.ts
export { aliyunImageSearch as imageSearch } from "./aliyun";
```

- [ ] **Step 6: Run tests to verify pass**

```bash
cd pi-web-tools && npx vitest run tests/image_search.test.ts 2>&1
```
Expected: all PASS

- [ ] **Step 7: Commit**

```bash
git add pi-web-tools/src/image_search/ pi-web-tools/tests/image_search.test.ts
git commit -m "feat(image_search): implement aliyun responses API image search"
```

---

### Task 8: web_fetch.ts

**Files:**
- Create: `pi-web-tools/src/web_fetch.ts`
- Create: `pi-web-tools/tests/web_fetch.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// tests/web_fetch.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

let webFetch: typeof import("../src/web_fetch.js").webFetch;

beforeEach(async () => {
	vi.resetModules();
	mockFetch.mockReset();
	const mod = await import("../src/web_fetch.js");
	webFetch = mod.webFetch;
});

describe("webFetch", () => {
	it("fetches and returns content", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			status: 200,
			url: "https://example.com",
			headers: new Headers({ "content-type": "text/html" }),
			text: () => Promise.resolve("<html><body><h1>Hello</h1><p>World</p></body></html>"),
		});

		const result = await webFetch("https://example.com", "markdown", 30);
		expect(result.content).toContain("# Hello");
		expect(result.content).toContain("World");
	});

	it("converts HTML to plain text", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			status: 200,
			url: "https://example.com",
			headers: new Headers({ "content-type": "text/html" }),
			text: () => Promise.resolve("<html><body><p>Hello World</p></body></html>"),
		});

		const result = await webFetch("https://example.com", "text", 30);
		expect(result.content.trim()).toBe("Hello World");
	});

	it("returns raw HTML in html format", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			status: 200,
			url: "https://example.com",
			headers: new Headers({ "content-type": "text/html" }),
			text: () => Promise.resolve("<html>raw</html>"),
		});

		const result = await webFetch("https://example.com", "html", 30);
		expect(result.content).toContain("<html>");
	});

	it("formats JSON responses", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			status: 200,
			url: "https://api.example.com",
			headers: new Headers({ "content-type": "application/json" }),
			text: () => Promise.resolve('{"key":"value"}'),
		});

		const result = await webFetch("https://api.example.com", "text", 30);
		expect(result.content).toContain('"key"');
	});

	it("throws on non-2xx", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 404,
			text: () => Promise.resolve("Not Found"),
		});

		await expect(webFetch("https://example.com", "text", 30)).rejects.toThrow("404");
	});

	it("rejects invalid URLs", async () => {
		await expect(webFetch("not-a-url", "text", 30)).rejects.toThrow("Invalid URL");
	});

	it("truncates content over 100K characters", async () => {
		const longText = "a".repeat(150_000);
		mockFetch.mockResolvedValueOnce({
			ok: true,
			status: 200,
			url: "https://example.com",
			headers: new Headers({ "content-type": "text/plain" }),
			text: () => Promise.resolve(longText),
		});

		const result = await webFetch("https://example.com", "text", 30);
		expect(result.content.length).toBeLessThan(150_000);
		expect(result.content).toContain("truncated");
	});
});
```

- [ ] **Step 2: Run test to verify fail**

```bash
cd pi-web-tools && npx vitest run tests/web_fetch.test.ts 2>&1
```
Expected: FAIL

- [ ] **Step 3: Write web_fetch.ts**

```typescript
const MAX_CONTENT_CHARS = 100_000;

export interface FetchResult {
	content: string;
	contentType: string;
	url: string;
	status: number;
}

export async function webFetch(
	url: string,
	format: "text" | "markdown" | "html",
	timeout: number,
	signal?: AbortSignal,
): Promise<FetchResult> {
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(url);
	} catch {
		throw new Error(`Invalid URL: ${url}`);
	}

	if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
		throw new Error(`Unsupported protocol: ${parsedUrl.protocol}`);
	}

	const timeoutMs = Math.min(timeout * 1000, 120_000);
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const s = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

	const response = await fetch(url, {
		method: "GET",
		headers: {
			"User-Agent": "pi-web-tools/1.0",
			Accept: format === "html" ? "text/html" : "text/html, text/plain, application/json",
		},
		redirect: "follow",
		signal: s,
	});

	const contentType = response.headers.get("content-type") || "text/plain";
	const body = await response.text();

	if (!response.ok) {
		const truncated = body.slice(0, 500);
		throw new Error(`HTTP ${response.status} from ${url}${truncated ? `: ${truncated}` : ""}`);
	}

	let content: string;

	if (contentType.includes("application/json")) {
		try {
			content = JSON.stringify(JSON.parse(body), null, 2);
		} catch {
			content = body;
		}
	} else if (format === "html") {
		content = body;
	} else {
		content = htmlToText(body, format);
	}

	if (content.length > MAX_CONTENT_CHARS) {
		const truncated = content.slice(0, MAX_CONTENT_CHARS);
		content = `${truncated}\n\n... [truncated ${content.length - MAX_CONTENT_CHARS} characters]`;
	}

	return { content, contentType, url: response.url, status: response.status };
}

function htmlToText(html: string, format: "text" | "markdown"): string {
	let text = html;

	text = text.replace(/<head[\s\S]*?<\/head>/gi, "");
	text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
	text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
	text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");

	if (format === "markdown") {
		text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n\n# $1\n\n");
		text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n\n## $1\n\n");
		text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n\n### $1\n\n");
		text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n\n#### $1\n\n");
		text = text.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "\n\n##### $1\n\n");
		text = text.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "\n\n###### $1\n\n");
		text = text.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**");
		text = text.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, "**$1**");
		text = text.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "*$1*");
		text = text.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, "*$1*");
		text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
		text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n\n```\n$1\n```\n\n");
		text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
		text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");
		text = text.replace(/<p[^>]*>/gi, "\n\n");
	}

	text = text.replace(/<br\s*\/?>/gi, "\n");
	text = text.replace(/<[^>]+>/g, "");
	text = text.replace(/&amp;/g, "&");
	text = text.replace(/&lt;/g, "<");
	text = text.replace(/&gt;/g, ">");
	text = text.replace(/&quot;/g, '"');
	text = text.replace(/&#39;/g, "'");
	text = text.replace(/&nbsp;/g, " ");
	text = text.replace(/\n{3,}/g, "\n\n");
	text = text.replace(/[ \t]+/g, " ");
	text = text.trim();

	return text;
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd pi-web-tools && npx vitest run tests/web_fetch.test.ts 2>&1
```
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add pi-web-tools/src/web_fetch.ts pi-web-tools/tests/web_fetch.test.ts
git commit -m "feat(web_fetch): implement URL fetcher with HTML→MD conversion"
```

---

### Task 9: Main entry point index.ts

**Files:**
- Create: `pi-web-tools/index.ts`

- [ ] **Step 1: Write index.ts**

```typescript
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { search } from "./src/web_search/index";
import { deepSearch } from "./src/deep_search/index";
import { imageSearch } from "./src/image_search/index";
import { webFetch } from "./src/web_fetch";

export default function (pi: ExtensionAPI) {
	// -------------------------------------------------------------------
	// web_search
	// -------------------------------------------------------------------
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			`Search the web and return raw results (titles, URLs, snippets). Sources: Exa (REST/MCP) → DuckDuckGo (free, no key needed). ` +
			`Use "source" to pick a specific source. The current year is ${new Date().getFullYear()}.`,
		promptSnippet:
			"web_search: search the web via Exa → DuckDuckGo. Returns raw results with titles, URLs, snippets. LLM synthesizes the answer.",
		promptGuidelines: [
			"Use web_search when you need current information outside your training data.",
			"Synthesize a clear answer from the search results and cite sources with markdown hyperlinks.",
		],
		parameters: Type.Object({
			query: Type.String({ minLength: 2, description: "The search query." }),
			numResults: Type.Optional(
				Type.Number({ minimum: 1, maximum: 20, default: 10, description: "Number of results (1-20)." }),
			),
			source: Type.Optional(
				Type.String({ enum: ["exa", "duckduckgo"], description: "Specify source, or omit for auto-fallback." }),
			),
		}),
		renderCall(args, theme) {
			const p = args as { query: string };
			return new Text(
				theme.fg("toolTitle", theme.bold("web_search ")) + theme.fg("accent", `"${p.query || "..."}"`),
				0,
				0,
			);
		},
		renderResult(result, { expanded }, theme) {
			const text = result.content?.[0];
			const body = text?.type === "text" ? text.text : "";
			const lines = body.split("\n");
			if (!expanded) {
				const preview = lines.slice(0, 6);
				if (lines.length > 6)
					preview.push(theme.fg("dim", `... ${lines.length - 6} more lines · ctrl+o to expand`));
				return new Text(preview.join("\n"), 0, 0);
			}
			return new Text(body, 0, 0);
		},
		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const p = params as { query: string; numResults?: number; source?: string };
			const query = p.query?.trim();
			if (!query) {
				return { content: [{ type: "text", text: "Error: query is required." }], details: {}, isError: true };
			}

			onUpdate?.({ content: [{ type: "text", text: "Searching..." }], details: {} });

			let firstProgress = true;
			const onProgress = (msg: string) => {
				if (firstProgress) {
					onUpdate?.({ content: [{ type: "text", text: msg }], details: {} });
					firstProgress = false;
				}
			};

			try {
				const result = await search(query, p.numResults ?? 10, signal, onProgress, p.source);
				const sourceLabel = `\n\n*Source: ${result.sourceLabel}*`;
				return {
					content: [{ type: "text", text: result.answer + sourceLabel }],
					details: { source: result.sourceLabel, sources: result.sources },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: `Search failed: ${message}` }], details: {}, isError: true };
			}
		},
	});

	// -------------------------------------------------------------------
	// deep_search
	// -------------------------------------------------------------------
	pi.registerTool({
		name: "deep_search",
		label: "Deep Search",
		description:
			"Deep search powered by Aliyun (Bailian) using web_search + web_extractor. The model searches the web, extracts page content, and synthesizes a comprehensive answer with sources.",
		promptSnippet:
			"deep_search: Aliyun-powered deep search that synthesizes web results into a comprehensive answer with sources.",
		promptGuidelines: [
			"Use deep_search for complex research questions that benefit from multi-source synthesis.",
			"deep_search is powered by Aliyun. Configure ALIYUN_API_KEY or use /login in pi.",
		],
		parameters: Type.Object({
			query: Type.String({ minLength: 2, description: "The search query." }),
		}),
		renderCall(args, theme) {
			const p = args as { query: string };
			return new Text(
				theme.fg("toolTitle", theme.bold("deep_search ")) + theme.fg("accent", `"${p.query || "..."}"`),
				0,
				0,
			);
		},
		renderResult(result, { expanded }, theme) {
			const text = result.content?.[0];
			const body = text?.type === "text" ? text.text : "";
			const lines = body.split("\n");
			if (!expanded) {
				const preview = lines.slice(0, 6);
				if (lines.length > 6)
					preview.push(theme.fg("dim", `... ${lines.length - 6} more lines · ctrl+o to expand`));
				return new Text(preview.join("\n"), 0, 0);
			}
			return new Text(body, 0, 0);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
			const p = params as { query: string };
			const query = p.query?.trim();
			if (!query) {
				return { content: [{ type: "text", text: "Error: query is required." }], details: {}, isError: true };
			}

			onUpdate?.({ content: [{ type: "text", text: "Deep searching..." }], details: {} });

			try {
				const result = await deepSearch(query, signal, ctx);
				const sourcesText = result.sources.length
					? "\n\nSources:\n" + result.sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join("\n")
					: "";
				return {
					content: [{ type: "text", text: result.answer + sourcesText }],
					details: { sources: result.sources },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: `Deep search failed: ${message}` }], details: {}, isError: true };
			}
		},
	});

	// -------------------------------------------------------------------
	// image_search
	// -------------------------------------------------------------------
	pi.registerTool({
		name: "image_search",
		label: "Image Search",
		description:
			"Search for images by text description (文搜图) or find similar images by URL (图搜图). Powered by Aliyun (Bailian). Returns image results and model analysis.",
		promptSnippet:
			"image_search: search images by text or find similar images by URL. Powered by Aliyun (Bailian).",
		promptGuidelines: [
			"Use image_search to find images matching a text description (provide query).",
			"Use image_search to find visually similar images (provide imageUrl, the image must be a publicly accessible URL).",
			"Both query and imageUrl can be provided together for combined search.",
		],
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({ minLength: 2, description: "Text description of the image to search for." }),
			),
			imageUrl: Type.Optional(
				Type.String({ description: "Public URL of the image to find similar images." }),
			),
		}),
		renderCall(args, theme) {
			const p = args as { query?: string; imageUrl?: string };
			const label = theme.fg("toolTitle", theme.bold("image_search "));
			if (p.imageUrl) return new Text(label + theme.fg("accent", `[image: ${p.imageUrl}]`), 0, 0);
			return new Text(label + theme.fg("accent", `"${p.query || "..."}"`), 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const text = result.content?.[0];
			const body = text?.type === "text" ? text.text : "";
			const lines = body.split("\n");
			if (!expanded) {
				const preview = lines.slice(0, 6);
				if (lines.length > 6)
					preview.push(theme.fg("dim", `... ${lines.length - 6} more lines · ctrl+o to expand`));
				return new Text(preview.join("\n"), 0, 0);
			}
			return new Text(body, 0, 0);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
			const p = params as { query?: string; imageUrl?: string };
			if (!p.query && !p.imageUrl) {
				return {
					content: [{ type: "text", text: "Error: at least one of query or imageUrl is required." }],
					details: {},
					isError: true,
				};
			}

			onUpdate?.({ content: [{ type: "text", text: "Searching images..." }], details: {} });

			try {
				const result = await imageSearch({ query: p.query, imageUrl: p.imageUrl }, signal, ctx);
				const imagesText = result.images.length
					? "\n\nImages:\n" +
						result.images.map((img) => `${img.index}. [${img.title}](${img.url})`).join("\n")
					: "";
				return {
					content: [{ type: "text", text: result.answer + imagesText }],
					details: { images: result.images },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Image search failed: ${message}` }],
					details: {},
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------
	// web_fetch
	// -------------------------------------------------------------------
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description: "Fetch content from a URL and return as text, markdown, or raw HTML.",
		promptSnippet: "web_fetch: fetch content from a URL as text, markdown, or raw HTML.",
		promptGuidelines: [
			"Use web_fetch to retrieve full page content from a URL.",
			"Prefer fetching specific pages rather than homepages for more targeted information.",
		],
		parameters: Type.Object({
			url: Type.String({ minLength: 5, description: "The URL to fetch content from." }),
			format: Type.Optional(
				Type.String({
					enum: ["text", "markdown", "html"],
					default: "markdown",
					description: "Output format. Default: markdown.",
				}),
			),
			timeout: Type.Optional(
				Type.Number({
					minimum: 1,
					maximum: 120,
					default: 30,
					description: "Timeout in seconds (1-120). Default: 30.",
				}),
			),
		}),
		renderCall(args, theme) {
			const p = args as { url: string };
			return new Text(theme.fg("toolTitle", theme.bold("web_fetch ")) + theme.fg("accent", p.url || "..."), 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const text = result.content?.[0];
			const body = text?.type === "text" ? text.text : "";
			const lines = body.split("\n");
			if (!expanded) {
				const preview = lines.slice(0, 6);
				if (lines.length > 6)
					preview.push(theme.fg("dim", `... ${lines.length - 6} more lines · ctrl+o to expand`));
				return new Text(preview.join("\n"), 0, 0);
			}
			return new Text(body, 0, 0);
		},
		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const p = params as { url: string; format?: "text" | "markdown" | "html"; timeout?: number };
			const url = p.url?.trim();
			if (!url) {
				return { content: [{ type: "text", text: "Error: url is required." }], details: {}, isError: true };
			}
			const format = p.format || "markdown";
			const timeout = p.timeout ?? 30;

			onUpdate?.({ content: [{ type: "text", text: `Fetching ${url}...` }], details: {} });

			try {
				const result = await webFetch(url, format, timeout, signal);
				const header = `URL: ${result.url}\nContent-Type: ${result.contentType}\n\n`;
				return {
					content: [{ type: "text", text: header + result.content }],
					details: { url: result.url, contentType: result.contentType, status: result.status },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: `Fetch failed: ${message}` }], details: {}, isError: true };
			}
		},
	});
}
```

- [ ] **Step 2: Run typecheck**

```bash
cd pi-web-tools && npx tsc --noEmit 2>&1
```
Expected: no errors

- [ ] **Step 3: Run lint**

```bash
cd pi-web-tools && npx biome lint . 2>&1
```
Expected: no errors

- [ ] **Step 4: Run all tests**

```bash
cd pi-web-tools && npx vitest run 2>&1
```
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add pi-web-tools/index.ts
git commit -m "feat: register all 4 tools (web_search, deep_search, image_search, web_fetch)"
```
