import type { defineTool as DefineToolType, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getPatternHint } from "../ast-grep/pattern-hints";
import { inferLangFromPath, runAstGrep } from "../ast-grep/search";
import type { CliLanguage, SgResult } from "../ast-grep/types";
import { formatSearchResult } from "../formatters";

const defineTool = ((t) => t) as typeof DefineToolType;

export const AST_GREP_LANGUAGES = ["typescript", "tsx", "javascript", "python", "java", "kotlin", "c", "cpp"] as const;

function isCliLanguage(v: unknown): v is CliLanguage {
	return typeof v === "string" && (AST_GREP_LANGUAGES as readonly string[]).includes(v);
}

const SearchParams = Type.Object({
	pattern: Type.String({
		description:
			"AST pattern with $VAR (single node) and $$$ (zero-or-more nodes). NOT regex. Must be a complete AST node.",
	}),
	lang: Type.Optional(
		Type.String({
			description: "Language: typescript/tsx/javascript/python/java/kotlin/c/cpp. Omit to infer from path extension.",
		}),
	),
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
		"Use ast_grep_search to find code by syntax structure. It ignores comments and string literals and handles cross-line patterns — use built-in grep only for plain text or comments.",
		"Patterns are AST nodes, not regex. Use $VAR (e.g. $X, $NAME) for a single node wildcard, $$$ for zero-or-more nodes. Example: 'console.log($MSG)' matches any console.log call.",
		"Do NOT use regex constructs (\\w, .*, |, [a-z], trailing ':') — they will not match. The tool returns a hint if it detects regex-style patterns.",
		"To find definitions: 'function $NAME($$$) { $$$ }' (ts/js), 'def $NAME($$$)' (py). Always pass lang when the project mixes languages.",
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
