import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./src/config";
import { LspManager } from "./src/lsp/manager";
import { refreshTools } from "./src/search-tools";
import { ast_grep_replace } from "./src/tools/ast-grep-replace";
import { ast_grep_search } from "./src/tools/ast-grep-search";
import { createLspTools } from "./src/tools/lsp-tools";

export default function (pi: ExtensionAPI) {
	const lspManager = new LspManager();
	const lspTools = createLspTools(lspManager, (cwd) => loadConfig(cwd));

	pi.registerTool(ast_grep_search);
	pi.registerTool(ast_grep_replace);
	pi.registerTool(lspTools.lsp_symbols);
	pi.registerTool(lspTools.lsp_hover);
	pi.registerTool(lspTools.lsp_navigate);

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		refreshTools(pi, loadConfig(ctx.cwd));
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		await lspManager.dispose();
	});
}
