import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./src/config";
import { LspManager } from "./src/lsp/manager";
import { syncToolsStatus } from "./src/search-tools";
import { ast_grep_search } from "./src/tools/ast-grep-search";
import { createLspTools } from "./src/tools/lsp-tools";

export default function (pi: ExtensionAPI) {
	const lspManager = new LspManager();
	const lspTools = createLspTools(lspManager, () => loadConfig());

	pi.registerTool(ast_grep_search);
	pi.registerTool(lspTools.lsp_symbols);
	pi.registerTool(lspTools.lsp_hover);
	pi.registerTool(lspTools.lsp_navigate);

	pi.on("session_start", () => {
		syncToolsStatus(pi, loadConfig());
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		await lspManager.dispose();
	});
}
