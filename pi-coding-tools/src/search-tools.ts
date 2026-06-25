import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CodingToolsConfig } from "./config";

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

export function refreshTools(pi: ExtensionAPI, config: CodingToolsConfig): void {
	const current = new Set(pi.getActiveTools());
	for (const name of ALL_TOOL_NAMES) {
		if (!config[name]) current.delete(name);
		else current.add(name);
	}
	pi.setActiveTools([...current]);
}
