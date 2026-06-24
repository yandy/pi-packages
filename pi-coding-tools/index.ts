import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./src/config";
import { LspManager } from "./src/lsp/manager";
import { enableTools } from "./src/search-tools";
import { ast_grep_search } from "./src/tools/ast-grep-search";
import { createLspTools } from "./src/tools/lsp-tools";

export default function (pi: ExtensionAPI) {
	const lspManager = new LspManager();
	const lspTools = createLspTools(lspManager, () => loadConfig());

	// factory 注册 4 工具
	pi.registerTool(ast_grep_search);
	pi.registerTool(lspTools.lsp_symbols);
	pi.registerTool(lspTools.lsp_hover);
	pi.registerTool(lspTools.lsp_navigate);

	pi.on("session_start", async (_event, _ctx) => {
		enableTools(pi, loadConfig());
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		await lspManager.dispose();
	});
}
