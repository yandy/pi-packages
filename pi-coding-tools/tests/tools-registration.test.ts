import type { Type } from "typebox";
import { beforeAll, describe, expect, it, vi } from "vitest";

// mock search 层
vi.mock("../src/ast-grep/search", () => ({
	runAstGrep: vi.fn(),
	inferLangFromPath: (p: string) => (p.endsWith(".ts") ? "typescript" : undefined),
}));
vi.mock("../src/ast-grep/binary", () => ({ getAstGrepPath: vi.fn(async () => "/fake/ast-grep") }));
vi.mock("../src/ast-grep/rewrite", () => ({
	runAstGrepRewrite: vi.fn(),
}));

import { runAstGrepRewrite } from "../src/ast-grep/rewrite";
import { runAstGrep } from "../src/ast-grep/search";
import type { SgResult } from "../src/ast-grep/types";
import { ast_grep_replace } from "../src/tools/ast-grep-replace";
import { ast_grep_search } from "../src/tools/ast-grep-search";

// mock lsp manager
const mockClient = {
	documentSymbols: vi.fn(async () => [
		{
			name: "UserService",
			kind: 5,
			range: { start: { line: 0, column: 0 }, end: { line: 9, column: 0 } },
			selectionRange: { start: { line: 0, column: 6 }, end: { line: 0, column: 16 } },
			children: [],
		},
	]),
	hover: vi.fn(async () => ({ contents: { kind: "markdown", value: "`findById(id: string): User`" } })),
	definition: vi.fn(async () => [
		{ uri: "file:///proj/src/user.ts", range: { start: { line: 4, column: 0 }, end: { line: 4, column: 10 } } },
	]),
	references: vi.fn(async () => [
		{ uri: "file:///proj/src/user.ts", range: { start: { line: 2, column: 4 }, end: { line: 2, column: 12 } } },
	]),
};
const mockManager = { getClientForFile: vi.fn(async () => ({ client: mockClient, server: { id: "ts" } })) };

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

describe("ast_grep_search tool", () => {
	it("has correct name and schema", () => {
		expect(ast_grep_search.name).toBe("ast_grep_search");
		const params = ast_grep_search.parameters as ReturnType<typeof Type.Object>;
		expect(params).toBeDefined();
	});

	it("returns formatted text on success", async () => {
		vi.mocked(runAstGrep).mockResolvedValueOnce(okResult);
		const res = await ast_grep_search.execute(
			"id",
			{ pattern: "console.log($MSG)", lang: "typescript", path: "src" },
			undefined,
			undefined,
			{ cwd: "/proj" } as never,
		);
		const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		expect(text).toContain("src/index.ts:5:1");
	});

	it("appends pattern hint when no matches and no error", async () => {
		vi.mocked(runAstGrep).mockResolvedValueOnce({ matches: [], totalMatches: 0, truncated: false });
		const res = await ast_grep_search.execute(
			"id",
			{ pattern: "foo\\w+", lang: "typescript", path: "src" },
			undefined,
			undefined,
			{ cwd: "/proj" } as never,
		);
		const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		expect(text).toMatch(/regex/);
	});

	it("surfaces binary-missing error", async () => {
		vi.mocked(runAstGrep).mockResolvedValueOnce({
			matches: [],
			totalMatches: 0,
			truncated: false,
			error: "ast-grep binary not found.",
		});
		const res = await ast_grep_search.execute(
			"id",
			{ pattern: "x", lang: "typescript", path: "src" },
			undefined,
			undefined,
			{ cwd: "/proj" } as never,
		);
		const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		expect(text).toContain("ast-grep binary not found");
	});
});

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
		expect(vi.mocked(runAstGrepRewrite).mock.lastCall?.[0].apply).toBe(false);
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
		expect(vi.mocked(runAstGrepRewrite).mock.lastCall?.[0].apply).toBe(true);
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
		vi
			.mocked(runAstGrepRewrite)
			.mockResolvedValueOnce({ matches: [], totalMatches: 0, truncated: false, applied: false });
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

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodingToolsConfig } from "../src/config";
import { createLspTools } from "../src/tools/lsp-tools";

const baseTrue: CodingToolsConfig = {
	ls: true,
	find: true,
	grep: true,
	ast_grep_search: true,
	ast_grep_replace: true,
	lsp_symbols: true,
	lsp_hover: true,
	lsp_navigate: true,
};

describe("lsp tools", () => {
	let tsFile: string;
	const tools = createLspTools(mockManager as never, (_cwd) => baseTrue);
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
		const res = await tools.lsp_hover.execute("id", { path: tsFile, line: 1, character: 0 }, undefined, undefined, {
			cwd: "/proj",
		} as never);
		const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		expect(text).toContain("findById");
	});

	it("lsp_navigate definition", async () => {
		const res = await tools.lsp_navigate.execute(
			"id",
			{ path: tsFile, line: 1, character: 0, operation: "definition" },
			undefined,
			undefined,
			{ cwd: "/proj" } as never,
		);
		const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		expect(text).toContain("definition");
	});

	it("lsp_navigate references", async () => {
		const res = await tools.lsp_navigate.execute(
			"id",
			{ path: tsFile, line: 1, character: 0, operation: "references" },
			undefined,
			undefined,
			{ cwd: "/proj" } as never,
		);
		const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		expect(text).toContain("references");
	});

	it("lsp tool surfaces install hint when server missing", async () => {
		const m = {
			getClientForFile: vi.fn(async () => {
				throw new Error("not installed. Install: npm i -g pyright");
			}),
		};
		const t = createLspTools(m as never, (_cwd) => baseTrue);
		const res = await t.lsp_hover.execute("id", { path: tsFile, line: 1, character: 0 }, undefined, undefined, {
			cwd: "/proj",
		} as never);
		const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		expect(text).toContain("not installed");
	});

	it("threads lsp config to manager.getClientForFile", async () => {
		const capturedConfigs: Array<CodingToolsConfig | undefined> = [];
		const configMgr = {
			getClientForFile: vi.fn(async (_path: string, _root: string, config?: CodingToolsConfig) => {
				capturedConfigs.push(config);
				return { client: mockClient, server: { id: "ts" } };
			}),
		};
		const cfg: CodingToolsConfig = {
			...baseTrue,
			lsp: { disabled: true, servers: { clangd: { disabled: true } } },
		};
		const tools2 = createLspTools(configMgr as never, (_cwd) => cfg);

		await tools2.lsp_symbols.execute("id", { path: tsFile }, undefined, undefined, { cwd: "/proj" } as never);
		expect(capturedConfigs.length).toBeGreaterThanOrEqual(1);
		expect(capturedConfigs[0]?.lsp?.disabled).toBe(true);
		expect(capturedConfigs[0]?.lsp?.servers?.clangd?.disabled).toBe(true);
	});
});
