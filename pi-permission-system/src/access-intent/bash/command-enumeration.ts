import type { TSNode } from "../../access-intent/bash/parser";
import type { BashCommandContext } from "../../types";

// ── Command type ─────────────────────────────────────────────────────────────

/**
 * One command-pattern unit of a parsed bash program.
 *
 * Minimal by design — `text` is the simple-command (or whole compound
 * statement) string matched against the bash rules.
 * The type is the stable extension point: #306 adds an execution `context`,
 * #307 adds per-command path candidates and an effective working directory.
 */
export interface BashCommand {
  readonly text: string;
  /**
   * Execution context for a nested command (substitution or subshell); absent
   * for a current-shell (top-level) command.
   */
  readonly context?: BashCommandContext;
  /**
   * True when this is an opaque-payload wrapper (`bash -c`/`eval`) whose inner
   * program is not re-parsed; its decision is floored to at least `ask` so it
   * cannot ride a permissive `allow`.
   */
  readonly opaque?: boolean;
}

// ── Command enumeration ──────────────────────────────────────────────────────

/**
 * Container node types descended into when enumerating command units.
 */
const COMMAND_ENUM_DESCEND = new Set([
  "program",
  "list",
  "pipeline",
  "redirected_statement",
]);

/**
 * Named node types skipped during command enumeration: redirect targets,
 * comments, and heredoc bodies — none is a command to evaluate.
 * Anonymous tokens (chain operators `&&`/`;`/`|`, substitution and subshell
 * delimiters `$(`/`)`/`` ` ``/`(`) are filtered by the `isNamed` guard, not
 * listed here.
 */
const COMMAND_ENUM_SKIP = new Set([
  "file_redirect",
  "heredoc_redirect",
  "herestring_redirect",
  "comment",
  "heredoc_body",
  "heredoc_end",
]);

/**
 * Nested execution contexts whose interior commands really execute and must be
 * evaluated too: command substitution (`$(…)`, backticks) and process
 * substitution (`<(…)`/`>(…)`).
 * Subshells (`( … )`) are handled separately because they are also emitted
 * whole.
 */
const NESTED_EXECUTION_CONTEXTS = new Map<string, BashCommandContext>([
  ["command_substitution", "command_substitution"],
  ["process_substitution", "process_substitution"],
]);

/**
 * Enumerate the command units of a bash program, in source order.
 *
 * Descends container nodes (`program`, `list`, `pipeline`,
 * `redirected_statement`) and emits each `command` node whole.
 * Additionally descends into the three nested execution contexts — command
 * substitution (`$(…)`, backticks), process substitution (`<(…)`/`>(…)`), and
 * subshells (`( … )`) — emitting each inner command as its own unit *in
 * addition to* the enclosing command, since those inner commands really execute
 * (#306).
 * Control-flow bodies and `{ … }` brace groups are emitted whole without
 * descending (deferred).
 *
 * The enclosing command/subshell is always still emitted whole, so adding the
 * nested units can only ever produce a more-restrictive decision, never weaker.
 *
 * Each emitted command unit has any leading `variable_assignment` prefix
 * stripped (so an env-var prefix cannot defeat a command-pattern rule).
 */
export function collectCommands(node: TSNode): BashCommand[] {
  const out: BashCommand[] = [];
  collectCommandsInto(node, undefined, out);
  return out;
}

function collectCommandsInto(
  node: TSNode,
  context: BashCommandContext | undefined,
  out: BashCommand[],
): void {
  // Anonymous tokens (operators `&&`/`;`/`|`, delimiters `$(`/`)`/`` ` ``/`(`)
  // carry no command.
  if (!node.isNamed) return;
  if (COMMAND_ENUM_SKIP.has(node.type)) return;

  if (node.type === "command") {
    out.push(
      makeUnit(commandUnitText(node), context, isOpaqueWrapperCommand(node)),
    );
    // A command's text already contains any substitution; descend its subtree
    // to ALSO emit the inner commands of command/process substitutions.
    collectSubstitutionCommands(node, out);
    return;
  }

  if (node.type === "subshell") {
    out.push(makeUnit(node.text, context)); // never-weaker whole emit
    descendCommandChildren(node, "subshell", out);
    return;
  }

  if (COMMAND_ENUM_DESCEND.has(node.type)) {
    descendCommandChildren(node, context, out);
    return;
  }

  // Any other named statement (compound_statement `{ … }`, if/while/for/case,
  // function_definition): emit whole, do not descend — deferred (#306).
  out.push(makeUnit(node.text, context));
}

function makeUnit(
  text: string,
  context: BashCommandContext | undefined,
  opaque = false,
): BashCommand {
  const unit: BashCommand = context ? { text, context } : { text };
  return opaque ? { ...unit, opaque } : unit;
}

/**
 * Shell command names whose `-c` flag introduces an opaque inline program.
 */
const SHELL_WRAPPER_NAMES = new Set(["bash", "sh", "dash", "zsh", "ksh"]);

/**
 * True when a `command` node is an opaque-payload wrapper: a shell
 * (`bash`/`sh`/`dash`/`zsh`/`ksh`) invoked with a `-c` flag, or `eval`. Its
 * inner program is a quoted argument the enumerator does not re-parse, so the
 * wrapper's decision is later floored to at least `ask`.
 *
 * The command name is matched on its basename (so `/bin/bash -c …` counts), and
 * a `-c` flag is recognized within a short-flag cluster (`-c`, `-ec`, `-xc`).
 * A leading `variable_assignment` prefix is skipped, matching `commandUnitText`.
 */
function isOpaqueWrapperCommand(node: TSNode): boolean {
  let commandName: string | undefined;
  let sawShortFlagC = false;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child?.isNamed) continue;
    if (child.type === "variable_assignment") continue;
    if (commandName === undefined) {
      commandName = basename(child.text);
      continue;
    }
    const text = child.text;
    if (text === "--") break;
    if (text.startsWith("-") && !text.startsWith("--") && text.includes("c")) {
      sawShortFlagC = true;
    }
  }
  if (commandName === undefined) return false;
  if (commandName === "eval") return true;
  return SHELL_WRAPPER_NAMES.has(commandName) && sawShortFlagC;
}

/** The final path segment of a command name (`/bin/bash` → `bash`). */
function basename(name: string): string {
  const slash = name.lastIndexOf("/");
  return slash === -1 ? name : name.slice(slash + 1);
}

/**
 * The command-pattern text of a `command` node, with any leading
 * `variable_assignment` prefix stripped.
 *
 * An env-var prefix (`AWS_PROFILE=prod aws …`, `PGPASSWORD=…`) is part of the
 * `command` node's text but must not defeat a rule that gates the underlying
 * command, so matching targets the text from the first non-assignment child
 * (the `command_name`) onward, sliced verbatim to preserve spacing. A pure
 * assignment (`FOO=bar`, no `command_name`) runs no command and is returned
 * unchanged.
 */
function commandUnitText(node: TSNode): string {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.isNamed && child.type !== "variable_assignment") {
      return node.text.slice(child.startIndex - node.startIndex);
    }
  }
  return node.text;
}

function descendCommandChildren(
  node: TSNode,
  context: BashCommandContext | undefined,
  out: BashCommand[],
): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) collectCommandsInto(child, context, out);
  }
}

/**
 * Search a command's subtree for command/process substitutions and enumerate
 * the commands inside them, tagged with the substitution's execution context.
 * A substitution can nest under `command_name` (when the whole command is
 * `$(…)`) or under an argument, so the entire subtree is searched.
 */
function collectSubstitutionCommands(node: TSNode, out: BashCommand[]): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    const nestedContext = NESTED_EXECUTION_CONTEXTS.get(child.type);
    if (nestedContext) {
      descendCommandChildren(child, nestedContext, out);
    } else {
      collectSubstitutionCommands(child, out);
    }
  }
}
