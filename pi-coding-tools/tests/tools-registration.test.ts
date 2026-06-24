import type { Type } from "typebox";
import { beforeAll, describe, expect, it, vi } from "vitest";

// mock search 层
vi.mock("../src/ast-grep/search", () => ({
	runAstGrep: vi.fn(),
	inferLangFromPath: (p: string) => (p.endsWith(".ts") ? "typescript" : undefined),
}));
vi.mock("../src/ast-grep/binary", () => ({ getAstGrepPath: vi.fn(async () => "/fake/ast-grep") }));

import { runAstGrep } from "../src/ast-grep/search";
import type { SgResult } from "../src/ast-grep/types";
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

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLspTools } from "../src/tools/lsp-tools";

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
		const t = createLspTools(m as never);
		const res = await t.lsp_hover.execute("id", { path: tsFile, line: 1, character: 0 }, undefined, undefined, {
			cwd: "/proj",
		} as never);
		const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		expect(text).toContain("not installed");
	});
});
