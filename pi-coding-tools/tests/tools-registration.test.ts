import type { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

// mock search 层
vi.mock("../src/ast-grep/search", () => ({
	runAstGrep: vi.fn(),
	inferLangFromPath: (p: string) => (p.endsWith(".ts") ? "typescript" : undefined),
}));
vi.mock("../src/ast-grep/binary", () => ({ getAstGrepPath: vi.fn(async () => "/fake/ast-grep") }));

import { runAstGrep } from "../src/ast-grep/search";
import type { SgResult } from "../src/ast-grep/types";
import { ast_grep_search } from "../src/tools/ast-grep-search";

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
