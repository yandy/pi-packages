import { StringEnum } from "@earendil-works/pi-ai";
import type { defineTool as DefineToolType, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CodingToolsConfig } from "../config";
import { formatHover, formatNavigate, formatSymbolTree } from "../formatters";
import type { LspManager } from "../lsp/manager";

const defineTool = ((t) => t) as typeof DefineToolType;

/** Minimal details carried by the LSP tools. */
export interface LspToolDetails {
	operation?: string;
	error?: string;
}

export interface LspTools {
	lsp_symbols: ReturnType<typeof defineTool>;
	lsp_hover: ReturnType<typeof defineTool>;
	lsp_navigate: ReturnType<typeof defineTool>;
}

/**
 * 三个 LSP 工具共用的「需要 language server」声明。
 *
 * 同一字符串注入三个工具后，pi 会按精确字符串去重 → system prompt 里只付 1 份（R6）。
 * 此前这条事实在 3 个 description 各写一次、又在 2 个 guideline 里换成不同措辞各写一次，
 * 既重复又因措辞漂移而去重失败。
 */
const LSP_LANGUAGE_SERVER_GUIDELINE =
	"lsp_symbols, lsp_hover and lsp_navigate need a language server; without one they return an install hint.";

export function createLspTools(manager: LspManager, getConfig: (cwd: string) => CodingToolsConfig): LspTools {
	const lsp_symbols = defineTool({
		name: "lsp_symbols",
		label: "LSP Symbols",
		description:
			"Get a file's symbol outline (classes, functions, methods, etc.) via LSP. ~95% fewer tokens than reading the whole file.",
		promptSnippet: "File skeleton outline via LSP (saves ~95% tokens vs full read)",
		promptGuidelines: [
			"Use lsp_symbols to skim an unfamiliar file's structure before reading details — far cheaper than read.",
			LSP_LANGUAGE_SERVER_GUIDELINE,
		],
		parameters: Type.Object({ path: Type.String({ description: "File path" }) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const cwd = (ctx as ExtensionContext).cwd;
			try {
				const { client } = await manager.getClientForFile(params.path, cwd, getConfig(cwd));
				const syms = await client.documentSymbols(params.path);
				return {
					content: [{ type: "text" as const, text: formatSymbolTree(syms, params.path) }],
					details: {} satisfies LspToolDetails,
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: ${e instanceof Error ? e.message : String(e)}`,
						},
					],
					details: { error: e instanceof Error ? e.message : String(e) } satisfies LspToolDetails,
				};
			}
		},
	});

	const lsp_hover = defineTool({
		name: "lsp_hover",
		label: "LSP Hover",
		description:
			"Query the type/documentation of the symbol at a position via LSP. The only tool that answers 'what type is this expression'.",
		promptSnippet: "Type/docs query at a position via LSP (what type is this)",
		promptGuidelines: [
			"Use lsp_hover to get a symbol's type or docs without reading surrounding code.",
			LSP_LANGUAGE_SERVER_GUIDELINE,
		],
		parameters: Type.Object({
			path: Type.String({ description: "File path" }),
			line: Type.Integer({ description: "Line number (1-based)" }),
			character: Type.Integer({ description: "Column (0-based)" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const cwd = (ctx as ExtensionContext).cwd;
			try {
				const { client } = await manager.getClientForFile(params.path, cwd, getConfig(cwd));
				const h = await client.hover(params.path, params.line, params.character);
				return {
					content: [{ type: "text" as const, text: formatHover(h) }],
					details: {} satisfies LspToolDetails,
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: ${e instanceof Error ? e.message : String(e)}`,
						},
					],
					details: { error: e instanceof Error ? e.message : String(e) } satisfies LspToolDetails,
				};
			}
		},
	});

	const lsp_navigate = defineTool({
		name: "lsp_navigate",
		label: "LSP Navigate",
		description:
			"Semantic navigation: jump to a symbol's definition, or find all its references, via LSP. More precise than ast_grep_search (resolves overloads, inheritance, node_modules type defs; no same-name false positives).",
		promptSnippet: "Semantic goto-definition / find-references via LSP (precise, not textual)",
		promptGuidelines: [
			"Use lsp_navigate with operation='definition'/'references' for exact cross-file resolution (resolves overloads/inheritance/typedefs; no same-name false positives).",
			LSP_LANGUAGE_SERVER_GUIDELINE,
		],
		parameters: Type.Object({
			path: Type.String({ description: "File path" }),
			line: Type.Integer({ description: "Line number (1-based)" }),
			character: Type.Integer({ description: "Column (0-based)" }),
			operation: StringEnum(["definition", "references"] as const, {
				description: "definition = where it's defined; references = who uses it",
			}),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const cwd = (ctx as ExtensionContext).cwd;
			try {
				const { client } = await manager.getClientForFile(params.path, cwd, getConfig(cwd));
				if (params.operation === "definition") {
					const r = await client.definition(params.path, params.line, params.character);
					return {
						content: [{ type: "text" as const, text: formatNavigate("definition", r, cwd) }],
						details: { operation: "definition" } satisfies LspToolDetails,
					};
				}
				const r = await client.references(params.path, params.line, params.character);
				return {
					content: [{ type: "text" as const, text: formatNavigate("references", r, cwd) }],
					details: { operation: "references" } satisfies LspToolDetails,
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: ${e instanceof Error ? e.message : String(e)}`,
						},
					],
					details: {
						operation: params.operation,
						error: e instanceof Error ? e.message : String(e),
					} satisfies LspToolDetails,
				};
			}
		},
	});

	return { lsp_symbols, lsp_hover, lsp_navigate };
}
