import { describe, expect, it, vi } from "vitest";
import type { CodingToolsConfig } from "../src/config";
import { enableSearchTools } from "../src/search-tools";

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
		const config: CodingToolsConfig = {
			ls: false,
			find: false,
			grep: false,
			ast_grep_search: false,
			lsp_symbols: false,
			lsp_hover: false,
			lsp_navigate: false,
		};
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
