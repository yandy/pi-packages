# pi-coding-tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a pi package that provides an `apply_patch` tool (Codex text format + lark freeform grammar) and enables the built-in `ls`/`find`/`grep` tools, both controllable via global/project-level config files.

**Architecture:** Based on [code-yeongyu/pi-apply-patch](https://github.com/code-yeongyu/pi-apply-patch) (ref 3), retaining its patch parsing, path safety, atomic writes, diff rendering, and failure recovery. Key differences: unconditional activation (no model-based switching), no edit/write replacement, adds ls/find/grep activation and config file support. Code split into focused modules under `src/` for testability.

**Tech Stack:** TypeScript, `@earendil-works/pi-coding-agent` (peerDep), `typebox`, `diff` npm package, vitest, biome.

## Global Constraints

- **Package name:** `@yandy0725/pi-coding-tools`
- **peerDep:** `@earendil-works/pi-coding-agent` `>=0.74.0` (not bundled, provided by pi runtime)
- **dep:** `diff` `^9.0.0`, `@types/diff` `^8.0.0` (devDep)
- **Code style:** biome with tab indent, double quotes, trailing commas, semicolons always (see `pi-web-tools/biome.json`)
- **Module:** ES modules (`"type": "module"`)
- **Test framework:** vitest, test files in `tests/**/*.test.ts`
- **Patch format:** Codex text format (`*** Begin Patch` ... `*** End Patch`) + lark freeform grammar
- **Path safety:** realpath + workspace boundary + symlink check (stricter than built-in edit/write)
- **Config:** global `~/.pi/agent/coding-tools.json` + project `<cwd>/.pi/coding-tools.json`, project overrides global, all default `true`
- **Activation:** unconditional (no model-based switching), config-gated
- **TDD:** write tests first, then implementation
- **Frequent commits:** commit after each task

---

## File Structure

```
pi-coding-tools/
├── package.json
├── index.ts
├── src/
│   ├── parse.ts              # Patch text parsing + lark grammar + seekSequence
│   ├── apply.ts              # File system application + path safety + recovery
│   ├── render.ts             # TUI diff rendering helpers
│   ├── apply-patch-tool.ts   # Tool definition (combines parse/apply/render)
│   ├── write-file-atomic.ts  # Atomic write (temp + rename)
│   ├── config.ts             # Config loading (global + project)
│   └── search-tools.ts       # ls/find/grep activation
├── tests/
│   ├── parse.test.ts
│   ├── apply.test.ts
│   ├── render.test.ts
│   ├── config.test.ts
│   ├── write-file-atomic.test.ts
│   └── search-tools.test.ts
├── tsconfig.json
├── vitest.config.ts
├── biome.json
├── AGENTS.md
├── RELEASE.md
└── README.md
```

---

### Task 1: Package scaffolding

**Files:**
- Create: `pi-coding-tools/package.json`
- Create: `pi-coding-tools/tsconfig.json`
- Create: `pi-coding-tools/vitest.config.ts`
- Create: `pi-coding-tools/biome.json`
- Create: `pi-coding-tools/.gitignore`

**Interfaces:**
- Produces: a buildable TypeScript project with `npm install`, `npm test`, `npm run typecheck`, `npm run lint`

- [ ] **Step 1: Create package.json**

Create `pi-coding-tools/package.json`:

```json
{
  "name": "@yandy0725/pi-coding-tools",
  "publishConfig": {
    "access": "public"
  },
  "version": "0.1.0",
  "description": "pi package providing apply_patch tool and enabling ls/find/grep built-in tools",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/yandy/pi-packages",
    "directory": "pi-coding-tools"
  },
  "type": "module",
  "keywords": [
    "pi-package"
  ],
  "files": [
    "index.ts",
    "src/"
  ],
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "lint": "biome lint .",
    "format": "biome format --write .",
    "check": "biome check ."
  },
  "pi": {
    "extensions": [
      "./index.ts"
    ]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": ">=0.74.0"
  },
  "dependencies": {
    "diff": "^9.0.0"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.5.0",
    "@earendil-works/pi-coding-agent": "^0.74.0",
    "@types/diff": "^8.0.0",
    "@types/node": "^22.0.0",
    "typescript": "~5.7.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

Copy from `pi-web-tools/tsconfig.json` exactly:

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

- [ ] **Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/**/*.test.ts"] },
});
```

- [ ] **Step 4: Create biome.json**

Copy from `pi-web-tools/biome.json` exactly:

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

- [ ] **Step 5: Create .gitignore**

```
node_modules/
*.tsbuildinfo
```

- [ ] **Step 6: Run npm install and verify**

Run: `cd pi-coding-tools && npm install`
Expected: succeeds, creates `node_modules/` and `package-lock.json`

- [ ] **Step 7: Verify typecheck passes (empty project)**

Run: `cd pi-coding-tools && npm run typecheck`
Expected: PASS (no errors, no files to check yet)

- [ ] **Step 8: Commit**

```bash
git add pi-coding-tools/package.json pi-coding-tools/package-lock.json pi-coding-tools/tsconfig.json pi-coding-tools/vitest.config.ts pi-coding-tools/biome.json pi-coding-tools/.gitignore
git commit -m "scaffold: pi-coding-tools package structure"
```

---

### Task 2: Config module (TDD)

**Files:**
- Create: `pi-coding-tools/src/config.ts`
- Test: `pi-coding-tools/tests/config.test.ts`

**Interfaces:**
- Produces: `CodingToolsConfig` interface, `loadConfig(cwd?: string): CodingToolsConfig`
- Consumes: `CONFIG_DIR_NAME`, `getAgentDir` from `@earendil-works/pi-coding-agent`

- [ ] **Step 1: Write the failing test**

Create `pi-coding-tools/tests/config.test.ts`:

```typescript
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type CodingToolsConfig } from "../src/config";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-coding-tools-test-"));
}

describe("loadConfig", () => {
  let tempCwd: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    tempCwd = makeTempDir();
    // loadConfig caches by cwd; reset cache between tests by using a unique cwd each time
    savedHome = process.env.HOME;
  });

  afterEach(() => {
    if (savedHome !== undefined) process.env.HOME = savedHome;
    rmSync(tempCwd, { recursive: true, force: true });
  });

  it("returns all-true defaults when no config files exist", () => {
    const config = loadConfig(tempCwd);
    const expected: CodingToolsConfig = {
      applyPatch: true,
      ls: true,
      find: true,
      grep: true,
    };
    expect(config).toEqual(expected);
  });

  it("reads global config from agent dir", () => {
    // Point HOME to temp dir so getAgentDir() resolves inside it
    process.env.HOME = tempCwd;
    const agentDir = join(tempCwd, ".pi", "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "coding-tools.json"),
      JSON.stringify({ applyPatch: false, grep: false }),
    );

    const config = loadConfig(tempCwd);
    expect(config).toEqual({
      applyPatch: false,
      ls: true,
      find: true,
      grep: false,
    });
  });

  it("project config overrides global config", () => {
    process.env.HOME = tempCwd;
    const agentDir = join(tempCwd, ".pi", "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "coding-tools.json"),
      JSON.stringify({ applyPatch: false, ls: false }),
    );

    // Project config at <cwd>/.pi/coding-tools.json
    mkdirSync(join(tempCwd, ".pi"), { recursive: true });
    // Use a subdirectory as cwd so HOME != cwd
    const projectCwd = join(tempCwd, "project");
    mkdirSync(projectCwd);
    mkdirSync(join(projectCwd, ".pi"), { recursive: true });
    writeFileSync(
      join(projectCwd, ".pi", "coding-tools.json"),
      JSON.stringify({ applyPatch: true }),
    );

    const config = loadConfig(projectCwd);
    expect(config).toEqual({
      applyPatch: true,   // overridden by project
      ls: false,          // from global
      find: true,         // default
      grep: true,         // default
    });
  });

  it("falls back to defaults when config JSON is invalid", () => {
    process.env.HOME = tempCwd;
    const agentDir = join(tempCwd, ".pi", "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "coding-tools.json"), "{ invalid json");

    const config = loadConfig(tempCwd);
    expect(config).toEqual({
      applyPatch: true,
      ls: true,
      find: true,
      grep: true,
    });
  });

  it("partial config: unspecified fields keep defaults", () => {
    process.env.HOME = tempCwd;
    const agentDir = join(tempCwd, ".pi", "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "coding-tools.json"),
      JSON.stringify({ find: false }),
    );

    const config = loadConfig(tempCwd);
    expect(config).toEqual({
      applyPatch: true,
      ls: true,
      find: false,
      grep: true,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pi-coding-tools && npm test`
Expected: FAIL — `Cannot find module '../src/config'`

- [ ] **Step 3: Write minimal implementation**

Create `pi-coding-tools/src/config.ts`:

```typescript
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface CodingToolsConfig {
  applyPatch: boolean;
  ls: boolean;
  find: boolean;
  grep: boolean;
}

const DEFAULT_CONFIG: CodingToolsConfig = {
  applyPatch: true,
  ls: true,
  find: true,
  grep: true,
};

let cachedConfig: CodingToolsConfig | null = null;
let cachedCwd: string | null = null;

function readJsonFile(path: string): Partial<CodingToolsConfig> | null {
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as Partial<CodingToolsConfig>;
  } catch {
    return null;
  }
}

export function loadConfig(cwd?: string): CodingToolsConfig {
  const dir = cwd || process.cwd();
  if (cachedConfig && cachedCwd === dir) return cachedConfig;

  const agentDir = getAgentDir();
  const globalConfig = readJsonFile(resolve(agentDir, "coding-tools.json")) || {};
  const projectConfig = readJsonFile(resolve(dir, CONFIG_DIR_NAME, "coding-tools.json")) || {};

  cachedConfig = {
    applyPatch: projectConfig.applyPatch ?? globalConfig.applyPatch ?? DEFAULT_CONFIG.applyPatch,
    ls: projectConfig.ls ?? globalConfig.ls ?? DEFAULT_CONFIG.ls,
    find: projectConfig.find ?? globalConfig.find ?? DEFAULT_CONFIG.find,
    grep: projectConfig.grep ?? globalConfig.grep ?? DEFAULT_CONFIG.grep,
  };
  cachedCwd = dir;
  return cachedConfig;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pi-coding-tools && npm test`
Expected: PASS — all 5 tests pass

- [ ] **Step 5: Run typecheck and lint**

Run: `cd pi-coding-tools && npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add pi-coding-tools/src/config.ts pi-coding-tools/tests/config.test.ts
git commit -m "feat: add config module with global/project-level loading"
```

---

### Task 3: Patch parser (TDD)

**Files:**
- Create: `pi-coding-tools/src/parse.ts`
- Test: `pi-coding-tools/tests/parse.test.ts`

**Interfaces:**
- Produces: `ParsedPatch` type, `PatchChunk` type, `PatchParseError` class, `parsePatch(patchText: string): ParsedPatch[]`, `parseNonEmptyPatch(patchText: string): ParsedPatch[]`, `seekSequence(...)`, `normalizeSeekLine(line: string): string`, `extractPatchedPaths(patchText: string): string[]`, `APPLY_PATCH_LARK_GRAMMAR` constant
- Consumes: nothing (pure functions)

> **Implementation note:** This module is a direct adaptation of [code-yeongyu/pi-apply-patch](https://github.com/code-yeongyu/pi-apply-patch) `src/index.ts` parsing functions. The functions `normalizePatchText`, `stripHeredoc`, `parsePatch`, `parseNonEmptyPatch`, `seekSequence`, `normalizeSeekLine`, `extractPatchedPaths`, and the `APPLY_PATCH_LARK_GRAMMAR` constant are copied verbatim from ref 3, only changing the file from `src/index.ts` to `src/parse.ts`.

- [ ] **Step 1: Write the failing test**

Create `pi-coding-tools/tests/parse.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  APPLY_PATCH_LARK_GRAMMAR,
  extractPatchedPaths,
  normalizeSeekLine,
  parseNonEmptyPatch,
  parsePatch,
  PatchParseError,
  type ParsedPatch,
} from "../src/parse";

describe("parsePatch", () => {
  it("parses a simple add file hunk", () => {
    const patch = `*** Begin Patch
*** Add File: hello.txt
+Hello, World!
+Second line
*** End Patch`;
    const result = parsePatch(patch);
    expect(result).toEqual([
      {
        type: "add",
        filePath: "hello.txt",
        content: "Hello, World!\nSecond line\n",
      },
    ]);
  });

  it("parses multiple hunks", () => {
    const patch = `*** Begin Patch
*** Add File: a.txt
+content a
*** Delete File: b.txt
*** End Patch`;
    const result = parsePatch(patch);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: "add", filePath: "a.txt", content: "content a\n" });
    expect(result[1]).toEqual({ type: "delete", filePath: "b.txt" });
  });

  it("parses add file with empty content", () => {
    const patch = `*** Begin Patch
*** Add File: empty.txt
*** End Patch`;
    const result = parsePatch(patch);
    expect(result).toEqual([{ type: "add", filePath: "empty.txt", content: "" }]);
  });

  it("parses delete file hunk", () => {
    const patch = `*** Begin Patch
*** Delete File: old.txt
*** End Patch`;
    const result = parsePatch(patch);
    expect(result).toEqual([{ type: "delete", filePath: "old.txt" }]);
  });

  it("parses update file with @@ context", () => {
    const patch = `*** Begin Patch
*** Update File: foo.ts
@@ function bar() {
 context line
-old line
+new line
 context line 2
*** End Patch`;
    const result = parsePatch(patch);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("update");
    if (result[0].type === "update") {
      expect(result[0].filePath).toBe("foo.ts");
      expect(result[0].chunks).toHaveLength(1);
      expect(result[0].chunks[0].changeContexts).toEqual(["function bar() {"]);
      expect(result[0].chunks[0].oldLines).toEqual(["old line"]);
      expect(result[0].chunks[0].newLines).toEqual(["new line"]);
      expect(result[0].chunks[0].isEndOfFile).toBe(false);
    }
  });

  it("parses update file with *** Move to", () => {
    const patch = `*** Begin Patch
*** Update File: old.ts
*** Move to: new.ts
@@ ctx
-old
+new
*** End Patch`;
    const result = parsePatch(patch);
    expect(result[0].type).toBe("update");
    if (result[0].type === "update") {
      expect(result[0].movePath).toBe("new.ts");
    }
  });

  it("parses update file with *** End of File", () => {
    const patch = `*** Begin Patch
*** Update File: foo.ts
@@ 
 context
+appended
*** End of File
*** End Patch`;
    const result = parsePatch(patch);
    expect(result[0].type).toBe("update");
    if (result[0].type === "update") {
      expect(result[0].chunks[0].isEndOfFile).toBe(true);
    }
  });

  it("parses update with no @@ context (first chunk allowed)", () => {
    const patch = `*** Begin Patch
*** Update File: foo.ts
-old
+new
*** End Patch`;
    const result = parsePatch(patch);
    expect(result[0].type).toBe("update");
    if (result[0].type === "update") {
      expect(result[0].chunks[0].changeContexts).toEqual([]);
    }
  });

  it("throws PatchParseError when missing *** Begin Patch", () => {
    expect(() => parsePatch("*** End Patch")).toThrow(PatchParseError);
  });

  it("throws PatchParseError when missing *** End Patch", () => {
    expect(() => parsePatch("*** Begin Patch\n*** Add File: a.txt\n+content")).toThrow(PatchParseError);
  });

  it("throws PatchParseError on empty patch", () => {
    expect(() => parseNonEmptyPatch("*** Begin Patch\n*** End Patch")).toThrow(PatchParseError);
  });

  it("throws PatchParseError on invalid hunk header", () => {
    expect(() =>
      parsePatch("*** Begin Patch\n*** Unknown: foo\n*** End Patch"),
    ).toThrow(PatchParseError);
  });

  it("normalizes CRLF to LF", () => {
    const patch = "*** Begin Patch\r\n*** Add File: a.txt\r\n+content\r\n*** End Patch\r\n";
    const result = parsePatch(patch);
    expect(result[0]).toEqual({ type: "add", filePath: "a.txt", content: "content\n" });
  });

  it("unwraps heredoc wrapper", () => {
    const inner = "*** Begin Patch\n*** Add File: a.txt\n+content\n*** End Patch";
    const wrapped = `<<EOF\n${inner}\nEOF`;
    const result = parsePatch(wrapped);
    expect(result).toHaveLength(1);
  });
});

describe("extractPatchedPaths", () => {
  it("extracts add/delete/update paths", () => {
    const patch = `*** Begin Patch
*** Add File: a.txt
+content
*** Update File: b.ts
@@ ctx
-old
+new
*** Delete File: c.md
*** End Patch`;
    expect(extractPatchedPaths(patch)).toEqual(["a.txt", "b.ts", "c.md"]);
  });

  it("returns empty array for text without patch markers", () => {
    expect(extractPatchedPaths("no patch here")).toEqual([]);
  });
});

describe("normalizeSeekLine", () => {
  it("replaces smart quotes with ASCII", () => {
    expect(normalizeSeekLine("hello \u201Cworld\u201D")).toBe('hello "world"');
  });

  it("replaces em-dash with hyphen", () => {
    expect(normalizeSeekLine("a\u2014b")).toBe("a-b");
  });

  it("replaces non-breaking spaces with regular spaces", () => {
    expect(normalizeSeekLine("a\u00A0b")).toBe("a b");
  });

  it("trims whitespace", () => {
    expect(normalizeSeekLine("  hello  ")).toBe("hello");
  });
});

describe("APPLY_PATCH_LARK_GRAMMAR", () => {
  it("contains the lark grammar definition", () => {
    expect(APPLY_PATCH_LARK_GRAMMAR).toContain('"*** Begin Patch"');
    expect(APPLY_PATCH_LARK_GRAMMAR).toContain('"*** End Patch"');
    expect(APPLY_PATCH_LARK_GRAMMAR).toContain("add_hunk");
    expect(APPLY_PATCH_LARK_GRAMMAR).toContain("update_hunk");
    expect(APPLY_PATCH_LARK_GRAMMAR).toContain("delete_hunk");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pi-coding-tools && npm test`
Expected: FAIL — `Cannot find module '../src/parse'`

- [ ] **Step 3: Write implementation**

Create `pi-coding-tools/src/parse.ts`. This is a direct adaptation of the parsing functions from [ref 3 `src/index.ts`](https://github.com/code-yeongyu/pi-apply-patch/blob/main/src/index.ts). Copy the following from ref 3 verbatim, exporting all functions and types that tests or later tasks need:

- Types: `ParsedPatch`, `PatchChunk`
- Error class: `PatchParseError`
- Constants: `APPLY_PATCH_LARK_GRAMMAR`, `APPLY_PATCH_FREEFORM_DESCRIPTION`
- Functions: `normalizePatchText`, `stripHeredoc`, `parsePatch`, `parseNonEmptyPatch`, `splitFileLines`, `seekSequence`, `normalizeSeekLine`, `extractPatchedPaths`

Reference source: https://github.com/code-yeongyu/pi-apply-patch/blob/main/src/index.ts — extract the parsing-related functions. Key functions to copy exactly:

```typescript
export type ParsedPatch =
  | { type: "add"; filePath: string; content: string }
  | { type: "delete"; filePath: string }
  | { type: "update"; filePath: string; movePath?: string; chunks: PatchChunk[] };

export type PatchChunk = {
  changeContexts: string[];
  oldLines: string[];
  newLines: string[];
  isEndOfFile: boolean;
};

export class PatchParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchParseError";
  }
}

// Copy these constants and functions verbatim from ref 3:
// - APPLY_PATCH_LARK_GRAMMAR
// - APPLY_PATCH_FREEFORM_DESCRIPTION
// - normalizePatchText
// - stripHeredoc
// - normalizeSeekLine
// - seekSequence
// - parsePatch
// - parseNonEmptyPatch
// - splitFileLines
// - extractPatchedPaths
```

The complete source is at the URL above. Copy the function bodies exactly — they are battle-tested. Only change: remove functions that belong to `apply.ts` (`replaceChunks`, `applySingleHunk`, `applyParsedPatchDetailed`, `applyPatch`, `createRecoveryInstructions`, path safety functions, `resolvePatchPath`) and rendering functions (those go to `render.ts`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pi-coding-tools && npm test`
Expected: PASS — all parse tests pass

- [ ] **Step 5: Run typecheck and lint**

Run: `cd pi-coding-tools && npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add pi-coding-tools/src/parse.ts pi-coding-tools/tests/parse.test.ts
git commit -m "feat: add Codex patch parser with lark grammar"
```

---

### Task 4: Atomic write utility (TDD)

**Files:**
- Create: `pi-coding-tools/src/write-file-atomic.ts`
- Test: `pi-coding-tools/tests/write-file-atomic.test.ts`

**Interfaces:**
- Produces: `writeFileAtomic(absPath: string, content: string): Promise<void>`, `AtomicWriteOperations` type
- Consumes: `node:fs/promises` (`writeFile`, `rename`, `unlink`)

> **Implementation note:** Direct copy from [ref 3 `src/write-file-atomic.ts`](https://github.com/code-yeongyu/pi-apply-patch/blob/main/src/write-file-atomic.ts).

- [ ] **Step 1: Write the failing test**

Create `pi-coding-tools/tests/write-file-atomic.test.ts`:

```typescript
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileAtomic } from "../src/write-file-atomic";

describe("writeFileAtomic", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pi-coding-tools-atomic-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes content to a new file", async () => {
    const filePath = join(tempDir, "output.txt");
    await writeFileAtomic(filePath, "hello world");
    expect(readFileSync(filePath, "utf-8")).toBe("hello world");
  });

  it("overwrites an existing file", async () => {
    const filePath = join(tempDir, "existing.txt");
    writeFileSync(filePath, "old content");
    await writeFileAtomic(filePath, "new content");
    expect(readFileSync(filePath, "utf-8")).toBe("new content");
  });

  it("does not leave temp files on success", async () => {
    const filePath = join(tempDir, "clean.txt");
    await writeFileAtomic(filePath, "data");
    const files = require("node:fs").readdirSync(tempDir);
    expect(files).toEqual(["clean.txt"]);
  });

  it("uses utf-8 encoding", async () => {
    const filePath = join(tempDir, "utf8.txt");
    await writeFileAtomic(filePath, "héllo wörld");
    expect(readFileSync(filePath, "utf-8")).toBe("héllo wörld");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pi-coding-tools && npm test`
Expected: FAIL — `Cannot find module '../src/write-file-atomic'`

- [ ] **Step 3: Write implementation**

Create `pi-coding-tools/src/write-file-atomic.ts`:

```typescript
import { rename, unlink, writeFile } from "node:fs/promises";

export type AtomicWriteOperations = {
  writeFile: (filePath: string, content: string, encoding: "utf-8") => Promise<void>;
  rename: (fromPath: string, toPath: string) => Promise<void>;
  unlink: (filePath: string) => Promise<void>;
};

const ATOMIC_WRITE_OPERATIONS: AtomicWriteOperations = {
  writeFile,
  rename,
  unlink,
};

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

export async function writeFileAtomic(
  absPath: string,
  content: string,
  operations: AtomicWriteOperations = ATOMIC_WRITE_OPERATIONS,
): Promise<void> {
  const tempPath = `${absPath}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
  await operations.writeFile(tempPath, content, "utf-8");
  try {
    await operations.rename(tempPath, absPath);
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) {
      throw error;
    }
    await operations.unlink(absPath);
    await operations.rename(tempPath, absPath);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pi-coding-tools && npm test`
Expected: PASS — all write-file-atomic tests pass

- [ ] **Step 5: Run typecheck and lint**

Run: `cd pi-coding-tools && npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add pi-coding-tools/src/write-file-atomic.ts pi-coding-tools/tests/write-file-atomic.test.ts
git commit -m "feat: add atomic file write utility"
```

---

### Task 5: Apply module (TDD)

**Files:**
- Create: `pi-coding-tools/src/apply.ts`
- Test: `pi-coding-tools/tests/apply.test.ts`

**Interfaces:**
- Produces: `PatchApplicationError`, `ApplyPatchError` classes; `ApplyPatchResult`, `ApplyPatchFailure`, `ApplyPatchRecoveryInstructions` types; `applyPatchDetailed(cwd, patchText, onProgress?)` and `applyParsedPatchDetailed(cwd, hunks, onProgress?)` functions
- Consumes: `ParsedPatch`, `PatchChunk`, `parseNonEmptyPatch`, `seekSequence`, `splitFileLines` from `./parse`; `writeFileAtomic` from `./write-file-atomic`

> **Implementation note:** Direct adaptation of ref 3's application functions. Copy `replaceChunks`, `applySingleHunk`, `applyParsedPatchDetailed`, `applyPatchDetailed`, `createRecoveryInstructions`, `resolvePatchPath`, `isPathWithinWorkspace`, `findExistingAncestor`, and error/result types from [ref 3 `src/index.ts`](https://github.com/code-yeongyu/pi-apply-patch/blob/main/src/index.ts).

- [ ] **Step 1: Write the failing test**

Create `pi-coding-tools/tests/apply.test.ts`:

```typescript
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPatchDetailed, ApplyPatchError, PatchApplicationError } from "../src/apply";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-coding-tools-apply-"));
}

describe("applyPatchDetailed", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeTempDir();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("creates a new file (add hunk)", async () => {
    const patch = `*** Begin Patch
*** Add File: new.txt
+Hello
+World
*** End Patch`;
    const result = await applyPatchDetailed(cwd, patch);
    expect(result.failures).toHaveLength(0);
    expect(result.appliedFiles).toEqual(["new.txt"]);
    const content = await import("node:fs/promises").then((m) => m.readFile(join(cwd, "new.txt"), "utf-8"));
    expect(content).toBe("Hello\nWorld\n");
  });

  it("creates nested directories for add hunk", async () => {
    const patch = `*** Begin Patch
*** Add File: deep/nested/dir/file.txt
+content
*** End Patch`;
    const result = await applyPatchDetailed(cwd, patch);
    expect(result.failures).toHaveLength(0);
    expect(result.appliedFiles).toEqual(["deep/nested/dir/file.txt"]);
  });

  it("deletes a file (delete hunk)", async () => {
    writeFileSync(join(cwd, "old.txt"), "old content");
    const patch = `*** Begin Patch
*** Delete File: old.txt
*** End Patch`;
    const result = await applyPatchDetailed(cwd, patch);
    expect(result.failures).toHaveLength(0);
    expect(result.appliedFiles).toEqual(["old.txt"]);
    expect(() => statSync(join(cwd, "old.txt"))).toThrow();
  });

  it("fails to delete nonexistent file", async () => {
    const patch = `*** Begin Patch
*** Delete File: nonexistent.txt
*** End Patch`;
    const result = await applyPatchDetailed(cwd, patch);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].filePath).toBe("nonexistent.txt");
  });

  it("updates a file with exact match", async () => {
    writeFileSync(join(cwd, "foo.ts"), "line1\noldLine\nline3\n");
    const patch = `*** Begin Patch
*** Update File: foo.ts
@@ 
 context
-oldLine
+newLine
*** End Patch`;
    const result = await applyPatchDetailed(cwd, patch);
    expect(result.failures).toHaveLength(0);
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(join(cwd, "foo.ts"), "utf-8");
    expect(content).toContain("newLine");
    expect(content).not.toContain("oldLine");
  });

  it("updates with fuzzy match (trimEnd)", async () => {
    writeFileSync(join(cwd, "foo.ts"), "oldLine   \n");
    const patch = `*** Begin Patch
*** Update File: foo.ts
-oldLine
+newLine
*** End Patch`;
    const result = await applyPatchDetailed(cwd, patch);
    expect(result.failures).toHaveLength(0);
    expect(result.details.fuzz).toBeGreaterThan(0);
  });

  it("appends at end of file with *** End of File", async () => {
    writeFileSync(join(cwd, "foo.ts"), "existing\n");
    const patch = `*** Begin Patch
*** Update File: foo.ts
@@ 
 existing
+appended
*** End of File
*** End Patch`;
    const result = await applyPatchDetailed(cwd, patch);
    expect(result.failures).toHaveLength(0);
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(join(cwd, "foo.ts"), "utf-8");
    expect(content).toBe("existing\nappended\n");
  });

  it("moves a file with *** Move to", async () => {
    writeFileSync(join(cwd, "old.ts"), "content\n");
    const patch = `*** Begin Patch
*** Update File: old.ts
*** Move to: new.ts
@@ 
-content
+newcontent
*** End Patch`;
    const result = await applyPatchDetailed(cwd, patch);
    expect(result.failures).toHaveLength(0);
    expect(() => statSync(join(cwd, "old.ts"))).toThrow();
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(join(cwd, "new.ts"), "utf-8");
    expect(content).toBe("newcontent\n");
  });

  it("partial success: first hunk succeeds, second fails", async () => {
    writeFileSync(join(cwd, "exists.txt"), "content\n");
    const patch = `*** Begin Patch
*** Add File: first.txt
+first
*** Delete File: nonexistent.txt
*** End Patch`;
    const result = await applyPatchDetailed(cwd, patch);
    expect(result.hasPartialSuccess).toBe(true);
    expect(result.appliedFiles).toContain("first.txt");
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].filePath).toBe("nonexistent.txt");
  });

  it("recovery instructions: mustReadFiles = failures, mustNotReadFiles = successes", async () => {
    writeFileSync(join(cwd, "exists.txt"), "content\n");
    const patch = `*** Begin Patch
*** Add File: success.txt
+ok
*** Delete File: missing.txt
*** End Patch`;
    const result = await applyPatchDetailed(cwd, patch);
    expect(result.recoveryInstructions.mustReadFiles).toContain("missing.txt");
    expect(result.recoveryInstructions.mustNotReadFiles).toContain("success.txt");
  });

  it("rejects path escaping workspace via ..", async () => {
    const patch = `*** Begin Patch
*** Add File: ../../escape.txt
+escaped
*** End Patch`;
    const result = await applyPatchDetailed(cwd, patch);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].message).toMatch(/escapes workspace/);
  });

  it("rejects absolute path outside workspace", async () => {
    const outsidePath = join(tmpdir(), "outside-absolute-test.txt");
    const patch = `*** Begin Patch
*** Add File: ${outsidePath}
+escaped
*** End Patch`;
    const result = await applyPatchDetailed(cwd, patch);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].message).toMatch(/escapes workspace/);
  });

  it("accumulates fuzz score across multiple chunks", async () => {
    writeFileSync(join(cwd, "foo.ts"), "line1   \nline2  \n");
    const patch = `*** Begin Patch
*** Update File: foo.ts
-line1
+new1
-line2
+new2
*** End Patch`;
    const result = await applyPatchDetailed(cwd, patch);
    expect(result.failures).toHaveLength(0);
    expect(result.details.fuzz).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pi-coding-tools && npm test`
Expected: FAIL — `Cannot find module '../src/apply'`

- [ ] **Step 3: Write implementation**

Create `pi-coding-tools/src/apply.ts`. Direct adaptation of ref 3's application functions from [ref 3 `src/index.ts`](https://github.com/code-yeongyu/pi-apply-patch/blob/main/src/index.ts). Copy the following from ref 3:

- Error classes: `PatchApplicationError`, `ApplyPatchError`
- Types: `ApplyPatchFailure`, `ApplyPatchRecoveryInstructions`, `ApplyPatchResult`, `ApplyPatchProgress`, `ApplyPatchProgressCallback`
- Path safety functions: `isPathWithinWorkspace`, `findExistingAncestor`, `resolvePatchPath`
- Application functions: `replaceChunks`, `applySingleHunk`, `applyParsedPatchDetailed`, `applyPatchDetailed`, `applyPatch` (the simple version)
- Recovery: `createRecoveryInstructions`
- Helper: `hasErrorCode`

Import from `./parse`: `ParsedPatch`, `PatchChunk`, `parseNonEmptyPatch`, `seekSequence`, `splitFileLines`.
Import from `./write-file-atomic`: `writeFileAtomic`.

The complete source is at the URL above. Copy function bodies exactly.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pi-coding-tools && npm test`
Expected: PASS — all apply tests pass

- [ ] **Step 5: Run typecheck and lint**

Run: `cd pi-coding-tools && npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add pi-coding-tools/src/apply.ts pi-coding-tools/tests/apply.test.ts
git commit -m "feat: add patch application with path safety and recovery"
```

---

### Task 6: Render module (TDD)

**Files:**
- Create: `pi-coding-tools/src/render.ts`
- Test: `pi-coding-tools/tests/render.test.ts`

**Interfaces:**
- Produces: `truncatePreview`, `extractPatchedPaths` (re-exported from parse or standalone), `formatPatchPreview`, `createPatchDiff`, `displayPath`, `formatPatchFilePath`, `formatPatchFileSummary`, `formatInFlightCallText`, `ApplyPatchPreview`, `ApplyPatchPreviewFile` types
- Consumes: `diff` npm package (`Diff.diffLines`, `Diff.diffWords`), `ParsedPatch` from `./parse`, `getLanguageFromPath`, `highlightCode` from `@earendil-works/pi-coding-agent`

> **Implementation note:** Direct adaptation of ref 3's rendering helper functions. Copy `truncatePreview`, `createPatchDiff`, `displayPath`, `formatPatchFilePath`, `formatPatchFileSummary`, `formatInFlightCallText`, `formatPatchPreview`, `formatLineCountSummary`, `formatPatchOperation`, `countLines`, `enforcePreviewCharLimit`, `createChangedHunkPreview`, `countWindowLines`, `formatPreviewWindow`, `isChangedPreviewLine`, `readExistingFileForPreview`, `normalizeDisplayPath`, and related types from [ref 3 `src/index.ts`](https://github.com/code-yeongyu/pi-apply-patch/blob/main/src/index.ts). Do NOT copy `renderCall`/`renderResult` (those go in `apply-patch-tool.ts`).

- [ ] **Step 1: Write the failing test**

Create `pi-coding-tools/tests/render.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  countLines,
  createPatchDiff,
  displayPath,
  extractPatchedPaths,
  formatInFlightCallText,
  formatPatchFileSummary,
  formatPatchPreview,
  truncatePreview,
  type ApplyPatchPreview,
  type ApplyPatchPreviewFile,
} from "../src/render";

describe("truncatePreview", () => {
  it("returns short text unchanged", () => {
    expect(truncatePreview("hello")).toBe("hello");
  });

  it("truncates long text to char limit", () => {
    const long = "x".repeat(5000);
    const result = truncatePreview(long);
    expect(result.length).toBeLessThanOrEqual(4000);
  });

  it("truncates many-line text to line limit", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const result = truncatePreview(lines);
    expect(result.split("\n").length).toBeLessThanOrEqual(16);
  });
});

describe("countLines", () => {
  it("counts 0 for empty string", () => {
    expect(countLines("")).toBe(0);
  });

  it("counts 1 for single line", () => {
    expect(countLines("hello")).toBe(1);
  });

  it("counts multiple lines", () => {
    expect(countLines("a\nb\nc")).toBe(3);
  });
});

describe("extractPatchedPaths", () => {
  it("extracts paths from patch text", () => {
    const patch = `*** Begin Patch
*** Add File: a.txt
+x
*** Update File: b.ts
*** Move to: c.ts
@@ ctx
-old
+new
*** End Patch`;
    expect(extractPatchedPaths(patch)).toEqual(["a.txt", "b.ts", "c.ts"]);
  });

  it("returns empty for no patch markers", () => {
    expect(extractPatchedPaths("nothing")).toEqual([]);
  });
});

describe("displayPath", () => {
  it("returns relative path as-is (normalized to /)", () => {
    expect(displayPath("foo/bar.ts", "/home/user/project")).toBe("foo/bar.ts");
  });

  it("returns relative path for absolute path inside cwd", () => {
    expect(displayPath("/home/user/project/src/file.ts", "/home/user/project")).toBe("src/file.ts");
  });

  it("returns absolute path for path outside cwd", () => {
    expect(displayPath("/etc/passwd", "/home/user/project")).toBe("/etc/passwd");
  });
});

describe("createPatchDiff", () => {
  it("generates diff with added/removed counts", () => {
    const result = createPatchDiff("old line\nsame", "new line\nsame");
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.diff).toContain("+");
    expect(result.diff).toContain("-");
  });

  it("returns zero counts for identical content", () => {
    const result = createPatchDiff("same\ncontent", "same\ncontent");
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
  });
});

describe("formatInFlightCallText", () => {
  it("returns 'Patching' when no paths found", () => {
    expect(formatInFlightCallText("no patch here")).toBe("Patching");
  });

  it("returns 'Patching: path' for single file", () => {
    const patch = "*** Begin Patch\n*** Add File: foo.txt\n+x\n*** End Patch";
    expect(formatInFlightCallText(patch)).toBe("Patching: foo.txt");
  });

  it("returns 'Patching (N files): ...' for multiple files", () => {
    const patch = `*** Begin Patch
*** Add File: a.txt
+x
*** Add File: b.txt
+y
*** End Patch`;
    expect(formatInFlightCallText(patch)).toBe("Patching (2 files): a.txt, b.txt");
  });
});

describe("formatPatchPreview", () => {
  it("formats single file preview", () => {
    const preview: ApplyPatchPreview = {
      files: [
        { filePath: "foo.ts", operation: "add", diff: "+new", added: 1, removed: 0 },
      ],
      added: 1,
      removed: 0,
    };
    const result = formatPatchPreview(preview, "/cwd", false);
    expect(result).toContain("foo.ts");
    expect(result).toContain("+1");
  });

  it("formats multi-file preview", () => {
    const preview: ApplyPatchPreview = {
      files: [
        { filePath: "a.ts", operation: "add", diff: "", added: 1, removed: 0 },
        { filePath: "b.ts", operation: "update", diff: "", added: 2, removed: 1 },
      ],
      added: 3,
      removed: 1,
    };
    const result = formatPatchPreview(preview, "/cwd", false);
    expect(result).toContain("2 files");
    expect(result).toContain("a.ts");
    expect(result).toContain("b.ts");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pi-coding-tools && npm test`
Expected: FAIL — `Cannot find module '../src/render'`

- [ ] **Step 3: Write implementation**

Create `pi-coding-tools/src/render.ts`. Direct adaptation of ref 3's rendering helper functions from [ref 3 `src/index.ts`](https://github.com/code-yeongyu/pi-apply-patch/blob/main/src/index.ts). Copy the following from ref 3:

- Types: `ApplyPatchPreviewFile`, `ApplyPatchPreview`, `ApplyPatchOperation`
- Constants: `PATCH_PREVIEW_MAX_LINES`, `PATCH_PREVIEW_MAX_CHARS`, `PATCH_PREVIEW_HEAD_LINES`, `PATCH_PREVIEW_TAIL_LINES`, `PATCH_PREVIEW_TRUNCATION_MARKER`
- Functions: `countLines`, `enforcePreviewCharLimit`, `countWindowLines`, `formatPreviewWindow`, `isChangedPreviewLine`, `createChangedHunkPreview`, `truncatePreview`, `normalizeDisplayPath`, `displayPath`, `formatPatchFilePath`, `formatLineCountSummary`, `formatPatchOperation`, `formatPatchFileSummary`, `formatPatchPreview`, `formatInFlightCallText`, `readExistingFileForPreview`, `createPatchDiff`, `extractPatchedPaths` (re-export from `./parse` or copy — ref 3 has it in index.ts, put it in parse.ts and re-export here)

Import: `Diff` from `"diff"`, `ParsedPatch` from `./parse`, `getLanguageFromPath`, `highlightCode` from `@earendil-works/pi-coding-agent`, `path` from `node:path`.

Do NOT copy: `renderCall`, `renderResult`, `renderPatchPreview`, `renderOpenCodeLikeDiff`, `renderInlineDiff`, `parseRenderableDiffLine`, `highlightDiffContent`, `replaceTabs`, `renderOpenCodeLikeDiffLine`, `applyLayeredBackground` — these are TUI component functions that go in `apply-patch-tool.ts` (integration layer).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pi-coding-tools && npm test`
Expected: PASS — all render tests pass

- [ ] **Step 5: Run typecheck and lint**

Run: `cd pi-coding-tools && npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add pi-coding-tools/src/render.ts pi-coding-tools/tests/render.test.ts
git commit -m "feat: add TUI rendering helpers for diff preview"
```

---

### Task 7: Search tools module (TDD)

**Files:**
- Create: `pi-coding-tools/src/search-tools.ts`
- Test: `pi-coding-tools/tests/search-tools.test.ts`

**Interfaces:**
- Produces: `enableSearchTools(pi: ExtensionAPI, config: CodingToolsConfig): void`
- Consumes: `ExtensionAPI` from `@earendil-works/pi-coding-agent`, `CodingToolsConfig` from `./config`

- [ ] **Step 1: Write the failing test**

Create `pi-coding-tools/tests/search-tools.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { enableSearchTools } from "../src/search-tools";
import type { CodingToolsConfig } from "../src/config";

function makeMockPi(allTools: string[], activeTools: string[]) {
  let currentActive = [...activeTools];
  return {
    getAllTools: vi.fn(() => allTools),
    getActiveTools: vi.fn(() => [...currentActive]),
    setActiveTools: vi.fn((tools: string[]) => {
      currentActive = [...tools];
    }),
  };
}

const allTrueConfig: CodingToolsConfig = {
  applyPatch: true,
  ls: true,
  find: true,
  grep: true,
};

describe("enableSearchTools", () => {
  it("adds ls/find/grep when not already active", () => {
    const pi = makeMockPi(["read", "bash", "edit", "write", "ls", "find", "grep"], ["read", "bash", "edit", "write"]);
    enableSearchTools(pi as any, allTrueConfig);
    expect(pi.setActiveTools).toHaveBeenCalledWith(
      expect.arrayContaining(["read", "bash", "edit", "write", "ls", "find", "grep"]),
    );
  });

  it("does not duplicate already-active tools", () => {
    const pi = makeMockPi(["read", "bash", "ls", "find", "grep"], ["read", "bash", "ls"]);
    enableSearchTools(pi as any, allTrueConfig);
    const result = pi.setActiveTools.mock.calls[0][0] as string[];
    const lsCount = result.filter((t) => t === "ls").length;
    expect(lsCount).toBe(1);
  });

  it("skips tools not in getAllTools", () => {
    const pi = makeMockPi(["read", "bash"], ["read", "bash"]);
    enableSearchTools(pi as any, allTrueConfig);
    const result = pi.setActiveTools.mock.calls[0][0] as string[];
    expect(result).not.toContain("ls");
    expect(result).not.toContain("find");
    expect(result).not.toContain("grep");
  });

  it("respects config: ls=false skips ls", () => {
    const pi = makeMockPi(["read", "ls", "find", "grep"], ["read"]);
    const config: CodingToolsConfig = { ...allTrueConfig, ls: false };
    enableSearchTools(pi as any, config);
    const result = pi.setActiveTools.mock.calls[0][0] as string[];
    expect(result).not.toContain("ls");
    expect(result).toContain("find");
    expect(result).toContain("grep");
  });

  it("respects config: all false adds nothing", () => {
    const pi = makeMockPi(["read", "ls", "find", "grep"], ["read"]);
    const config: CodingToolsConfig = { applyPatch: true, ls: false, find: false, grep: false };
    enableSearchTools(pi as any, config);
    const result = pi.setActiveTools.mock.calls[0][0] as string[];
    expect(result).toEqual(["read"]);
  });

  it("preserves existing active tools", () => {
    const pi = makeMockPi(["read", "bash", "edit", "ls", "find", "grep"], ["read", "bash", "edit"]);
    enableSearchTools(pi as any, allTrueConfig);
    const result = pi.setActiveTools.mock.calls[0][0] as string[];
    expect(result).toContain("read");
    expect(result).toContain("bash");
    expect(result).toContain("edit");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pi-coding-tools && npm test`
Expected: FAIL — `Cannot find module '../src/search-tools'`

- [ ] **Step 3: Write implementation**

Create `pi-coding-tools/src/search-tools.ts`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CodingToolsConfig } from "./config";

export function enableSearchTools(pi: ExtensionAPI, config: CodingToolsConfig): void {
  const allTools = new Set(pi.getAllTools());
  const current = new Set(pi.getActiveTools());
  const desired = [
    { name: "ls", enabled: config.ls },
    { name: "find", enabled: config.find },
    { name: "grep", enabled: config.grep },
  ] as const;
  for (const { name, enabled } of desired) {
    if (enabled && allTools.has(name) && !current.has(name)) {
      current.add(name);
    }
  }
  pi.setActiveTools([...current]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pi-coding-tools && npm test`
Expected: PASS — all search-tools tests pass

- [ ] **Step 5: Run typecheck and lint**

Run: `cd pi-coding-tools && npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add pi-coding-tools/src/search-tools.ts pi-coding-tools/tests/search-tools.test.ts
git commit -m "feat: add ls/find/grep activation module"
```

---

### Task 8: Apply patch tool definition (integration layer)

**Files:**
- Create: `pi-coding-tools/src/apply-patch-tool.ts`

**Interfaces:**
- Produces: `createApplyPatchTool(): ToolDefinition` — returns a tool definition object with `name`, `label`, `description`, `parameters`, `freeform`, `prepareArguments`, `execute`, `renderCall`, `renderResult`
- Consumes: `parseNonEmptyPatch`, `APPLY_PATCH_LARK_GRAMMAR`, `APPLY_PATCH_FREEFORM_DESCRIPTION`, `ParsedPatch` from `./parse`; `applyParsedPatchDetailed`, `ApplyPatchResult`, `ApplyPatchToolDetails` from `./apply`; rendering functions from `./render`; `defineTool`, `Type`, `Text`, `Box`, `Container`, `Spacer` from packages

> **Implementation note:** This is the integration layer combining parse + apply + render into a tool definition. Adapted from [ref 3 `src/index.ts`](https://github.com/code-yeongyu/pi-apply-patch/blob/main/src/index.ts) `createApplyPatchTool()` function. Copy `normalizeApplyPatchArguments`, `createApplyPatchTool`, and the TUI rendering functions (`applyLayeredBackground`, `renderPatchPreview`, `renderOpenCodeLikeDiff`, `renderInlineDiff`, `parseRenderableDiffLine`, `highlightDiffContent`, `replaceTabs`, `renderOpenCodeLikeDiffLine`, `getApplyPatchRenderState`, `formatPendingPatchUpdate`, `createPendingPatchUpdate`, `createPatchPreview`).

- [ ] **Step 1: Write implementation**

Create `pi-coding-tools/src/apply-patch-tool.ts`. This combines the tool definition and TUI rendering from ref 3. Adapt from [ref 3 `src/index.ts`](https://github.com/code-yeongyu/pi-apply-patch/blob/main/src/index.ts):

Copy from ref 3:
- `normalizeApplyPatchArguments`
- `ApplyPatchToolDetails` type
- `ApplyPatchRenderState` type and `applyPatchRenderStates` Map
- All TUI rendering functions: `applyLayeredBackground`, `renderPatchPreview`, `renderOpenCodeLikeDiff`, `renderInlineDiff`, `parseRenderableDiffLine`, `highlightDiffContent`, `replaceTabs`, `renderOpenCodeLikeDiffLine`, `getApplyPatchRenderState`, `clearApplyPatchRenderState`, `formatPendingPatchUpdate`, `createPendingPatchUpdate`, `createPatchPreview`
- `createApplyPatchTool` function (the main export)

Import from `./parse`: `parseNonEmptyPatch`, `parsePatch`, `APPLY_PATCH_LARK_GRAMMAR`, `APPLY_PATCH_FREEFORM_DESCRIPTION`, `ParsedPatch`, `extractPatchedPaths`, `normalizePatchText`.
Import from `./apply`: `applyParsedPatchDetailed`, `ApplyPatchResult`, `ApplyPatchProgress`.
Import from `./render`: `truncatePreview`, `displayPath`, `formatPatchPreview`, `formatInFlightCallText`, `formatPatchFileSummary`, `formatPatchFilePath`, `formatPatchFileHeader`, `formatLineCountSummary`, `formatPatchOperation`, `createPatchDiff`, `readExistingFileForPreview`, `ApplyPatchPreview`, `ApplyPatchPreviewFile`.
Import from `@earendil-works/pi-coding-agent`: `defineTool`, `getLanguageFromPath`, `highlightCode`.
Import from `@earendil-works/pi-tui`: `Box`, `Container`, `Spacer`, `Text`.
Import from `typebox`: `Type`.
Import `Diff` from `"diff"`.

Key differences from ref 3:
- Remove `syncToolset`, `isOpenAIGptModel`, `GPT_APPLY_PATCH_PROVIDERS`, `STANDARD_EDIT_TOOL_NAMES` — no conditional activation
- Remove `registerApplyPatchExtension` — registration happens in `index.ts`
- Export only `createApplyPatchTool`

- [ ] **Step 2: Run typecheck**

Run: `cd pi-coding-tools && npm run typecheck`
Expected: PASS

- [ ] **Step 3: Run lint**

Run: `cd pi-coding-tools && npm run lint`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add pi-coding-tools/src/apply-patch-tool.ts
git commit -m "feat: add apply_patch tool definition with TUI rendering"
```

---

### Task 9: Extension entry point

**Files:**
- Create: `pi-coding-tools/index.ts`

**Interfaces:**
- Produces: default export function `(pi: ExtensionAPI) => void`
- Consumes: `createApplyPatchTool` from `./src/apply-patch-tool`, `enableSearchTools` from `./src/search-tools`, `loadConfig` from `./src/config`

- [ ] **Step 1: Write implementation**

Create `pi-coding-tools/index.ts`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createApplyPatchTool } from "./src/apply-patch-tool";
import { loadConfig } from "./src/config";
import { enableSearchTools } from "./src/search-tools";

export default function (pi: ExtensionAPI) {
  const config = loadConfig();

  if (config.applyPatch) {
    pi.registerTool(createApplyPatchTool());
  }

  pi.on("session_start", async (_event, _ctx) => {
    enableSearchTools(pi, config);
  });
}
```

- [ ] **Step 2: Run typecheck**

Run: `cd pi-coding-tools && npm run typecheck`
Expected: PASS

- [ ] **Step 3: Run all tests**

Run: `cd pi-coding-tools && npm test`
Expected: PASS — all tests still pass

- [ ] **Step 4: Run lint**

Run: `cd pi-coding-tools && npm run lint`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pi-coding-tools/index.ts
git commit -m "feat: add extension entry point with config-gated tool registration"
```

---

### Task 10: Documentation files

**Files:**
- Create: `pi-coding-tools/AGENTS.md`
- Create: `pi-coding-tools/RELEASE.md`
- Create: `pi-coding-tools/README.md`

- [ ] **Step 1: Create AGENTS.md**

```markdown
# pi-coding-tools Agent 指南

发布新版本请参考 RELEASE.md。
```

- [ ] **Step 2: Create RELEASE.md**

```markdown
# 发布新版本

发布通过 GitHub Actions 自动完成，触发条件是推送 `pi-coding-tools-v*` 格式的 git tag。

## 操作步骤

```bash
cd pi-coding-tools

# 1. 升级版本号并打 tag
npm version <新版本号> --no-git-tag-version
git add package.json package-lock.json
git commit -m "<新版本号>"
git tag pi-coding-tools-v<新版本号>

# 2. 推送
git push origin main --tags

# 3. 创建 GitHub Release（触发发布）
gh release create pi-coding-tools-v<新版本号> --title "pi-coding-tools v<新版本号>" --notes ""
```

创建 Release 后，`.github/workflows/publish.yml` 响应 `release: published` 事件，执行 `npm install` + `npm publish --provenance`（OIDC 认证，无需本地 npm token）。

发布到：`@yandy0725/pi-coding-tools@X.Y.Z`（public access）

## 注意事项

- `npm version` 在 monorepo 子目录下不会自动 commit/tag，需手动操作
- tag 格式必须是 `pi-coding-tools-vX.Y.Z`，不能是 `vX.Y.Z`
- 发布前确保 `npm run typecheck`、`npm run lint`、`npm run test` 全部通过
```

- [ ] **Step 3: Create README.md**

```markdown
# pi-coding-tools

Pi package providing the `apply_patch` tool and enabling `ls`/`find`/`grep` built-in tools.

## Features

- **apply_patch**: Apply Codex-style patches to files (add/update/delete/move) using a freeform grammar — no JSON wrapping needed.
- **ls/find/grep**: Enables these built-in tools that are off by default.

## Installation

```bash
pi install npm:@yandy0725/pi-coding-tools
```

## Configuration

Configuration files control which tools are enabled. All default to `true`.

### Global config

`~/.pi/agent/coding-tools.json`:

```json
{
  "applyPatch": true,
  "ls": true,
  "find": true,
  "grep": true
}
```

### Project config

`<project>/.pi/coding-tools.json` (overrides global):

```json
{
  "grep": false
}
```

### Fields

| Field | Default | Description |
|-------|---------|-------------|
| `applyPatch` | `true` | Register the `apply_patch` tool |
| `ls` | `true` | Enable the `ls` built-in tool |
| `find` | `true` | Enable the `find` built-in tool |
| `grep` | `true` | Enable the `grep` built-in tool |

## Patch Format

The `apply_patch` tool uses Codex text format:

```
*** Begin Patch
*** Add File: new.txt
+Hello, World!
*** Update File: existing.ts
@@ function foo() {
-old line
+new line
*** Delete File: old.txt
*** End Patch
```

See the [Codex apply_patch documentation](https://github.com/code-yeongyu/pi-apply-patch) for full syntax details.
```

- [ ] **Step 4: Commit**

```bash
git add pi-coding-tools/AGENTS.md pi-coding-tools/RELEASE.md pi-coding-tools/README.md
git commit -m "docs: add AGENTS.md, RELEASE.md, README.md"
```

---

### Task 11: CI workflow updates

**Files:**
- Modify: `.github/workflows/publish.yml`
- Modify: `.github/workflows/test.yml`

- [ ] **Step 1: Update publish.yml**

In `.github/workflows/publish.yml`, find the `Determine package directory` step and add a new case before the closing `esac`:

```yaml
            pi-coding-tools-v*)
              echo "dir=pi-coding-tools" >> "$GITHUB_OUTPUT"
              ;;
```

The full case block should now read:

```yaml
      - name: Determine package directory
        id: info
        run: |
          TAG="${{ github.event.release.tag_name }}"
          case "$TAG" in
            pi-container-sandbox-v*)
              echo "dir=pi-container-sandbox" >> "$GITHUB_OUTPUT"
              ;;
            pi-web-tools-v*)
              echo "dir=pi-web-tools" >> "$GITHUB_OUTPUT"
              ;;
            pi-coding-tools-v*)
              echo "dir=pi-coding-tools" >> "$GITHUB_OUTPUT"
              ;;
          esac
```

- [ ] **Step 2: Update test.yml**

In `.github/workflows/test.yml`, find the `filters` section and add a new entry:

```yaml
        filters: |
            pi-container-sandbox:
              - "pi-container-sandbox/**"
            pi-web-tools:
              - "pi-web-tools/**"
            pi-coding-tools:
              - "pi-coding-tools/**"
```

- [ ] **Step 3: Verify YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/publish.yml')); yaml.safe_load(open('.github/workflows/test.yml')); print('OK')"`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/publish.yml .github/workflows/test.yml
git commit -m "ci: add pi-coding-tools to publish and test workflows"
```

---

### Task 12: Final verification

- [ ] **Step 1: Run all tests**

Run: `cd pi-coding-tools && npm test`
Expected: PASS — all tests pass

- [ ] **Step 2: Run typecheck**

Run: `cd pi-coding-tools && npm run typecheck`
Expected: PASS — no type errors

- [ ] **Step 3: Run lint**

Run: `cd pi-coding-tools && npm run lint`
Expected: PASS — no lint errors

- [ ] **Step 4: Run format check**

Run: `cd pi-coding-tools && npm run check`
Expected: PASS

- [ ] **Step 5: Verify package can be loaded as a pi extension**

Run: `cd pi-coding-tools && node -e "import('./index.ts').then(m => console.log(typeof m.default)).catch(e => console.error(e.message))"`
Expected: prints `function` (the default export is a function)

> Note: This may fail if jiti is not available. In that case, skip this step — the real test is `pi -e ./pi-coding-tools` in a live session.

- [ ] **Step 6: Final commit if any formatting changes**

```bash
cd pi-coding-tools && npm run format
git add -A
git diff --cached --quiet || git commit -m "style: format code"
```
