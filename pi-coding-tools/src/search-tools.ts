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
		if (!enabled[name] && current.has(name)) {
			current.delete(name);
		} else if (enabled[name] && allTools.has(name) && !current.has(name)) {
			current.add(name);
		}
	}
	pi.setActiveTools([...current]);
}
