/**
 * Value object for a session-scoped approval: one surface, one-or-more patterns.
 *
 * Owned by gate descriptors and passed to the session store — the runner never
 * needs to know whether there is one pattern or many.
 */
export class SessionApproval {
  private constructor(
    readonly surface: string,
    readonly patterns: readonly string[],
  ) {}

  /** Create an approval for a single pattern (the common case). */
  static single(surface: string, pattern: string): SessionApproval {
    return new SessionApproval(surface, [pattern]);
  }

  /**
   * Create an approval for multiple patterns (e.g. bash external-directory
   * gates that cover several uncovered paths in one prompt).
   */
  static multiple(
    surface: string,
    patterns: readonly string[],
  ): SessionApproval {
    return new SessionApproval(surface, [...patterns]);
  }

  /** Representative pattern for the interactive prompt — the first, if any. */
  get representativePattern(): string | undefined {
    return this.patterns[0];
  }

  /**
   * Single-pattern shape `applyPermissionGate` echoes back to the caller.
   * Returns `undefined` when patterns is empty (degenerate case).
   */
  toGateApproval(): { surface: string; pattern: string } | undefined {
    const pattern = this.representativePattern;
    if (pattern === undefined) return undefined;
    return { surface: this.surface, pattern };
  }
}
