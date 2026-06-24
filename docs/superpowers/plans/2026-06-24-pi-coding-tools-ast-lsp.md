# pi-coding-tools AST/LSP 代码理解工具 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 扩展 `pi-coding-tools` 包，新增 4 个 token-efficient 代码理解工具（`ast_grep_search` / `lsp_symbols` / `lsp_hover` / `lsp_navigate`），让 LLM 用最少 token 理解代码库。

**Architecture:** 三层工具集——文件级（ls/find/grep，现有）+ AST 级（`ast_grep_search`，ast-grep CLI）+ 语义级（`lsp_symbols`/`lsp_hover`/`lsp_navigate`，LSP via `vscode-jsonrpc`）。最小 LSP manager：懒加载 + 进程缓存 + 空闲超时(5min) + 崩溃驱逐重启一次。所有工具通过 `coding-tools.json` 配置可开关。

**Tech Stack:** TypeScript (typebox schemas), ast-grep CLI (`@ast-grep/cli`), `vscode-jsonrpc` (LSP), `extract-zip` (可选下载), vitest, biome.

## Global Constraints

- **工作区**：先用 `using-git-worktrees` skill 建隔离 worktree，所有改动在 worktree 内进行。monorepo 根 `/home/yandy/workspace/pri/pi-packages`，目标包 `pi-coding-tools/`。
- **包管理**：用 npm workspaces（根 `package.json` 已含 `pi-coding-tools` workspace）。装依赖在**根目录** `npm install`（workspace 联动）。
- **风格**：biome（lint/format），vitest（test），`tsc --noEmit`（typecheck）。tab 缩进（现有文件用 tab）。无 `any`，无 enum（用字面量联合 + StringEnum）。
- **工具命名**：机制前缀——`ast_grep_search` / `lsp_symbols` / `lsp_hover` / `lsp_navigate`（不用 `code_*`）。
- **位置约定**：对外 `line` 1-based、`character` 0-based；内部转 LSP 0-based（`line - 1`）。
- **ast-grep 二进制名**：同时找 `ast-grep`（Linux/cargo/brew 标准，优先）和 `sg`（`@ast-grep/cli` npm shim）。命令用 `ast-grep run --json=compact`。
- **P0 语言**：ts/js、python、java、kotlin、c/c++。
- **不做**：lsp_symbols ast-grep fallback、ast_grep_replace、lsp rename、refcount/init-reaping、napi（已评估放弃，仅内置 ts/js）。
- **版本**：`pi-coding-tools` 0.2.0 → 0.3.0。
- **每任务结束**：`npm run check --workspace pi-coding-tools`（tsc+biome）+ `npm test --workspace pi-coding-tools` 全绿后 commit。

**参考代码（已克隆在 `.superpowers/refs/`，仅阅读借鉴，代码自写）**：
- `.superpowers/refs/pi-ast-grep/src/ast-grep/`（binary-path.ts, cli.ts, json-output.ts, result-formatter.ts, pattern-hints.ts, tools.ts, types.ts）
- `.superpowers/refs/pi-lsp-client/src/lsp/`（manager.ts, client.ts, connection.ts, constants.ts, language-mappings.ts, server-definitions.ts）

---

## File Structure

**Create:**
- `pi-coding-tools/src/ast-grep/binary.ts` — `ast-grep`/`sg` 二进制解析（PATH→npm→平台包→可选下载）
- `pi-coding-tools/src/ast-grep/pattern-hints.ts` — 正则误用检测（纯函数）
- `pi-coding-tools/src/ast-grep/search.ts` — 执行 `ast-grep run`，解析 JSON，返回 `SgResult`
- `pi-coding-tools/src/ast-grep/types.ts` — `CliMatch`/`SgResult`/`RunSgOptions` 类型
- `pi-coding-tools/src/formatters.ts` — 各工具紧凑输出格式化（纯函数）
- `pi-coding-tools/src/lsp/types.ts` — LSP 协议子集类型（DocumentSymbol/Location/Hover/MarkedString）
- `pi-coding-tools/src/lsp/servers.ts` — 每语言服务器定义 + 语言检测
- `pi-coding-tools/src/lsp/client.ts` — JSON-RPC over stdio 客户端（didOpen/hover/docSymbol/def/refs）
- `pi-coding-tools/src/lsp/manager.ts` — `LspManager`（懒加载+进程缓存+空闲超时+崩溃重启+dispose）
- `pi-coding-tools/src/tools/ast-grep-search.ts` — `ast_grep_search` 工具定义
- `pi-coding-tools/src/tools/lsp-symbols.ts` — `lsp_symbols` 工具定义
- `pi-coding-tools/src/tools/lsp-hover.ts` — `lsp_hover` 工具定义
- `pi-coding-tools/src/tools/lsp-navigate.ts` — `lsp_navigate` 工具定义
- `pi-coding-tools/tests/ast-grep/pattern-hints.test.ts`
- `pi-coding-tools/tests/ast-grep/search.test.ts`
- `pi-coding-tools/tests/formatters.test.ts`
- `pi-coding-tools/tests/lsp/servers.test.ts`
- `pi-coding-tools/tests/lsp/client.test.ts`
- `pi-coding-tools/tests/lsp/manager.test.ts`
- `pi-coding-tools/tests/lsp/fixtures/fake-lsp-server.mjs`
- `pi-coding-tools/tests/tools-registration.test.ts`
- `pi-coding-tools/tests/sg-binary.integration.test.ts`
- `pi-coding-tools/NOTICE`

**Modify:**
- `pi-coding-tools/index.ts` — 注册 4 工具 + session_start 激活 + session_shutdown dispose
- `pi-coding-tools/src/config.ts` — 扩展 4 工具布尔 + `lsp` 配置块
- `pi-coding-tools/src/search-tools.ts` — `enableSearchTools`→`enableTools`，管理 7 工具活动集
- `pi-coding-tools/tests/config.test.ts` — 扩展新字段断言
- `pi-coding-tools/tests/search-tools.test.ts` — 改名 `enableTools` + 新工具断言
- `pi-coding-tools/package.json` — version 0.3.0 + deps
- `pi-coding-tools/README.md` — 4 工具说明
- `README.md`（根）— pi-coding-tools 描述行修正

---

## Task 1: Worktree + 依赖脚手架 + 配置扩展

**Files:**
- Modify: `pi-coding-tools/package.json`
- Modify: `pi-coding-tools/src/config.ts`
- Modify: `pi-coding-tools/tests/config.test.ts`
- Create: `pi-coding-tools/NOTICE`

**Interfaces:**
- Produces: `CodingToolsConfig`（含 `ast_grep_search`/`lsp_symbols`/`lsp_hover`/`lsp_navigate` 布尔 + `lsp?: { disabled?: boolean; servers?: Record<string, ServerOverride> }`），`loadConfig(cwd?)`

- [ ] **Step 1: 建 git worktree（用 using-git-worktrees skill）**

在 monorepo 根目录执行（创建隔离工作区）：
```bash
cd /home/yandy/workspace/pri/pi-packages
git worktree add .worktrees/pi-coding-tools-ast-lsp -b feat/pi-coding-tools-ast-lsp main
cd .worktrees/pi-coding-tools-ast-lsp
```
后续所有命令都在 `.worktrees/pi-coding-tools-ast-lsp` 下执行。worktree 共享主仓库的 git 对象，npm workspaces 在 worktree 内重新 `npm ci` 或 `npm install` 即可。

- [ ] **Step 2: 加依赖到 pi-coding-tools/package.json**

把 `pi-coding-tools/package.json` 的 `version` 改为 `"0.3.0"`，`dependencies` 从 `{}` 改为：
```json
	"dependencies": {
		"@ast-grep/cli": "^0.41.1",
		"extract-zip": "^2.0.1",
		"vscode-jsonrpc": "^8.2.1"
	},
```
保留现有 `peerDependencies`、`devDependencies`、`pi.extensions`、`files`（`files` 已是 `["index.ts", "src/"]`，新增 src 子目录自动覆盖）。

- [ ] **Step 3: 在根目录装依赖**

```bash
cd .worktrees/pi-coding-tools-ast-lsp
npm install
```
预期：根 `package-lock.json` 更新，`pi-coding-tools/node_modules` 软链到根 `node_modules`。

- [ ] **Step 4: 写失败测试 — config 扩展字段**

替换 `pi-coding-tools/tests/config.test.ts` 全文为：
```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";

const baseTrue = {
	ls: true,
	find: true,
	grep: true,
	ast_grep_search: true,
	lsp_symbols: true,
	lsp_hover: true,
	lsp_navigate: true,
};

describe("loadConfig", () => {
	afterEach(() => {
		vi.resetModules();
	});

	it("returns all-true defaults when no config files", () => {
		vi.doMock("@earendil-works/pi-coding-agent", () => ({
			getAgentDir: () => "/nonexistent-agent-dir",
			CONFIG_DIR_NAME: ".pi",
		}));
		const { loadConfig } = require("../src/config");
		const cfg = loadConfig("/nonexistent-cwd");
		expect(cfg).toEqual(baseTrue);
	});

	it("merges global then project (project wins)", () => {
		vi.doMock("@earendil-works/pi-coding-agent", () => ({
			getAgentDir: () => "/nonexistent-agent-dir",
			CONFIG_DIR_NAME: ".pi",
		}));
		vi.doMock("node:fs", () => ({
			readFileSync: (p: string) => {
				if (p.endsWith("agent/coding-tools.json")) return JSON.stringify({ lsp_hover: false, grep: false });
				if (p.endsWith(".pi/coding-tools.json")) return JSON.stringify({ lsp_hover: true });
				throw new Error("not found");
			},
		}));
		const { loadConfig } = require("../src/config");
		const cfg = loadConfig("/proj");
		expect(cfg.lsp_hover).toBe(true); // project overrides global
		expect(cfg.grep).toBe(false); // global only, not overridden by project
	});

	it("parses lsp block with disabled + servers", () => {
		vi.doMock("@earendil-works/pi-coding-agent", () => ({
			getAgentDir: () => "/nonexistent-agent-dir",
			CONFIG_DIR_NAME: ".pi",
		}));
		vi.doMock("node:fs", () => ({
			readFileSync: (p: string) => {
				if (p.endsWith(".pi/coding-tools.json"))
					return JSON.stringify({
						lsp: { disabled: true, servers: { clangd: { disabled: true } } },
					});
				throw new Error("not found");
			},
		}));
		const { loadConfig } = require("../src/config");
		const cfg = loadConfig("/proj");
		expect(cfg.lsp?.disabled).toBe(true);
		expect(cfg.lsp?.servers?.["clangd"]?.disabled).toBe(true);
	});
});
```

- [ ] **Step 5: 运行测试确认失败**

```bash
npm test --workspace pi-coding-tools -- config.test
```
预期：FAIL（`ast_grep_search` 等字段 undefined，`lsp` undefined）。

- [ ] **Step 6: 实现 config.ts**

替换 `pi-coding-tools/src/config.ts` 全文为：
```typescript
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ServerOverride {
	command?: string[];
	disabled?: boolean;
	priority?: number;
	env?: Record<string, string>;
}

export interface LspConfig {
	disabled?: boolean;
	servers?: Record<string, ServerOverride>;
}

export interface CodingToolsConfig {
	ls: boolean;
	find: boolean;
	grep: boolean;
	ast_grep_search: boolean;
	lsp_symbols: boolean;
	lsp_hover: boolean;
	lsp_navigate: boolean;
	lsp?: LspConfig;
}

const DEFAULT_CONFIG: CodingToolsConfig = {
	ls: true,
	find: true,
	grep: true,
	ast_grep_search: true,
	lsp_symbols: true,
	lsp_hover: true,
	lsp_navigate: true,
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
		ls: projectConfig.ls ?? globalConfig.ls ?? DEFAULT_CONFIG.ls,
		find: projectConfig.find ?? globalConfig.find ?? DEFAULT_CONFIG.find,
		grep: projectConfig.grep ?? globalConfig.grep ?? DEFAULT_CONFIG.grep,
		ast_grep_search: projectConfig.ast_grep_search ?? globalConfig.ast_grep_search ?? DEFAULT_CONFIG.ast_grep_search,
		lsp_symbols: projectConfig.lsp_symbols ?? globalConfig.lsp_symbols ?? DEFAULT_CONFIG.lsp_symbols,
		lsp_hover: projectConfig.lsp_hover ?? globalConfig.lsp_hover ?? DEFAULT_CONFIG.lsp_hover,
		lsp_navigate: projectConfig.lsp_navigate ?? globalConfig.lsp_navigate ?? DEFAULT_CONFIG.lsp_navigate,
		lsp: projectConfig.lsp ?? globalConfig.lsp ?? DEFAULT_CONFIG.lsp,
	};
	cachedCwd = dir;
	return cachedConfig;
}
```

- [ ] **Step 7: 运行测试确认通过**

```bash
npm test --workspace pi-coding-tools -- config.test
```
预期：PASS（3 个测试全绿）。

- [ ] **Step 8: 创建 NOTICE**

创建 `pi-coding-tools/NOTICE`：
```
pi-coding-tools

Copyright (c) 2026 yandy

This package's ast-grep binary resolution logic (PATH / npm package / platform
package / GitHub release download) is adapted from pi-ast-grep
(https://github.com/code-yeongyu/pi-ast-grep), MIT licensed, Copyright (c)
Yeongyu Kim. See the ast-grep CLI itself at https://ast-grep.github.io.

The LSP client/manager patterns are informed by pi-lsp-client
(https://github.com/code-yeongyu/pi-lsp-client), MIT licensed.
```

- [ ] **Step 9: typecheck + lint + commit**

```bash
npm run check --workspace pi-coding-tools
git add pi-coding-tools/package.json pi-coding-tools/src/config.ts pi-coding-tools/tests/config.test.ts pi-coding-tools/NOTICE package-lock.json
git commit -m "feat(pi-coding-tools): extend config schema for ast/lsp tools + deps"
```

---

## Task 2: ast-grep 类型 + pattern-hints（纯函数）

**Files:**
- Create: `pi-coding-tools/src/ast-grep/types.ts`
- Create: `pi-coding-tools/src/ast-grep/pattern-hints.ts`
- Test: `pi-coding-tools/tests/ast-grep/pattern-hints.test.ts`

**Interfaces:**
- Produces: `CliMatch`/`Position`/`Range`/`SgResult`/`RunSgOptions` 类型；`getPatternHint(pattern, lang): string | null`

- [ ] **Step 1: 写失败测试 — pattern-hints**

创建 `pi-coding-tools/tests/ast-grep/pattern-hints.test.ts`：
```typescript
import { describe, expect, it } from "vitest";
import { getPatternHint } from "../../src/ast-grep/pattern-hints";

describe("getPatternHint", () => {
	it("detects \\w regex escape", () => {
		expect(getPatternHint("foo\\w+", "typescript")).toMatch(/regex/);
	});

	it("detects .* wildcard", () => {
		expect(getPatternHint("foo.*bar", "typescript")).toMatch(/regex|\$\$\$/);
	});

	it("detects alternation |", () => {
		expect(getPatternHint("foo|bar", "typescript")).toMatch(/alternation/);
	});

	it("detects python trailing colon on def", () => {
		expect(getPatternHint("def foo():", "python")).toMatch(/trailing colon/);
	});

	it("detects incomplete ts function pattern", () => {
		expect(getPatternHint("function $NAME", "typescript")).toMatch(/params and body/);
	});

	it("returns null for valid pattern", () => {
		expect(getPatternHint("console.log($MSG)", "typescript")).toBeNull();
	});
});
```

- [ ] **Step 2: 运行确认失败**

```bash
npm test --workspace pi-coding-tools -- pattern-hints
```
预期：FAIL（模块不存在）。

- [ ] **Step 3: 实现 types.ts**

创建 `pi-coding-tools/src/ast-grep/types.ts`：
```typescript
export type CliLanguage =
	| "typescript" | "tsx" | "javascript" | "python" | "java"
	| "kotlin" | "c" | "cpp";

export interface Position {
	line: number; // 0-based
	column: number; // 0-based
}

export interface Range {
	start: Position;
	end: Position;
	byteOffset: { start: number; end: number };
}

export interface CliMatch {
	text: string;
	range: Range;
	file: string;
	lines: string;
	charCount: { leading: number; trailing: number };
	language: string;
}

export type SgTruncationReason = "max_matches" | "max_output_bytes" | "timeout";

export interface SgResult {
	matches: CliMatch[];
	totalMatches: number;
	truncated: boolean;
	truncatedReason?: SgTruncationReason;
	error?: string;
}

export interface RunSgOptions {
	pattern: string;
	lang: CliLanguage;
	paths: string[];
}
```

- [ ] **Step 4: 实现 pattern-hints.ts**

创建 `pi-coding-tools/src/ast-grep/pattern-hints.ts`（移植自 pi-ast-grep，限定我们的语言集）：
```typescript
import type { CliLanguage } from "./types";

export function detectRegexMisuse(pattern: string): string | null {
	const src = pattern.trim();
	if (/\\[wWdDsSbB]/.test(src)) {
		return 'Hint: "\\w", "\\d", "\\s", "\\b" are regex escapes. ast-grep matches AST nodes, not text - use $VAR for identifiers, $$$ for node lists, or switch to grep for text search.';
	}
	if (/\[[a-zA-Z0-9]-[a-zA-Z0-9]\]/.test(src)) {
		return 'Hint: "[a-z]" and similar character classes are regex, not AST. Use $VAR to match any identifier, or switch to grep for text search.';
	}
	if (!src.includes("$") && /\w\.[*+]/.test(src)) {
		return 'Hint: ".*" and ".+" are regex wildcards. In ast-grep use $$$ for multiple AST nodes and $VAR for a single node. For text patterns, switch to grep.';
	}
	if (/^[-\w.*]+\|[-\w.*|]+$/.test(src)) {
		return 'Hint: "|" is regex alternation and does NOT work in ast-grep patterns. Options: (a) fire one ast_grep_search per alternative, or (b) switch to grep with a regex pattern like "foo|bar".';
	}
	return null;
}

export function detectLanguageSpecificMistake(pattern: string, lang: CliLanguage): string | null {
	const src = pattern.trim();
	if (lang === "python") {
		if (src.startsWith("class ") && src.endsWith(":")) return `Hint: Remove trailing colon. Try: "${src.slice(0, -1)}"`;
		if ((src.startsWith("def ") || src.startsWith("async def ")) && src.endsWith(":"))
			return `Hint: Remove trailing colon. Try: "${src.slice(0, -1)}"`;
	}
	if (lang === "typescript" || lang === "tsx" || lang === "javascript") {
		if (/^(export\s+)?(async\s+)?function\s+\$[A-Z_]+\s*$/i.test(src))
			return 'Hint: Function patterns need params and body. Try "function $NAME($$$) { $$$ }"';
	}
	if (lang === "kotlin" || lang === "java") {
		if (/^(public\s+)?(static\s+)?(final\s+)?(class|void|int|String)\s+\$[A-Z_]+\s*$/i.test(src))
			return 'Hint: Method patterns need params and body. Try a full signature like "void $NAME($$$) { $$$ }"';
	}
	return null;
}

export function getPatternHint(pattern: string, lang: CliLanguage): string | null {
	return detectRegexMisuse(pattern) ?? detectLanguageSpecificMistake(pattern, lang);
}
```

- [ ] **Step 5: 运行确认通过**

```bash
npm test --workspace pi-coding-tools -- pattern-hints
```
预期：PASS（6 个测试全绿）。

- [ ] **Step 6: check + commit**

```bash
npm run check --workspace pi-coding-tools
git add pi-coding-tools/src/ast-grep/types.ts pi-coding-tools/src/ast-grep/pattern-hints.ts pi-coding-tools/tests/ast-grep/pattern-hints.test.ts
git commit -m "feat(pi-coding-tools): ast-grep types + regex pattern hints"
```

---

## Task 3: ast-grep 二进制解析（PATH + npm + 平台包，无自动下载 v1）

**Files:**
- Create: `pi-coding-tools/src/ast-grep/binary.ts`

**Interfaces:**
- Produces: `getAstGrepPath(): Promise<string | null>`, `findAstGrepPathSync(): string | null`
- Consumes: `@ast-grep/cli`（通过 createRequire 解析）

> v1 不做 GitHub 自动下载（PI_OFFLINE gating 留 P1）。先找 PATH（`ast-grep` 优先 + `sg`）→ `@ast-grep/cli` 包内 shim → 平台 npm 包。找不到返回 null，工具层给安装提示。

- [ ] **Step 1: 实现 binary.ts**

创建 `pi-coding-tools/src/ast-grep/binary.ts`：
```typescript
import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";

const MIN_BINARY_SIZE_BYTES = 10_000;

function isValidBinary(filePath: string): boolean {
	try {
		return statSync(filePath).size > MIN_BINARY_SIZE_BYTES;
	} catch {
		return false;
	}
}

const PLATFORM_PACKAGE_MAP: Record<string, string> = {
	"darwin-arm64": "@ast-grep/cli-darwin-arm64",
	"darwin-x64": "@ast-grep/cli-darwin-x64",
	"linux-arm64": "@ast-grep/cli-linux-arm64-gnu",
	"linux-x64": "@ast-grep/cli-linux-x64-gnu",
	"win32-x64": "@ast-grep/cli-win32-x64-msvc",
	"win32-arm64": "@ast-grep/cli-win32-arm64-msvc",
};

function getPlatformPackageName(): string | null {
	return PLATFORM_PACKAGE_MAP[`${process.platform}-${process.arch}`] ?? null;
}

function findOnPath(binaryName: string): string | null {
	const isWindows = process.platform === "win32";
	const pathEnv = process.env["PATH"] ?? (isWindows ? (process.env["Path"] ?? "") : "");
	if (!pathEnv) return null;
	const exts = isWindows ? ["", ".exe"] : [""];
	for (const dir of pathEnv.split(delimiter)) {
		for (const suffix of exts) {
			const candidate = join(dir, binaryName + suffix);
			if (existsSync(candidate) && isValidBinary(candidate)) return candidate;
		}
	}
	return null;
}

// ast-grep 二进制名因安装方式而异：cargo/brew/Linux 装的是 `ast-grep`；
// @ast-grep/cli npm 包内部 shim 叫 `sg`。优先找 ast-grep（标准名），再找 sg。
function findBinaryInCliPackage(binaryName: string): string | null {
	try {
		const require = createRequire(import.meta.url);
		const cliPackageJsonPath = require.resolve("@ast-grep/cli/package.json");
		const cliDirectory = dirname(cliPackageJsonPath);
		const p = join(cliDirectory, binaryName);
		if (existsSync(p) && isValidBinary(p)) return p;
	} catch {}
	return null;
}

function findBinaryInPlatformPackage(): string | null {
	const platformPackage = getPlatformPackageName();
	if (!platformPackage) return null;
	try {
		const require = createRequire(import.meta.url);
		const packageJsonPath = require.resolve(`${platformPackage}/package.json`);
		const packageDirectory = dirname(packageJsonPath);
		const binaryName = process.platform === "win32" ? "ast-grep.exe" : "ast-grep";
		const p = join(packageDirectory, binaryName);
		if (existsSync(p) && isValidBinary(p)) return p;
	} catch {}
	return null;
}

export function findAstGrepPathSync(): string | null {
	// 1. PATH: ast-grep 优先（Linux/cargo/brew 标准），再 sg（npm shim）
	const onPath = findOnPath("ast-grep") ?? findOnPath("sg");
	if (onPath) return onPath;
	// 2. @ast-grep/cli 包内 sg shim
	const inCli = findBinaryInCliPackage(process.platform === "win32" ? "sg.exe" : "sg");
	if (inCli) return inCli;
	// 3. 平台 npm 包（二进制名 ast-grep）
	const inPlatform = findBinaryInPlatformPackage();
	if (inPlatform) return inPlatform;
	return null;
}

let resolved: string | null = null;

export async function getAstGrepPath(): Promise<string | null> {
	if (resolved && existsSync(resolved)) return resolved;
	const p = findAstGrepPathSync();
	if (p) resolved = p;
	return p;
}

export function resetResolvedForTests(): void {
	resolved = null;
}
```

> 注：此任务无独立单测（涉及文件系统/npm 解析，靠 Task 4 的集成测试覆盖）。`resetResolvedForTests` 供后续测试用。

- [ ] **Step 2: typecheck + commit**

```bash
npm run check --workspace pi-coding-tools
git add pi-coding-tools/src/ast-grep/binary.ts
git commit -m "feat(pi-coding-tools): ast-grep binary resolution (ast-grep + sg, PATH/npm/platform)"
```

---

## Task 4: ast-grep 搜索执行 + JSON 解析 + 输出格式化

**Files:**
- Create: `pi-coding-tools/src/ast-grep/search.ts`
- Create: `pi-coding-tools/src/formatters.ts`
- Test: `pi-coding-tools/tests/ast-grep/search.test.ts`
- Test: `pi-coding-tools/tests/formatters.test.ts`

**Interfaces:**
- Produces: `runAstGrep(options: RunSgOptions): Promise<SgResult>`；`formatSearchResult(result: SgResult): string`；`formatSymbolTree(...)`/`formatHover(...)`/`formatNavigate(...)`（Task 8 用，本任务先建 search + formatSearchResult）
- Consumes: `getAstGrepPath`（Task 3），`CliMatch`/`SgResult`/`RunSgOptions`（Task 2）

- [ ] **Step 1: 写失败测试 — search JSON 解析（注入假 stdout）**

创建 `pi-coding-tools/tests/ast-grep/search.test.ts`：
```typescript
import { describe, expect, it } from "vitest";
import { parseSgStdout } from "../../src/ast-grep/search";

const sampleMatches = [
	{
		text: "console.log(\"hi\")",
		file: "src/index.ts",
		lines: "console.log(\"hi\");\n",
		language: "typescript",
		charCount: { leading: 0, trailing: 0 },
		range: {
			start: { line: 10, column: 2 },
			end: { line: 10, column: 20 },
			byteOffset: { start: 0, end: 20 },
		},
	},
];

describe("parseSgStdout", () => {
	it("parses valid compact json array", () => {
		const result = parseSgStdout(JSON.stringify(sampleMatches));
		expect(result.matches).toHaveLength(1);
		expect(result.matches[0].file).toBe("src/index.ts");
		expect(result.matches[0].range.start.line).toBe(10);
		expect(result.totalMatches).toBe(1);
		expect(result.truncated).toBe(false);
	});

	it("returns empty on blank stdout", () => {
		const result = parseSgStdout("   ");
		expect(result.matches).toEqual([]);
		expect(result.totalMatches).toBe(0);
	});

	it("returns empty on invalid json", () => {
		const result = parseSgStdout("not json");
		expect(result.matches).toEqual([]);
		expect(result.totalMatches).toBe(0);
	});
});
```

- [ ] **Step 2: 运行确认失败**

```bash
npm test --workspace pi-coding-tools -- search.test
```
预期：FAIL（`parseSgStdout` 不存在）。

- [ ] **Step 3: 实现 search.ts**

创建 `pi-coding-tools/src/ast-grep/search.ts`：
```typescript
import { spawn } from "node:child_process";
import { extname } from "node:path";
import { getAstGrepPath } from "./binary";
import type { CliLanguage, CliMatch, RunSgOptions, SgResult } from "./types";

const SEARCH_TIMEOUT_MS = 30_000;

const EXT_TO_LANG: Record<string, CliLanguage> = {
	".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "javascript",
	".mjs": "javascript", ".cjs": "javascript",
	".py": "python", ".java": "java", ".kt": "kotlin", ".kts": "kotlin",
	".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hxx": "cpp",
};

export function inferLangFromPath(path: string): CliLanguage | undefined {
	return EXT_TO_LANG[extname(path).toLowerCase()];
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isCliMatch(v: unknown): v is CliMatch {
	if (!isRecord(v)) return false;
	const range = v["range"];
	const charCount = v["charCount"];
	if (!isRecord(range) || !isRecord(charCount)) return false;
	const byteOffset = range["byteOffset"];
	return (
		typeof v["text"] === "string" &&
		typeof v["file"] === "string" &&
		typeof v["lines"] === "string" &&
		typeof v["language"] === "string" &&
		typeof charCount["leading"] === "number" &&
		typeof charCount["trailing"] === "number" &&
		isRecord(byteOffset) &&
		typeof byteOffset["start"] === "number" &&
		typeof byteOffset["end"] === "number" &&
		isRecord(range["start"]) &&
		typeof range["start"]["line"] === "number" &&
		typeof range["start"]["column"] === "number" &&
		isRecord(range["end"]) &&
		typeof range["end"]["line"] === "number" &&
		typeof range["end"]["column"] === "number"
	);
}

export function parseSgStdout(stdout: string): SgResult {
	if (!stdout.trim()) return { matches: [], totalMatches: 0, truncated: false };
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return { matches: [], totalMatches: 0, truncated: false };
	}
	const matches = Array.isArray(parsed) && parsed.every(isCliMatch) ? (parsed as CliMatch[]) : [];
	return { matches, totalMatches: matches.length, truncated: false };
}

const INSTALL_HINT = [
	"ast-grep binary not found.",
	"",
	"Install options:",
	"  npm install -g @ast-grep/cli",
	"  cargo install ast-grep --locked",
	"  brew install ast-grep",
].join("\n");

function buildArgs(options: RunSgOptions): string[] {
	const args = ["run", "-p", options.pattern, "--lang", options.lang, "--json=compact"];
	args.push(...(options.paths.length > 0 ? options.paths : ["."]));
	return args;
}

export async function runAstGrep(options: RunSgOptions): Promise<SgResult> {
	const cliPath = await getAstGrepPath();
	if (!cliPath) return { matches: [], totalMatches: 0, truncated: false, error: INSTALL_HINT };

	return new Promise<SgResult>((resolve) => {
		const proc = spawn(cliPath, buildArgs(options), { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			proc.kill("SIGKILL");
			resolve({ matches: [], totalMatches: 0, truncated: true, truncatedReason: "timeout", error: "search timed out" });
		}, SEARCH_TIMEOUT_MS);

		proc.stdout.setEncoding("utf-8");
		proc.stderr.setEncoding("utf-8");
		proc.stdout.on("data", (c: string) => (stdout += c));
		proc.stderr.on("data", (c: string) => (stderr += c));

		proc.once("error", () => {
			clearTimeout(timer);
			resolve({ matches: [], totalMatches: 0, truncated: false, error: INSTALL_HINT });
		});
		proc.once("close", (code) => {
			clearTimeout(timer);
			if (code !== 0 && !stdout.trim()) {
				if (stderr.includes("No files found")) {
					resolve({ matches: [], totalMatches: 0, truncated: false });
					return;
				}
				resolve({ matches: [], totalMatches: 0, truncated: false, error: stderr.trim() || `ast-grep exited with code ${code}` });
				return;
			}
			resolve(parseSgStdout(stdout));
		});
	});
}
```

- [ ] **Step 4: 运行 search 测试确认通过**

```bash
npm test --workspace pi-coding-tools -- search.test
```
预期：PASS（3 个测试）。

- [ ] **Step 5: 写失败测试 — formatSearchResult**

创建 `pi-coding-tools/tests/formatters.test.ts`：
```typescript
import { describe, expect, it } from "vitest";
import { formatSearchResult } from "../src/formatters";
import type { SgResult } from "../src/ast-grep/types";

const match: SgResult["matches"][number] = {
	text: "console.log(\"hi\")",
	file: "src/index.ts",
	lines: "console.log(\"hi\");\n",
	language: "typescript",
	charCount: { leading: 0, trailing: 0 },
	range: {
		start: { line: 10, column: 2 },
		end: { line: 10, column: 20 },
		byteOffset: { start: 0, end: 20 },
	},
};

describe("formatSearchResult", () => {
	it("formats matches with file:line:col and snippet", () => {
		const out = formatSearchResult({ matches: [match], totalMatches: 1, truncated: false });
		expect(out).toContain("1 match");
		expect(out).toContain("src/index.ts:11:3");
		expect(out).toContain('console.log("hi")');
	});

	it("groups by file with count", () => {
		const m2 = { ...match, file: "src/index.ts", range: { ...match.range, start: { line: 20, column: 0 } } };
		const out = formatSearchResult({ matches: [match, m2], totalMatches: 2, truncated: false });
		expect(out).toContain("src/index.ts (2 matches)");
	});

	it("no matches", () => {
		expect(formatSearchResult({ matches: [], totalMatches: 0, truncated: false })).toContain("No matches");
	});

	it("surfaces error", () => {
		expect(formatSearchResult({ matches: [], totalMatches: 0, truncated: false, error: "boom" })).toContain("boom");
	});
});
```

- [ ] **Step 6: 运行确认失败**

```bash
npm test --workspace pi-coding-tools -- formatters.test
```
预期：FAIL（`formatSearchResult` 不存在）。

- [ ] **Step 7: 实现 formatters.ts（先放 search 部分，其余 Task 8 补）**

创建 `pi-coding-tools/src/formatters.ts`：
```typescript
import type { CliMatch, SgResult } from "./ast-grep/types";

export function formatSearchResult(result: SgResult): string {
	if (result.error) return `Error: ${result.error}`;
	if (result.matches.length === 0) return "No matches found";

	// group by file
	const byFile = new Map<string, CliMatch[]>();
	for (const m of result.matches) {
		const arr = byFile.get(m.file) ?? [];
		arr.push(m);
		byFile.set(m.file, arr);
	}

	const lines: string[] = [];
	lines.push(`${result.matches.length} match(es) • ${byFile.size} file(s)`);
	for (const [file, ms] of byFile) {
		lines.push(`${file} (${ms.length} match${ms.length > 1 ? "es" : ""})`);
		for (const m of ms) {
			const loc = `${m.range.start.line + 1}:${m.range.start.column + 1}`;
			lines.push(`  ${loc}  ${m.lines.trim()}`);
		}
	}
	if (result.truncated) {
		lines.push(`(truncated, ${result.totalMatches} total)`);
	}
	return lines.join("\n");
}
```

- [ ] **Step 8: 运行 formatters 测试确认通过**

```bash
npm test --workspace pi-coding-tools -- formatters.test
```
预期：PASS（4 个测试）。

- [ ] **Step 9: check + commit**

```bash
npm run check --workspace pi-coding-tools
git add pi-coding-tools/src/ast-grep/search.ts pi-coding-tools/src/formatters.ts pi-coding-tools/tests/ast-grep/search.test.ts pi-coding-tools/tests/formatters.test.ts
git commit -m "feat(pi-coding-tools): ast-grep search execution + json parse + search formatter"
```

---

## Task 5: `ast_grep_search` 工具定义 + 注册测试

**Files:**
- Create: `pi-coding-tools/src/tools/ast-grep-search.ts`
- Test: `pi-coding-tools/tests/tools-registration.test.ts`（本任务先放 ast_grep_search 断言，后续任务追加 lsp 工具断言）

**Interfaces:**
- Produces: `ast_grep_search` 工具定义对象（`name`/`description`/`promptSnippet`/`promptGuidelines`/`parameters`/`execute`），导出 `AST_GREP_LANGUAGES` 常量
- Consumes: `runAstGrep`（Task 4），`formatSearchResult`（Task 4），`getPatternHint`（Task 2），`inferLangFromPath`（Task 4）

- [ ] **Step 1: 写失败测试 — 工具注册 + execute（mock runAstGrep）**

创建 `pi-coding-tools/tests/tools-registration.test.ts`：
```typescript
import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";

// mock search 层
vi.mock("../src/ast-grep/search", () => ({
	runAstGrep: vi.fn(),
	inferLangFromPath: (p: string) => (p.endsWith(".ts") ? "typescript" : undefined),
}));
vi.mock("../src/ast-grep/binary", () => ({ getAstGrepPath: vi.fn(async () => "/fake/ast-grep") }));

import { runAstGrep } from "../src/ast-grep/search";
import { ast_grep_search } from "../src/tools/ast-grep-search";
import type { SgResult } from "../src/ast-grep/types";

const okResult: SgResult = {
	matches: [
		{
			text: "console.log('hi')",
			file: "src/index.ts",
			lines: "console.log('hi');\n",
			language: "typescript",
			charCount: { leading: 0, trailing: 0 },
			range: { start: { line: 4, column: 0 }, end: { line: 4, column: 19 }, byteOffset: { start: 0, end: 19 } },
		},
	],
	totalMatches: 1,
	truncated: false,
};

describe("ast_grep_search tool", () => {
	it("has correct name and schema", () => {
		expect(ast_grep_search.name).toBe("ast_grep_search");
		const params = ast_grep_search.parameters as ReturnType<typeof Type.Object>;
		expect(params).toBeDefined();
	});

	it("returns formatted text on success", async () => {
		vi.mocked(runAstGrep).mockResolvedValueOnce(okResult);
		const res = await ast_grep_search.execute("id", { pattern: "console.log($MSG)", lang: "typescript", path: "src" }, undefined, undefined, { cwd: "/proj" } as never);
		const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		expect(text).toContain("src/index.ts:5:1");
	});

	it("appends pattern hint when no matches and no error", async () => {
		vi.mocked(runAstGrep).mockResolvedValueOnce({ matches: [], totalMatches: 0, truncated: false });
		const res = await ast_grep_search.execute("id", { pattern: "foo\\w+", lang: "typescript", path: "src" }, undefined, undefined, { cwd: "/proj" } as never);
		const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		expect(text).toMatch(/regex/);
	});

	it("surfaces binary-missing error", async () => {
		vi.mocked(runAstGrep).mockResolvedValueOnce({ matches: [], totalMatches: 0, truncated: false, error: "ast-grep binary not found." });
		const res = await ast_grep_search.execute("id", { pattern: "x", lang: "typescript", path: "src" }, undefined, undefined, { cwd: "/proj" } as never);
		const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		expect(text).toContain("ast-grep binary not found");
	});
});
```

- [ ] **Step 2: 运行确认失败**

```bash
npm test --workspace pi-coding-tools -- tools-registration
```
预期：FAIL（`ast_grep_search` 不存在）。

- [ ] **Step 3: 实现 ast-grep-search.ts**

创建 `pi-coding-tools/src/tools/ast-grep-search.ts`：
```typescript
import type { defineTool as DefineToolType, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getPatternHint } from "../ast-grep/pattern-hints";
import { runAstGrep, inferLangFromPath } from "../ast-grep/search";
import type { CliLanguage, SgResult } from "../ast-grep/types";
import { formatSearchResult } from "../formatters";

const defineTool: typeof DefineToolType = (t) => t;

export const AST_GREP_LANGUAGES = [
	"typescript", "tsx", "javascript", "python", "java", "kotlin", "c", "cpp",
] as const;

function isCliLanguage(v: unknown): v is CliLanguage {
	return typeof v === "string" && (AST_GREP_LANGUAGES as readonly string[]).includes(v);
}

const SearchParams = Type.Object({
	pattern: Type.String({
		description: "AST pattern with $VAR (single node) and $$$ (zero-or-more nodes). NOT regex. Must be a complete AST node.",
	}),
	lang: Type.Optional(
		Type.String({
			description: "Language: typescript/tsx/javascript/python/java/kotlin/c/cpp. Omit to infer from path extension.",
		}),
	),
	path: Type.Optional(Type.String({ description: "File or directory to search (default: cwd)" })),
});

export interface AstGrepSearchDetails {
	pattern: string;
	lang: CliLanguage;
	paths: string[];
	matches: SgResult["matches"];
	totalMatches: number;
	truncated: boolean;
	error?: string;
	hint?: string;
}

export const ast_grep_search = defineTool({
	name: "ast_grep_search",
	label: "AST Grep Search",
	description:
		"Search code by AST syntax structure. More precise than grep: ignores comments/strings, handles cross-line patterns. " +
		"Patterns are AST nodes using $VAR (single node) and $$$ (zero-or-more nodes) — NOT regex.",
	promptSnippet: "Search code by AST structure (more precise than grep; ignores comments/strings)",
	promptGuidelines: [
		"Use ast_grep_search to find code by syntax structure. It ignores comments and string literals and handles cross-line patterns — use built-in grep only for plain text or comments.",
		"Patterns are AST nodes, not regex. Use $VAR (e.g. $X, $NAME) for a single node wildcard, $$$ for zero-or-more nodes. Example: 'console.log($MSG)' matches any console.log call.",
		"Do NOT use regex constructs (\\w, .*, |, [a-z], trailing ':') — they will not match. The tool returns a hint if it detects regex-style patterns.",
		"To find definitions: 'function $NAME($$$) { $$$ }' (ts/js), 'def $NAME($$$)' (py). Always pass lang when the project mixes languages.",
	],
	parameters: SearchParams,
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const cwd = (ctx as ExtensionContext).cwd;
		const path = params.path ?? cwd;
		let lang: CliLanguage | undefined = params.lang ? (isCliLanguage(params.lang) ? params.lang : undefined) : inferLangFromPath(path);
		if (params.lang && !isCliLanguage(params.lang)) {
			return {
				content: [{ type: "text" as const, text: `Unsupported language: ${params.lang}` }],
				details: { pattern: params.pattern, lang: "typescript", paths: [path], matches: [], totalMatches: 0, truncated: false },
			};
		}
		if (!lang) lang = "typescript";

		const result = await runAstGrep({ pattern: params.pattern, lang, paths: [path] });
		const text = formatSearchResult(result);
		const hint = result.matches.length === 0 && !result.error ? (getPatternHint(params.pattern, lang) ?? undefined) : undefined;
		const finalText = hint ? `${text}\n\n${hint}` : text;

		const details: AstGrepSearchDetails = {
			pattern: params.pattern,
			lang,
			paths: [path],
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

- [ ] **Step 4: 运行确认通过**

```bash
npm test --workspace pi-coding-tools -- tools-registration
```
预期：PASS（4 个测试）。

- [ ] **Step 5: check + commit**

```bash
npm run check --workspace pi-coding-tools
git add pi-coding-tools/src/tools/ast-grep-search.ts pi-coding-tools/tests/tools-registration.test.ts
git commit -m "feat(pi-coding-tools): ast_grep_search tool"
```

---

## Task 6: LSP 类型 + 服务器定义 + 语言检测

**Files:**
- Create: `pi-coding-tools/src/lsp/types.ts`
- Create: `pi-coding-tools/src/lsp/servers.ts`
- Test: `pi-coding-tools/tests/lsp/servers.test.ts`

**Interfaces:**
- Produces: `ServerDef`（id/command/extensions/initOptions/installHint），`BUILTIN_SERVERS: ServerDef[]`，`resolveServerForFile(path, config?): { server: ServerDef; installed: boolean } | null`，`detectLanguage(path): string | undefined`
- Consumes: `CodingToolsConfig`（Task 1，读 `lsp.servers` override + `disabled`）

- [ ] **Step 1: 写失败测试 — servers**

创建 `pi-coding-tools/tests/lsp/servers.test.ts`：
```typescript
import { describe, expect, it } from "vitest";
import { BUILTIN_SERVERS, detectLanguage, resolveServerForFile } from "../../src/lsp/servers";

describe("servers", () => {
	it("detects language by extension", () => {
		expect(detectLanguage("src/a.ts")).toBe("typescript");
		expect(detectLanguage("a.py")).toBe("python");
		expect(detectLanguage("a.java")).toBe("java");
		expect(detectLanguage("a.kt")).toBe("kotlin");
		expect(detectLanguage("a.cpp")).toBe("cpp");
		expect(detectLanguage("a.md")).toBeUndefined();
	});

	it("resolves server for .ts", () => {
		const r = resolveServerForFile("src/a.ts");
		expect(r?.server.id).toBe("typescript-language-server");
	});

	it("resolves server for .py", () => {
		expect(resolveServerForFile("a.py")?.server.id).toBe("pyright");
	});

	it("returns null for unsupported extension", () => {
		expect(resolveServerForFile("a.md")).toBeNull();
	});

	it("respects config lsp.servers override disabled", () => {
		const r = resolveServerForFile("a.cpp", { lsp: { servers: { clangd: { disabled: true } } } });
		expect(r).toBeNull();
	});

	it("respects config lsp.disabled (whole lsp off)", () => {
		const r = resolveServerForFile("a.ts", { lsp: { disabled: true } });
		expect(r).toBeNull();
	});

	it("builtin servers cover all P0 langs", () => {
		const ids = BUILTIN_SERVERS.map((s) => s.id);
		expect(ids).toContain("typescript-language-server");
		expect(ids).toContain("pyright");
		expect(ids).toContain("jdtls");
		expect(ids).toContain("kotlin-language-server");
		expect(ids).toContain("clangd");
	});
});
```

- [ ] **Step 2: 运行确认失败**

```bash
npm test --workspace pi-coding-tools -- servers.test
```
预期：FAIL（模块不存在）。

- [ ] **Step 3: 实现 types.ts**

创建 `pi-coding-tools/src/lsp/types.ts`（LSP 协议子集）：
```typescript
export interface Position {
	line: number; // 0-based
	character: number; // 0-based
}

export interface Range {
	start: Position;
	end: Position;
}

export interface Location {
	uri: string;
	range: Range;
}

export interface LocationLink {
	originSelectionRange?: Range;
	targetUri: string;
	targetRange: Range;
	targetSelectionRange?: Range;
}

export type SymbolKind = number;

export interface DocumentSymbol {
	name: string;
	detail?: string;
	kind: SymbolKind;
	range: Range;
	selectionRange: Range;
	children?: DocumentSymbol[];
}

export interface SymbolInformation {
	name: string;
	kind: SymbolKind;
	location: Location;
	containerName?: string;
}

export interface MarkupContent {
	kind: "plaintext" | "markdown";
	value: string;
}

export type Hover = {
	contents: MarkupContent | string | Array<MarkupContent | string>;
	range?: Range;
} | null;

// SymbolKind 常用枚举值（LSP 规范）
export const SYMBOL_KIND: Record<string, number> = {
	File: 1, Module: 2, Namespace: 3, Package: 4, Class: 5, Method: 6, Property: 7,
	Field: 8, Constructor: 9, Enum: 10, Interface: 11, Function: 12, Variable: 13,
	Constant: 14, Struct: 23, Event: 24, Operator: 25, TypeParameter: 26,
};

export function symbolKindName(kind: number): string {
	const entry = Object.entries(SYMBOL_KIND).find(([, v]) => v === kind);
	return entry ? entry[0] : "Symbol";
}
```

- [ ] **Step 4: 实现 servers.ts**

创建 `pi-coding-tools/src/lsp/servers.ts`：
```typescript
import { existsSync } from "node:fs";
import { extname } from "node:path";
import { lookup as lookupCommand } from "node:child_process";
import type { CodingToolsConfig } from "../config";
import type { ServerOverride } from "../config";

export interface ServerDef {
	id: string;
	command: string[];
	extensions: string[];
	languageId: string; // LSP languageId for didOpen
	installHint: string;
	initOptions?: Record<string, unknown>;
}

// node:child_process 的 lookup 在 spawn 解析里用不到；installed 探测用 which 风格
function isCommandOnPath(cmd: string): boolean {
	// 简化：用 existsSync 扫 PATH（与 binary.ts 一致风格）
	const pathEnv = process.env["PATH"] ?? "";
	const isWin = process.platform === "win32";
	const exts = isWin ? (process.env["PATHEXT"] ?? ".exe").split(";") : [""];
	for (const dir of pathEnv.split(require("node:path").delimiter)) {
		for (const ext of exts) {
			if (existsSync(`${dir}/${cmd}${ext}`)) return true;
		}
	}
	return false;
}

export const BUILTIN_SERVERS: ServerDef[] = [
	{
		id: "typescript-language-server",
		command: ["typescript-language-server", "--stdio"],
		extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
		languageId: "typescript",
		installHint: "npm install -g typescript-language-server typescript",
	},
	{
		id: "pyright",
		command: ["pyright-langserver", "--stdio"],
		extensions: [".py"],
		languageId: "python",
		installHint: "npm install -g pyright  (or: pip install basedpyright && use basedpyright-langserver)",
	},
	{
		id: "jdtls",
		command: ["jdtls"],
		extensions: [".java"],
		languageId: "java",
		installHint: "Install Eclipse JDT Language Server (jdtls). Requires JDK 17+.",
	},
	{
		id: "kotlin-language-server",
		command: ["kotlin-language-server"],
		extensions: [".kt", ".kts"],
		languageId: "kotlin",
		installHint: "Install kotlin-language-server (https://github.com/fwcd/kotlin-language-server). Requires JDK.",
	},
	{
		id: "clangd",
		command: ["clangd"],
		extensions: [".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hxx"],
		languageId: "cpp",
		installHint: "Install clangd (apt install clangd / brew install llvm). Needs compile_commands.json for best hover/goto.",
	},
];

const EXT_TO_LANG_ID: Record<string, string> = {};
for (const s of BUILTIN_SERVERS) {
	for (const ext of s.extensions) EXT_TO_LANG_ID[ext.toLowerCase()] = s.languageId;
}

export function detectLanguage(path: string): string | undefined {
	return EXT_TO_LANG_ID[extname(path).toLowerCase()];
}

function applyOverride(server: ServerDef, override: ServerOverride | undefined): ServerDef | null {
	if (!override) return server;
	if (override.disabled) return null;
	return {
		...server,
		...(override.command ? { command: override.command } : {}),
		...(override.priority !== undefined ? {} : {}),
	};
}

export interface ResolvedServer {
	server: ServerDef;
	installed: boolean;
}

export function resolveServerForFile(
	path: string,
	config?: CodingToolsConfig,
): ResolvedServer | null {
	if (config?.lsp?.disabled) return null;
	const langId = detectLanguage(path);
	if (!langId) return null;
	const builtin = BUILTIN_SERVERS.find((s) => s.languageId === langId);
	if (!builtin) return null;
	const override = config?.lsp?.servers?.[builtin.id];
	const server = applyOverride(builtin, override);
	if (!server) return null;
	return { server, installed: isCommandOnPath(server.command[0] ?? "") };
}
```

> 注：`isCommandOnPath` 用 `require("node:path").delimiter` 取分隔符（避免顶部 import 混乱）。若 biome 报 `lookup` 未使用，删除未用的 `lookup as lookupCommand` import。

- [ ] **Step 5: 运行确认通过**

```bash
npm test --workspace pi-coding-tools -- servers.test
```
预期：PASS（7 个测试）。

- [ ] **Step 6: check + commit**

```bash
npm run check --workspace pi-coding-tools
# 若 lint 报 lookup 未使用，从 servers.ts 顶部删除 `import { lookup as lookupCommand } ...` 那行
git add pi-coding-tools/src/lsp/types.ts pi-coding-tools/src/lsp/servers.ts pi-coding-tools/tests/lsp/servers.test.ts
git commit -m "feat(pi-coding-tools): lsp types + builtin server definitions (5 langs)"
```

---

## Task 7: LSP JSON-RPC 客户端（fake server 端到端测试）

**Files:**
- Create: `pi-coding-tools/src/lsp/client.ts`
- Create: `pi-coding-tools/tests/lsp/fixtures/fake-lsp-server.mjs`
- Test: `pi-coding-tools/tests/lsp/client.test.ts`

**Interfaces:**
- Produces: `class LspClient { constructor(root, server: ServerDef); start(): Promise<void>; initialize(): Promise<void>; openFile(path): Promise<void>; hover(path, line1Based, char0Based): Promise<Hover>; documentSymbols(path): Promise<DocumentSymbol[]>; definition(path, line, char): Promise<Location|LocationLink|Location[]|null>; references(path, line, char): Promise<Location[]>; isAlive(): boolean; command(): string[]; stop(): Promise<void> }`

- [ ] **Step 1: 写 fake LSP server 夹具**

创建 `pi-coding-tools/tests/lsp/fixtures/fake-lsp-server.mjs`（讲 JSON-RPC over stdio，响应 initialize/documentSymbol/hover/definition/references）：
```javascript
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// 简易 JSON-RPC over stdio 服务器，供 client.test.ts 端到端测试
let buf = "";
let nextId = 1;
const pending = new Map();

function send(msg) {
	process.stdout.write(`${JSON.stringify(msg)}\r\n`);
}

function handleMessage(msg) {
	if (msg.id !== undefined && msg.method) {
		// request
		const result = handleRequest(msg.method, msg.params ?? {});
		send({ jsonrpc: "2.0", id: msg.id, result });
	} else if (msg.method && msg.id === undefined) {
		// notification — no response
	}
}

function handleRequest(method, params) {
	switch (method) {
		case "initialize":
			return { capabilities: { hoverProvider: true, documentSymbolProvider: true, definitionProvider: true, referencesProvider: true } };
		case "initialized":
			return null;
		case "textDocument/documentSymbol": {
			const uri = params.textDocument.uri;
			return [
				{ name: "UserService", kind: 5, range: { start: { line: 0, column: 0 }, end: { line: 9, column: 0 } }, selectionRange: { start: { line: 0, column: 6 }, end: { line: 0, column: 16 } }, children: [
					{ name: "findById", kind: 6, detail: "findById(id: string): User", range: { start: { line: 1, column: 2 }, end: { line: 3, column: 2 } }, selectionRange: { start: { line: 1, column: 2 }, end: { line: 1, column: 10 } } },
				] },
			];
		}
		case "textDocument/hover":
			return { contents: { kind: "markdown", value: "`(method) UserService.findById(id: string): User`" } };
		case "textDocument/definition":
			return [{ uri: params.textDocument.uri, range: { start: { line: 5, column: 0 }, end: { line: 5, column: 10 } } }];
		case "textDocument/references":
			return [
				{ uri: params.textDocument.uri, range: { start: { line: 2, column: 4 }, end: { line: 2, column: 12 } } },
				{ uri: params.textDocument.uri, range: { start: { line: 7, column: 0 }, end: { line: 7, column: 8 } } },
			];
		default:
			return null;
	}
}

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
	buf += chunk;
	let idx;
	while ((idx = buf.indexOf("\r\n")) >= 0) {
		const line = buf.slice(0, idx);
		buf = buf.slice(idx + 2);
		if (!line.trim()) continue;
		try {
			handleMessage(JSON.parse(line));
		} catch {}
	}
});
process.stdin.on("end", () => process.exit(0));
```

- [ ] **Step 2: 写失败测试 — client 端到端**

创建 `pi-coding-tools/tests/lsp/client.test.ts`：
```typescript
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LspClient } from "../../src/lsp/client";
import type { ServerDef } from "../../src/lsp/servers";

const fakeServerPath = join(import.meta.dirname, "fixtures/fake-lsp-server.mjs");
const fakeServer: ServerDef = {
	id: "fake",
	command: ["node", fakeServerPath],
	extensions: [".ts"],
	languageId: "typescript",
	installHint: "fake",
};

let root: string;
let client: LspClient;
let sampleFile: string;

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "lsp-client-"));
	sampleFile = join(root, "sample.ts");
	writeFileSync(sampleFile, "class UserService {\n  findById(id) { return null; }\n}\nconst u = new UserService();\nu.findById('1');\n");
	client = new LspClient(root, fakeServer);
	await client.start();
	await client.initialize();
});

afterAll(async () => {
	await client.stop();
});

describe("LspClient end-to-end (fake server)", () => {
	it("documentSymbols returns tree", async () => {
		const syms = await client.documentSymbols(sampleFile);
		expect(syms.length).toBeGreaterThan(0);
		const cls = syms.find((s) => "name" in s && s.name === "UserService");
		expect(cls).toBeDefined();
		expect(cls && "children" in cls && cls.children?.length).toBe(1);
	});

	it("hover returns contents", async () => {
		const h = await client.hover(sampleFile, 2, 6);
		expect(h).not.toBeNull();
	});

	it("definition returns location", async () => {
		const def = await client.definition(sampleFile, 4, 2);
		expect(def).not.toBeNull();
	});

	it("references returns array", async () => {
		const refs = await client.references(sampleFile, 2, 6);
		expect(Array.isArray(refs) ? refs.length : 0).toBeGreaterThan(0);
	});

	it("isAlive true after start", () => {
		expect(client.isAlive()).toBe(true);
	});
});
```

- [ ] **Step 3: 运行确认失败**

```bash
npm test --workspace pi-coding-tools -- client.test
```
预期：FAIL（`LspClient` 不存在）。

- [ ] **Step 4: 实现 client.ts**

创建 `pi-coding-tools/src/lsp/client.ts`（基于 `vscode-jsonrpc`，最小实现）：
```typescript
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import * as jsonrpc from "vscode-jsonrpc";
import type { ServerDef } from "./servers";
import type { DocumentSymbol, Hover, Location, LocationLink, SymbolInformation } from "./types";

const POST_OPEN_DELAY_MS = 200;

export class LspClient {
	private conn: jsonrpc.MessageConnection | null = null;
	private proc: import("node:child_process").ChildProcess | null = null;
	private readonly openedFiles = new Set<string>();
	private readonly documentVersions = new Map<string, number>();
	private readonly lastMtime = new Map<string, number>();
	private alive = false;

	constructor(
		private readonly root: string,
		private readonly server: ServerDef,
	) {}

	command(): string[] {
		return this.server.command;
	}

	isAlive(): boolean {
		return this.alive;
	}

	async start(): Promise<void> {
		const [cmd, ...args] = this.server.command;
		this.proc = spawn(cmd, args, { cwd: this.root, stdio: ["pipe", "pipe", "pipe"] });
		this.alive = true;
		this.proc.once("exit", () => {
			this.alive = false;
		});
		this.conn = jsonrpc.createMessageConnection(
			new jsonrpc.StreamMessageReader(this.proc.stdout),
			new jsonrpc.StreamMessageWriter(this.proc.stdin),
		);
		this.conn.listen();
	}

	async initialize(): Promise<void> {
		if (!this.conn) throw new Error("not started");
		await this.conn.sendRequest("initialize", {
			processId: process.pid,
			rootUri: pathToFileURL(this.root).href,
			capabilities: {},
			workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: "root" }],
			initializationOptions: this.server.initOptions ?? {},
		});
		await this.conn.sendNotification("initialized", {});
	}

	private async sendRequest<R>(method: string, params: unknown): Promise<R> {
		if (!this.conn) throw new Error("not started");
		return this.conn.sendRequest(method, params);
	}

	private async sendNotification(method: string, params: unknown): Promise<void> {
		if (!this.conn) throw new Error("not started");
		await this.conn.sendNotification(method, params);
	}

	async openFile(filePath: string): Promise<void> {
		const absPath = resolve(filePath);
		const uri = pathToFileURL(absPath).href;
		const text = readFileSync(absPath, "utf-8");
		const mtime = statSync(absPath).mtimeMs;

		if (this.openedFiles.has(absPath)) {
			// mtime 变了 → 重开刷新（捕获外部编辑）
			if (this.lastMtime.get(uri) === mtime) return;
			await this.sendNotification("textDocument/didClose", { textDocument: { uri } });
			this.openedFiles.delete(absPath);
		}

		const version = (this.documentVersions.get(uri) ?? 0) + 1;
		this.documentVersions.set(uri, version);
		this.lastMtime.set(uri, mtime);
		await this.sendNotification("textDocument/didOpen", {
			textDocument: { uri, languageId: this.server.languageId, version, text },
		});
		this.openedFiles.add(absPath);
		await new Promise((r) => setTimeout(r, POST_OPEN_DELAY_MS));
	}

	async hover(filePath: string, line: number, character: number): Promise<Hover> {
		const absPath = resolve(filePath);
		await this.openFile(absPath);
		return this.sendRequest<Hover>("textDocument/hover", {
			textDocument: { uri: pathToFileURL(absPath).href },
			position: { line: line - 1, character },
		});
	}

	async documentSymbols(filePath: string): Promise<Array<DocumentSymbol | SymbolInformation>> {
		const absPath = resolve(filePath);
		await this.openFile(absPath);
		return this.sendRequest<Array<DocumentSymbol | SymbolInformation>>("textDocument/documentSymbol", {
			textDocument: { uri: pathToFileURL(absPath).href },
		});
	}

	async definition(filePath: string, line: number, character: number): Promise<Location | LocationLink | Array<Location | LocationLink> | null> {
		const absPath = resolve(filePath);
		await this.openFile(absPath);
		return this.sendRequest("textDocument/definition", {
			textDocument: { uri: pathToFileURL(absPath).href },
			position: { line: line - 1, character },
		});
	}

	async references(filePath: string, line: number, character: number, includeDeclaration = true): Promise<Location[]> {
		const absPath = resolve(filePath);
		await this.openFile(absPath);
		return this.sendRequest<Location[]>("textDocument/references", {
			textDocument: { uri: pathToFileURL(absPath).href },
			position: { line: line - 1, character },
			context: { includeDeclaration },
		});
	}

	async stop(): Promise<void> {
		this.alive = false;
		try {
			if (this.conn) {
				await this.conn.sendRequest("shutdown", null).catch(() => {});
				await this.conn.sendNotification("exit", null).catch(() => {});
				this.conn.dispose();
			}
		} catch {}
		this.conn = null;
		if (this.proc) {
			this.proc.stdin?.destroy();
			this.proc.kill("SIGKILL");
			this.proc = null;
		}
	}
}
```

- [ ] **Step 5: 运行确认通过**

```bash
npm test --workspace pi-coding-tools -- client.test
```
预期：PASS（5 个测试）。若 fake server 通信失败，检查 `\r\n` 分隔与 JSON-RPC Content-Length 头——`vscode-jsonrpc` 的 StreamMessageReader 默认期望**换行分隔的 JSON**（不是 LSP 的 Content-Length 分帧）？实际上 `vscode-jsonrpc` 默认用 `Content-Length` 头分帧。**若失败**，把 fake server 改用 `vscode-jsonrpc` 的 writer，或改用 `createMessageConnection` + `SocketMessageReader`。修复方案见 Step 6。

- [ ] **Step 6: 若 Step 5 失败的修复 — fake server 用 vscode-jsonrpc 分帧**

`vscode-jsonrpc` 的 `StreamMessageReader/Writer` 使用 LSP 标准 `Content-Length` 头分帧，纯文本 `\r\n` 不兼容。把 `fake-lsp-server.mjs` 改为用 `vscode-jsonrpc`：
```javascript
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc";

const conn = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));
// （把上面 handleMessage 的逻辑挂到 conn.onRequest / conn.onNotification）
conn.onRequest("initialize", () => ({ capabilities: { hoverProvider: true, documentSymbolProvider: true, definitionProvider: true, referencesProvider: true } }));
conn.onRequest("textDocument/documentSymbol", () => [/* 同上 symbol 树 */]);
conn.onRequest("textDocument/hover", () => ({ contents: { kind: "markdown", value: "`(method) UserService.findById(id: string): User`" } }));
conn.onRequest("textDocument/definition", (p) => [{ uri: p.textDocument.uri, range: { start: { line: 5, column: 0 }, end: { line: 5, column: 10 } } }]);
conn.onRequest("textDocument/references", (p) => [{ uri: p.textDocument.uri, range: { start: { line: 2, column: 4 }, end: { line: 2, column: 12 } } }]);
conn.onNotification("initialized", () => {});
conn.onNotification("textDocument/didOpen", () => {});
conn.onNotification("textDocument/didClose", () => {});
conn.listen();
```
重跑 `npm test --workspace pi-coding-tools -- client.test` 至 PASS。

- [ ] **Step 7: check + commit**

```bash
npm run check --workspace pi-coding-tools
git add pi-coding-tools/src/lsp/client.ts pi-coding-tools/tests/lsp/fixtures/fake-lsp-server.mjs pi-coding-tools/tests/lsp/client.test.ts
git commit -m "feat(pi-coding-tools): lsp json-rpc client + fake server e2e test"
```

---

## Task 8: LSP Manager（生命周期：懒加载 + 进程缓存 + 空闲超时 + 崩溃重启）

**Files:**
- Create: `pi-coding-tools/src/lsp/manager.ts`
- Test: `pi-coding-tools/tests/lsp/manager.test.ts`

**Interfaces:**
- Produces: `class LspManager { getClientForFile(path, config?): Promise<{ client: LspClient; server: ServerDef }>; dispose(): Promise<void> }`，内部用可注入的 `clientFactory` 与 `now()` 便于测试
- Consumes: `LspClient`（Task 7），`resolveServerForFile`（Task 6）

- [ ] **Step 1: 写失败测试 — manager 生命周期（用 FakeLspClient，不连真实服务器）**

创建 `pi-coding-tools/tests/lsp/manager.test.ts`：
```typescript
import { describe, expect, it, vi } from "vitest";
import { LspManager } from "../../src/lsp/manager";
import type { LspClient } from "../../src/lsp/client";
import type { ServerDef } from "../../src/lsp/servers";

class FakeLspClient {
	alive = false;
	starts = 0;
	stops = 0;
	hoverCalls = 0;
	markDead = () => { this.alive = false; };
	constructor(public root: string, public server: ServerDef) {}
	async start() { this.starts++; this.alive = true; }
	async initialize() {}
	async openFile() {}
	async hover() { this.hoverCalls++; return { contents: "type" }; }
	async documentSymbols() { return []; }
	async definition() { return null; }
	async references() { return []; }
	isAlive() { return this.alive; }
	command() { return this.server.command; }
	async stop() { this.stops++; this.alive = false; }
}

const tsServer: ServerDef = { id: "ts", command: ["fake"], extensions: [".ts"], languageId: "typescript", installHint: "" };

describe("LspManager", () => {
	it("lazily creates + caches one client per language", async () => {
		const factory = vi.fn((root, server) => new FakeLspClient(root, server) as unknown as LspClient);
		const m = new LspManager({ clientFactory: factory });
		await m.getClientForFile("/p/a.ts");
		await m.getClientForFile("/p/b.ts");
		expect(factory).toHaveBeenCalledTimes(1); // 同语言复用
		await m.dispose();
	});

	it("reaps idle client after timeout", async () => {
		vi.useFakeTimers();
		const fake = new FakeLspClient("/p", tsServer);
		const m = new LspManager({
			clientFactory: () => fake as unknown as LspClient,
			now: () => Date.now(),
			idleTimeoutMs: 1000,
			reaperIntervalMs: 500,
		});
		await m.getClientForFile("/p/a.ts");
		expect(fake.stops).toBe(0);
		vi.advanceTimersByTime(1500);
		expect(fake.stops).toBe(1); // 被空闲回收
		vi.useRealTimers();
		await m.dispose();
	});

	it("restarts once after crash (dead client) for read op", async () => {
		const fake = new FakeLspClient("/p", tsServer);
		let call = 0;
		const m = new LspManager({ clientFactory: () => fake as unknown as LspClient });
		await m.getClientForFile("/p/a.ts");
		fake.markDead();
		// 再次获取应重建（start 计数 +1）
		await m.getClientForFile("/p/a.ts");
		expect(fake.starts).toBe(2);
		await m.dispose();
	});

	it("dispose stops all", async () => {
		const fake = new FakeLspClient("/p", tsServer);
		const m = new LspManager({ clientFactory: () => fake as unknown as LspClient });
		await m.getClientForFile("/p/a.ts");
		await m.dispose();
		expect(fake.stops).toBeGreaterThanOrEqual(1);
	});
});
```
> 修正测试里笔误：`FakeLrepClient` 应为 `FakeLspClient`（实现时统一为 `FakeLspClient`）。

- [ ] **Step 2: 运行确认失败**

```bash
npm test --workspace pi-coding-tools -- manager.test
```
预期：FAIL（`LspManager` 不存在）。

- [ ] **Step 3: 实现 manager.ts**

创建 `pi-coding-tools/src/lsp/manager.ts`：
```typescript
import { resolveServerForFile, type ServerDef } from "./servers";
import { LspClient } from "./client";
import type { CodingToolsConfig } from "../config";

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_REAPER_INTERVAL_MS = 60_000;

interface Managed {
	client: LspClient;
	server: ServerDef;
	lastUsedAt: number;
}

export interface LspManagerOptions {
	idleTimeoutMs?: number;
	reaperIntervalMs?: number;
	now?: () => number;
	clientFactory?: (root: string, server: ServerDef) => LspClient;
}

export class LspManager {
	private readonly clients = new Map<string, Managed>(); // languageId → managed
	private reaper: NodeJS.Timeout | null = null;
	private disposed = false;
	private readonly idleTimeoutMs: number;
	private readonly reaperIntervalMs: number;
	private readonly now: () => number;
	private readonly clientFactory: (root: string, server: ServerDef) => LspClient;

	constructor(opts: LspManagerOptions = {}) {
		this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
		this.reaperIntervalMs = opts.reaperIntervalMs ?? DEFAULT_REAPER_INTERVAL_MS;
		this.now = opts.now ?? (() => Date.now());
		this.clientFactory = opts.clientFactory ?? ((root, server) => new LspClient(root, server));
		this.startReaper();
	}

	private startReaper(): void {
		this.reaper = setInterval(() => this.reapStale(), this.reaperIntervalMs);
		this.reaper.unref?.();
	}

	private reapStale(): void {
		const t = this.now();
		for (const [lang, m] of this.clients) {
			if (t - m.lastUsedAt > this.idleTimeoutMs) {
				m.client.stop().catch(() => {});
				this.clients.delete(lang);
			}
		}
	}

	async getClientForFile(
		path: string,
		config?: CodingToolsConfig,
	): Promise<{ client: LspClient; server: ServerDef }> {
		if (this.disposed) throw new Error("LspManager disposed");
		const resolved = resolveServerForFile(path, config);
		if (!resolved) throw new Error(`No LSP server for ${path}`);
		const { server, installed } = resolved;
		if (!installed) {
			throw new Error(`LSP server '${server.id}' not installed. Install: ${server.installHint}`);
		}

		const lang = server.languageId;
		let m = this.clients.get(lang);
		if (m && !m.client.isAlive()) {
			// 崩溃：驱逐，下方重建（重启一次）
			await m.client.stop().catch(() => {});
			this.clients.delete(lang);
			m = undefined;
		}
		if (!m) {
			const client = this.clientFactory(process.cwd(), server);
			await client.start();
			await client.initialize();
			m = { client, server, lastUsedAt: this.now() };
			this.clients.set(lang, m);
		}
		m.lastUsedAt = this.now();
		return { client: m.client, server: m.server };
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		if (this.reaper) {
			clearInterval(this.reaper);
			this.reaper = null;
		}
		const stops = [...this.clients.values()].map((m) => m.client.stop().catch(() => {}));
		this.clients.clear();
		await Promise.allSettled(stops);
	}
}
```

- [ ] **Step 4: 运行确认通过**

```bash
npm test --workspace pi-coding-tools -- manager.test
```
预期：PASS（4 个测试）。注意测试里 `FakeLrepClient` 笔误需改为 `FakeLspClient`（实现时修正）。

- [ ] **Step 5: check + commit**

```bash
npm run check --workspace pi-coding-tools
git add pi-coding-tools/src/lsp/manager.ts pi-coding-tools/tests/lsp/manager.test.ts
git commit -m "feat(pi-coding-tools): minimal lsp manager (lazy + cache + idle reap + crash restart)"
```

---

## Task 9: LSP 输出格式化（symbol 树 / hover / navigate）

**Files:**
- Modify: `pi-coding-tools/src/formatters.ts`（追加 3 个格式化函数）
- Modify: `pi-coding-tools/tests/formatters.test.ts`（追加断言）

**Interfaces:**
- Produces: `formatSymbolTree(symbols: Array<DocumentSymbol | SymbolInformation>, filePath: string): string`；`formatHover(hover: Hover): string`；`formatNavigate(operation, result, rootDir): string`
- Consumes: `DocumentSymbol`/`SymbolInformation`/`Hover`/`Location`/`LocationLink`（Task 6 types），`symbolKindName`

- [ ] **Step 1: 写失败测试 — 追加到 formatters.test.ts**

在 `pi-coding-tools/tests/formatters.test.ts` 顶部 import 区追加：
```typescript
import { formatHover, formatNavigate, formatSymbolTree } from "../src/formatters";
import type { DocumentSymbol, Hover, Location } from "../src/lsp/types";
```
在文件末尾追加：
```typescript
const sym: DocumentSymbol = {
	name: "UserService", kind: 5, detail: "class UserService",
	range: { start: { line: 0, column: 0 }, end: { line: 9, column: 0 } },
	selectionRange: { start: { line: 0, column: 6 }, end: { line: 0, column: 16 } },
	children: [
		{ name: "findById", kind: 6, detail: "findById(id: string): User", range: { start: { line: 1, column: 2 }, end: { line: 3, column: 2 } }, selectionRange: { start: { line: 1, column: 2 }, end: { line: 1, column: 10 } } },
	],
};

describe("formatSymbolTree", () => {
	it("renders tree with kind + detail", () => {
		const out = formatSymbolTree([sym], "src/user.ts");
		expect(out).toContain("src/user.ts");
		expect(out).toContain("class UserService");
		expect(out).toContain("findById(id: string): User");
		expect(out).toContain("├──");
	});
});

describe("formatHover", () => {
	it("renders markdown contents", () => {
		const h: Hover = { contents: { kind: "markdown", value: "`(method) findById(id: string): User`" } };
		expect(formatHover(h)).toContain("findById(id: string): User");
	});
	it("null hover → message", () => {
		expect(formatHover(null)).toMatch(/No hover/);
	});
});

describe("formatNavigate", () => {
	const loc: Location = { uri: "file:///proj/src/user.ts", range: { start: { line: 4, column: 0 }, end: { line: 4, column: 10 } } };
	it("definition → single location", () => {
		const out = formatNavigate("definition", loc, "/proj");
		expect(out).toContain("definition");
		expect(out).toContain("src/user.ts:5:1");
	});
	it("references → list", () => {
		const out = formatNavigate("references", [loc, loc], "/proj");
		expect(out).toContain("references (2)");
	});
});
```

- [ ] **Step 2: 运行确认失败**

```bash
npm test --workspace pi-coding-tools -- formatters.test
```
预期：FAIL（3 个新函数不存在；已有的 search 测试仍 pass）。

- [ ] **Step 3: 实现 — 追加到 formatters.ts**

在 `pi-coding-tools/src/formatters.ts` 顶部 import 区追加：
```typescript
import { fileURLToPath } from "node:url";
import { relative } from "node:path";
import type { DocumentSymbol, Hover, Location, LocationLink, SymbolInformation } from "./lsp/types";
import { symbolKindName } from "./lsp/types";
```
在文件末尾追加：
```typescript
function isDocumentSymbol(s: DocumentSymbol | SymbolInformation): s is DocumentSymbol {
	return "range" in s && "selectionRange" in s;
}

function renderSymbolNode(s: DocumentSymbol, prefix: string, isLast: boolean): string[] {
	const branch = isLast ? "└──" : "├──";
	const kind = symbolKindName(s.kind).toLowerCase();
	const detail = s.detail ? `  ${s.detail}` : "";
	const lines = [`${prefix}${branch} ${kind} ${s.name}${detail}`];
	const childPrefix = prefix + (isLast ? "    " : "│   ");
	const children = s.children ?? [];
	children.forEach((c, i) => {
		lines.push(...renderSymbolNode(c, childPrefix, i === children.length - 1));
	});
	return lines;
}

export function formatSymbolTree(symbols: Array<DocumentSymbol | SymbolInformation>, filePath: string): string {
	const lines: string[] = [filePath];
	// DocumentSymbol 有树；SymbolInformation 是扁平（fallback 不做了，但兼容）
	const docs = symbols.filter(isDocumentSymbol) as DocumentSymbol[];
	const flat = symbols.filter((s) => !isDocumentSymbol(s)) as SymbolInformation[];
	docs.forEach((s, i) => lines.push(...renderSymbolNode(s, "", i === docs.length - 1)));
	flat.forEach((s) => {
		const kind = symbolKindName(s.kind).toLowerCase();
		lines.push(`├── ${kind} ${s.name}`);
	});
	return lines.join("\n");
}

export function formatHover(hover: Hover): string {
	if (!hover) return "No hover information at this position.";
	const c = hover.contents;
	let text: string;
	if (typeof c === "string") text = c;
	else if (Array.isArray(c)) text = c.map((x) => (typeof x === "string" ? x : x.value)).join("\n");
	else text = c.value;
	// 剥 markdown 反引号噪声，保留可读签名
	return text.trim() || "No hover information at this position.";
}

function uriToRelPath(uri: string, rootDir: string): string {
	try {
		const abs = fileURLToPath(uri);
		const rel = relative(rootDir, abs);
		return rel || abs;
	} catch {
		return uri;
	}
}

function formatLocation(loc: Location, rootDir: string): string {
	const p = uriToRelPath(loc.uri, rootDir);
	return `${p}:${loc.range.start.line + 1}:${loc.range.start.column + 1}`;
}

export function formatNavigate(operation: "definition" | "references", result: Location | LocationLink | Array<Location | LocationLink> | null, rootDir: string): string {
	if (!result || (Array.isArray(result) && result.length === 0)) {
		return operation === "definition" ? "No definition found." : "No references found.";
	}
	const locs: Location[] = [];
	const arr = Array.isArray(result) ? result : [result];
	for (const r of arr) {
		if ("uri" in r) locs.push(r as Location);
		else if ("targetUri" in r) locs.push({ uri: (r as LocationLink).targetUri, range: (r as LocationLink).targetRange });
	}
	if (operation === "definition") {
		return `definition →\n${locs.map((l) => `  ${formatLocation(l, rootDir)}`).join("\n")}`;
	}
	return `references (${locs.length}) →\n${locs.map((l) => `  ${formatLocation(l, rootDir)}`).join("\n")}`;
}
```

- [ ] **Step 4: 运行确认通过**

```bash
npm test --workspace pi-coding-tools -- formatters.test
```
预期：PASS（search 4 + symbolTree 1 + hover 2 + navigate 2 = 9 个测试）。

- [ ] **Step 5: check + commit**

```bash
npm run check --workspace pi-coding-tools
git add pi-coding-tools/src/formatters.ts pi-coding-tools/tests/formatters.test.ts
git commit -m "feat(pi-coding-tools): lsp formatters (symbol tree / hover / navigate)"
```

---

## Task 10: `lsp_symbols` / `lsp_hover` / `lsp_navigate` 工具

**Files:**
- Create: `pi-coding-tools/src/tools/lsp-symbols.ts`
- Create: `pi-coding-tools/src/tools/lsp-hover.ts`
- Create: `pi-coding-tools/src/tools/lsp-navigate.ts`
- Modify: `pi-coding-tools/tests/tools-registration.test.ts`（追加 3 工具断言）

**Interfaces:**
- Produces: 3 个工具定义对象，均接受共享的 `LspManager`（通过闭包注入或模块级单例）
- Consumes: `LspManager`（Task 8），`formatSymbolTree`/`formatHover`/`formatNavigate`（Task 9）

> 设计：3 个工具用工厂函数 `createLspTools(manager: LspManager)` 返回 3 个工具定义，共享同一 manager（呼应草案"共用同一 LSP 连接"）。这样 index.ts 注入单例。

- [ ] **Step 1: 写失败测试 — 追加到 tools-registration.test.ts**

在 `pi-coding-tools/tests/tools-registration.test.ts` 顶部 mock 区追加（mock manager + formatters 依赖）：
```typescript
// mock lsp manager
const mockClient = {
	documentSymbols: vi.fn(async () => [
		{ name: "UserService", kind: 5, range: { start: { line: 0, column: 0 }, end: { line: 9, column: 0 } }, selectionRange: { start: { line: 0, column: 6 }, end: { line: 0, column: 16 } }, children: [] },
	]),
	hover: vi.fn(async () => ({ contents: { kind: "markdown", value: "`findById(id: string): User`" } })),
	definition: vi.fn(async () => [{ uri: "file:///proj/src/user.ts", range: { start: { line: 4, column: 0 }, end: { line: 4, column: 10 } } }]),
	references: vi.fn(async () => [{ uri: "file:///proj/src/user.ts", range: { start: { line: 2, column: 4 }, end: { line: 2, column: 12 } } }]),
};
const mockManager = { getClientForFile: vi.fn(async () => ({ client: mockClient, server: { id: "ts" } })) };
```
文件末尾追加：
```typescript
import { createLspTools } from "../src/tools/lsp-tools";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("lsp tools", () => {
	let tsFile: string;
	const tools = createLspTools(mockManager as never);
	beforeAll(() => {
		const root = mkdtempSync(join(tmpdir(), "lsp-tools-"));
		tsFile = join(root, "a.ts");
		writeFileSync(tsFile, "class A {}\n");
	});

	it("lsp_symbols formats tree", async () => {
		const res = await tools.lsp_symbols.execute("id", { path: tsFile }, undefined, undefined, { cwd: "/proj" } as never);
		const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		expect(text).toContain("UserService");
	});

	it("lsp_hover formats type", async () => {
		const res = await tools.lsp_hover.execute("id", { path: tsFile, line: 1, character: 0 }, undefined, undefined, { cwd: "/proj" } as never);
		const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		expect(text).toContain("findById");
	});

	it("lsp_navigate definition", async () => {
		const res = await tools.lsp_navigate.execute("id", { path: tsFile, line: 1, character: 0, operation: "definition" }, undefined, undefined, { cwd: "/proj" } as never);
		const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		expect(text).toContain("definition");
	});

	it("lsp_navigate references", async () => {
		const res = await tools.lsp_navigate.execute("id", { path: tsFile, line: 1, character: 0, operation: "references" }, undefined, undefined, { cwd: "/proj" } as never);
		const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		expect(text).toContain("references");
	});

	it("lsp tool surfaces install hint when server missing", async () => {
		const m = { getClientForFile: vi.fn(async () => { throw new Error("not installed. Install: npm i -g pyright"); }) };
		const t = createLspTools(m as never);
		const res = await t.lsp_hover.execute("id", { path: tsFile, line: 1, character: 0 }, undefined, undefined, { cwd: "/proj" } as never);
		const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		expect(text).toContain("not installed");
	});
});
```
> 顶部需 `import { beforeAll } from "vitest"`（与已有 import 合并）。

- [ ] **Step 2: 运行确认失败**

```bash
npm test --workspace pi-coding-tools -- tools-registration
```
预期：FAIL（`createLspTools`/`lsp-tools` 不存在）。

- [ ] **Step 3: 实现 lsp-tools.ts（含 3 工具）**

创建 `pi-coding-tools/src/tools/lsp-tools.ts`：
```typescript
import type { defineTool as DefineToolType, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { LspManager } from "../lsp/manager";
import { formatHover, formatNavigate, formatSymbolTree } from "../formatters";

const defineTool: typeof DefineToolType = (t) => t;

export interface LspTools {
	lsp_symbols: ReturnType<typeof defineTool>;
	lsp_hover: ReturnType<typeof defineTool>;
	lsp_navigate: ReturnType<typeof defineTool>;
}

export function createLspTools(manager: LspManager): LspTools {
	const lsp_symbols = defineTool({
		name: "lsp_symbols",
		label: "LSP Symbols",
		description: "Get a file's symbol outline (classes, functions, methods, etc.) via LSP. ~95% fewer tokens than reading the whole file. Requires a language server for the file's language.",
		promptSnippet: "File skeleton outline via LSP (saves ~95% tokens vs full read)",
		promptGuidelines: [
			"Use lsp_symbols to skim an unfamiliar file's structure before reading details — far cheaper than read.",
			"lsp_symbols needs a language server installed. If none is installed, it returns an install hint.",
			"For a textual pattern across files, use grep instead. For exact cross-file resolution, use lsp_navigate.",
		],
		parameters: Type.Object({ path: Type.String({ description: "File path" }) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const cwd = (ctx as ExtensionContext).cwd;
			try {
				const { client } = await manager.getClientForFile(params.path);
				const syms = await client.documentSymbols(params.path);
				return { content: [{ type: "text" as const, text: formatSymbolTree(syms, params.path) }] };
			} catch (e) {
				return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
			}
		},
	});

	const lsp_hover = defineTool({
		name: "lsp_hover",
		label: "LSP Hover",
		description: "Query the type/documentation of the symbol at a position via LSP. The only tool that answers 'what type is this expression'. Requires a language server.",
		promptSnippet: "Type/docs query at a position via LSP (what type is this)",
		promptGuidelines: [
			"Use lsp_hover to learn a symbol's type or docs without reading surrounding code.",
			"Position is line (1-based) and character (0-based column).",
			"Needs a language server installed; returns an install hint otherwise.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "File path" }),
			line: Type.Integer({ description: "Line number (1-based)" }),
			character: Type.Integer({ description: "Column (0-based)" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				const { client } = await manager.getClientForFile(params.path);
				const h = await client.hover(params.path, params.line, params.character);
				return { content: [{ type: "text" as const, text: formatHover(h) }] };
			} catch (e) {
				return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
			}
		},
	});

	const lsp_navigate = defineTool({
		name: "lsp_navigate",
		label: "LSP Navigate",
		description: "Semantic navigation: jump to a symbol's definition, or find all its references, via LSP. More precise than ast_grep_search (resolves overloads, inheritance, node_modules type defs; no same-name false positives). Requires a language server.",
		promptSnippet: "Semantic goto-definition / find-references via LSP (precise, not textual)",
		promptGuidelines: [
			"Use lsp_navigate with operation='definition' to find where a symbol is truly defined (resolves inheritance/overloads/type defs that ast_grep_search cannot).",
			"Use operation='references' to find all real usages of a symbol (no same-name false positives, unlike ast_grep_search).",
			"Position is line (1-based) and character (0-based). Needs a language server installed.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "File path" }),
			line: Type.Integer({ description: "Line number (1-based)" }),
			character: Type.Integer({ description: "Column (0-based)" }),
			operation: StringEnum(["definition", "references"] as const, { description: "definition = where it's defined; references = who uses it" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const cwd = (ctx as ExtensionContext).cwd;
			try {
				const { client } = await manager.getClientForFile(params.path);
				if (params.operation === "definition") {
					const r = await client.definition(params.path, params.line, params.character);
					return { content: [{ type: "text" as const, text: formatNavigate("definition", r, cwd) }] };
				}
				const r = await client.references(params.path, params.line, params.character);
				return { content: [{ type: "text" as const, text: formatNavigate("references", r, cwd) }] };
			} catch (e) {
				return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
			}
		},
	});

	return { lsp_symbols, lsp_hover, lsp_navigate };
}
```

- [ ] **Step 4: 运行确认通过**

```bash
npm test --workspace pi-coding-tools -- tools-registration
```
预期：PASS（ast_grep_search 4 + lsp 5 = 9 个测试）。

- [ ] **Step 5: check + commit**

```bash
npm run check --workspace pi-coding-tools
git add pi-coding-tools/src/tools/lsp-tools.ts pi-coding-tools/tests/tools-registration.test.ts
git commit -m "feat(pi-coding-tools): lsp_symbols / lsp_hover / lsp_navigate tools"
```

---

## Task 11: 入口接线（index.ts + enableTools + session_shutdown）+ 文档 + 最终验证

**Files:**
- Modify: `pi-coding-tools/index.ts`
- Modify: `pi-coding-tools/src/search-tools.ts`（`enableSearchTools`→`enableTools`）
- Modify: `pi-coding-tools/tests/search-tools.test.ts`
- Modify: `pi-coding-tools/README.md`
- Modify: `README.md`（根）

**Interfaces:**
- Produces: `enableTools(pi, config)` 管理 7 工具活动集；index.ts 注册 4 工具 + session 生命周期

- [ ] **Step 1: 改 search-tools.ts → enableTools**

替换 `pi-coding-tools/src/search-tools.ts` 全文为：
```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CodingToolsConfig } from "./config";

const ALL_TOOL_NAMES = ["ls", "find", "grep", "ast_grep_search", "lsp_symbols", "lsp_hover", "lsp_navigate"] as const;

export function enableTools(pi: ExtensionAPI, config: CodingToolsConfig): void {
	const allTools = new Set(pi.getAllTools().map((t) => t.name));
	const current = new Set(pi.getActiveTools());
	const enabled: Record<string, boolean> = {
		ls: config.ls,
		find: config.find,
		grep: config.grep,
		ast_grep_search: config.ast_grep_search,
		lsp_symbols: config.lsp_symbols,
		lsp_hover: config.lsp_hover,
		lsp_navigate: config.lsp_navigate,
	};
	for (const name of ALL_TOOL_NAMES) {
		if (enabled[name] && allTools.has(name) && !current.has(name)) {
			current.add(name);
		}
	}
	pi.setActiveTools([...current]);
}
```

- [ ] **Step 2: 更新 search-tools.test.ts（改名 enableTools + 新工具断言）**

替换 `pi-coding-tools/tests/search-tools.test.ts` 中所有 `enableSearchTools` → `enableTools`，并在 `allTrueConfig` 改为：
```typescript
const allTrueConfig = {
	ls: true, find: true, grep: true,
	ast_grep_search: true, lsp_symbols: true, lsp_hover: true, lsp_navigate: true,
};
```
并在 makeMockPi 的 allTools 里加入 `ast_grep_search`/`lsp_symbols`/`lsp_hover`/`lsp_navigate`，使现有断言覆盖新工具。新增一个断言：
```typescript
it("adds ast_grep_search when enabled and present", () => {
	const pi = makeMockPi(["read", "ast_grep_search", "lsp_symbols"], ["read"]);
	enableTools(pi as any, allTrueConfig);
	const result = pi.setActiveTools.mock.calls[0][0] as string[];
	expect(result).toContain("ast_grep_search");
	expect(result).toContain("lsp_symbols");
});
```

- [ ] **Step 3: 运行 search-tools 测试确认通过**

```bash
npm test --workspace pi-coding-tools -- search-tools
```
预期：PASS。

- [ ] **Step 4: 接线 index.ts**

替换 `pi-coding-tools/index.ts` 全文为：
```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./src/config";
import { LspManager } from "./src/lsp/manager";
import { enableTools } from "./src/search-tools";
import { ast_grep_search } from "./src/tools/ast-grep-search";
import { createLspTools } from "./src/tools/lsp-tools";

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	const lspManager = new LspManager();
	const lspTools = createLspTools(lspManager);

	// factory 注册 4 工具
	pi.registerTool(ast_grep_search);
	pi.registerTool(lspTools.lsp_symbols);
	pi.registerTool(lspTools.lsp_hover);
	pi.registerTool(lspTools.lsp_navigate);

	pi.on("session_start", async (_event, _ctx) => {
		enableTools(pi, loadConfig());
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		await lspManager.dispose();
	});
}
```

- [ ] **Step 5: typecheck（确认 index 接线无误）**

```bash
npm run typecheck --workspace pi-coding-tools
```
预期：PASS。若有类型错误（如 `loadConfig` 缓存导致 session 间不刷新），确认 `loadConfig` 每次返回缓存——可接受（config 在 session_start 读一次）。若 `registerTool` 签名不匹配，对照 pi 文档 `pi.registerTool(definition)`。

- [ ] **Step 6: 全量测试 + check**

```bash
npm test --workspace pi-coding-tools
npm run check --workspace pi-coding-tools
```
预期：全绿。

- [ ] **Step 7: 更新 pi-coding-tools/README.md**

在 `## Features` 下追加（保留现有 ls/find/grep 说明）：
```markdown
## AST/LSP 代码理解工具

新增 4 个 token-efficient 工具，让 LLM 用最少 token 理解代码库：

| Tool | 用途 | 机制 |
|------|------|------|
| `ast_grep_search` | 按 AST 结构搜索代码（比 grep 精准，不匹配注释/字符串） | ast-grep CLI |
| `lsp_symbols` | 文件骨架大纲（比 read 省 ~95% token） | LSP documentSymbol |
| `lsp_hover` | 查符号类型/文档（唯一能答"这表达式什么类型"） | LSP hover |
| `lsp_navigate` | 语义跳转：定义在哪 / 谁在用（operation: definition\|references） | LSP definition/references |

### 支持语言

| 语言 | LSP 服务器 | 安装 |
|------|-----------|------|
| TypeScript/JavaScript | typescript-language-server | `npm i -g typescript-language-server typescript` |
| Python | pyright | `npm i -g pyright` |
| Java | jdtls | Eclipse JDT LS（需 JDK 17+） |
| Kotlin | kotlin-language-server | [fwcd/kotlin-language-server](https://github.com/fwcd/kotlin-language-server) |
| C/C++ | clangd | `apt install clangd` / `brew install llvm`（需 compile_commands.json） |

`ast_grep_search` 支持 ts/tsx/js/python/java/kotlin/c/cpp，无需 LSP。

### ast-grep 二进制

`ast_grep_search` 需要 `ast-grep`（或 `sg`）二进制。安装：`npm i -g @ast-grep/cli` / `cargo install ast-grep` / `brew install ast-grep`。

### 配置

在 `coding-tools.json` 中可开关每个工具（默认全 true），并可整体关 LSP 或覆盖服务器：

```jsonc
{
  "ast_grep_search": true,
  "lsp_symbols": true,
  "lsp_hover": true,
  "lsp_navigate": true,
  "lsp": { "disabled": false, "servers": { "clangd": { "disabled": true } } }
}
```
```

- [ ] **Step 8: 修正根 README.md 描述行**

把根 `README.md` 表格里 pi-coding-tools 行的描述从 `apply_patch tool + ls/find/grep built-in tools` 改为 `AST/LSP code-intel tools (ast_grep_search/lsp_symbols/lsp_hover/lsp_navigate) + ls/find/grep`。

- [ ] **Step 9: 提交 + worktree 合并**

```bash
npm run check --workspace pi-coding-tools && npm test --workspace pi-coding-tools
git add -A
git commit -m "feat(pi-coding-tools): wire 4 ast/lsp tools into entry + enableTools + docs (v0.3.0)"
# 合并回 main
cd /home/yandy/workspace/pri/pi-packages
git checkout main
git merge --no-ff feat/pi-coding-tools-ast-lsp -m "Merge feat/pi-coding-tools-ast-lsp: AST/LSP code-intel tools"
# 清理 worktree
git worktree remove .worktrees/pi-coding-tools-ast-lsp
git branch -d feat/pi-coding-tools-ast-lsp
```

- [ ] **Step 10: 最终全量验证（合并后）**

```bash
cd /home/yandy/workspace/pri/pi-packages
npm ci
npm run typecheck
npm run check
npm test
```
预期：全绿。若 `pi-coding-tools` 的 `sg-binary.integration.test.ts`（Task 中未单独列，可并入 Task 5 或跳过）在无 `ast-grep` 时跳过——确认它用 `it.skipIf(!hasSg)` 或 try/catch 跳过。

- [ ] **Step 11: 发布准备（按 RELEASE.md）**

```bash
npm version 0.3.0 --workspace=pi-coding-tools --no-git-tag-version
git add pi-coding-tools/package.json package-lock.json
git commit -m "pi-coding-tools v0.3.0"
git tag pi-coding-tools-v0.3.0
git push origin main --tags
gh release create pi-coding-tools-v0.3.0 --title "pi-coding-tools v0.3.0" --notes ""
```
（确认 `.github/workflows/publish.yml` 的 case 语句已含 `pi-coding-tools-v*)`——既有发布流程已支持，无需改。）

---

## Self-Review（计划自审，实施前由计划作者完成）

**Spec coverage 核查：**
- ✅ 4 工具（ast_grep_search/lsp_symbols/lsp_hover/lsp_navigate）→ Task 5, 10
- ✅ ast-grep CLI 后端 + 二进制名 ast-grep+sg → Task 2, 3, 4
- ✅ 最小 LSP manager（懒加载+缓存+空闲超时+崩溃重启）→ Task 8
- ✅ lsp_symbols 纯 LSP 无 fallback → Task 10
- ✅ 5 语言服务器 → Task 6
- ✅ 配置扩展（4 布尔 + lsp 块）→ Task 1
- ✅ mtime 重开刷新 → Task 7 client.ts
- ✅ 位置约定 line 1-based/char 0-based → Task 7, 10
- ✅ 输出格式紧凑 → Task 4, 9
- ✅ 错误处理（二进制缺失/LSP 未装/崩溃/pattern-hint）→ Task 3,4,5,10
- ✅ 测试（纯单元+mock client+fake server+gated 集成）→ 各 Task
- ✅ git worktree 开发 → Task 1 Step 1, Task 11 Step 9
- ✅ index 接线 + session_shutdown dispose → Task 11
- ✅ NOTICE + README + 版本 0.3.0 → Task 1, 11

**Placeholder 扫描：** 无 TBD/TODO；所有代码步骤含完整代码。Task 7 Step 6 的 fake server 分帧修复是条件分支（给出完整修复代码），非占位符。

**类型一致性核查：**
- `LspManager.getClientForFile(path, config?)` 在 Task 8 定义、Task 10 使用 — 一致
- `createLspTools(manager)` 返回 `{lsp_symbols, lsp_hover, lsp_navigate}` — Task 10 定义、Task 11 使用 — 一致
- `enableTools(pi, config)` — Task 11 定义替换 `enableSearchTools`，测试同步改名 — 一致
- `CliLanguage`/`SgResult`/`CliMatch` — Task 2 定义，Task 4/5 使用 — 一致
- `ServerDef`/`resolveServerForFile` — Task 6 定义，Task 7/8 使用 — 一致
- `formatSearchResult`/`formatSymbolTree`/`formatHover`/`formatNavigate` — Task 4/9 定义，Task 5/10 使用 — 一致

**已知实施注意点（非占位符，是真实风险提示）：**
1. Task 6 `servers.ts` 的 `isCommandOnPath` 用了 `require("node:path")` 内联——若 biome 禁止 `require`，改为顶部 `import { delimiter } from "node:path"`。顶部未用的 `lookup as lookupCommand` import 需删除。
2. Task 7 fake server 分帧：`vscode-jsonrpc` 用 Content-Length 头，纯 `\r\n` 文本不兼容，Step 6 给了用 `vscode-jsonrpc` 重写 fake server 的完整修复。
3. Task 8 测试里 `FakeLrepClient` 是笔误，实现时统一为 `FakeLspClient`（已在测试代码注释标明）。
4. Task 11 `loadConfig()` 有缓存，session 间不重读——v1 可接受（config 在 session_start 读一次）。
