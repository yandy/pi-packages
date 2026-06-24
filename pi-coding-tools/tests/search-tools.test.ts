import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { CodingToolsConfig } from "../src/config";
import { enableTools } from "../src/search-tools";

function makeMockPi(allTools: string[], activeTools: string[]) {
	let currentActive = [...activeTools];
	return {
		getAllTools: vi.fn(() => allTools.map((name) => ({ name }))),
		getActiveTools: vi.fn(() => [...currentActive]),
		setActiveTools: vi.fn((tools: string[]) => {
			currentActive = [...tools];
		}),
	};
}

const allTrueConfig: CodingToolsConfig = {
	ls: true,
	find: true,
	grep: true,
	ast_grep_search: true,
	lsp_symbols: true,
	lsp_hover: true,
	lsp_navigate: true,
};

describe("enableTools", () => {
	it("adds ls/find/grep when not already active", () => {
		const pi = makeMockPi(
			[
				"read",
				"bash",
				"edit",
				"write",
				"ls",
				"find",
				"grep",
				"ast_grep_search",
				"lsp_symbols",
				"lsp_hover",
				"lsp_navigate",
			],
			["read", "bash", "edit", "write"],
		);
		enableTools(pi as unknown as ExtensionAPI, allTrueConfig);
		expect(pi.setActiveTools).toHaveBeenCalledWith(
			expect.arrayContaining([
				"read",
				"bash",
				"edit",
				"write",
				"ls",
				"find",
				"grep",
				"ast_grep_search",
				"lsp_symbols",
				"lsp_hover",
				"lsp_navigate",
			]),
		);
	});

	it("does not duplicate already-active tools", () => {
		const pi = makeMockPi(
			["read", "bash", "ls", "find", "grep", "ast_grep_search", "lsp_symbols", "lsp_hover", "lsp_navigate"],
			["read", "bash", "ls"],
		);
		enableTools(pi as unknown as ExtensionAPI, allTrueConfig);
		const result = pi.setActiveTools.mock.calls[0][0] as string[];
		const lsCount = result.filter((t) => t === "ls").length;
		expect(lsCount).toBe(1);
	});

	it("skips tools not in getAllTools", () => {
		const pi = makeMockPi(["read", "bash"], ["read", "bash"]);
		enableTools(pi as unknown as ExtensionAPI, allTrueConfig);
		const result = pi.setActiveTools.mock.calls[0][0] as string[];
		expect(result).not.toContain("ls");
		expect(result).not.toContain("find");
		expect(result).not.toContain("grep");
		expect(result).not.toContain("ast_grep_search");
		expect(result).not.toContain("lsp_symbols");
		expect(result).not.toContain("lsp_hover");
		expect(result).not.toContain("lsp_navigate");
	});

	it("respects config: ls=false skips ls", () => {
		const pi = makeMockPi(
			["read", "ls", "find", "grep", "ast_grep_search", "lsp_symbols", "lsp_hover", "lsp_navigate"],
			["read"],
		);
		const config: CodingToolsConfig = { ...allTrueConfig, ls: false };
		enableTools(pi as unknown as ExtensionAPI, config);
		const result = pi.setActiveTools.mock.calls[0][0] as string[];
		expect(result).not.toContain("ls");
		expect(result).toContain("find");
		expect(result).toContain("grep");
		expect(result).toContain("ast_grep_search");
		expect(result).toContain("lsp_symbols");
		expect(result).toContain("lsp_hover");
		expect(result).toContain("lsp_navigate");
	});

	it("respects config: all false adds nothing", () => {
		const pi = makeMockPi(
			["read", "ls", "find", "grep", "ast_grep_search", "lsp_symbols", "lsp_hover", "lsp_navigate"],
			["read"],
		);
		const config: CodingToolsConfig = {
			ls: false,
			find: false,
			grep: false,
			ast_grep_search: false,
			lsp_symbols: false,
			lsp_hover: false,
			lsp_navigate: false,
		};
		enableTools(pi as unknown as ExtensionAPI, config);
		const result = pi.setActiveTools.mock.calls[0][0] as string[];
		expect(result).toEqual(["read"]);
	});

	it("preserves existing active tools", () => {
		const pi = makeMockPi(
			["read", "bash", "edit", "ls", "find", "grep", "ast_grep_search", "lsp_symbols", "lsp_hover", "lsp_navigate"],
			["read", "bash", "edit"],
		);
		enableTools(pi as unknown as ExtensionAPI, allTrueConfig);
		const result = pi.setActiveTools.mock.calls[0][0] as string[];
		expect(result).toContain("read");
		expect(result).toContain("bash");
		expect(result).toContain("edit");
	});

	it("adds ast_grep_search when enabled and present", () => {
		const pi = makeMockPi(["read", "ast_grep_search", "lsp_symbols"], ["read"]);
		enableTools(pi as unknown as ExtensionAPI, allTrueConfig);
		const result = pi.setActiveTools.mock.calls[0][0] as string[];
		expect(result).toContain("ast_grep_search");
		expect(result).toContain("lsp_symbols");
	});
});
