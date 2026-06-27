import type { AccessPath } from "../../access-intent/access-path";
import { type BashCommand, collectCommands } from "../../access-intent/bash/command-enumeration";
import {
	type BashPathRuleCandidate,
	collectPathCandidates,
	projectExternalPaths,
	projectRuleCandidates,
} from "../../access-intent/bash/cwd-projection";
import { getParser } from "../../access-intent/bash/parser";

export type { BashCommand, BashPathRuleCandidate };

/**
 * A bash command parsed once into a born-ready representation.
 *
 * Parsing is the expensive step (tree-sitter WASM); `BashProgram` performs it
 * a single time and eagerly resolves all three typed slices so the bash
 * permission gates do not each re-parse or re-walk the command, and so the
 * slices are guaranteed to agree.
 *
 * Construct via the async `parse()` factory; the constructor is private.
 */
export class BashProgram {
	private constructor(
		private readonly commandUnits: readonly BashCommand[],
		private readonly resolvedExternalPaths: readonly AccessPath[],
		private readonly resolvedRuleCandidates: readonly BashPathRuleCandidate[],
	) {}

	/**
	 * Parse a bash command into a born-ready `BashProgram`.
	 *
	 * Uses tree-sitter-bash to build the full AST, enumerates command units and
	 * walks path-candidate tokens once, then eagerly resolves all three slices
	 * against `cwd`. Heredoc bodies, comments, and other non-argument content are
	 * skipped. An unparseable command yields an empty program.
	 */
	static async parse(command: string, cwd: string): Promise<BashProgram> {
		const parser = await getParser();
		const tree = parser.parse(command);
		if (!tree) return new BashProgram([], [], []);

		try {
			const candidates = collectPathCandidates(tree.rootNode);
			return new BashProgram(
				collectCommands(tree.rootNode),
				projectExternalPaths(candidates, cwd),
				projectRuleCandidates(candidates, cwd),
			);
		} finally {
			tree.delete();
		}
	}

	/**
	 * The top-level command-pattern units of the chain, in source order.
	 *
	 * Splits on the shell chain operators (`&&`, `||`, `;`, `|`, `&`, newlines);
	 * quotes, command substitution, and subshells are respected by the parser and
	 * are NOT split — a subshell or other compound statement is emitted whole.
	 * Each unit has any leading `variable_assignment` prefix stripped, and an
	 * opaque-payload wrapper (`bash -c`/`eval`) is flagged `opaque` so its decision
	 * is floored to `ask`.
	 * May be empty (e.g. an empty command or a comment-only line); callers fall
	 * back to the whole command so the surface is never evaluated weaker than
	 * before.
	 */
	// Used by resolveBashCommandCheck (bash-command.ts) and tests. Fallow's
	// syntactic analysis cannot resolve the static-factory return type (private
	// ctor), so it reports a false positive here.
	// fallow-ignore-next-line unused-class-member
	commands(): BashCommand[] {
		return [...this.commandUnits];
	}

	/**
	 * Deduplicated paths that resolve outside `cwd`, as {@link AccessPath} value
	 * objects holding both the lexical (as-typed) and canonical (symlink-resolved)
	 * forms behind distinct accessors.
	 *
	 * Resolved eagerly at parse time against the `cwd` supplied to `parse()`.
	 * Use `.matchValues()` for `external_directory` pattern matching and
	 * `.boundaryValue()` for containment checks; `.value()` for display and logs.
	 */
	externalPaths(): AccessPath[] {
		return [...this.resolvedExternalPaths];
	}

	/**
	 * Path-rule candidates paired with their policy lookup values.
	 *
	 * Resolved eagerly at parse time against the `cwd` supplied to `parse()`.
	 * Each token is resolved against the effective working directory in force at
	 * the token's position (folding literal current-shell `cd` commands), while
	 * raw and project-relative aliases are retained for backward-compatible
	 * relative rules. A token after a non-literal `cd` keeps only its literal
	 * value so no spurious absolute rule can match (#393).
	 */
	pathRuleCandidates(): BashPathRuleCandidate[] {
		return [...this.resolvedRuleCandidates];
	}
}
