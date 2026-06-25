# Pi Vision Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a new pi package `pi-vision-tools` that adds a `describe_image` tool letting non-multimodal models delegate image analysis to a vision-capable model, configurable via a `/vision` command with a footer 👁 indicator.

**Architecture:** A single pi extension exports a default factory. It registers (1) a `describe_image` tool that decodes an image (file path / data URL / raw base64), optionally compresses it via `sharp`, then calls the configured vision model through pi's own client (`complete()` from `@earendil-works/pi-ai/compat`) using auth resolved via `ctx.modelRegistry.getApiKeyAndHeaders()`; (2) a `/vision` command for configuration (`config provider/model`, `on`, `off`, status) persisted to `~/.pi/agent/vision-tools.json`; (3) lifecycle hooks (`session_start`, `model_select`) that auto-enable/disable the tool based on the calling model's modality and refresh a footer indicator. Pure logic (image decoding, config parsing/validation, reasoning mapping, compression decision) lives in focused, unit-tested modules; the `complete()` call is dependency-injected so the call path is testable without network.

**Tech Stack:** TypeScript (ESM, `moduleResolution: "bundler"`, tabs, double quotes), typebox (tool params), `@earendil-works/pi-ai/compat` (`complete`, content types), `@earendil-works/pi-coding-agent` (`ExtensionAPI`, `getAgentDir`), `@earendil-works/pi-tui` (`Text`), vitest, biome. Optional `sharp` via dynamic import for image compression.

## Global Constraints

- Package name: `@yandy0725/pi-vision-tools`, scoped under npm workspaces in this monorepo (`pi-packages`).
- `type: "module"`, ESM, local imports use `.js` extension (e.g. `./src/image.js`) per monorepo convention.
- Formatting: tabs, double quotes, trailing commas, semicolons, 120 line width (root `biome.json`).
- Tool param enums use `StringEnum` from `@earendil-works/pi-ai` (Google-compat). Other params use typebox `Type`.
- Model API calls reuse pi's client: `complete()` from `@earendil-works/pi-ai/compat`. Auth via `ctx.modelRegistry.getApiKeyAndHeaders(model)` → `{ ok: true, apiKey?, headers? } | { ok: false, error }`. NEVER hand-build fetch for standard APIs.
- Image content part shape: `{ type: "image", data: base64String, mimeType: "image/png" }` (NOT the `source`/`mediaType` shape shown in some doc snippets — verified against `@earendil-works/pi-ai` types).
- Config persisted to `getAgentDir() + "/vision-tools.json"` (≈ `~/.pi/agent/vision-tools.json`). Read/write via `node:fs/promises`.
- `sharp` is OPTIONAL: load via dynamic `import("sharp")`; if unavailable, send raw bytes. Never list `sharp` as a hard dependency.
- Compression env vars: `PI_VISION_MAX_DIM` (default `1568`), `PI_VISION_JPEG_QUALITY` (default `85`).
- Auto enable/disable: if the active model's `input` array contains `"image"`, the `describe_image` tool is disabled by default; otherwise enabled. `/vision on|off` is a manual override.
- Footer indicator 👁 shown via `ctx.ui.setStatus("pi-vision", ...)` when the tool is effectively enabled; cleared (`setStatus("pi-vision", undefined)`) when disabled.
- Reasoning levels: `off | minimal | low | medium | high | xhigh`. Map to `complete()` option `reasoningEffort` (`ThinkingLevel`, which excludes `"off"`). For `"off"`, omit `reasoningEffort` entirely.
- Tests: vitest, `tests/**/*.test.ts`, import src as `../src/x.js`. Pure-function modules are unit tested; `complete()` is injected for the call path.
- Peer dep: `@earendil-works/pi-coding-agent: ">=0.74.0"`. Runtime dep: `@earendil-works/pi-ai: "^0.80.2"` (matches `pi-coding-tools` monorepo convention). `sharp` NOT in dependencies.
- Release: tag `pi-vision-tools-vX.Y.Z`, GitHub Release triggers publish (see RELEASE.md, mirrors `pi-todo`).

## File Structure

```
pi-vision-tools/
├── index.ts                  # Extension factory: registers tool, command, lifecycle hooks; wires modules
├── package.json              # npm workspace package manifest
├── tsconfig.json             # extends ../tsconfig.base.json
├── vitest.config.ts          # includes tests/**/*.test.ts
├── RELEASE.md                # release process (mirrors pi-todo)
├── README.md                 # user-facing docs (condense from spec)
├── src/
│   ├── config.ts             # VisionConfig type, load/save/parse/validate, default config, merge
│   ├── image.ts              # decode image source (path/data-url/base64) → { data, mimeType }
│   ├── compress.ts           # optional sharp compression; returns raw bytes unchanged if no sharp
│   ├── reasoning.ts          # map reasoning level → complete() options
│   └── vision.ts             # resolveVisionModel() + callVision() — the complete() call path (DI)
└── tests/
    ├── config.test.ts
    ├── image.test.ts
    ├── compress.test.ts
    ├── reasoning.test.ts
    └── vision.test.ts
```

Module responsibilities:
- **config.ts** — owns the on-disk JSON shape (`{ provider?, model?, enabled?: "auto"|"on"|"off" }`), atomic-ish read/write, parse/validate, defaults, and a cached in-memory copy. No pi imports (pure).
- **image.ts** — pure decoding: classifies an `image_path` as file path / `data:` URL / raw base64, reads file or decodes base64, returns `{ data: Buffer, mimeType }`. No pi imports.
- **compress.ts** — decides whether to compress, dynamically imports `sharp`, applies resize/strip/convert. Pure env-var parsing + sharp. No pi imports.
- **reasoning.ts** — maps the tool's `reasoning` param to a `{ reasoningEffort?: ThinkingLevel }` option object. Pure.
- **vision.ts** — `resolveVisionModel(registry, config)`: finds model, checks `input` includes `"image"`, returns `{ model } | { error }`. `callVision({ model, auth, messages, reasoning, signal, complete })`: builds `Context`, calls injected `complete()`, extracts text. Pure-ish (DI for `complete`).
- **index.ts** — glue: loads config on `session_start`, registers tool (calls image→compress→vision), registers `/vision` command (subcommands), handles `model_select` for auto-enable + footer, manages `pi.setActiveTools`.

---

### Task 1: Scaffold the package

**Files:**
- Create: `pi-vision-tools/package.json`
- Create: `pi-vision-tools/tsconfig.json`
- Create: `pi-vision-tools/vitest.config.ts`
- Create: `pi-vision-tools/index.ts` (minimal stub)
- Create: `pi-vision-tools/.gitignore`
- Modify: `package.json` (root, add workspace)
- Modify: `vitest.config.ts` (root, add project)
- Modify: `README.md` (root, add row to packages table)

**Interfaces:**
- Produces: a buildable, installable workspace package whose default export is a no-op extension factory, so `npm ci`, `npm run typecheck`, and `npm test` stay green.

- [ ] **Step 1: Create `pi-vision-tools/package.json`**

```json
{
	"name": "@yandy0725/pi-vision-tools",
	"publishConfig": {
		"access": "public"
	},
	"version": "0.1.0",
	"description": "pi package adding a describe_image tool that lets non-multimodal models delegate image analysis to a vision model",
	"license": "MIT",
	"repository": {
		"type": "git",
		"url": "https://github.com/yandy/pi-packages",
		"directory": "pi-vision-tools"
	},
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
	"pi": {
		"extensions": ["./index.ts"]
	},
	"peerDependencies": {
		"@earendil-works/pi-coding-agent": ">=0.74.0"
	},
	"dependencies": {
		"@earendil-works/pi-ai": "^0.80.2"
	},
	"devDependencies": {
		"@earendil-works/pi-tui": "^0.79.9",
		"typebox": "^1.1.38"
	}
}
```

- [ ] **Step 2: Create `pi-vision-tools/tsconfig.json`**

```json
{
	"extends": "../tsconfig.base.json",
	"include": ["index.ts", "src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 3: Create `pi-vision-tools/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
	},
});
```

- [ ] **Step 4: Create `pi-vision-tools/.gitignore`**

```
node_modules/
.opencode/
*.log
.DS_Store
.worktrees/
```

- [ ] **Step 5: Create minimal `pi-vision-tools/index.ts` stub**

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// Implemented in later tasks.
	void pi;
}
```

- [ ] **Step 6: Add workspace to root `package.json`**

In `package.json`, append `"pi-vision-tools"` to the `workspaces` array (after `"pi-todo"`):

```json
	"workspaces": [
		"pi-coding-tools",
		"pi-container-sandbox",
		"pi-web-tools",
		"pi-todo",
		"pi-vision-tools"
	],
```

- [ ] **Step 7: Add project to root `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: ["pi-coding-tools", "pi-container-sandbox", "pi-web-tools", "pi-todo", "pi-vision-tools"],
	},
});
```

- [ ] **Step 8: Add a row to root `README.md` packages table**

Insert after the `pi-todo` row:

```markdown
| [pi-vision-tools](./pi-vision-tools) | `describe_image` tool — delegate image analysis to a vision model | `@yandy0725/pi-vision-tools` |
```

- [ ] **Step 9: Install and verify**

Run: `npm ci`
Expected: workspace links `pi-vision-tools`, installs `@earendil-works/pi-ai` into it.

Run: `npm run typecheck`
Expected: PASS (no errors).

Run: `npm test`
Expected: PASS (no tests yet → vitest reports 0 tests, exit 0).

Run: `npm run check`
Expected: PASS (biome clean; stub has no lint errors).

- [ ] **Step 10: Commit**

```bash
git add pi-vision-tools package.json package-lock.json vitest.config.ts README.md
git commit -m "feat(pi-vision-tools): scaffold package"
```

---

### Task 2: Config module (type, defaults, parse, load, save)

**Files:**
- Create: `pi-vision-tools/src/config.ts`
- Test: `pi-vision-tools/tests/config.test.ts`

**Interfaces:**
- Produces:
  - `export type VisionEnabledState = "auto" | "on" | "off"`
  - `export interface VisionConfig { provider?: string; model?: string; enabled: VisionEnabledState; defaultReasoning?: ThinkingLevel | "off"; }`
  - `export const DEFAULT_CONFIG: VisionConfig` → `{ enabled: "auto" }`
  - `export function parseConfig(raw: unknown): VisionConfig` — validates + merges defaults; throws on invalid types.
  - `export function configPath(agentDir: string): string` — returns `${agentDir}/vision-tools.json`.
  - `export async function loadConfig(agentDir: string, _fs?: typeof import("node:fs/promises")): Promise<VisionConfig>` — reads file, returns parsed config or `DEFAULT_CONFIG` if missing/corrupt.
  - `export async function saveConfig(agentDir: string, config: VisionConfig, _fs?: typeof import("node:fs/promises")): Promise<void>` — mkdir -p agentDir, atomic write (temp + rename).
- Consumes: `ThinkingLevel` from `@earendil-works/pi-ai`.

- [ ] **Step 1: Write the failing test `tests/config.test.ts`**

```ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_CONFIG,
	configPath,
	loadConfig,
	parseConfig,
	saveConfig,
	type VisionConfig,
} from "../src/config.js";

describe("parseConfig", () => {
	it("returns DEFAULT_CONFIG for null/undefined/empty object", () => {
		expect(parseConfig(null)).toEqual(DEFAULT_CONFIG);
		expect(parseConfig(undefined)).toEqual(DEFAULT_CONFIG);
		expect(parseConfig({})).toEqual(DEFAULT_CONFIG);
	});

	it("accepts a fully valid config", () => {
		const raw = { provider: "openai", model: "gpt-4o", enabled: "on", defaultReasoning: "high" };
		expect(parseConfig(raw)).toEqual(raw);
	});

	it("defaults enabled to 'auto' when omitted", () => {
		expect(parseConfig({ provider: "openai", model: "gpt-4o" })).toEqual({
			provider: "openai",
			model: "gpt-4o",
			enabled: "auto",
		});
	});

	it("rejects an invalid enabled value", () => {
		expect(() => parseConfig({ enabled: "maybe" })).toThrow(/enabled/);
	});

	it("rejects a non-string provider", () => {
		expect(() => parseConfig({ provider: 123 })).toThrow(/provider/);
	});

	it("rejects a non-string model", () => {
		expect(() => parseConfig({ model: false })).toThrow(/model/);
	});

	it("rejects an invalid defaultReasoning", () => {
		expect(() => parseConfig({ defaultReasoning: "ultra" })).toThrow(/defaultReasoning/);
	});

	it("strips unknown keys", () => {
		expect(parseConfig({ provider: "x", extra: 1 })).toEqual({ provider: "x", enabled: "auto" });
	});
});

describe("configPath", () => {
	it("joins agentDir with vision-tools.json", () => {
		expect(configPath("/home/u/.pi/agent")).toBe("/home/u/.pi/agent/vision-tools.json");
	});
});

describe("loadConfig / saveConfig (filesystem)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "vision-cfg-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("returns DEFAULT_CONFIG when the file does not exist", async () => {
		expect(await loadConfig(dir)).toEqual(DEFAULT_CONFIG);
	});

	it("returns DEFAULT_CONFIG when the file is corrupt JSON", async () => {
		await writeFile(configPath(dir), "{ not json");
		expect(await loadConfig(dir)).toEqual(DEFAULT_CONFIG);
	});

	it("round-trips a config through save then load", async () => {
		const cfg: VisionConfig = { provider: "openai", model: "gpt-4o", enabled: "off", defaultReasoning: "low" };
		await saveConfig(dir, cfg);
		expect(await loadConfig(dir)).toEqual(cfg);
	});

	it("write is not pretty / is valid JSON", async () => {
		await saveConfig(dir, { provider: "p", model: "m", enabled: "auto" });
		const raw = await readFile(configPath(dir), "utf8");
		expect(JSON.parse(raw)).toEqual({ provider: "p", model: "m", enabled: "auto" });
	});

	it("saveConfig creates the agent dir if missing", async () => {
		const nested = join(dir, "deep", "agent");
		await saveConfig(nested, DEFAULT_CONFIG);
		expect(await loadConfig(nested)).toEqual(DEFAULT_CONFIG);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pi-vision-tools && npx vitest run tests/config.test.ts`
Expected: FAIL — `Cannot find module '../src/config.js'`.

- [ ] **Step 3: Implement `src/config.ts`**

```ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-ai";

export type VisionEnabledState = "auto" | "on" | "off";

export interface VisionConfig {
	provider?: string;
	model?: string;
	enabled: VisionEnabledState;
	defaultReasoning?: ThinkingLevel | "off";
}

export const DEFAULT_CONFIG: VisionConfig = { enabled: "auto" };

const ENABLED_STATES = ["auto", "on", "off"] as const;
const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export function configPath(agentDir: string): string {
	return join(agentDir, "vision-tools.json");
}

export function parseConfig(raw: unknown): VisionConfig {
	if (raw == null || typeof raw !== "object") return { ...DEFAULT_CONFIG };
	const obj = raw as Record<string, unknown>;

	const cfg: VisionConfig = { enabled: "auto" };

	if (obj.provider !== undefined) {
		if (typeof obj.provider !== "string" || obj.provider.length === 0) {
			throw new Error("vision-tools config: provider must be a non-empty string");
		}
		cfg.provider = obj.provider;
	}

	if (obj.model !== undefined) {
		if (typeof obj.model !== "string" || obj.model.length === 0) {
			throw new Error("vision-tools config: model must be a non-empty string");
		}
		cfg.model = obj.model;
	}

	if (obj.enabled !== undefined) {
		if (typeof obj.enabled !== "string" || !ENABLED_STATES.includes(obj.enabled as VisionEnabledState)) {
			throw new Error(`vision-tools config: enabled must be one of ${ENABLED_STATES.join(", ")}`);
		}
		cfg.enabled = obj.enabled as VisionEnabledState;
	}

	if (obj.defaultReasoning !== undefined) {
		if (
			typeof obj.defaultReasoning !== "string" ||
			!REASONING_LEVELS.includes(obj.defaultReasoning as (typeof REASONING_LEVELS)[number])
		) {
			throw new Error(`vision-tools config: defaultReasoning must be one of ${REASONING_LEVELS.join(", ")}`);
		}
		cfg.defaultReasoning = obj.defaultReasoning as ThinkingLevel | "off";
	}

	return cfg;
}

export async function loadConfig(
	agentDir: string,
): Promise<VisionConfig> {
	try {
		const text = await readFile(configPath(agentDir), "utf8");
		return parseConfig(JSON.parse(text));
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

export async function saveConfig(agentDir: string, config: VisionConfig): Promise<void> {
	await mkdir(agentDir, { recursive: true });
	const text = JSON.stringify(config);
	const target = configPath(agentDir);
	const tmp = `${target}.tmp`;
	await writeFile(tmp, text, "utf8");
	await rename(tmp, target);
}
```

> Note: `_fs` injection was dropped from the signature — the test uses a real tmpdir instead (matches `web_fetch`-style filesystem testing). If you prefer DI, keep an optional `_readFile`/`_writeFile`; the test above does not require it.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pi-vision-tools && npx vitest run tests/config.test.ts`
Expected: PASS (all assertions green).

- [ ] **Step 5: Commit**

```bash
git add pi-vision-tools/src/config.ts pi-vision-tools/tests/config.test.ts
git commit -m "feat(pi-vision-tools): config module with load/save/parse"
```

---

### Task 3: Image decoding module

**Files:**
- Create: `pi-vision-tools/src/image.ts`
- Test: `pi-vision-tools/tests/image.test.ts`

**Interfaces:**
- Produces:
  - `export interface DecodedImage { data: Buffer; mimeType: string; }`
  - `export interface ImageReadOptions { readFile?: (path: string) => Promise<Buffer>; }`
  - `export async function decodeImage(imagePath: string, opts?: ImageReadOptions): Promise<DecodedImage>` — classify + decode. Throws `Error` with a clear message for unsupported protocol / unreadable file / too-short base64.
- Consumes: `node:fs/promises` `readFile`.

Behavior rules (from spec "Image formats"):
- String starting with `data:` → parse data URL `data:<mime>;base64,<data>`. Validate mime + that payload is base64.
- String starting with `/`, `./`, `../`, `~`, or matching a path-like shape (contains a slash or dot-extension) AND length ≤ 100 → treat as file path; read file; infer mime from extension.
- Otherwise, if length > 100 → treat as raw base64; default mime to `image/png` if extension inference is impossible? **Spec says raw base64 is "a base64-encoded string over 100 characters"** and supported formats include PNG/JPEG/GIF/WebP/BMP. For raw base64 we cannot know the mime; default to `image/png` (callers/models usually tolerate this; sharp compression later re-encodes to JPEG anyway).
- Supported mime types: `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/bmp`.

- [ ] **Step 1: Write the failing test `tests/image.test.ts`**

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeImage } from "../src/image.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

describe("decodeImage — data URL", () => {
	it("decodes a base64 data URL", async () => {
		const b64 = PNG_MAGIC.toString("base64");
		const img = await decodeImage(`data:image/png;base64,${b64}`);
		expect(img.mimeType).toBe("image/png");
		expect(img.data).toEqual(PNG_MAGIC);
	});

	it("decodes a jpeg data URL", async () => {
		const b64 = JPEG_MAGIC.toString("base64");
		const img = await decodeImage(`data:image/jpeg;base64,${b64}`);
		expect(img.mimeType).toBe("image/jpeg");
		expect(img.data).toEqual(JPEG_MAGIC);
	});

	it("rejects a non-image data URL mime", async () => {
		await expect(decodeImage("data:text/plain;base64,aGVsbG8=")).rejects.toThrow(/mime|unsupported/i);
	});
});

describe("decodeImage — file path", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "vision-img-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("reads a png file and infers mime", async () => {
		const p = join(dir, "shot.png");
		await writeFile(p, PNG_MAGIC);
		const img = await decodeImage(p);
		expect(img.mimeType).toBe("image/png");
		expect(img.data).toEqual(PNG_MAGIC);
	});

	it("reads a jpeg file and infers mime", async () => {
		const p = join(dir, "photo.jpg");
		await writeFile(p, JPEG_MAGIC);
		const img = await decodeImage(p);
		expect(img.mimeType).toBe("image/jpeg");
	});

	it("rejects an unsupported extension", async () => {
		const p = join(dir, "x.txt");
		await writeFile(p, Buffer.from("nope"));
		await expect(decodeImage(p)).rejects.toThrow(/unsupported|mime/i);
	});

	it("rejects a missing file", async () => {
		await expect(decodeImage(join(dir, "nope.png"))).rejects.toThrow(/read|not found|no such/i);
	});
});

describe("decodeImage — raw base64", () => {
	it("decodes a long base64 string as image/png", async () => {
		const b64 = Buffer.concat([PNG_MAGIC, Buffer.alloc(200, 0)]).toString("base64");
		expect(b64.length).toBeGreaterThan(100);
		const img = await decodeImage(b64);
		expect(img.mimeType).toBe("image/png");
		expect(img.data.length).toBe(PNG_MAGIC.length + 200);
	});

	it("rejects a short string that is neither path nor data url", async () => {
		await expect(decodeImage("abc")).rejects.toThrow(/base64|path|unsupported/i);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pi-vision-tools && npx vitest run tests/image.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/image.ts`**

```ts
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

export interface DecodedImage {
	data: Buffer;
	mimeType: string;
}

export interface ImageReadOptions {
	readFile?: (path: string) => Promise<Buffer>;
}

const EXT_TO_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
};

const SUPPORTED_MIMES = new Set(Object.values(EXT_TO_MIME));

const DATA_URL_RE = /^data:([^;]+)?;base64,(.*)$/s;

function looksLikePath(s: string): boolean {
	if (s.startsWith("/")) return true;
	if (s.startsWith("./") || s.startsWith("../")) return true;
	if (s.startsWith("~")) return true;
	// has a dot-extension and is short enough not to be base64
	const ext = extname(s).toLowerCase();
	if (ext && EXT_TO_MIME[ext] && s.length <= 100) return true;
	return false;
}

export async function decodeImage(imagePath: string, opts?: ImageReadOptions): Promise<DecodedImage> {
	const src = imagePath?.trim();
	if (!src) throw new Error("image_path is required");

	// 1. data URL
	const m = DATA_URL_RE.exec(src);
	if (m) {
		const mime = (m[1] || "").toLowerCase();
		if (!SUPPORTED_MIMES.has(mime)) {
			throw new Error(`Unsupported image mime type: ${mime || "(missing)"}`);
		}
		const data = Buffer.from(m[2], "base64");
		if (data.length === 0) throw new Error("Empty image data in data URL");
		return { data, mimeType: mime };
	}

	// 2. file path
	if (looksLikePath(src)) {
		const ext = extname(src).toLowerCase();
		const mime = EXT_TO_MIME[ext];
		if (!mime) throw new Error(`Unsupported image extension: ${ext || "(none)"}`);
		const read = opts?.readFile ?? readFile;
		let data: Buffer;
		try {
			data = await read(src);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			throw new Error(`Failed to read image file ${src}: ${msg}`);
		}
		if (data.length === 0) throw new Error(`Empty image file: ${src}`);
		return { data, mimeType: mime };
	}

	// 3. raw base64 (>100 chars)
	if (src.length > 100) {
		const data = Buffer.from(src, "base64");
		if (data.length === 0) throw new Error("Invalid base64 image data");
		return { data, mimeType: "image/png" };
	}

	throw new Error("image_path must be a file path, a data: URL, or raw base64 (>100 chars)");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pi-vision-tools && npx vitest run tests/image.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pi-vision-tools/src/image.ts pi-vision-tools/tests/image.test.ts
git commit -m "feat(pi-vision-tools): image decoding (path/data-url/base64)"
```

---

### Task 4: Reasoning mapping module

**Files:**
- Create: `pi-vision-tools/src/reasoning.ts`
- Test: `pi-vision-tools/tests/reasoning.test.ts`

**Interfaces:**
- Produces:
  - `export type VisionReasoning = "off" | "minimal" | "low" | "medium" | "high" | "xhigh"`
  - `export function reasoningToOptions(level: VisionReasoning | undefined): { reasoningEffort?: import("@earendil-works/pi-ai").ThinkingLevel }` — returns `{}` for `undefined` or `"off"`; `{ reasoningEffort: level }` otherwise.

- [ ] **Step 1: Write the failing test `tests/reasoning.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { reasoningToOptions, type VisionReasoning } from "../src/reasoning.js";

describe("reasoningToOptions", () => {
	it("returns empty object for undefined", () => {
		expect(reasoningToOptions(undefined)).toEqual({});
	});

	it("returns empty object for 'off'", () => {
		expect(reasoningToOptions("off")).toEqual({});
	});

	const levels: VisionReasoning[] = ["minimal", "low", "medium", "high", "xhigh"];
	for (const lvl of levels) {
		it(`maps '${lvl}' to { reasoningEffort: '${lvl}' }`, () => {
			expect(reasoningToOptions(lvl)).toEqual({ reasoningEffort: lvl });
		});
	}
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pi-vision-tools && npx vitest run tests/reasoning.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/reasoning.ts`**

```ts
import type { ThinkingLevel } from "@earendil-works/pi-ai";

export type VisionReasoning = "off" | ThinkingLevel;

export interface ReasoningOptions {
	reasoningEffort?: ThinkingLevel;
}

export function reasoningToOptions(level: VisionReasoning | undefined): ReasoningOptions {
	if (!level || level === "off") return {};
	return { reasoningEffort: level };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pi-vision-tools && npx vitest run tests/reasoning.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pi-vision-tools/src/reasoning.ts pi-vision-tools/tests/reasoning.test.ts
git commit -m "feat(pi-vision-tools): reasoning level mapping"
```

---

### Task 5: Compression module (optional sharp)

**Files:**
- Create: `pi-vision-tools/src/compress.ts`
- Test: `pi-vision-tools/tests/compress.test.ts`

**Interfaces:**
- Produces:
  - `export interface CompressionSettings { maxDim: number; jpegQuality: number; }`
  - `export function readCompressionSettings(env?: NodeJS.ProcessEnv): CompressionSettings` — reads `PI_VISION_MAX_DIM` (default 1568) and `PI_VISION_JPEG_QUALITY` (default 85), clamps.
  - `export async function compressImage(image: DecodedImage, settings: CompressionSettings, _sharpLoader?: () => Promise<unknown>): Promise<DecodedImage>` — when `compress` is requested: dynamically import sharp (or use injected loader); if unavailable, return image unchanged; else resize to maxDim, strip alpha, convert to JPEG quality. Returns a `DecodedImage` with `mimeType: "image/jpeg"`.
- Consumes: `DecodedImage` from `./image.js`.

Behavior (from spec "Compression controls" + "How it works"):
- Resize so the longest dimension ≤ `maxDim` (only downscale, never upscale).
- Strip alpha channel (RGBA → RGB).
- Convert lossless PNG → JPEG quality `jpegQuality`. (We convert all compressed output to JPEG per spec example.)
- On any sharp error, fall back to the original image unchanged (best effort).

- [ ] **Step 1: Write the failing test `tests/compress.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { compressImage, readCompressionSettings, type CompressionSettings } from "../src/compress.js";
import type { DecodedImage } from "../src/image.js";

describe("readCompressionSettings", () => {
	it("uses defaults when env unset", () => {
		expect(readCompressionSettings({})).toEqual({ maxDim: 1568, jpegQuality: 85 });
	});

	it("reads custom values", () => {
		expect(readCompressionSettings({ PI_VISION_MAX_DIM: "800", PI_VISION_JPEG_QUALITY: "70" })).toEqual({
			maxDim: 800,
			jpegQuality: 70,
		});
	});

	it("clamps invalid values back to defaults", () => {
		expect(readCompressionSettings({ PI_VISION_MAX_DIM: "0", PI_VISION_JPEG_QUALITY: "999" })).toEqual({
			maxDim: 1568,
			jpegQuality: 85,
		});
	});

	it("clamps quality to [1,100]", () => {
		expect(readCompressionSettings({ PI_VISION_JPEG_QUALITY: "0" }).jpegQuality).toBe(85);
		expect(readCompressionSettings({ PI_VISION_JPEG_QUALITY: "50" }).jpegQuality).toBe(50);
	});
});

describe("compressImage", () => {
	const png: DecodedImage = { data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mimeType: "image/png" };

	it("returns the image unchanged when sharp loader resolves to null (sharp not installed)", async () => {
		const out = await compressImage(png, { maxDim: 1568, jpegQuality: 85 }, async () => null);
		expect(out).toBe(png);
	});

	it("returns the image unchanged when the loader throws", async () => {
		const out = await compressImage(
			png,
			{ maxDim: 1568, jpegQuality: 85 },
			async () => {
				throw new Error("Cannot find module 'sharp'");
			},
		);
		expect(out).toBe(png);
	});

	it("uses a fake sharp pipeline to produce a jpeg DecodedImage", async () => {
		const fakeSharp = {
			resize: function () {
				return this;
			},
			removeAlpha: function () {
				return this;
			},
			jpeg: function () {
				return this;
			},
			toBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
		};
		const out = await compressImage(png, { maxDim: 100, jpegQuality: 80 }, async () => ({
			default: (data: Buffer) => fakeSharp,
		}));
		expect(out.mimeType).toBe("image/jpeg");
		expect(out.data.length).toBeGreaterThan(0);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pi-vision-tools && npx vitest run tests/compress.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/compress.ts`**

```ts
import type { DecodedImage } from "./image.js";

export interface CompressionSettings {
	maxDim: number;
	jpegQuality: number;
}

const DEFAULT_MAX_DIM = 1568;
const DEFAULT_JPEG_QUALITY = 85;

function parseIntOrDefault(v: string | undefined, dflt: number, min: number, max: number): number {
	if (v == null) return dflt;
	const n = Number.parseInt(v, 10);
	if (!Number.isFinite(n) || n < min || n > max) return dflt;
	return n;
}

export function readCompressionSettings(env: NodeJS.ProcessEnv = process.env): CompressionSettings {
	return {
		maxDim: parseIntOrDefault(env.PI_VISION_MAX_DIM, DEFAULT_MAX_DIM, 1, 10_000),
		jpegQuality: parseIntOrDefault(env.PI_VISION_JPEG_QUALITY, DEFAULT_JPEG_QUALITY, 1, 100),
	};
}

// Minimal structural type for the bits of sharp we use.
interface SharpPipeline {
	resize(opts: { width?: number; height?: number; withoutEnlargement: boolean; fit: string }): SharpPipeline;
	removeAlpha(): SharpPipeline;
	jpeg(opts: { quality: number }): SharpPipeline;
	toBuffer(): Promise<Buffer>;
}
type SharpModule = (data: Buffer) => SharpPipeline;

const defaultSharpLoader = async (): Promise<SharpModule | null> => {
	try {
		const mod = (await import("sharp")) as { default?: SharpModule } & SharpModule;
		return mod.default ?? (mod as unknown as SharpModule);
	} catch {
		return null;
	}
};

export async function compressImage(
	image: DecodedImage,
	settings: CompressionSettings,
	_sharpLoader: () => Promise<SharpModule | null> = defaultSharpLoader,
): Promise<DecodedImage> {
	const getSharp = typeof _sharpLoader === "function" ? _sharpLoader : defaultSharpLoader;
	let sharp: SharpModule | null;
	try {
		sharp = await getSharp();
	} catch {
		return image;
	}
	if (!sharp) return image;

	try {
		const buf = await sharp(image.data)
			.resize({ width: settings.maxDim, height: settings.maxDim, withoutEnlargement: true, fit: "inside" })
			.removeAlpha()
			.jpeg({ quality: settings.jpegQuality })
			.toBuffer();
		return { data: buf, mimeType: "image/jpeg" };
	} catch {
		return image;
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pi-vision-tools && npx vitest run tests/compress.test.ts`
Expected: PASS.

> If the fake-sharp test is flaky due to `this` binding, adjust the fake to return concrete objects (the implementation uses `return this;` chaining; the test's `function () { return this; }` works because `sharp(image.data)` returns the pipeline object and methods return `this`). If the third test fails on binding, rewrite the fake methods to return a captured `pipeline` const instead.

- [ ] **Step 5: Commit**

```bash
git add pi-vision-tools/src/compress.ts pi-vision-tools/tests/compress.test.ts
git commit -m "feat(pi-vision-tools): optional sharp compression"
```

---

### Task 6: Vision call path (resolve model + call complete with DI)

**Files:**
- Create: `pi-vision-tools/src/vision.ts`
- Test: `pi-vision-tools/tests/vision.test.ts`

**Interfaces:**
- Consumes:
  - `VisionConfig` from `./config.js`
  - `DecodedImage` from `./image.js`
  - `ReasoningOptions` from `./reasoning.js`
  - `ModelRegistry`, `Model`, `ResolvedRequestAuth`, `complete`, `UserMessage`, `Context`, `AssistantMessage` types
- Produces:
  - `export interface VisionCallInput { model: Model<any>; auth: { apiKey?: string; headers?: Record<string,string> }; prompt: string; images: DecodedImage[]; reasoning: ReasoningOptions; signal?: AbortSignal; }`
  - `export interface VisionCallResult { text: string; usage?: { input?: number; output?: number }; errorMessage?: string; stopReason?: string; }`
  - `export interface ResolveResult { ok: true; model: Model<any> } | { ok: false; error: string }`
  - `export function resolveVisionModel(registry: { find(provider: string, id: string): Model<any> | undefined }, config: VisionConfig): ResolveResult` — returns error string if provider/model missing or model lacks image input.
  - `export async function callVision(input: VisionCallInput, completeFn: CompleteFn): Promise<VisionCallResult>` — builds a single user message with text + image parts, calls `completeFn(model, context, options)`, extracts text. On thrown error returns `{ text: "", errorMessage }`.
  - `export type CompleteFn = (model: Model<any>, context: Context, options?: Record<string, unknown>) => Promise<AssistantMessage>`

- [ ] **Step 1: Write the failing test `tests/vision.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { callVision, resolveVisionModel, type CompleteFn } from "../src/vision.js";
import type { VisionConfig } from "../src/config.js";
import type { DecodedImage } from "../src/image.js";

const fakeModel = (input: string[]) =>
	({ id: "m", name: "m", api: "openai-completions", provider: "p", baseUrl: "https://x", reasoning: false, input, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 1000 }) as any;

describe("resolveVisionModel", () => {
	const registry = {
		find: (provider: string, id: string) =>
			provider === "openai" && id === "gpt-4o" ? fakeModel(["text", "image"]) : undefined,
	};

	it("resolves a configured vision model", () => {
		const cfg: VisionConfig = { provider: "openai", model: "gpt-4o", enabled: "auto" };
		const r = resolveVisionModel(registry, cfg);
		expect(r.ok).toBe(true);
	});

	it("errors when provider/model not configured", () => {
		const r = resolveVisionModel(registry, { enabled: "auto" });
		expect(r.ok).toBe(false);
		expect((r as { error: string }).error).toMatch(/not configured/i);
	});

	it("errors when model not found in registry", () => {
		const r = resolveVisionModel(registry, { provider: "openai", model: "nope", enabled: "auto" });
		expect(r.ok).toBe(false);
		expect((r as { error: string }).error).toMatch(/not found/i);
	});

	it("errors when the model lacks image input", () => {
		const reg = { find: () => fakeModel(["text"]) };
		const r = resolveVisionModel(reg, { provider: "openai", model: "text-only", enabled: "auto" });
		expect(r.ok).toBe(false);
		expect((r as { error: string }).error).toMatch(/vision|image/i);
	});
});

describe("callVision", () => {
	const model = fakeModel(["text", "image"]);
	const img: DecodedImage = { data: Buffer.from([1, 2, 3]), mimeType: "image/png" };

	it("builds a message with text + image parts and returns extracted text", async () => {
		const completeFn: CompleteFn = async (_m, context, _opts) => {
			const msg = (context as any).messages[0];
			expect(msg.content[0]).toEqual({ type: "text", text: "describe" });
			expect(msg.content[1]).toEqual({ type: "image", data: "AQID", mimeType: "image/png" });
			return {
				role: "assistant",
				content: [{ type: "text", text: "it is red" }],
				api: "openai-completions",
				provider: "p",
				model: "m",
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
				stopReason: "stop",
				timestamp: 0,
			} as any;
		};

		const out = await callVision(
			{ model, auth: { apiKey: "k" }, prompt: "describe", images: [img], reasoning: {} },
			completeFn,
		);
		expect(out.text).toBe("it is red");
		expect(out.usage?.input).toBe(10);
		expect(out.errorMessage).toBeUndefined();
	});

	it("passes reasoningEffort through when provided", async () => {
		let receivedOpts: any;
		const completeFn: CompleteFn = async (_m, _c, opts) => {
			receivedOpts = opts;
			return { role: "assistant", content: [{ type: "text", text: "x" }], api: "openai-completions", provider: "p", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop", timestamp: 0 } as any;
		};
		await callVision({ model, auth: { apiKey: "k" }, prompt: "p", images: [img], reasoning: { reasoningEffort: "high" } }, completeFn);
		expect(receivedOpts.reasoningEffort).toBe("high");
	});

	it("returns errorMessage when completeFn throws", async () => {
		const completeFn: CompleteFn = async () => {
			throw new Error("boom");
		};
		const out = await callVision({ model, auth: { apiKey: "k" }, prompt: "p", images: [img], reasoning: {} }, completeFn);
		expect(out.text).toBe("");
		expect(out.errorMessage).toMatch(/boom/);
	});

	it("concatenates multiple text content parts", async () => {
		const completeFn: CompleteFn = async () =>
			({ role: "assistant", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }], api: "openai-completions", provider: "p", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop", timestamp: 0 }) as any;
		const out = await callVision({ model, auth: { apiKey: "k" }, prompt: "p", images: [img], reasoning: {} }, completeFn);
		expect(out.text).toBe("a\nb");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pi-vision-tools && npx vitest run tests/vision.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/vision.ts`**

```ts
import type { AssistantMessage, Context, Model, UserMessage } from "@earendil-works/pi-ai";
import type { VisionConfig } from "./config.js";
import type { DecodedImage } from "./image.js";
import type { ReasoningOptions } from "./reasoning.js";

export type CompleteFn = (
	model: Model<any>,
	context: Context,
	options?: Record<string, unknown>,
) => Promise<AssistantMessage>;

export interface VisionCallInput {
	model: Model<any>;
	auth: { apiKey?: string; headers?: Record<string, string> };
	prompt: string;
	images: DecodedImage[];
	reasoning: ReasoningOptions;
	signal?: AbortSignal;
}

export interface VisionCallResult {
	text: string;
	usage?: { input?: number; output?: number };
	errorMessage?: string;
	stopReason?: string;
}

export type ResolveResult = { ok: true; model: Model<any> } | { ok: false; error: string };

interface ModelLookup {
	find(provider: string, id: string): Model<any> | undefined;
}

export function resolveVisionModel(registry: ModelLookup, config: VisionConfig): ResolveResult {
	if (!config.provider || !config.model) {
		return { ok: false, error: "Vision model not configured. Run: /vision config provider <p> ; /vision config model <m>" };
	}
	const model = registry.find(config.provider, config.model);
	if (!model) {
		return { ok: false, error: `Vision model not found: ${config.provider}/${config.model}` };
	}
	if (!Array.isArray(model.input) || !model.input.includes("image")) {
		return { ok: false, error: `Model ${config.provider}/${config.model} does not support image input` };
	}
	return { ok: true, model };
}

export async function callVision(input: VisionCallInput, completeFn: CompleteFn): Promise<VisionCallResult> {
	const userMessage: UserMessage = {
		role: "user",
		content: [
			{ type: "text", text: input.prompt },
			...input.images.map((img) => ({
				type: "image" as const,
				data: img.data.toString("base64"),
				mimeType: img.mimeType,
			})),
		],
		timestamp: Date.now(),
	};

	const context: Context = { messages: [userMessage] };

	const options: Record<string, unknown> = {
		apiKey: input.auth.apiKey,
		headers: input.auth.headers,
		...input.reasoning,
	};
	if (input.signal) options.signal = input.signal;

	try {
		const res = await completeFn(input.model, context, options);
		const text = res.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		return {
			text,
			usage: { input: res.usage?.input, output: res.usage?.output },
			stopReason: res.stopReason,
			errorMessage: res.errorMessage,
		};
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { text: "", errorMessage: msg };
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pi-vision-tools && npx vitest run tests/vision.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pi-vision-tools/src/vision.ts pi-vision-tools/tests/vision.test.ts
git commit -m "feat(pi-vision-tools): vision model resolve + complete call path"
```

---

### Task 7: Wire the extension — tool, command, lifecycle, footer

**Files:**
- Create: `pi-vision-tools/index.ts` (full implementation, replaces stub)
- Create: `pi-vision-tools/src/state.ts` (effective-enabled computation + footer refresh helper)

**Interfaces:**
- Consumes: all `src/*.ts` modules; `ExtensionAPI`, `ExtensionContext`, `ExtensionCommandContext`, `getAgentDir` from `@earendil-works/pi-coding-agent`; `complete` from `@earendil-works/pi-ai/compat`; `Type` from `typebox`, `StringEnum` from `@earendil-works/pi-ai`; `Text` from `@earendil-works/pi-tui`.
- Produces: the default extension factory.

Behavior to implement (from spec):
1. **`session_start`**: load config into memory; compute effective enabled; sync `pi.setActiveTools`; refresh footer.
2. **`model_select`**: recompute effective enabled (auto mode depends on new model's `input`); sync active tools; refresh footer.
3. **`describe_image` tool** params: `image_path` (string), `prompt` (string), `compress` (optional bool, default true), `reasoning` (optional `StringEnum(["off","minimal","low","medium","high","xhigh"])`).
   - If effectively disabled → return error result (do not call model).
   - Resolve vision model via `resolveVisionModel`; on failure return error result with the guidance message.
   - `getApiKeyAndHeaders(model)`; if `!auth.ok || !auth.apiKey` → error result.
   - decode → (if compress) compress → `callVision` with injected `complete`.
   - Return `{ content: [{type:"text", text}], details: { model, usage, compressed, mimeType } }`.
4. **`/vision` command** — parse `args` string:
   - no args → notify current config + effective state.
   - `config provider <p>` → set `config.provider`, save, notify.
   - `config model <m>` → set `config.model`, save, notify.
   - `config default-reasoning <level>` → set `config.defaultReasoning`, save, notify.
   - `on` → `config.enabled = "on"`, save, refresh.
   - `off` → `config.enabled = "off"`, save, refresh.
   - `auto` → `config.enabled = "auto"`, save, refresh.
   - `status` (or unknown) → notify status.
5. **Footer**: `ctx.ui.setStatus("pi-vision", "👁 <provider/model>")` when effectively enabled & has UI; `setStatus("pi-vision", undefined)` when disabled.

- [ ] **Step 1: Create `src/state.ts`**

```ts
import type { Model } from "@earendil-works/pi-ai";
import type { VisionConfig, VisionEnabledState } from "./config.js";

export function callingModelHasVision(model: Model<any> | undefined): boolean {
	return !!model && Array.isArray(model.input) && model.input.includes("image");
}

export function effectiveEnabled(config: VisionConfig, model: Model<any> | undefined): boolean {
	if (config.enabled === "on") return true;
	if (config.enabled === "off") return false;
	return !callingModelHasVision(model);
}

export function footerLabel(config: VisionConfig, enabled: boolean): string | undefined {
	if (!enabled) return undefined;
	if (!config.provider || !config.model) return undefined;
	return `👁 ${config.provider}/${config.model}`;
}
```

> Add a small test for `effectiveEnabled`/`footerLabel` if desired; minimum: the tool/command wiring is verified by typecheck + manual run. (Optional test omitted to keep task focused; logic is trivial and pure — feel free to add `tests/state.test.ts` mirroring the reasoning test style.)

- [ ] **Step 2: Implement `index.ts`**

```ts
import { complete } from "@earendil-works/pi-ai/compat";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadConfig, saveConfig, type VisionConfig } from "./src/config.js";
import { compressImage, readCompressionSettings } from "./src/compress.js";
import { decodeImage } from "./src/image.js";
import { reasoningToOptions, type VisionReasoning } from "./src/reasoning.js";
import { callingModelHasVision, effectiveEnabled, footerLabel } from "./src/state.js";
import { callVision, resolveVisionModel } from "./src/vision.js";

const TOOL_NAME = "describe_image";
const STATUS_KEY = "pi-vision";

export default function (pi: ExtensionAPI) {
	let config: VisionConfig = { enabled: "auto" };
	let enabled = false;

	const refresh = (ctx: ExtensionContext) => {
		enabled = effectiveEnabled(config, ctx.model);
		const active = pi.getActiveTools();
		if (enabled && !active.includes(TOOL_NAME)) {
			pi.setActiveTools([...active, TOOL_NAME]);
		} else if (!enabled && active.includes(TOOL_NAME)) {
			pi.setActiveTools(active.filter((t) => t !== TOOL_NAME));
		}
		if (ctx.hasUI) {
			const label = footerLabel(config, enabled);
			ctx.ui.setStatus(STATUS_KEY, label);
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		config = await loadConfig(getAgentDir());
		refresh(ctx);
	});
	pi.on("model_select", async (_event, ctx) => {
		refresh(ctx);
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Describe Image",
		description:
			"Analyze an image by delegating to a vision-capable model. Lets non-multimodal models understand images. " +
			"`image_path` is a file path, data: URL, or raw base64 (>100 chars). " +
			"`compress` (default true) downscales/strips to speed up; set false for pixel-perfect needs. " +
			"`reasoning` controls the vision model's thinking effort (off/minimal/low/medium/high/xhigh).",
		promptSnippet: "describe_image: delegate image analysis to a vision model (non-multimodal models).",
		promptGuidelines: [
			"Use describe_image when you need to understand an image you cannot see (the calling model lacks vision).",
			"Set compress:false when you need pixel-perfect accuracy (reading coordinates, tiny UI elements).",
			"Set reasoning:'high'/'xhigh' for complex visual analysis (architecture diagrams, bug hunting).",
		],
		parameters: Type.Object({
			image_path: Type.String({ description: "File path, data: URL, or raw base64 (>100 chars)." }),
			prompt: Type.String({ description: "Instruction for the vision model, e.g. 'describe', 'extract text', 'find the bug'." }),
			compress: Type.Optional(Type.Boolean({ default: true, description: "Compress image before sending (default true)." })),
			reasoning: Type.Optional(
				StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, {
					description: "Vision model reasoning effort. Default off.",
				}),
			),
		}),
		renderCall(args, theme) {
			const p = args as { image_path?: string; prompt?: string };
			const target = p.image_path ? (p.image_path.length > 40 ? `${p.image_path.slice(0, 37)}...` : p.image_path) : "...";
			return new Text(theme.fg("toolTitle", theme.bold("describe_image ")) + theme.fg("accent", target) + theme.fg("dim", ` · ${p.prompt?.slice(0, 30) ?? ""}`), 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const text = result.content?.[0];
			const body = text?.type === "text" ? text.text : "";
			const lines = body.split("\n");
			if (!expanded) {
				const preview = lines.slice(0, 6);
				if (lines.length > 6) preview.push(theme.fg("dim", `... ${lines.length - 6} more lines · ctrl+o to expand`));
				return new Text(preview.join("\n"), 0, 0);
			}
			return new Text(body, 0, 0);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!enabled) {
				return {
					content: [{ type: "text", text: "describe_image is disabled. Run /vision on to enable." }],
					details: { error: "disabled" },
					isError: true,
				};
			}
			const p = params as { image_path: string; prompt: string; compress?: boolean; reasoning?: VisionReasoning };

			const resolved = resolveVisionModel(ctx.modelRegistry, config);
			if (!resolved.ok) {
				return { content: [{ type: "text", text: resolved.error }], details: { error: resolved.error }, isError: true };
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(resolved.model);
			if (!auth.ok || !auth.apiKey) {
				const msg = auth.ok ? `No API key for ${config.provider}/${config.model}` : auth.error;
				return { content: [{ type: "text", text: msg }], details: { error: msg }, isError: true };
			}

			onUpdate?.({ content: [{ type: "text", text: "Decoding image..." }], details: {} });

			let image;
			try {
				image = await decodeImage(p.image_path);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				return { content: [{ type: "text", text: `Image decode failed: ${msg}` }], details: { error: msg }, isError: true };
			}

			const doCompress = p.compress !== false;
			let compressed = false;
			let mimeType = image.mimeType;
			if (doCompress) {
				onUpdate?.({ content: [{ type: "text", text: "Compressing..." }], details: {} });
				const out = await compressImage(image, readCompressionSettings());
				compressed = out !== image;
				mimeType = out.mimeType;
				image = out;
			}

			onUpdate?.({ content: [{ type: "text", text: "Analyzing image..." }], details: {} });

			const reasoning = reasoningToOptions(p.reasoning ?? config.defaultReasoning);
			const result = await callVision(
				{ model: resolved.model, auth: { apiKey: auth.apiKey, headers: auth.headers }, prompt: p.prompt, images: [image], reasoning, signal: signal ?? undefined },
				complete,
			);

			if (result.errorMessage) {
				return {
					content: [{ type: "text", text: `Vision model error: ${result.errorMessage}` }],
					details: { error: result.errorMessage, model: `${config.provider}/${config.model}` },
					isError: true,
				};
			}

			return {
				content: [{ type: "text", text: result.text }],
				details: { model: `${config.provider}/${config.model}`, usage: result.usage, compressed, mimeType, reasoning: p.reasoning ?? "off" },
			};
		},
	});

	pi.registerCommand("vision", {
		description: "Configure the vision model for describe_image (/vision config | on | off | status)",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = parts[0];

			const notifyConfig = () => {
				const target = config.provider && config.model ? `${config.provider}/${config.model}` : "(unconfigured)";
				const visionCap = callingModelHasVision(ctx.model) ? "yes" : "no";
				ctx.ui.notify(
					`vision: ${target}\nenabled: ${config.enabled} (effective: ${enabled ? "on" : "off"})\ncalling model has vision: ${visionCap}`,
					"info",
				);
			};

			if (!sub || sub === "status") {
				notifyConfig();
				return;
			}

			if (sub === "on" || sub === "off" || sub === "auto") {
				config = { ...config, enabled: sub as VisionConfig["enabled"] };
				await saveConfig(getAgentDir(), config);
				refresh(ctx);
				ctx.ui.notify(`vision ${sub}`, "info");
				return;
			}

			if (sub === "config") {
				const key = parts[1];
				const val = parts[2];
				if (key === "provider" && val) config = { ...config, provider: val };
				else if (key === "model" && val) config = { ...config, model: val };
				else if (key === "default-reasoning" && val) config = { ...config, defaultReasoning: val as VisionReasoning };
				else {
					ctx.ui.notify("Usage: /vision config provider <p> | model <m> | default-reasoning <level>", "warning");
					return;
				}
				await saveConfig(getAgentDir(), config);
				refresh(ctx);
				ctx.ui.notify(`vision ${key} = ${val}`, "info");
				return;
			}

			ctx.ui.notify("Usage: /vision [config provider <p> | config model <m> | on | off | auto | status]", "warning");
		},
	});
}
```

- [ ] **Step 3: Typecheck**

Run: `cd pi-vision-tools && npx tsc --noEmit`
Expected: PASS.

> If `complete` import errors because `@earendil-works/pi-ai/compat` types differ slightly, cast `complete` to `CompleteFn` via `callVision(..., complete as CompleteFn)`. The `CompleteFn` type in `vision.ts` already uses a permissive `Record<string, unknown>` options bag, matching `ProviderStreamOptions`.

- [ ] **Step 4: Lint + format**

Run: `cd pi-vision-tools && npx biome check .`
Expected: PASS (run `npx biome format --write .` if formatting drifts).

- [ ] **Step 5: Run full suite**

Run: `cd pi-vision-tools && npx vitest run`
Expected: all test files PASS.

- [ ] **Step 6: Commit**

```bash
git add pi-vision-tools/index.ts pi-vision-tools/src/state.ts
git commit -m "feat(pi-vision-tools): wire tool, /vision command, lifecycle + footer"
```

---

### Task 8: README and RELEASE docs

**Files:**
- Create: `pi-vision-tools/README.md`
- Create: `pi-vision-tools/RELEASE.md`

- [ ] **Step 1: Create `README.md`**

Condense the spec (`docs/prompts/pi-vision-tools.md`) into a user-facing README. Include: features table, how it works diagram, configuration (`/vision` commands + sharp install + env vars), usage examples, image formats, license MIT. Use the spec as the source of truth for wording.

- [ ] **Step 2: Create `RELEASE.md`**

Mirror `pi-todo/RELEASE.md`, substituting `pi-vision-tools` for `pi-todo` everywhere (tag `pi-vision-tools-vX.Y.Z`, `--workspace=pi-vision-tools`, publish workspace `pi-vision-tools`).

- [ ] **Step 3: Commit**

```bash
git add pi-vision-tools/README.md pi-vision-tools/RELEASE.md
git commit -m "docs(pi-vision-tools): README and release process"
```

---

### Task 9: Final verification (monorepo-wide)

- [ ] **Step 1: Full typecheck**

Run: `npm run typecheck`
Expected: all workspaces PASS, including `pi-vision-tools`.

- [ ] **Step 2: Full lint/format check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 3: Full test**

Run: `npm test`
Expected: all workspace tests PASS.

- [ ] **Step 4: Manual smoke test (optional, needs a vision model API key)**

```
pi -e ./pi-vision-tools/index.ts
/vision config provider openai
/vision config model gpt-4o
# confirm 👁 footer appears (if calling model lacks vision)
# ask the model: "describe /tmp/some.png"
# confirm describe_image is called and returns text
```

- [ ] **Step 5: Final commit if any drift**

```bash
git add -A
git commit -m "chore(pi-vision-tools): final verification" || echo "nothing to commit"
```

---

## Self-Review

**1. Spec coverage:**
- `describe_image` tool with `image_path`, `prompt`, `compress`, `reasoning` → Task 7. ✓
- Compression via sharp (optional), env vars `PI_VISION_MAX_DIM`/`PI_VISION_JPEG_QUALITY`, `compress:false` for accuracy → Tasks 5, 7. ✓
- Reasoning levels off/minimal/low/medium/high/xhigh, default off, configurable default → Tasks 4, 7 (config `defaultReasoning`). ✓
- `/vision config provider|model`, `/vision` status, `/vision on|off` → Task 7. ✓ (added `auto` + `default-reasoning` as natural extensions.)
- Config persisted to `{agentDir}/vision-tools.json`, takes effect immediately → Tasks 2, 7. ✓
- Auto enable/disable by calling model modality (`input` includes image) → Tasks 7, `state.ts`. ✓
- Footer 👁 indicator on/off → Task 7 (`setStatus`). ✓
- Model resolved via `ctx.modelRegistry.find()`, auth via `getApiKeyAndHeaders()` → Task 7 + Task 6. ✓
- API call follows api type via pi's client (`complete()`) → Task 6 + 7. ✓
- Image decode (file/data URL/base64), formats PNG/JPEG/GIF/WebP/BMP → Task 3. ✓
- Returns vision model text as tool result → Task 6/7. ✓
- npm package `@yandy0725/pi-vision-tools`, MIT, pi-package keyword → Task 1. ✓

**2. Placeholder scan:** No TBD/TODO/"add error handling" placeholders. All code blocks contain real code. Test code is complete. ✓

**3. Type consistency:** `VisionConfig`/`VisionEnabledState` (Task 2) used consistently in Task 6 & 7. `DecodedImage` (Task 3) used in Tasks 5, 6, 7. `ReasoningOptions`/`VisionReasoning` (Task 4) used in Tasks 6, 7. `CompleteFn`/`ResolveResult`/`VisionCallInput`/`VisionCallResult` (Task 6) used in Task 7. `resolveVisionModel`/`callVision` signatures match. ✓

Gaps: none identified.
