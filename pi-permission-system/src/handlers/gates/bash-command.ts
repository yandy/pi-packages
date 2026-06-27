import type { BashCommand } from "../../access-intent/bash/command-enumeration";
import { pickMostRestrictive } from "../../handlers/gates/candidate-check";
import type { ScopedPermissionResolver } from "../../permission-resolver";
import type { PermissionCheckResult } from "../../types";

/**
 * Resolve the bash command-pattern decision for a (possibly chained) command.
 *
 * A bash invocation may be a shell program with several commands joined by
 * `&&`, `||`, `;`, `|`, `&`, or newlines. Matching the whole string against the
 * bash patterns lets a denied command ride through on an allowed leading one
 * (issue #301). Instead, the caller supplies the program's command units (from
 * the shared `BashProgram.commands()` parse) — including those nested inside
 * substitutions and subshells (#306); each is evaluated on the `bash` surface
 * and the most restrictive result wins (`deny > ask > allow`).
 *
 * The selected result carries the offending sub-command in `command`, its rule
 * in `matchedPattern`, and the offending command's execution context in
 * `commandContext` (set only for a nested command), so the prompt,
 * session-approval suggestion, and decision event scope to that command.
 *
 * An opaque-payload wrapper unit (`bash -c`/`eval`, flagged `opaque` by the
 * enumerator) has its inner program hidden behind a quoted argument, so an
 * `allow` is floored up to a synthetic `ask` (the `<opaque-bash-wrapper>`
 * pattern) to keep it from riding a permissive rule; an explicit `deny`/`ask`
 * on the wrapper is left untouched (`deny > ask > allow`).
 *
 * When `commands` is empty there are two cases. A trivially-empty command (an
 * empty, whitespace-only, or comment-only line) has genuinely nothing to gate,
 * so the whole `command` is resolved as before. A non-empty command that parsed
 * to zero command units (a parse anomaly or an opaque program) fails closed to
 * a synthetic `ask` so a permissive top-level `*` cannot silently allow an
 * unparseable command (e.g. `cd /repo && git push` riding a top-level allow on
 * the empty-parse path) — #452.
 *
 * Pure and synchronous: the (async, tree-sitter) parse happens once in the
 * handler, which passes the decomposed `commands` here.
 */
export function resolveBashCommandCheck(
	command: string,
	commands: BashCommand[],
	agentName: string | undefined,
	resolver: ScopedPermissionResolver,
): PermissionCheckResult {
	if (commands.length === 0) {
		if (isTriviallyEmptyCommand(command)) {
			return resolver.resolve({
				kind: "tool",
				surface: "bash",
				input: { command },
				agentName,
			});
		}
		return {
			state: "ask",
			toolName: "bash",
			source: "bash",
			origin: "builtin",
			command,
			matchedPattern: "<unparseable-bash-command>",
		};
	}

	const results = commands.map((cmd) => {
		const base = resolver.resolve({
			kind: "tool",
			surface: "bash",
			input: { command: cmd.text },
			agentName,
		});
		const result =
			cmd.opaque && base.state === "allow"
				? {
						...base,
						state: "ask" as const,
						matchedPattern: "<opaque-bash-wrapper>",
					}
				: base;
		return cmd.context ? { ...result, commandContext: cmd.context } : result;
	});
	return (
		pickMostRestrictive(results) ??
		resolver.resolve({
			kind: "tool",
			surface: "bash",
			input: { command },
			agentName,
		})
	);
}

/**
 * True when a command has genuinely nothing to gate: it is empty,
 * whitespace-only, or contains only comment lines (every non-blank line starts
 * with `#`). Such a command yields zero command units legitimately, so the
 * whole-string resolve is safe rather than a parse anomaly.
 */
function isTriviallyEmptyCommand(command: string): boolean {
	const lines = command
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	return lines.every((line) => line.startsWith("#"));
}
