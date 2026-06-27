import { isAbsolute, join, resolve } from "node:path";
import { AccessPath } from "../../access-intent/access-path";
import {
  ARG_NODE_TYPES,
  SKIP_SUBTREE_TYPES,
} from "../../access-intent/bash/node-text";
import type { TSNode } from "../../access-intent/bash/parser";
import {
  classifyTokenAsPathCandidate,
  classifyTokenAsRuleCandidate,
} from "../../access-intent/bash/token-classification";
import {
  collectCommandTokens,
  collectPathCandidateTokens,
  collectRedirectTokens,
  extractCommandName,
} from "../../access-intent/bash/token-collection";
import { canonicalizePath } from "../../canonicalize-path";
import {
  isPathWithinDirectory,
  isSafeSystemPath,
  normalizePathForComparison,
  normalizePathPolicyLiteral,
} from "../../path-utils";

// ── Internal types ───────────────────────────────────────────────────────────

/**
 * The working directory in force where a path candidate appears.
 *
 * A `known` base carries an `offset` to be joined with `cwd` at resolution
 * time: a relative-or-absolute path string built by folding the literal targets
 * of current-shell `cd` commands (`""` = `cwd`); an absolute offset (from
 * `cd /abs`) ignores `cwd` at resolution time.
 * An `unknown` base marks a non-literal `cd` target (`cd "$DIR"`, `cd $(…)`,
 * `cd -`, bare `cd`, `cd ~…`) that made the effective directory unresolvable.
 */
type EffectiveBase =
  | { readonly kind: "known"; readonly offset: string }
  | { readonly kind: "unknown" };

/**
 * A path-candidate token paired with the effective working directory projected
 * onto the point in the command stream where it appears.
 */
interface PathCandidate {
  readonly token: string;
  readonly base: EffectiveBase;
}

// ── Public output type ───────────────────────────────────────────────────────

export interface BashPathRuleCandidate {
  /** Raw path-like token shown in prompts, logs, and session approvals. */
  readonly token: string;
  /** The path's lexical and canonical forms for permission policy matching. */
  readonly path: AccessPath;
}

// ── Walk-time constants ──────────────────────────────────────────────────────

/** The working directory in force at the start of a program (`cwd`). */
const CWD_BASE: EffectiveBase = { kind: "known", offset: "" };

/** The effective directory after a non-literal or unresolvable `cd`. */
const UNKNOWN_BASE: EffectiveBase = { kind: "unknown" };

// ── AST walk — collect PathCandidates ───────────────────────────────────────

/**
 * Walk the AST once, collecting every path-candidate token tagged with the
 * effective working directory projected onto its position.
 *
 * The effective directory is stateful: it starts at `cwd` and each
 * current-shell `cd <literal>` (joined by `&&`, `||`, `;`, or a newline)
 * folds into it for subsequent commands.
 * A `cd` inside a pipeline or a backgrounded command runs in a subshell and
 * does not update the running directory; subshell and brace-group interiors
 * inherit the enclosing base without folding their own `cd`s (a conservative
 * first tier).
 */
export function collectPathCandidates(rootNode: TSNode): PathCandidate[] {
  const out: PathCandidate[] = [];
  walkForCandidates(rootNode, CWD_BASE, out);
  return out;
}

/**
 * Collect a single node's candidates tagged with `base`, returning the
 * effective base in force *after* the node (the input base unless the node is
 * a current-shell `cd <literal>` that folds the running directory).
 */
function walkForCandidates(
  node: TSNode,
  base: EffectiveBase,
  out: PathCandidate[],
): EffectiveBase {
  switch (node.type) {
    case "program":
    case "list":
    case "redirected_statement":
      return walkCurrentShellSequence(node, base, out);
    case "command":
      tagTokens(collectCommandTokens(node), base, out);
      return foldCd(node, base);
    case "pipeline":
      // tree-sitter-bash mis-groups a redirect-bearing `&&`/`;` list as the
      // first stage of a pipeline (`cd a && pnpm x 2>&1 | tail` parses as
      // `(cd a && pnpm x 2>&1) | tail`), burying a current-shell `cd` inside
      // a node the `default` case treats as non-folding. Recover bash operator
      // precedence (`|` binds tighter than `&&`/`||`/`;`): fold the first
      // stage's leading current-shell commands while keeping its terminal
      // command and every downstream stage as non-folding subshells (#454).
      return walkPipeline(node, base, out);
    case "subshell":
      // A subshell runs in a child shell: its interior `cd`s fold within the
      // subshell but reset on exit, so the folded base is discarded.
      walkCurrentShellSequence(node, base, out);
      return base;
    case "compound_statement":
      // A `{ … }` brace group runs in the current shell, so its `cd`s persist
      // to following commands — thread and return the folded base.
      return walkCurrentShellSequence(node, base, out);
    default:
      // Pipelines, control-flow bodies, redirect targets, and command/process
      // substitution interiors: collect every candidate in the subtree tagged
      // with the enclosing base and do not fold their internal `cd`s. (Folding
      // inside substitutions is deferred — conservative, never under-flags.)
      tagTokens(collectPathCandidateTokens(node), base, out);
      return base;
  }
}

/**
 * Fold a current-shell sequence (`program` / `list` / `redirected_statement`):
 * thread the effective base left-to-right through the children so a `cd`
 * updates the base for following siblings.
 * A statement immediately followed by the background operator (`&`) runs in a
 * subshell, so its folded base is discarded.
 */
function walkCurrentShellSequence(
  seqNode: TSNode,
  base: EffectiveBase,
  out: PathCandidate[],
): EffectiveBase {
  let current = base;
  for (let i = 0; i < seqNode.childCount; i++) {
    const child = seqNode.child(i);
    if (!child?.isNamed) continue;
    if (SKIP_SUBTREE_TYPES.has(child.type)) continue;
    const after = walkForCandidates(child, current, out);
    current = isBackgrounded(seqNode, i) ? current : after;
  }
  return current;
}

/**
 * Walk a `pipeline` node, returning the effective base in force after it.
 *
 * Each stage of a true pipeline (`A | B | C`) runs in a subshell, so a `cd`
 * inside any stage must not leak — the base normally passes through unchanged.
 * The exception is the first stage: tree-sitter-bash wraps a redirect-bearing
 * current-shell `&&`/`;` list (`cd a && pnpm x 2>&1 | tail`) as that stage,
 * and bash precedence makes the list's leading commands current-shell, so they
 * fold and the folded base persists past the pipeline to following siblings.
 *
 * The terminal command of the first stage is the real pipe stage (a subshell)
 * and must not fold; every stage after a `|` is a downstream subshell stage
 * and collects tokens against the folded base without folding (#454).
 */
function walkPipeline(
  node: TSNode,
  base: EffectiveBase,
  out: PathCandidate[],
): EffectiveBase {
  let current = base;
  let first = true;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child?.isNamed) continue;
    if (SKIP_SUBTREE_TYPES.has(child.type)) continue;
    if (first) {
      current = foldPipelineFirstStage(child, current, out);
      first = false;
      continue;
    }
    // Downstream stage (after a `|`): subshell — collect against the folded
    // base, do not fold.
    tagTokens(collectPathCandidateTokens(child), current, out);
  }
  return current;
}

/**
 * Collect the first pipe stage's candidates, folding its leading current-shell
 * `cd` commands when tree-sitter wrapped a `list` or `redirected_statement`
 * around them.
 * The terminal command of that container is the real pipe stage (a subshell)
 * and is collected without folding.
 * A bare `command` first stage (a true pipeline first stage such as
 * `cd nested | cat ../b`) is a subshell: it collects against the input base
 * and does not fold.
 */
function foldPipelineFirstStage(
  node: TSNode,
  base: EffectiveBase,
  out: PathCandidate[],
): EffectiveBase {
  if (node.type === "list") return foldListExceptTerminal(node, base, out);
  if (node.type === "redirected_statement") {
    let current = base;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child?.isNamed) continue;
      if (child.type === "file_redirect") {
        // Redirect destinations are part of the piped stage; collect them
        // against the folded base without folding.
        tagTokens(collectRedirectTokens(child), current, out);
        continue;
      }
      // The inner statement is the `list`/`command` being redirected; fold its
      // leading current-shell commands via the terminal-excluding walk.
      current = foldPipelineFirstStage(child, current, out);
    }
    return current;
  }
  // Bare `command` or any other shape: a true subshell first stage.
  tagTokens(collectPathCandidateTokens(node), base, out);
  return base;
}

/**
 * Fold every named, non-skip child of a `list` except the last, threading the
 * effective base left-to-right through the leading current-shell commands; the
 * terminal child is the real pipe stage and is collected without folding.
 */
function foldListExceptTerminal(
  node: TSNode,
  base: EffectiveBase,
  out: PathCandidate[],
): EffectiveBase {
  const namedChildren: TSNode[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.isNamed && !SKIP_SUBTREE_TYPES.has(child.type)) {
      namedChildren.push(child);
    }
  }
  let current = base;
  for (let i = 0; i < namedChildren.length; i++) {
    const child = namedChildren[i];
    if (i < namedChildren.length - 1) {
      current = walkForCandidates(child, current, out);
    } else {
      // Terminal child = the real pipe stage; collect without folding.
      tagTokens(collectPathCandidateTokens(child), current, out);
    }
  }
  return current;
}

/**
 * True when the statement at `index` is immediately followed by the background
 * operator (`&`) — distinct from the `&&` / `||` / `;` current-shell
 * separators.
 */
function isBackgrounded(seqNode: TSNode, index: number): boolean {
  const next = seqNode.child(index + 1);
  if (!next || next.isNamed) return false;
  return next.type === "&";
}

function tagTokens(
  tokens: readonly string[],
  base: EffectiveBase,
  out: PathCandidate[],
): void {
  for (const token of tokens) out.push({ token, base });
}

// ── cd-fold helpers ──────────────────────────────────────────────────────────

/**
 * Compute the effective base after a command runs.
 * Returns `base` unchanged unless the command is `cd`:
 *
 * - `cd /abs` (absolute literal) → a fresh known base, recovering from an
 *   earlier unknown base.
 * - `cd rel` (relative literal) → fold into a known base, or stay unknown if
 *   the base was already unknown.
 * - `cd "$DIR"` / `cd $(…)` / `cd -` / bare `cd` / `cd ~…` (non-literal) →
 *   unknown.
 */
function foldCd(commandNode: TSNode, base: EffectiveBase): EffectiveBase {
  if (extractCommandName(commandNode) !== "cd") return base;
  const target = cdLiteralTarget(commandNode);
  if (target === null) return UNKNOWN_BASE;
  if (isAbsolute(target)) return { kind: "known", offset: target };
  if (base.kind === "unknown") return UNKNOWN_BASE;
  return { kind: "known", offset: join(base.offset, target) };
}

/**
 * Resolve the literal target of a `cd` command, or `null` when the first
 * argument is not a static literal (contains an expansion or command
 * substitution) or cannot be resolved against the working directory (`cd -`,
 * `cd ~…`, bare `cd`).
 */
function cdLiteralTarget(commandNode: TSNode): string | null {
  for (let i = 0; i < commandNode.childCount; i++) {
    const child = commandNode.child(i);
    if (!child) continue;
    if (child.type === "command_name" || child.type === "variable_assignment")
      continue;
    if (!child.isNamed) continue;
    // Skip the `--` end-of-flags marker; the next argument is the target.
    if (child.type === "word" && child.text === "--") continue;
    if (!ARG_NODE_TYPES.has(child.type)) return null;
    return literalTextOf(child);
  }
  return null;
}

/**
 * The literal string value of an argument node, or `null` when it contains a
 * variable expansion / command substitution or is a non-resolvable `cd`
 * destination (`-`, `~…`).
 */
function literalTextOf(node: TSNode): string | null {
  switch (node.type) {
    case "word": {
      const text = node.text;
      if (text === "-" || text.startsWith("~")) return null;
      return text;
    }
    case "raw_string": {
      const text = node.text;
      return text.length >= 2 && text.startsWith("'") && text.endsWith("'")
        ? text.slice(1, -1)
        : text;
    }
    case "concatenation": {
      let result = "";
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child) continue;
        const part = literalTextOf(child);
        if (part === null) return null;
        result += part;
      }
      return result;
    }
    case "string": {
      let result = "";
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child) continue;
        if (child.type === '"') continue;
        if (child.type !== "string_content") return null;
        result += child.text;
      }
      return result;
    }
    default:
      return null;
  }
}

// ── Per-candidate helpers ────────────────────────────────────────────────────

/**
 * True when a path candidate is relative (resolved against the effective
 * directory) rather than absolute (`/…`) or home-relative (`~…`), which are
 * base-independent.
 * Used to decide which candidates an unknown base affects.
 */
function isRelativeCandidate(candidate: string): boolean {
  return !candidate.startsWith("/") && !candidate.startsWith("~");
}

function buildRuleCandidatePath(
  candidate: string,
  base: EffectiveBase,
  cwd: string,
): AccessPath {
  // An unknown base + relative candidate stays literal-only: a resolved
  // absolute or canonical alias would resolve against the wrong directory and
  // could spuriously match a rule (#393).
  if (base.kind === "unknown" && isRelativeCandidate(candidate)) {
    return AccessPath.forLiteral(normalizePathPolicyLiteral(candidate));
  }

  const resolveBase = base.kind === "known" ? resolve(cwd, base.offset) : cwd;
  return AccessPath.forPath(candidate, { cwd, resolveBase });
}

// ── Projection functions ─────────────────────────────────────────────────────

/**
 * Project a collection of path candidates into deduplicated external paths.
 *
 * Filters candidates through the strict path classifier
 * (`classifyTokenAsPathCandidate`), resolves each against its effective working
 * directory base, and returns only paths that resolve outside `cwd` in their
 * lexical (as-typed, normalized but not symlink-resolved) form.
 *
 * The outside-`cwd` decision and the dedup identity use the canonical
 * (symlink-resolved) form so `external_directory` config patterns match the
 * path as the user typed it (#418).
 */
export function projectExternalPaths(
  candidates: readonly PathCandidate[],
  cwd: string,
): AccessPath[] {
  const normalizedCwd = canonicalizePath(normalizePathForComparison(cwd, cwd));

  const seen = new Set<string>();
  const externalPaths: AccessPath[] = [];

  for (const { token, base } of candidates) {
    const candidate = classifyTokenAsPathCandidate(token);
    if (!candidate) continue;

    // Unknown effective directory: a relative candidate could resolve anywhere,
    // so flag it conservatively (resolving against `cwd` only for a display
    // path). Absolute / `~` candidates are base-independent and resolve below.
    if (base.kind === "unknown" && isRelativeCandidate(candidate)) {
      const lexical = normalizePathForComparison(candidate, cwd);
      const canonical = canonicalizePath(lexical);
      if (
        canonical &&
        normalizedCwd !== "" &&
        !isSafeSystemPath(canonical) &&
        !seen.has(canonical)
      ) {
        seen.add(canonical);
        // The factory recomputes the canonical via canonicalNormalizePathForComparison
        // (win32-lowercased, #382) rather than reusing the raw canonicalizePath output.
        externalPaths.push(AccessPath.forPath(lexical, { cwd }));
      }
      continue;
    }

    const resolveBase = base.kind === "known" ? resolve(cwd, base.offset) : cwd;
    const lexical = normalizePathForComparison(candidate, resolveBase);
    if (!lexical) continue;
    // The boundary decision and dedup identity use the canonical
    // (symlink-resolved) form, but the returned value is the lexical form so
    // config patterns match the path as the user typed it (#418).
    const canonical = canonicalizePath(lexical);

    if (
      normalizedCwd !== "" &&
      !isSafeSystemPath(canonical) &&
      !isPathWithinDirectory(canonical, normalizedCwd) &&
      !seen.has(canonical)
    ) {
      seen.add(canonical);
      // The factory recomputes the canonical via canonicalNormalizePathForComparison
      // (win32-lowercased, #382) rather than reusing the raw canonicalizePath output.
      externalPaths.push(AccessPath.forPath(lexical, { cwd }));
    }
  }

  return externalPaths;
}

/**
 * Project a collection of path candidates into rule candidates with their
 * cd-aware policy lookup values.
 *
 * Filters candidates through the broad path classifier
 * (`classifyTokenAsRuleCandidate`) and pairs each qualifying token with its
 * set of policy values (absolute + project-relative + raw).
 * A token after a non-literal `cd` keeps only its literal value so no
 * spurious absolute rule can match (#393).
 */
export function projectRuleCandidates(
  candidates: readonly PathCandidate[],
  cwd: string,
): BashPathRuleCandidate[] {
  const seen = new Set<string>();
  const result: BashPathRuleCandidate[] = [];

  for (const { token, base } of candidates) {
    const candidate = classifyTokenAsRuleCandidate(token);
    if (!candidate) continue;

    const path = buildRuleCandidatePath(candidate, base, cwd);
    const matchValues = path.matchValues();
    if (matchValues.length === 0) continue;

    const key = matchValues.join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ token: candidate, path });
  }

  return result;
}
