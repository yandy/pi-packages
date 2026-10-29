import type { defineTool as DefineToolType, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getPatternHint } from "../ast-grep/pattern-hints";
import { runAstGrepRewrite } from "../ast-grep/rewrite";
import { inferLangFromPath } from "../ast-grep/search";
import type { CliLanguage, CliRewriteMatch } from "../ast-grep/types";
import { formatRewriteResult } from "../formatters";
import { AST_GREP_LANGUAGES } from "./ast-grep-search";
import { AST_LANG_DESCRIPTION, AST_PATTERN_DESCRIPTION } from "./shared-params";

const defineTool = ((t) => t) as typeof DefineToolType;

function isCliLanguage(v: unknown): v is CliLanguage {
	return typeof v === "string" && (AST_GREP_LANGUAGES as readonly string[]).includes(v);
}

const ReplaceParams = Type.Object({
	pattern: Type.String({ description: AST_PATTERN_DESCRIPTION }),
	rewrite: Type.String({
		description:
			"Replacement string. Reference captured meta-variables, e.g. 'logger.info($MSG)'. The same $VAR/$$$ syntax as the pattern.",
	}),
	lang: Type.Optional(Type.String({ description: AST_LANG_DESCRIPTION })),
	path: Type.Optional(Type.String({ description: "File or directory to rewrite (default: cwd)" })),
	apply: Type.Optional(
		Type.Boolean({
			description: "Default false = dry-run: preview changes WITHOUT writing files. Set true to write changes to disk.",
		}),
	),
});

export interface AstGrepReplaceDetails {
	pattern: string;
	rewrite: string;
	lang?: CliLanguage;
	paths: string[];
	apply: boolean;
	matches: CliRewriteMatch[];
	totalMatches: number;
	truncated: boolean;
	error?: string;
	hint?: string;
}

export const ast_grep_replace = defineTool({
	name: "ast_grep_replace",
	label: "AST Grep Replace",
	description:
		"Rewrite code by AST structure (AST-aware find-and-replace). Dry-run by default: previews before→after changes WITHOUT writing. " +
		"Set apply=true to write changes to disk. Patterns use $VAR (single node) and $$$ (zero-or-more nodes) — NOT regex.",
	promptSnippet: "AST-aware rewrite (dry-run by default; apply=true to write)",
	promptGuidelines: [
		"Use ast_grep_replace for structural rewrites (same $VAR/$$$ pattern rules as ast_grep_search).",
		"Every $VAR used in rewrite must be captured by the pattern — unbound ones substitute to empty and vanish silently.",
	],
	parameters: ReplaceParams,
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const cwd = (ctx as ExtensionContext).cwd;
		const path = params.path ?? cwd;
		const apply = params.apply === true;
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
					rewrite: params.rewrite,
					paths: [path],
					apply,
					matches: [],
					totalMatches: 0,
					truncated: false,
				},
			};
		}
		if (!lang) lang = "typescript";

		const result = await runAstGrepRewrite({
			pattern: params.pattern,
			rewrite: params.rewrite,
			lang,
			paths: [path],
			apply,
		});
		const text = formatRewriteResult(result);
		const hint =
			result.matches.length === 0 && !result.error ? (getPatternHint(params.pattern, lang) ?? undefined) : undefined;
		const finalText = hint ? `${text}\n\n${hint}` : text;

		const details: AstGrepReplaceDetails = {
			pattern: params.pattern,
			rewrite: params.rewrite,
			lang,
			paths: [path],
			apply,
			matches: result.matches,
			totalMatches: result.totalMatches,
			truncated: result.truncated,
		};
		if (result.error !== undefined) details.error = result.error;
		if (hint !== undefined) details.hint = hint;

		return { content: [{ type: "text" as const, text: finalText }], details };
	},
});
