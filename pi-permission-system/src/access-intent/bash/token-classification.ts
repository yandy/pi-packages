/**
 * Pure, synchronous token-classification helpers for bash path extraction.
 *
 * Exports two classifiers consumed by `cwd-projection.ts`:
 *   - `classifyTokenAsPathCandidate` — strict gate for the external-directory guard.
 *   - `classifyTokenAsRuleCandidate` — broader gate for cross-cutting `path` rules.
 *
 * Both classifiers share the private `rejectNonPathToken` predicate that captures
 * the seven rejection cases common to both (the production clone this module was
 * extracted to eliminate).
 */

// ── Public classifiers ─────────────────────────────────────────────────────

/**
 * Strict path-candidate classifier for the external-directory guard.
 *
 * Accepts tokens that unambiguously look like filesystem paths:
 * - Absolute paths (starting with `/`)
 * - Home-relative paths (starting with `~/`)
 * - Parent-traversal paths (containing `..`)
 *
 * Returns the raw token string if it qualifies, or `null` to skip.
 */
export function classifyTokenAsPathCandidate(token: string): string | null {
  if (rejectNonPathToken(token)) return null;

  if (token.startsWith("/")) return token;
  if (token.startsWith("~/")) return token;
  if (token.includes("..")) return token;

  return null;
}

/**
 * Broader token classifier for cross-cutting `path` permission rules.
 *
 * Accepts the same shapes as `classifyTokenAsPathCandidate`, plus:
 * - Dot-files and `./`-relative paths (starting with `.`)
 * - Any relative path containing `/` (e.g. `src/foo.ts`)
 *
 * The `~/foo` case is covered by `includes("/")` — no separate `~/` branch needed.
 *
 * Does NOT require the strict "must start with `/` or `~/` or contain `..`"
 * gate that the external-directory classifier uses.
 *
 * Returns the raw token string if it qualifies, or `null` to skip.
 */
export function classifyTokenAsRuleCandidate(token: string): string | null {
  if (rejectNonPathToken(token)) return null;

  if (token.startsWith(".")) return token;
  if (token.includes("/")) return token; // covers ~/ paths and all relative paths with /
  if (token.includes("..")) return token; // bare ".." (no slash)

  return null;
}

// ── Private rejection predicate ────────────────────────────────────────────

/**
 * URL pattern to skip tokens that look like URLs rather than paths.
 */
const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Regex metacharacter sequences that are never found in real filesystem paths.
 * If a token contains any of these, it is almost certainly a regex pattern
 * (e.g. a grep argument) rather than a path.
 */
const REGEX_METACHAR_PATTERN = /\.\*|\.\+|\\\||\\\(|\\\)|\[.*?\]|\^\//;

/**
 * Shared rejection prelude: returns `true` when a token can never be a
 * filesystem path, regardless of which classifier is asking.
 *
 * Rejects: empty tokens, flags (leading `-`), env assignments (`FOO=/bar`),
 * URLs, `@scope/package` patterns, bare-slash tokens, and regex metacharacter
 * sequences.
 */
function rejectNonPathToken(token: string): boolean {
  if (!token) return true;
  if (token.startsWith("-")) return true;

  // Env assignment: = appears before any /  (FOO=/bar is an assignment,
  // /foo=bar is not because the slash comes first).
  const eqIndex = token.indexOf("=");
  const slashIndex = token.indexOf("/");
  if (eqIndex !== -1 && (slashIndex === -1 || eqIndex < slashIndex))
    return true;

  if (URL_PATTERN.test(token)) return true;

  // @scope/package patterns (npm scoped packages) — but @/ is allowed through
  // since it looks like an absolute-rooted path, not an npm scope.
  if (token.startsWith("@") && !token.startsWith("@/")) return true;

  // Bare-slash tokens (/, //, ///) resolve to filesystem root and are never
  // meaningful path arguments in practice.
  if (/^\/+$/.test(token)) return true;

  if (REGEX_METACHAR_PATTERN.test(token)) return true;

  return false;
}
