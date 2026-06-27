import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Expand `~` and `$HOME` prefixes in a pattern to the OS home directory.
 *
 * Supported forms:
 * - `~`          → `homedir()`
 * - `~/path`     → `homedir()/path`
 * - `~\path`     → `homedir()\path` (Windows)
 * - `$HOME`      → `homedir()`
 * - `$HOME/path` → `homedir()/path`
 * - `$HOME\path` → `homedir()\path` (Windows)
 *
 * All other patterns are returned unchanged.
 */
export function expandHomePath(pattern: string): string {
  if (pattern === "~" || pattern === "$HOME") {
    return homedir();
  }
  if (pattern.startsWith("~/") || pattern.startsWith("~\\")) {
    return join(homedir(), pattern.slice(2));
  }
  if (pattern.startsWith("$HOME/") || pattern.startsWith("$HOME\\")) {
    return join(homedir(), pattern.slice(6));
  }
  return pattern;
}
