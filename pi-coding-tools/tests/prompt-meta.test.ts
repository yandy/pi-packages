import { describe, expect, it } from "vitest";
import { AST_GREP_LANGUAGES } from "../src/tools/ast-grep-search";
import { ast_grep_replace } from "../src/tools/ast-grep-replace";
import { ast_grep_search } from "../src/tools/ast-grep-search";
import { createLspTools } from "../src/tools/lsp-tools";
import { assertPromptHygiene } from "../../scripts/prompt-hygiene";

// LSP 工具在定义期不碰 manager，注册面只需要占位。
const lspTools = createLspTools({} as never, () => ({}) as never);

describe("prompt hygiene", () => {
	it("ast_grep_* / lsp_* 的三通道文案符合约定且不超预算", () => {
		assertPromptHygiene({
			pkg: "pi-coding-tools",
			budget: 4700,
			tools: [ast_grep_search, ast_grep_replace, lspTools.lsp_symbols, lspTools.lsp_hover, lspTools.lsp_navigate],
			authored: ["ast_grep_search", "ast_grep_replace", "lsp_symbols", "lsp_hover", "lsp_navigate"],
		});
	});

	it("pattern/lang 描述来自共享常量（两个工具不许各写一份）", () => {
		const patternOf = (t: any) => t.parameters.properties.pattern.description;
		const langOf = (t: any) => t.parameters.properties.lang.description;
		expect(patternOf(ast_grep_search)).toBe(patternOf(ast_grep_replace));
		expect(langOf(ast_grep_search)).toBe(langOf(ast_grep_replace));
		// lang 的兜底行为必须写在提示里：推断失败会静默按 typescript 搜。
		expect(langOf(ast_grep_search)).toContain("falls back to typescript");
		expect(AST_GREP_LANGUAGES).toContain("typescript");
	});
});
