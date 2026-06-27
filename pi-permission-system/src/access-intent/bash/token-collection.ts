import { basename } from "node:path";
import { ARG_NODE_TYPES, resolveNodeText, SKIP_SUBTREE_TYPES } from "../../access-intent/bash/node-text";
import type { TSNode } from "../../access-intent/bash/parser";

// ── Public surface ─────────────────────────────────────────────────────────

/**
 * Recursively visit the AST and collect resolved text of nodes that
 * represent command arguments or redirect destinations.
 *
 * Skips `heredoc_body`, `heredoc_end`, and `comment` subtrees entirely.
 *
 * For commands in `PATTERN_FIRST_COMMANDS`, uses position-based
 * argument skipping to avoid collecting inline patterns/scripts
 * as path candidates. For all other commands, collects all
 * arguments generically.
 */
export function collectPathCandidateTokens(node: TSNode): string[] {
	if (SKIP_SUBTREE_TYPES.has(node.type)) return [];
	if (node.type === "command") return collectCommandTokens(node);
	if (node.type === "file_redirect") return collectRedirectTokens(node);

	const tokens: string[] = [];
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (child) tokens.push(...collectPathCandidateTokens(child));
	}
	return tokens;
}

/**
 * Select the collection strategy for a `command` node: pattern-first
 * commands use `collectPatternCommandTokens`; all others use
 * `collectGenericCommandTokens`.
 */
export function collectCommandTokens(node: TSNode): string[] {
	const commandName = extractCommandName(node);
	const config = commandName ? PATTERN_FIRST_COMMANDS.get(commandName) : undefined;
	return config ? collectPatternCommandTokens(node, config) : collectGenericCommandTokens(node);
}

/**
 * Collect redirect-destination tokens from a `file_redirect` node.
 */
export function collectRedirectTokens(node: TSNode): string[] {
	const tokens: string[] = [];
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (!child) continue;
		if (ARG_NODE_TYPES.has(child.type)) {
			tokens.push(resolveNodeText(child));
		}
	}
	return tokens;
}

/**
 * Extract the command name from a `command` node.
 * Returns the basename (e.g. `/usr/bin/sed` → `sed`), or undefined
 * if the command name cannot be determined (e.g. variable expansion).
 */
export function extractCommandName(node: TSNode): string | undefined {
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (!child) continue;
		if (child.type === "command_name") {
			const text = resolveNodeText(child);
			return text ? basename(text) : undefined;
		}
	}
	return undefined;
}

// ── Private helpers and config ─────────────────────────────────────────────

interface PatternCommandConfig {
	/** Flags that consume the next argument as a non-path value (pattern, separator, etc.) */
	readonly argConsumingFlags: ReadonlySet<string>;
	/** Flags that consume the next argument as a file path */
	readonly fileConsumingFlags: ReadonlySet<string>;
	/**
	 * Number of leading positional arguments that are patterns/scripts, not paths.
	 * Default: 1 (covers sed, awk, grep, rg).
	 * sd uses 2 (FIND and REPLACE_WITH are both non-path positionals).
	 */
	readonly patternPositionals?: number;
}

/**
 * Commands whose first N positional arguments are inline patterns/scripts,
 * not filesystem paths. The map stores per-command flag configuration so
 * the walker can correctly identify which arguments are consumed by flags
 * vs. which are positional.
 */
const PATTERN_FIRST_COMMANDS: ReadonlyMap<string, PatternCommandConfig> = new Map([
	[
		"sed",
		{
			argConsumingFlags: new Set(["-e", "-i"]),
			fileConsumingFlags: new Set(["-f"]),
		},
	],
	[
		"awk",
		{
			argConsumingFlags: new Set(["-e", "-F", "-v"]),
			fileConsumingFlags: new Set(["-f"]),
		},
	],
	[
		"gawk",
		{
			argConsumingFlags: new Set(["-e", "-F", "-v"]),
			fileConsumingFlags: new Set(["-f"]),
		},
	],
	[
		"nawk",
		{
			argConsumingFlags: new Set(["-e", "-F", "-v"]),
			fileConsumingFlags: new Set(["-f"]),
		},
	],
	[
		"grep",
		{
			argConsumingFlags: new Set(["-e", "-A", "-B", "-C", "-m"]),
			fileConsumingFlags: new Set(["-f"]),
		},
	],
	[
		"egrep",
		{
			argConsumingFlags: new Set(["-e", "-A", "-B", "-C", "-m"]),
			fileConsumingFlags: new Set(["-f"]),
		},
	],
	[
		"fgrep",
		{
			argConsumingFlags: new Set(["-e", "-A", "-B", "-C", "-m"]),
			fileConsumingFlags: new Set(["-f"]),
		},
	],
	[
		"rg",
		{
			argConsumingFlags: new Set(["-e", "-A", "-B", "-C", "-m", "-g", "-t", "-T", "-j", "-M", "-r", "-E"]),
			fileConsumingFlags: new Set(["-f"]),
		},
	],
	[
		"sd",
		{
			argConsumingFlags: new Set(["-n", "-f"]),
			fileConsumingFlags: new Set([]),
			patternPositionals: 2,
		},
	],
]);

/**
 * Describes what the walker should do when it encounters a flag word inside
 * a pattern-first command.  Using a discriminated union lets the `switch` in
 * `collectPatternCommandTokens` narrow `nextArgAction` without a non-null
 * assertion (which would trigger the Biome/ESLint assertion conflict).
 */
type PatternCommandFlagDirective =
	| { kind: "end-of-flags" }
	| { kind: "regular-flag" }
	| {
			kind: "consume-arg";
			nextArgAction: "skip" | "extract";
			setsExplicitScript: boolean;
	  };

/**
 * Classify a flag word from a pattern-first command into a directive that
 * tells the walker how to handle the flag and its following argument.
 */
function classifyPatternCommandFlag(text: string, config: PatternCommandConfig): PatternCommandFlagDirective {
	if (text === "--") return { kind: "end-of-flags" };
	if (config.argConsumingFlags.has(text)) {
		return {
			kind: "consume-arg",
			nextArgAction: "skip",
			setsExplicitScript: text === "-e" || text === "-f",
		};
	}
	if (config.fileConsumingFlags.has(text)) {
		return {
			kind: "consume-arg",
			nextArgAction: "extract",
			setsExplicitScript: true,
		};
	}
	return { kind: "regular-flag" };
}

/**
 * Collect path-candidate tokens from a command known to have
 * pattern/script arguments in leading positional slots.
 *
 * Uses position-based skipping: the first N positional arguments
 * (where N = patternPositionals, default 1) are assumed to be
 * inline patterns/scripts and are skipped. Remaining positional
 * arguments are collected as path candidates.
 *
 * Flags listed in `argConsumingFlags` consume the next argument
 * (skipped). Flags in `fileConsumingFlags` consume the next
 * argument as a file path (collected). The flags `-e` and `-f`
 * additionally signal that an explicit script was provided via
 * flag, so no inline positional script is expected.
 */
function collectPatternCommandTokens(node: TSNode, config: PatternCommandConfig): string[] {
	const patternPositionals = config.patternPositionals ?? 1;
	let hasExplicitScript = false;
	let positionalsSeen = 0;
	let nextArgAction: "skip" | "extract" | null = null;
	let pastEndOfFlags = false;
	const tokens: string[] = [];

	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (!child) continue;

		// Skip command_name and variable_assignment nodes.
		if (child.type === "command_name" || child.type === "variable_assignment") continue;

		// Only process argument-like nodes; recurse into others
		// (e.g. command_substitution) for nested commands.
		if (!ARG_NODE_TYPES.has(child.type)) {
			tokens.push(...collectPathCandidateTokens(child));
			continue;
		}

		const text = resolveNodeText(child);

		// Handle consumed argument from previous flag.
		if (nextArgAction === "skip") {
			nextArgAction = null;
			continue;
		}
		if (nextArgAction === "extract") {
			tokens.push(text);
			nextArgAction = null;
			continue;
		}

		// Flag detection (only before "--" end-of-flags marker).
		if (!pastEndOfFlags && child.type === "word" && text.startsWith("-") && text.length > 1) {
			const directive = classifyPatternCommandFlag(text, config);
			switch (directive.kind) {
				case "end-of-flags":
					pastEndOfFlags = true;
					break;
				case "consume-arg":
					nextArgAction = directive.nextArgAction;
					if (directive.setsExplicitScript) hasExplicitScript = true;
					break;
				case "regular-flag":
					break;
			}
			continue;
		}

		// Positional argument.
		if (!hasExplicitScript && positionalsSeen < patternPositionals) {
			positionalsSeen++;
			continue; // Skip: this is an inline pattern/script.
		}

		// File argument — collect as path candidate.
		tokens.push(text);
	}

	return tokens;
}

/**
 * Collect all argument tokens from a generic (non-pattern-first) command node,
 * skipping the command name and variable assignments.
 */
function collectGenericCommandTokens(node: TSNode): string[] {
	const tokens: string[] = [];
	let seenCommandName = false;

	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (!child) continue;

		if (child.type === "command_name") {
			seenCommandName = true;
			continue;
		}
		// Skip variable_assignment nodes (FOO=/bar)
		if (child.type === "variable_assignment") continue;

		// If there was no explicit command_name node, the first word-like
		// child is the command name itself — skip it.
		if (!seenCommandName && ARG_NODE_TYPES.has(child.type)) {
			seenCommandName = true;
			continue;
		}

		// Argument nodes: resolve their text and collect.
		if (ARG_NODE_TYPES.has(child.type)) {
			tokens.push(resolveNodeText(child));
			continue;
		}

		// Recurse into other children (e.g. command_substitution nested in args)
		tokens.push(...collectPathCandidateTokens(child));
	}

	return tokens;
}
