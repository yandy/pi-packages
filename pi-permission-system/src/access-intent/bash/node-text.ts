import type { TSNode } from "../../access-intent/bash/parser";

/**
 * Node types whose subtrees must never be descended into for
 * path extraction — their text content is not a command argument.
 */
export const SKIP_SUBTREE_TYPES = new Set(["heredoc_body", "heredoc_end", "comment"]);

/**
 * Node types that represent argument values in the AST
 * (word, concatenation, single-quoted string, double-quoted string).
 */
export const ARG_NODE_TYPES = new Set(["word", "concatenation", "string", "raw_string"]);

/**
 * Resolve the "shell value" of an argument node — the string the shell
 * would pass to the command after quote removal.
 *
 * - `word`          → `.text` (already unquoted)
 * - `raw_string`    → strip surrounding single quotes
 * - `string`        → strip surrounding double quotes, concatenate children text
 * - `concatenation` → concatenate resolved children
 * - other           → `.text` as fallback
 */
export function resolveNodeText(node: TSNode): string {
	switch (node.type) {
		case "word":
			return node.text;
		case "raw_string": {
			// Strip surrounding single quotes: 'content' → content
			const t = node.text;
			if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
				return t.slice(1, -1);
			}
			return t;
		}
		case "string": {
			// Double-quoted string: concatenate the resolved text of inner children,
			// skipping the quote-delimiter nodes (literal `"`).
			let result = "";
			for (let i = 0; i < node.childCount; i++) {
				const child = node.child(i);
				if (!child) continue;
				// Skip the literal `"` delimiters
				if (child.type === '"') continue;
				result += resolveNodeText(child);
			}
			return result;
		}
		case "string_content":
		case "simple_expansion":
		case "expansion":
			return node.text;
		case "concatenation": {
			let result = "";
			for (let i = 0; i < node.childCount; i++) {
				const child = node.child(i);
				if (!child) continue;
				result += resolveNodeText(child);
			}
			return result;
		}
		default:
			return node.text;
	}
}
