import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { CodingToolsConfig } from "../src/config";
import { syncToolsStatus } from "../src/search-tools";

function makeMockPi(activeTools: string[]) {
	let currentActive = [...activeTools];
	return {
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
	ast_grep_replace: true,
	lsp_symbols: true,
	lsp_hover: true,
	lsp_navigate: true,
};

describe("syncToolsStatus", () => {
	it("adds enabled tools that are not yet active (built-in activation)", () => {
		const pi = makeMockPi(["read", "bash", "edit", "write"]);
		syncToolsStatus(pi as unknown as ExtensionAPI, allTrueConfig);
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
				"ast_grep_replace",
				"lsp_symbols",
				"lsp_hover",
				"lsp_navigate",
			]),
		);
	});

	it("removes tools that config says false", () => {
		const pi = makeMockPi(["read", "bash", "edit", "ls", "lsp_hover", "lsp_navigate"]);
		const config: CodingToolsConfig = { ...allTrueConfig, lsp_hover: false, lsp_navigate: false };
		syncToolsStatus(pi as unknown as ExtensionAPI, config);
		const result = pi.setActiveTools.mock.calls[0][0] as string[];
		expect(result).not.toContain("lsp_hover");
		expect(result).not.toContain("lsp_navigate");
		expect(result).toContain("read");
		expect(result).toContain("ls");
	});

	it("all false removes everything", () => {
		const pi = makeMockPi([
			"read",
			"ls",
			"find",
			"grep",
			"ast_grep_search",
			"ast_grep_replace",
			"lsp_symbols",
			"lsp_hover",
			"lsp_navigate",
		]);
		const config: CodingToolsConfig = {
			ls: false,
			find: false,
			grep: false,
			ast_grep_search: false,
			ast_grep_replace: false,
			lsp_symbols: false,
			lsp_hover: false,
			lsp_navigate: false,
		};
		syncToolsStatus(pi as unknown as ExtensionAPI, config);
		expect(pi.setActiveTools.mock.calls[0][0]).toEqual(["read"]);
	});

	it("Set.add is idempotent — no duplicates", () => {
		const pi = makeMockPi(["read", "ls", "find"]);
		syncToolsStatus(pi as unknown as ExtensionAPI, allTrueConfig);
		const result = pi.setActiveTools.mock.calls[0][0] as string[];
		expect(result.filter((t) => t === "ls").length).toBe(1);
		expect(result.filter((t) => t === "find").length).toBe(1);
	});

	it("preserves non-coding tools", () => {
		const pi = makeMockPi(["read", "bash", "edit", "write"]);
		syncToolsStatus(pi as unknown as ExtensionAPI, allTrueConfig);
		const result = pi.setActiveTools.mock.calls[0][0] as string[];
		expect(result).toContain("read");
		expect(result).toContain("bash");
		expect(result).toContain("edit");
		expect(result).toContain("write");
	});
});
