import {
  canonicalNormalizePathForComparison,
  getPathPolicyValues,
  normalizePathForComparison,
} from "../path-utils";

/**
 * A path's two representations held behind type-distinct accessors.
 *
 * A single `string` carrying both meanings was the root cause of [#418]:
 * both external-directory gates matched config patterns against the
 * symlink-resolved (canonical) path instead of the typed (lexical) path,
 * defeating a configured `/tmp/*` allow.
 *
 * `AccessPath` makes the misuse a compile error:
 * - {@link matchValues} returns `string[]` — the lexical alias union ∪ canonical,
 *   for `external_directory` pattern matching.
 * - {@link boundaryValue} returns `string` — the canonical form, for
 *   outside-CWD containment and infra-read checks.
 * - {@link value} returns `string` — the lexical absolute form, for display,
 *   approval patterns, decision values, and logs.
 *
 * Construct via {@link forPath} (resolved, with optional cd-folded base) or
 * {@link forLiteral} (literal-only, for an unknown base); the constructor is
 * private.
 */
export class AccessPath {
  private constructor(
    private readonly lexical: string,
    private readonly matchAliases: readonly string[],
    private readonly canonical: string,
  ) {}

  /**
   * Pattern-match values for the `external_directory` surface: the lexical
   * alias union plus the canonical alias, so a config pattern on either the
   * typed form (`/tmp/*`) or the symlink-resolved form (`/private/tmp/*`)
   * matches (#418).
   *
   * Collapses to the lexical aliases when the canonical equals one of them
   * (e.g. when the path is not a symlink).
   */
  matchValues(): string[] {
    return this.canonical
      ? [...new Set([...this.matchAliases, this.canonical])]
      : [...this.matchAliases];
  }

  /**
   * Canonical (symlink-resolved, win32-lowercased) form, for the outside-CWD
   * boundary decision and Pi infrastructure-read containment checks.
   *
   * Returns `""` when the path could not be resolved (empty input).
   */
  boundaryValue(): string {
    return this.canonical;
  }

  /**
   * Lexical (as-typed, normalized but not symlink-resolved) form, for display,
   * approval patterns, decision values, and log messages.
   *
   * Returns `""` for empty input.
   */
  value(): string {
    return this.lexical;
  }

  /**
   * Build an `AccessPath` for a tool-input or bash-token path, resolved against
   * `resolveBase` (the cd-folded effective directory; defaults to `cwd`).
   *
   * Serves every path surface: the tool path gate, the tool external-directory
   * gate, and the bash path/external-directory gates (which pass a cd-resolved
   * `resolveBase`).
   *
   * - `matchValues()` returns the lexical alias union from `getPathPolicyValues`
   *   plus the canonical alias from `canonicalNormalizePathForComparison`
   *   (#418), so a config pattern on either the typed or symlink-resolved form
   *   matches.
   * - `boundaryValue()` returns
   *   `canonicalNormalizePathForComparison(pathValue, resolveBase)`, which is
   *   win32-lowercased (#382) — do not substitute a raw `canonicalizePath`
   *   output here.
   * - `value()` returns `normalizePathForComparison(pathValue, resolveBase)`,
   *   the absolute lexical form.
   */
  static forPath(
    pathValue: string,
    options: { cwd: string; resolveBase?: string },
  ): AccessPath {
    const { cwd, resolveBase = cwd } = options;
    return new AccessPath(
      normalizePathForComparison(pathValue, resolveBase),
      getPathPolicyValues(pathValue, { cwd, resolveBase }),
      canonicalNormalizePathForComparison(pathValue, resolveBase),
    );
  }

  /**
   * Build a literal-only `AccessPath` for a path whose effective base is
   * unknown (a relative bash token after a non-literal `cd`).
   *
   * Carries no canonical alias and no absolute resolution — `matchValues()` is
   * `[literal]` (or `[]` when empty) and `boundaryValue()` is `""` — so no
   * spurious absolute or symlink-resolved rule can match (#393).
   */
  static forLiteral(literal: string): AccessPath {
    return new AccessPath(literal, literal ? [literal] : [], "");
  }
}
