import type { defineTool as DefineToolType, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getPatternHint } from "../ast-grep/pattern-hints";
import { inferLangFromPath, runAstGrep } from "../ast-grep/search";
import type { CliLanguage, SgResult } from "../ast-grep/types";
import { formatSearchResult } from "../formatters";
import { AST_LANG_DESCRIPTION, AST_PATTERN_DESCRIPTION } from "./shared-params";

const defineTool = ((t) => t) as typeof DefineToolType;

export const AST_GREP_LANGUAGES = ["typescript", "tsx", "javascript", "python", "java", "kotlin", "c", "cpp"] as const;

function isCliLanguage(v: unknown): v is CliLanguage {
	return typeof v === "string" && (AST_GREP_LANGUAGES as readonly string[]).includes(v);
}

const SearchParams = Type.Object({
	pattern: Type.String({ description: AST_PATTERN_DESCRIPTION }),
	lang: Type.Optional(Type.String({ description: AST_LANG_DESCRIPTION })),
	path: Type.Optional(Type.String({ description: "File or directory to search (default: cwd)" })),
});

export interface AstGrepSearchDetails {
	pattern: string;
	lang?: CliLanguage;
	paths: string[];
	matches: SgResult["matches"];
	totalMatches: number;
	truncated: boolean;
	error?: string;
	hint?: string;
}

export const ast_grep_search = defineTool({
	name: "ast_grep_search",
	label: "AST Grep Search",
	description:
		"Search code by AST syntax structure. More precise than grep: ignores comments/strings, handles cross-line patterns. " +
		"Patterns are AST nodes using $VAR (single node) and $$$ (zero-or-more nodes) — NOT regex.",
	promptSnippet: "Search code by AST structure (more precise than grep; ignores comments/strings)",
	promptGuidelines: [
		"Use ast_grep_search to find code by syntax structure — it ignores comments/strings and matches across lines. For plain text use grep (or rg via bash).",
		"Patterns are AST nodes, not regex: \\w, .*, [a-z], a bare alternation bar, and a trailing ':' never match; the tool returns a hint when it detects them.",
		"Definitions: 'function $NAME($$$) { $$$ }' (ts/js), 'def $NAME($$$)' (py). Pass lang in mixed-language repos.",
	],
	parameters: SearchParams,
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const cwd = (ctx as ExtensionContext).cwd;
		const path = params.path ?? cwd;
		let lang: CliLanguage | undefined = params.lang
			? isCliLanguage(params.lang)
				? params.lang
				: undefined
			: inferLangFromPath(path);
		if (params.lang && !isCliLanguage(params.lang)) {
			return {
				content: [{ type: "text" as const, text: `Unsupported language: ${params.lang}` }],
				details: {
					pattern: params.pattern,
					paths: [path],
					matches: [],
					totalMatches: 0,
					truncated: false,
				},
			};
		}
		if (!lang) lang = "typescript";

		const result = await runAstGrep({ pattern: params.pattern, lang, paths: [path] });
		const text = formatSearchResult(result);
		const hint =
			result.matches.length === 0 && !result.error ? (getPatternHint(params.pattern, lang) ?? undefined) : undefined;
		const finalText = hint ? `${text}\n\n${hint}` : text;

		const details: AstGrepSearchDetails = {
			pattern: params.pattern,
			lang,
			paths: [path],
			matches: result.matches,
			totalMatches: result.totalMatches,
			truncated: result.truncated,
		};
		if (result.error !== undefined) details.error = result.error;
		if (hint !== undefined) details.hint = hint;

		return { content: [{ type: "text" as const, text: finalText }], details };
	},
});
