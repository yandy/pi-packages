# ast_grep_replace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `ast_grep_replace` tool to `@yandy0725/pi-coding-tools` that performs AST-aware code rewrite via the ast-grep CLI, dry-run by default (preview without writing), with an `apply` flag to write changes to disk.

**Architecture:** A new `src/ast-grep/rewrite.ts` core layer reuses the existing binary resolution (`getAstGrepPath`) and language inference (`inferLangFromPath`) to spawn `ast-grep run -p PATTERN -r REWRITE --json=compact` (plus `-U` when applying). A new `src/tools/ast-grep-replace.ts` tool wraps it with a `formatRewriteResult` formatter producing before→after previews. Config gains an `ast_grep_replace` toggle. All existing search code is untouched.

**Tech Stack:** TypeScript (ESM), ast-grep CLI (`@ast-grep/cli`), typebox schemas, vitest, biome (tab indent, double quotes, semicolons, trailing commas).

## Global Constraints

- Package root: `pi-coding-tools/` (run commands from repo root with `-w pi-coding-tools` or `cd pi-coding-tools`).
- Style: biome — tab indentation, double quotes, semicolons always, trailing commas `all`, arrow parens always, lineWidth 120. Verify with `npm run check`.
- Test runner: vitest. Commands: `npm test -w pi-coding-tools`, `npm run typecheck -w pi-coding-tools`, `npm run check -w pi-coding-tools`.
- Existing types (`CliMatch`, `SgResult`, `RunSgOptions`) MUST NOT be modified — add new types alongside.
- `INSTALL_HINT` is reused from `search.ts`; do not duplicate install text.
- Default config value for `ast_grep_replace` is `true` (enabled).
- All commands assume CWD = repo root `/home/yandy/workspace/pri/pi-packages`.

---

## File Structure

| File | Responsibility | Status |
|------|----------------|--------|
| `pi-coding-tools/src/ast-grep/types.ts` | Add rewrite types (`CliRewriteMatch`, `SgRewriteResult`, `RunSgRewriteOptions`) | Modify |
| `pi-coding-tools/src/ast-grep/rewrite.ts` | `runAstGrepRewrite()` + `parseRewriteStdout()` — spawn CLI, parse JSON with `replacement` | Create |
| `pi-coding-tools/src/formatters.ts` | Add `formatRewriteResult()` — before→after preview + apply summary | Modify |
| `pi-coding-tools/src/tools/ast-grep-replace.ts` | `ast_grep_replace` tool definition (params + execute) | Create |
| `pi-coding-tools/src/config.ts` | Add `ast_grep_replace` boolean to interface, default, merge | Modify |
| `pi-coding-tools/src/search-tools.ts` | Add `"ast_grep_replace"` to `ALL_TOOL_NAMES` | Modify |
| `pi-coding-tools/index.ts` | Register `ast_grep_replace` | Modify |
| `pi-coding-tools/tests/ast-grep/rewrite.test.ts` | Unit test `parseRewriteStdout` | Create |
| `pi-coding-tools/tests/ast-grep/rewrite.integration.test.ts` | Integration: dry-run no write, apply writes | Create |
| `pi-coding-tools/tests/formatters.test.ts` | `formatRewriteResult` tests | Modify |
| `pi-coding-tools/tests/tools-registration.test.ts` | `ast_grep_replace` dry-run/apply/binary-missing | Modify |
| `pi-coding-tools/tests/search-tools.test.ts` | Add `ast_grep_replace` to configs | Modify |
| `pi-coding-tools/tests/config.test.ts` | Add `ast_grep_replace` to `baseTrue` | Modify |
| `pi-coding-tools/README.md` | Document new tool + config field | Modify |

---

### Task 1: Rewrite types

**Files:**
- Modify: `pi-coding-tools/src/ast-grep/types.ts`

**Interfaces:**
- Produces: `CliRewriteMatch` (extends `CliMatch` with `replacement: string` and `replacementOffsets: { start: number; end: number }`), `SgRewriteResult` (matches, totalMatches, truncated, truncatedReason?, error?, applied: boolean), `RunSgRewriteOptions` (extends `RunSgOptions` with `rewrite: string; apply: boolean`).

- [ ] **Step 1: Add the three new types to the end of `types.ts`**

Append after the existing `RunSgOptions` interface (do NOT modify any existing type):

```ts
export interface CliRewriteMatch extends CliMatch {
	replacement: string;
	replacementOffsets: { start: number; end: number };
}

export interface SgRewriteResult {
	matches: CliRewriteMatch[];
	totalMatches: number;
	truncated: boolean;
	truncatedReason?: SgTruncationReason;
	error?: string;
	applied: boolean;
}

export interface RunSgRewriteOptions extends RunSgOptions {
	rewrite: string;
	apply: boolean;
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck -w pi-coding-tools`
Expected: PASS (no errors) — types are additive and unused-yet types are fine because biome `noUnusedVariables` does not flag exported interfaces.

- [ ] **Step 3: Commit**

```bash
git add pi-coding-tools/src/ast-grep/types.ts
git commit -m "feat(pi-coding-tools): add ast-grep rewrite types"
```

---

### Task 2: Rewrite core layer — `parseRewriteStdout` (TDD)

**Files:**
- Create: `pi-coding-tools/src/ast-grep/rewrite.ts`
- Test: `pi-coding-tools/tests/ast-grep/rewrite.test.ts`

**Interfaces:**
- Consumes: `CliRewriteMatch`, `SgRewriteResult` from Task 1.
- Produces: `parseRewriteStdout(stdout: string): Pick<SgRewriteResult, "matches" | "totalMatches" | "truncated">` — returns `{ matches: CliRewriteMatch[]; totalMatches: number; truncated: boolean }`.

- [ ] **Step 1: Write the failing test**

Create `pi-coding-tools/tests/ast-grep/rewrite.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseRewriteStdout } from "../../src/ast-grep/rewrite";

const sampleRewriteMatches = [
	{
		text: 'console.log("hi")',
		file: "src/index.ts",
		lines: 'console.log("hi");\n',
		language: "typescript",
		charCount: { leading: 0, trailing: 1 },
		range: {
			start: { line: 4, column: 0 },
			end: { line: 4, column: 19 },
			byteOffset: { start: 0, end: 19 },
		},
		replacement: 'logger.info("hi")',
		replacementOffsets: { start: 0, end: 19 },
	},
];

describe("parseRewriteStdout", () => {
	it("parses valid compact json array with replacement fields", () => {
		const result = parseRewriteStdout(JSON.stringify(sampleRewriteMatches));
		expect(result.matches).toHaveLength(1);
		expect(result.matches[0].file).toBe("src/index.ts");
		expect(result.matches[0].replacement).toBe('logger.info("hi")');
		expect(result.matches[0].replacementOffsets).toEqual({ start: 0, end: 19 });
		expect(result.totalMatches).toBe(1);
		expect(result.truncated).toBe(false);
	});

	it("returns empty on blank stdout", () => {
		const result = parseRewriteStdout("   ");
		expect(result.matches).toEqual([]);
		expect(result.totalMatches).toBe(0);
		expect(result.truncated).toBe(false);
	});

	it("returns empty on invalid json", () => {
		const result = parseRewriteStdout("not json");
		expect(result.matches).toEqual([]);
		expect(result.totalMatches).toBe(0);
	});

	it("returns empty when matches lack replacement field", () => {
		const noReplacement = [{ text: "x", file: "a.ts", lines: "x", language: "typescript", charCount: { leading: 0, trailing: 0 }, range: { start: { line: 0, column: 0 }, end: { line: 0, column: 1 }, byteOffset: { start: 0, end: 1 } } }];
		const result = parseRewriteStdout(JSON.stringify(noReplacement));
		expect(result.matches).toEqual([]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w pi-coding-tools -- rewrite.test 2>&1 | tail -20`
Expected: FAIL — `Cannot find module '../../src/ast-grep/rewrite'` (file does not exist yet).

- [ ] **Step 3: Write minimal implementation of `parseRewriteStdout`**

Create `pi-coding-tools/src/ast-grep/rewrite.ts`:

```ts
import type { CliRewriteMatch, SgRewriteResult } from "./types";

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isCliRewriteMatch(v: unknown): v is CliRewriteMatch {
	if (!isRecord(v)) return false;
	const range = v.range;
	const charCount = v.charCount;
	const replacementOffsets = v.replacementOffsets;
	if (
		!isRecord(range) ||
		!isRecord(charCount) ||
		!isRecord(replacementOffsets) ||
		!isRecord(range.byteOffset) ||
		!isRecord(range.start) ||
		!isRecord(range.end)
	) {
		return false;
	}
	return (
		typeof v.text === "string" &&
		typeof v.file === "string" &&
		typeof v.lines === "string" &&
		typeof v.language === "string" &&
		typeof v.replacement === "string" &&
		typeof charCount.leading === "number" &&
		typeof charCount.trailing === "number" &&
		typeof range.byteOffset.start === "number" &&
		typeof range.byteOffset.end === "number" &&
		typeof range.start.line === "number" &&
		typeof range.start.column === "number" &&
		typeof range.end.line === "number" &&
		typeof range.end.column === "number" &&
		typeof replacementOffsets.start === "number" &&
		typeof replacementOffsets.end === "number"
	);
}

export function parseRewriteStdout(stdout: string): Pick<SgRewriteResult, "matches" | "totalMatches" | "truncated"> {
	if (!stdout.trim()) return { matches: [], totalMatches: 0, truncated: false };
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return { matches: [], totalMatches: 0, truncated: false };
	}
	const matches =
		Array.isArray(parsed) && parsed.every(isCliRewriteMatch) ? (parsed as CliRewriteMatch[]) : [];
	return { matches, totalMatches: matches.length, truncated: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w pi-coding-tools -- rewrite.test 2>&1 | tail -20`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add pi-coding-tools/src/ast-grep/rewrite.ts pi-coding-tools/tests/ast-grep/rewrite.test.ts
git commit -m "feat(pi-coding-tools): add parseRewriteStdout for ast-grep rewrite"
```

---

### Task 3: Rewrite core layer — `runAstGrepRewrite`

**Files:**
- Modify: `pi-coding-tools/src/ast-grep/rewrite.ts`

**Interfaces:**
- Consumes: `getAstGrepPath` from `./binary`, `CliLanguage`, `RunSgRewriteOptions`, `SgRewriteResult` from `./types`, `parseRewriteStdout` from same file.
- Produces: `runAstGrepRewrite(options: RunSgRewriteOptions): Promise<SgRewriteResult>` — spawns `ast-grep run -p -r --json=compact` (+`-U` when `apply`), returns result with `applied` set from `options.apply`.

- [ ] **Step 1: Add `runAstGrepRewrite` to `rewrite.ts`**

Add these imports at the top of `pi-coding-tools/src/ast-grep/rewrite.ts` (merge with existing import line — keep the `CliRewriteMatch`/`SgRewriteResult` import, add the rest):

```ts
import { spawn } from "node:child_process";
import { getAstGrepPath } from "./binary";
import type { CliLanguage, RunSgRewriteOptions, SgRewriteResult } from "./types";
```

(Replace the existing `import type { CliRewriteMatch, SgRewriteResult } from "./types";` line with the above two import lines — `CliRewriteMatch` is still referenced inside `isCliRewriteMatch`, so keep it: use `import type { CliLanguage, CliRewriteMatch, RunSgRewriteOptions, SgRewriteResult } from "./types";` plus the `spawn` and `getAstGrepPath` imports.)

Append `runAstGrepRewrite` and its helpers after `parseRewriteStdout`:

```ts
const REWRITE_TIMEOUT_MS = 30_000;

const INSTALL_HINT = [
	"ast-grep binary not found.",
	"",
	"Install options:",
	"  npm install -g @ast-grep/cli",
	"  cargo install ast-grep --locked",
	"  brew install ast-grep",
].join("\n");

function buildRewriteArgs(options: RunSgRewriteOptions): string[] {
	const args = [
		"run",
		"-p",
		options.pattern,
		"-r",
		options.rewrite,
		"--lang",
		options.lang,
		"--json=compact",
	];
	if (options.apply) args.push("-U");
	args.push(...(options.paths.length > 0 ? options.paths : ["."]));
	return args;
}

export async function runAstGrepRewrite(options: RunSgRewriteOptions): Promise<SgRewriteResult> {
	const cliPath = await getAstGrepPath();
	if (!cliPath) {
		return { matches: [], totalMatches: 0, truncated: false, error: INSTALL_HINT, applied: options.apply };
	}

	return new Promise<SgRewriteResult>((resolve) => {
		const proc = spawn(cliPath, buildRewriteArgs(options), { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			proc.kill("SIGKILL");
			resolve({
				matches: [],
				totalMatches: 0,
				truncated: true,
				truncatedReason: "timeout",
				error: "rewrite timed out",
				applied: options.apply,
			});
		}, REWRITE_TIMEOUT_MS);

		proc.stdout.setEncoding("utf-8");
		proc.stderr.setEncoding("utf-8");
		proc.stdout.on("data", (c: string) => (stdout += c));
		proc.stderr.on("data", (c: string) => (stderr += c));

		proc.once("error", () => {
			clearTimeout(timer);
			resolve({ matches: [], totalMatches: 0, truncated: false, error: INSTALL_HINT, applied: options.apply });
		});
		proc.once("close", (code) => {
			clearTimeout(timer);
			if (code !== 0 && !stdout.trim()) {
				if (stderr.includes("No files found")) {
					resolve({ matches: [], totalMatches: 0, truncated: false, applied: options.apply });
					return;
				}
				resolve({
					matches: [],
					totalMatches: 0,
					truncated: false,
					error: stderr.trim() || `ast-grep exited with code ${code}`,
					applied: options.apply,
				});
				return;
			}
			const parsed = parseRewriteStdout(stdout);
			resolve({ ...parsed, applied: options.apply });
		});
	});
}
```

- [ ] **Step 2: Verify typecheck + existing tests still pass**

Run: `npm run typecheck -w pi-coding-tools && npm test -w pi-coding-tools -- rewrite.test 2>&1 | tail -20`
Expected: typecheck PASS; rewrite.test PASS (4 tests). `runAstGrepRewrite` is not yet unit-tested (integration test comes in Task 5) but must compile.

- [ ] **Step 3: Commit**

```bash
git add pi-coding-tools/src/ast-grep/rewrite.ts
git commit -m "feat(pi-coding-tools): add runAstGrepRewrite CLI runner"
```

---

### Task 4: `formatRewriteResult` formatter (TDD)

**Files:**
- Modify: `pi-coding-tools/src/formatters.ts`
- Test: `pi-coding-tools/tests/formatters.test.ts`

**Interfaces:**
- Consumes: `CliRewriteMatch`, `SgRewriteResult` from `./ast-grep/types`.
- Produces: `formatRewriteResult(result: SgRewriteResult): string`.

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block at the end of `pi-coding-tools/tests/formatters.test.ts`. Also add the import of `formatRewriteResult` to the existing import line from `"../src/formatters"`.

Update the import line (currently `import { formatHover, formatNavigate, formatSearchResult, formatSymbolTree } from "../src/formatters";`) to:

```ts
import { formatHover, formatNavigate, formatRewriteResult, formatSearchResult, formatSymbolTree } from "../src/formatters";
```

Add `CliRewriteMatch`/`SgRewriteResult` to the existing type import (currently `import type { SgResult } from "../src/ast-grep/types";`):

```ts
import type { CliRewriteMatch, SgResult, SgRewriteResult } from "../src/ast-grep/types";
```

Append this block at the end of the file:

```ts
const rewriteMatch: CliRewriteMatch = {
	text: 'console.log("hi")',
	file: "src/index.ts",
	lines: 'console.log("hi");\n',
	language: "typescript",
	charCount: { leading: 0, trailing: 1 },
	range: { start: { line: 4, column: 0 }, end: { line: 4, column: 19 }, byteOffset: { start: 0, end: 19 } },
	replacement: 'logger.info("hi")',
	replacementOffsets: { start: 0, end: 19 },
};

describe("formatRewriteResult", () => {
	it("dry-run lists before→after with file:line and dry-run marker", () => {
		const out = formatRewriteResult({
			matches: [rewriteMatch],
			totalMatches: 1,
			truncated: false,
			applied: false,
		});
		expect(out).toContain("1 match");
		expect(out).toContain("dry-run");
		expect(out).toContain("src/index.ts:5:1");
		expect(out).toContain('console.log("hi")');
		expect(out).toContain('logger.info("hi")');
	});

	it("groups by file with count in dry-run", () => {
		const m2 = { ...rewriteMatch, range: { ...rewriteMatch.range, start: { line: 10, column: 0 } } };
		const out = formatRewriteResult({
			matches: [rewriteMatch, m2],
			totalMatches: 2,
			truncated: false,
			applied: false,
		});
		expect(out).toContain("src/index.ts (2 matches)");
	});

	it("apply mode shows Applied summary with per-file changes", () => {
		const out = formatRewriteResult({
			matches: [rewriteMatch],
			totalMatches: 1,
			truncated: false,
			applied: true,
		});
		expect(out).toContain("Applied 1 change");
		expect(out).toContain("src/index.ts (1 change)");
		expect(out).not.toContain("dry-run");
	});

	it("no matches", () => {
		expect(
			formatRewriteResult({ matches: [], totalMatches: 0, truncated: false, applied: false }),
		).toContain("No matches");
	});

	it("surfaces error", () => {
		expect(
			formatRewriteResult({ matches: [], totalMatches: 0, truncated: false, error: "boom", applied: false }),
		).toContain("boom");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w pi-coding-tools -- formatters.test 2>&1 | tail -20`
Expected: FAIL — `formatRewriteResult is not a function` (not exported yet).

- [ ] **Step 3: Implement `formatRewriteResult`**

Add to `pi-coding-tools/src/formatters.ts`. Add `CliRewriteMatch`/`SgRewriteResult` to the existing type import line (currently `import type { CliMatch, SgResult } from "./ast-grep/types";`):

```ts
import type { CliMatch, CliRewriteMatch, SgResult, SgRewriteResult } from "./ast-grep/types";
```

Append this function at the end of the file (after `formatNavigate`):

```ts
export function formatRewriteResult(result: SgRewriteResult): string {
	if (result.error) return `Error: ${result.error}`;
	if (result.matches.length === 0) return "No matches found";

	const byFile = new Map<string, CliRewriteMatch[]>();
	for (const m of result.matches) {
		const arr = byFile.get(m.file) ?? [];
		arr.push(m);
		byFile.set(m.file, arr);
	}

	const lines: string[] = [];
	if (result.applied) {
		lines.push(`Applied ${result.matches.length} change(s) across ${byFile.size} file(s)`);
		for (const [file, ms] of byFile) {
			lines.push(`${file} (${ms.length} change${ms.length > 1 ? "s" : ""})`);
		}
	} else {
		lines.push(`${result.matches.length} match(es) • ${byFile.size} file(s) [dry-run, no files written]`);
		for (const [file, ms] of byFile) {
			lines.push(`${file} (${ms.length} match${ms.length > 1 ? "es" : ""})`);
			for (const m of ms) {
				const loc = `${m.range.start.line + 1}:${m.range.start.column + 1}`;
				lines.push(`  ${m.file}:${loc}  - ${m.text.trim()}`);
				lines.push(`  ${" ".repeat(m.file.length + loc.length + 6)}+ ${m.replacement.trim()}`);
			}
		}
	}
	if (result.truncated) {
		lines.push(`(truncated, ${result.totalMatches} total)`);
	}
	return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w pi-coding-tools -- formatters.test 2>&1 | tail -20`
Expected: PASS — all formatter tests pass (existing + 5 new).

- [ ] **Step 5: Commit**

```bash
git add pi-coding-tools/src/formatters.ts pi-coding-tools/tests/formatters.test.ts
git commit -m "feat(pi-coding-tools): add formatRewriteResult before→after formatter"
```

---

### Task 5: Integration test — dry-run vs apply (TDD)

**Files:**
- Create: `pi-coding-tools/tests/ast-grep/rewrite.integration.test.ts`

**Interfaces:**
- Consumes: `runAstGrepRewrite` from `../../src/ast-grep/rewrite`, `findAstGrepPathSync`/`resetResolvedForTests` from `../../src/ast-grep/binary`.

This task resolves the open risk: confirm `-U` + `--json=compact` actually writes files. The apply test asserts the file content changed.

- [ ] **Step 1: Write the integration test**

Create `pi-coding-tools/tests/ast-grep/rewrite.integration.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findAstGrepPathSync, resetResolvedForTests } from "../../src/ast-grep/binary";
import { runAstGrepRewrite } from "../../src/ast-grep/rewrite";

resetResolvedForTests();

describe.skipIf(findAstGrepPathSync() === null)("ast-grep rewrite integration (real binary)", () => {
	let fixtureDir: string;
	let fixtureFile: string;

	beforeAll(() => {
		fixtureDir = mkdtempSync(join(tmpdir(), "sg-rewrite-integ-"));
		fixtureFile = join(fixtureDir, "a.ts");
		writeFileSync(fixtureFile, 'console.log("hi");\n');
	});

	afterAll(() => {
		rmSync(fixtureDir, { recursive: true, force: true });
	});

	it("dry-run returns replacement preview without writing files", async () => {
		const result = await runAstGrepRewrite({
			pattern: "console.log($MSG)",
			rewrite: "logger.info($MSG)",
			lang: "typescript",
			paths: [fixtureDir],
			apply: false,
		});
		expect(result.error).toBeUndefined();
		expect(result.applied).toBe(false);
		expect(result.matches.length).toBeGreaterThanOrEqual(1);
		expect(result.matches[0].replacement).toBe('logger.info("hi")');
		// file unchanged
		expect(readFileSync(fixtureFile, "utf-8")).toBe('console.log("hi");\n');
	});

	it("apply writes the replacement to disk", async () => {
		const result = await runAstGrepRewrite({
			pattern: "console.log($MSG)",
			rewrite: "logger.info($MSG)",
			lang: "typescript",
			paths: [fixtureDir],
			apply: true,
		});
		expect(result.error).toBeUndefined();
		expect(result.applied).toBe(true);
		expect(result.matches.length).toBeGreaterThanOrEqual(1);
		// file changed
		expect(readFileSync(fixtureFile, "utf-8")).toBe('logger.info("hi");\n');
	});
});
```

- [ ] **Step 2: Run the integration test**

Run: `npm test -w pi-coding-tools -- rewrite.integration 2>&1 | tail -30`
Expected: PASS — both tests pass. This confirms `-U` + `--json=compact` writes files AND returns structured matches. If the apply test FAILS (file unchanged), the fallback is: change `buildRewriteArgs` so apply mode does NOT use `--json=compact` (drop it when `options.apply`), parse the `Applied N changes` line from stdout for the count, and adjust `runAstGrepRewrite` to build a synthetic match list — but only do this if the test fails. Prefer the current implementation which the test validates.

- [ ] **Step 3: Commit**

```bash
git add pi-coding-tools/tests/ast-grep/rewrite.integration.test.ts
git commit -m "test(pi-coding-tools): ast-grep rewrite dry-run vs apply integration"
```

---

### Task 6: `ast_grep_replace` tool definition

**Files:**
- Create: `pi-coding-tools/src/tools/ast-grep-replace.ts`

**Interfaces:**
- Consumes: `AST_GREP_LANGUAGES` from `./ast-grep-search`, `inferLangFromPath` from `../ast-grep/search`, `runAstGrepRewrite` from `../ast-grep/rewrite`, `getPatternHint` from `../ast-grep/pattern-hints`, `formatRewriteResult` from `../formatters`, `CliLanguage` + `CliRewriteMatch` from `../ast-grep/types`.
- Produces: exported `ast_grep_replace` tool object (same shape as `ast_grep_search`).

- [ ] **Step 1: Create the tool file**

Create `pi-coding-tools/src/tools/ast-grep-replace.ts`:

```ts
import type { defineTool as DefineToolType, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getPatternHint } from "../ast-grep/pattern-hints";
import { runAstGrepRewrite } from "../ast-grep/rewrite";
import { inferLangFromPath } from "../ast-grep/search";
import type { CliLanguage, CliRewriteMatch } from "../ast-grep/types";
import { formatRewriteResult } from "../formatters";
import { AST_GREP_LANGUAGES } from "./ast-grep-search";

const defineTool = ((t) => t) as typeof DefineToolType;

function isCliLanguage(v: unknown): v is CliLanguage {
	return typeof v === "string" && (AST_GREP_LANGUAGES as readonly string[]).includes(v);
}

const ReplaceParams = Type.Object({
	pattern: Type.String({
		description:
			"AST pattern with $VAR (single node) and $$$ (zero-or-more nodes). NOT regex. Must be a complete AST node.",
	}),
	rewrite: Type.String({
		description:
			"Replacement string. Reference captured meta-variables, e.g. 'logger.info($MSG)'. The same $VAR/$$$ syntax as the pattern.",
	}),
	lang: Type.Optional(
		Type.String({
			description: "Language: typescript/tsx/javascript/python/java/kotlin/c/cpp. Omit to infer from path extension.",
		}),
	),
	path: Type.Optional(Type.String({ description: "File or directory to rewrite (default: cwd)" })),
	apply: Type.Optional(
		Type.Boolean({
			description:
				"Default false = dry-run: preview changes WITHOUT writing files. Set true to write changes to disk.",
		}),
	),
});

export interface AstGrepReplaceDetails {
	pattern: string;
	rewrite: string;
	lang?: CliLanguage;
	paths: string[];
	apply: boolean;
	matches: CliRewriteMatch[];
	totalMatches: number;
	truncated: boolean;
	error?: string;
	hint?: string;
}

export const ast_grep_replace = defineTool({
	name: "ast_grep_replace",
	label: "AST Grep Replace",
	description:
		"Rewrite code by AST structure (AST-aware find-and-replace). Dry-run by default: previews before→after changes WITHOUT writing. " +
		"Set apply=true to write changes to disk. Patterns use $VAR (single node) and $$$ (zero-or-more nodes) — NOT regex.",
	promptSnippet: "AST-aware rewrite (dry-run by default; apply=true to write)",
	promptGuidelines: [
		"Use ast_grep_replace for structural code changes. It is dry-run by default — call with apply=true only after reviewing the preview.",
		"Patterns are AST nodes, not regex. Use $VAR (e.g. $MSG) to capture a node and reference it in rewrite, $$$ for zero-or-more nodes. Example: pattern 'console.log($MSG)', rewrite 'logger.info($MSG)'.",
		"Always dry-run first (omit apply) to preview before→after, then call again with apply=true to write. Do NOT use regex constructs (\\w, .*, |).",
	],
	parameters: ReplaceParams,
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const cwd = (ctx as ExtensionContext).cwd;
		const path = params.path ?? cwd;
		const apply = params.apply === true;
		let lang: CliLanguage | undefined = params.lang
			? isCliLanguage(params.lang)
				? params.lang
				: undefined
			: inferLangFromPath(path);
		if (params.lang && !isCliLanguage(params.lang)) {
			return {
				content: [{ type: "text" as const, text: `Unsupported language: ${params.lang}` }],
				details: {
					pattern: params.pattern,
					rewrite: params.rewrite,
					paths: [path],
					apply,
					matches: [],
					totalMatches: 0,
					truncated: false,
				},
			};
		}
		if (!lang) lang = "typescript";

		const result = await runAstGrepRewrite({ pattern: params.pattern, rewrite: params.rewrite, lang, paths: [path], apply });
		const text = formatRewriteResult(result);
		const hint =
			result.matches.length === 0 && !result.error ? (getPatternHint(params.pattern, lang) ?? undefined) : undefined;
		const finalText = hint ? `${text}\n\n${hint}` : text;

		const details: AstGrepReplaceDetails = {
			pattern: params.pattern,
			rewrite: params.rewrite,
			lang,
			paths: [path],
			apply,
			matches: result.matches,
			totalMatches: result.totalMatches,
			truncated: result.truncated,
		};
		if (result.error !== undefined) details.error = result.error;
		if (hint !== undefined) details.hint = hint;

		return { content: [{ type: "text" as const, text: finalText }], details };
	},
});
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck -w pi-coding-tools 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add pi-coding-tools/src/tools/ast-grep-replace.ts
git commit -m "feat(pi-coding-tools): add ast_grep_replace tool definition"
```

---

### Task 7: Tool registration tests (TDD)

**Files:**
- Modify: `pi-coding-tools/tests/tools-registration.test.ts`

**Interfaces:**
- Consumes: `ast_grep_replace` from `../src/tools/ast-grep-replace`, `runAstGrepRewrite` from `../src/ast-grep/rewrite`.

- [ ] **Step 1: Add mocks and tests for `ast_grep_replace`**

In `pi-coding-tools/tests/tools-registration.test.ts`, add a mock for the rewrite module alongside the existing search mock. After the existing `vi.mock("../src/ast-grep/search", ...)` block, add:

```ts
vi.mock("../src/ast-grep/rewrite", () => ({
	runAstGrepRewrite: vi.fn(),
}));
```

Add the import of `runAstGrepRewrite` and `ast_grep_replace`. Near the existing `import { runAstGrep } from "../src/ast-grep/search";` add:

```ts
import { runAstGrepRewrite } from "../src/ast-grep/rewrite";
```

Near the existing `import { ast_grep_search } from "../src/tools/ast-grep-search";` add:

```ts
import { ast_grep_replace } from "../src/tools/ast-grep-replace";
```

Add a `CliRewriteMatch`-shaped fixture and a new `describe` block (place after the `ast_grep_search` describe block, before the `lsp tools` describe block):

```ts
const rewriteOk: Awaited<ReturnType<typeof runAstGrepRewrite>> = {
	matches: [
		{
			text: 'console.log("hi")',
			file: "src/index.ts",
			lines: 'console.log("hi");\n',
			language: "typescript",
			charCount: { leading: 0, trailing: 1 },
			range: { start: { line: 4, column: 0 }, end: { line: 4, column: 19 }, byteOffset: { start: 0, end: 19 } },
			replacement: 'logger.info("hi")',
			replacementOffsets: { start: 0, end: 19 },
		},
	],
	totalMatches: 1,
	truncated: false,
	applied: false,
};

describe("ast_grep_replace tool", () => {
	it("has correct name and schema", () => {
		expect(ast_grep_replace.name).toBe("ast_grep_replace");
		expect(ast_grep_replace.parameters).toBeDefined();
	});

	it("dry-run previews without applying", async () => {
		vi.mocked(runAstGrepRewrite).mockResolvedValueOnce(rewriteOk);
		const res = await ast_grep_replace.execute(
			"id",
			{ pattern: "console.log($MSG)", rewrite: "logger.info($MSG)", lang: "typescript", path: "src" },
			undefined,
			undefined,
			{ cwd: "/proj" } as never,
		);
		const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		expect(text).toContain("dry-run");
		expect(text).toContain("src/index.ts:5:1");
		expect(text).toContain('logger.info("hi")');
		// apply flag defaults to false in the call
		expect(vi.mocked(runAstGrepRewrite).mock.calls[0][0].apply).toBe(false);
	});

	it("apply=true is forwarded", async () => {
		vi.mocked(runAstGrepRewrite).mockResolvedValueOnce({ ...rewriteOk, applied: true });
		const res = await ast_grep_replace.execute(
			"id",
			{ pattern: "console.log($MSG)", rewrite: "logger.info($MSG)", apply: true, path: "src" },
			undefined,
			undefined,
			{ cwd: "/proj" } as never,
		);
		const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		expect(text).toContain("Applied 1 change");
		expect(vi.mocked(runAstGrepRewrite).mock.calls[0][0].apply).toBe(true);
	});

	it("surfaces binary-missing error", async () => {
		vi.mocked(runAstGrepRewrite).mockResolvedValueOnce({
			matches: [],
			totalMatches: 0,
			truncated: false,
			error: "ast-grep binary not found.",
			applied: false,
		});
		const res = await ast_grep_replace.execute(
			"id",
			{ pattern: "x", rewrite: "y", lang: "typescript", path: "src" },
			undefined,
			undefined,
			{ cwd: "/proj" } as never,
		);
		const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		expect(text).toContain("ast-grep binary not found");
	});

	it("appends pattern hint when no matches and no error", async () => {
		vi.mocked(runAstGrepRewrite).mockResolvedValueOnce({ matches: [], totalMatches: 0, truncated: false, applied: false });
		const res = await ast_grep_replace.execute(
			"id",
			{ pattern: "foo\\w+", rewrite: "bar", lang: "typescript", path: "src" },
			undefined,
			undefined,
			{ cwd: "/proj" } as never,
		);
		const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		expect(text).toMatch(/regex/);
	});
});
```

- [ ] **Step 2: Run the new tests**

Run: `npm test -w pi-coding-tools -- tools-registration 2>&1 | tail -30`
Expected: PASS — all 5 new `ast_grep_replace` tests pass plus existing tests.

- [ ] **Step 3: Commit**

```bash
git add pi-coding-tools/tests/tools-registration.test.ts
git commit -m "test(pi-coding-tools): ast_grep_replace tool registration tests"
```

---

### Task 8: Config + tool-status integration

**Files:**
- Modify: `pi-coding-tools/src/config.ts`
- Modify: `pi-coding-tools/src/search-tools.ts`
- Modify: `pi-coding-tools/tests/config.test.ts`
- Modify: `pi-coding-tools/tests/search-tools.test.ts`

**Interfaces:**
- Produces: `CodingToolsConfig.ast_grep_replace: boolean`; `ALL_TOOL_NAMES` includes `"ast_grep_replace"`.

- [ ] **Step 1: Add the config field — write failing test first**

In `pi-coding-tools/tests/config.test.ts`, update the `baseTrue` const (currently has fields through `lsp_navigate: true`) to add `ast_grep_replace: true`:

```ts
const baseTrue = {
	ls: true,
	find: true,
	grep: true,
	ast_grep_search: true,
	ast_grep_replace: true,
	lsp_symbols: true,
	lsp_hover: true,
	lsp_navigate: true,
};
```

In `pi-coding-tools/tests/search-tools.test.ts`, update `allTrueConfig` and the all-false config to include `ast_grep_replace`. Add `ast_grep_replace: true,` to `allTrueConfig`, and `ast_grep_replace: false,` to the "all false removes everything" config. Also add `"ast_grep_replace"` to the `arrayContaining` expectation list in the first test and to the `makeMockPi(["read", "ls", "find", "grep", "ast_grep_search", "lsp_symbols", "lsp_hover", "lsp_navigate"])` array in the "all false" test.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w pi-coding-tools -- "config.test|search-tools" 2>&1 | tail -30`
Expected: FAIL — type errors / assertion failures because `ast_grep_replace` is not yet on `CodingToolsConfig`.

- [ ] **Step 3: Implement the config field**

In `pi-coding-tools/src/config.ts`:

Add `ast_grep_replace: boolean;` to the `CodingToolsConfig` interface, right after `ast_grep_search: boolean;`.

Add `ast_grep_replace: true,` to `DEFAULT_CONFIG`, right after `ast_grep_search: true,`.

Add this merge line in `loadConfig`, right after the `ast_grep_search` line:

```ts
		ast_grep_replace: projectConfig.ast_grep_replace ?? globalConfig.ast_grep_replace ?? DEFAULT_CONFIG.ast_grep_replace,
```

In `pi-coding-tools/src/search-tools.ts`, update `ALL_TOOL_NAMES`:

```ts
const ALL_TOOL_NAMES = [
	"ls",
	"find",
	"grep",
	"ast_grep_search",
	"ast_grep_replace",
	"lsp_symbols",
	"lsp_hover",
	"lsp_navigate",
] as const;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w pi-coding-tools -- "config.test|search-tools" 2>&1 | tail -30`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pi-coding-tools/src/config.ts pi-coding-tools/src/search-tools.ts pi-coding-tools/tests/config.test.ts pi-coding-tools/tests/search-tools.test.ts
git commit -m "feat(pi-coding-tools): add ast_grep_replace config toggle"
```

---

### Task 9: Register tool in index.ts

**Files:**
- Modify: `pi-coding-tools/index.ts`

- [ ] **Step 1: Register the tool**

In `pi-coding-tools/index.ts`, add the import (after the existing `ast_grep_search` import):

```ts
import { ast_grep_replace } from "./src/tools/ast-grep-replace";
```

Add the registration call (after `pi.registerTool(ast_grep_search);`):

```ts
	pi.registerTool(ast_grep_replace);
```

- [ ] **Step 2: Verify typecheck + full test suite**

Run: `npm run typecheck -w pi-coding-tools && npm test -w pi-coding-tools 2>&1 | tail -30`
Expected: typecheck PASS; all tests PASS.

- [ ] **Step 3: Commit**

```bash
git add pi-coding-tools/index.ts
git commit -m "feat(pi-coding-tools): register ast_grep_replace tool"
```

---

### Task 10: README documentation

**Files:**
- Modify: `pi-coding-tools/README.md`

- [ ] **Step 1: Add the tool to the features table and config fields**

In `pi-coding-tools/README.md`, in the AST/LSP tools table (the one with rows for `ast_grep_search`, `lsp_symbols`, etc.), add a row after `ast_grep_search`:

```markdown
| `ast_grep_replace` | AST-aware 重写代码（dry-run 预览，apply=true 写盘） | ast-grep CLI `-r`/`-U` |
```

In the config fields table (the `| Field | Default | Description |` table), add a row after the `ast_grep_search` row:

```markdown
| `ast_grep_replace` | `true` | Enable the AST-based code rewrite tool (dry-run by default) |
```

In the config JSON example block (the one with `"ast_grep_search": true,`), add `"ast_grep_replace": true,` after the `ast_grep_search` line.

- [ ] **Step 2: Commit**

```bash
git add pi-coding-tools/README.md
git commit -m "docs(pi-coding-tools): document ast_grep_replace tool"
```

---

### Task 11: Final verification

- [ ] **Step 1: Run the full verification suite**

Run: `cd pi-coding-tools && npm run typecheck && npm run check && npm test 2>&1 | tail -40`
Expected: typecheck PASS, biome check PASS, all tests PASS.

- [ ] **Step 2: Smoke-test the tool manually (optional but recommended)**

Run a quick dry-run against the package's own source:

```bash
cd pi-coding-tools && npx ast-grep run -p 'console.log($MSG)' -r 'logger.info($MSG)' --lang typescript --json=compact src 2>&1 | head -c 200
```

Expected: JSON array (likely empty if no console.log in src, which is fine — confirms the CLI invocation works).

- [ ] **Step 3: No commit needed if all green — work is complete**

If any check fails, fix and re-run. Once green, the feature is complete and ready for release per `pi-coding-tools/RELEASE.md`.
