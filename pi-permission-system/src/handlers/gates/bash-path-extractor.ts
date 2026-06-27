import { BashProgram } from "../../access-intent/bash/program";

/**
 * Extract paths from a bash command string that resolve outside CWD.
 *
 * Thin facade over {@link BashProgram.externalPaths}; parses the command and
 * returns the cd-aware external paths in their lexical (as-typed) string form.
 * See `BashProgram` for the parsing and resolution semantics.
 *
 * Returns `string[]` (not `AccessPath[]`) so the large projection-correctness
 * test suite in `bash-external-directory.test.ts` can assert path values
 * without migrating every call site.
 */
export async function extractExternalPathsFromBashCommand(
  command: string,
  cwd: string,
): Promise<string[]> {
  return (await BashProgram.parse(command, cwd))
    .externalPaths()
    .map((p) => p.value());
}
