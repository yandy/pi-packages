import { realpathSync } from "node:fs";
import { join } from "node:path";

/**
 * Resolve symlinks in an absolute path, best-effort.
 *
 * Splits the path into components and tries `realpathSync` from the full path
 * down to `/`, re-appending the non-existent tail to the first ancestor that
 * resolves. Returns the input unchanged when no ancestor resolves (unreachable
 * in practice since `/` always exists) or when a non-ENOENT/ENOTDIR error is
 * encountered (e.g. `EACCES`, `ELOOP`), so callers fall back to lexical
 * containment for paths that cannot be resolved.
 */
export function canonicalizePath(absolutePath: string): string {
  if (!absolutePath) return absolutePath;

  const parts = absolutePath.split("/").filter(Boolean);
  for (let i = parts.length; i >= 0; i--) {
    const candidate = "/" + parts.slice(0, i).join("/");
    try {
      const real = realpathSync(candidate);
      const tail = parts.slice(i);
      return tail.length === 0 ? real : join(real, ...tail);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return absolutePath;
    }
  }
  return absolutePath;
}
