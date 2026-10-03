import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { CodingToolsConfig } from "../src/config";
import { refreshTools } from "../src/search-tools";

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
	ast_grep_search: true,
	ast_grep_replace: true,
	lsp_symbols: true,
	lsp_hover: true,
	lsp_navigate: true,
};

const CUSTOM_TOOLS = ["ast_grep_search", "ast_grep_replace", "lsp_symbols", "lsp_hover", "lsp_navigate"];

describe("refreshTools", () => {
	it("activates enabled custom tools that are not yet active", () => {
		const pi = makeMockPi(["read", "bash", "edit", "write"]);
		refreshTools(pi as unknown as ExtensionAPI, allTrueConfig);
		const result = pi.setActiveTools.mock.calls[0][0] as string[];
		for (const name of CUSTOM_TOOLS) expect(result).toContain(name);
	});

	it("preserves non-coding tools", () => {
		const pi = makeMockPi(["read", "bash", "edit", "write"]);
		refreshTools(pi as unknown as ExtensionAPI, allTrueConfig);
		const result = pi.setActiveTools.mock.calls[0][0] as string[];
		expect(result).toContain("read");
		expect(result).toContain("bash");
		expect(result).toContain("edit");
		expect(result).toContain("write");
	});

	it("removes custom tools that config says false", () => {
		const pi = makeMockPi(["read", "lsp_hover", "lsp_navigate"]);
		const config: CodingToolsConfig = { ...allTrueConfig, lsp_hover: false, lsp_navigate: false };
		refreshTools(pi as unknown as ExtensionAPI, config);
		const result = pi.setActiveTools.mock.calls[0][0] as string[];
		expect(result).not.toContain("lsp_hover");
		expect(result).not.toContain("lsp_navigate");
		expect(result).toContain("read");
	});

	it("all false removes every custom tool", () => {
		const pi = makeMockPi(["read", ...CUSTOM_TOOLS]);
		const config: CodingToolsConfig = {
			ast_grep_search: false,
			ast_grep_replace: false,
			lsp_symbols: false,
			lsp_hover: false,
			lsp_navigate: false,
		};
		refreshTools(pi as unknown as ExtensionAPI, config);
		expect(pi.setActiveTools.mock.calls[0][0]).toEqual(["read"]);
	});

	it("Set.add is idempotent — no duplicates", () => {
		const pi = makeMockPi(["read", "lsp_symbols"]);
		refreshTools(pi as unknown as ExtensionAPI, allTrueConfig);
		const result = pi.setActiveTools.mock.calls[0][0] as string[];
		expect(result.filter((t) => t === "lsp_symbols").length).toBe(1);
	});

	it("does not activate built-in ls/find/grep when inactive", () => {
		const pi = makeMockPi(["read", "bash", "edit", "write"]);
		refreshTools(pi as unknown as ExtensionAPI, allTrueConfig);
		const result = pi.setActiveTools.mock.calls[0][0] as string[];
		expect(result).not.toContain("ls");
		expect(result).not.toContain("find");
		expect(result).not.toContain("grep");
	});

	it("keeps built-in tools active when pi already activated them", () => {
		const pi = makeMockPi(["read", "grep"]);
		refreshTools(pi as unknown as ExtensionAPI, allTrueConfig);
		const result = pi.setActiveTools.mock.calls[0][0] as string[];
		expect(result).toContain("grep");
	});

	it("does not let legacy ls/find/grep keys deactivate built-ins", () => {
		const pi = makeMockPi(["read", "grep"]);
		const legacyConfig = { ...allTrueConfig, ls: false, find: false, grep: false } as CodingToolsConfig;
		refreshTools(pi as unknown as ExtensionAPI, legacyConfig);
		const result = pi.setActiveTools.mock.calls[0][0] as string[];
		expect(result).toContain("grep");
		expect(result).not.toContain("ls");
		expect(result).not.toContain("find");
	});
});
