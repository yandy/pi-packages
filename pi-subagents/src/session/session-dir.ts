/**
 * session-dir.ts — Pure function for deriving subagent session directories.
 *
 * Subagent sessions are nested under the parent session's basename so they are
 * discoverable via the parent session path without cluttering the main session list.
 */

import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * Derive the session directory for a subagent from the parent session file.
 *
 * Layout: `<parent-dir>/<parent-basename>/tasks/`
 *
 * Example:
 *   parent: `~/.pi/agent/sessions/--project--/2026-05-20T12-00-00Z_.jsonl`
 *   result: `~/.pi/agent/sessions/--project--/2026-05-20T12-00-00Z_/tasks`
 *
 * Falls back to a temp directory when the parent session is not persisted
 * (e.g. API/headless mode where the parent uses `SessionManager.inMemory()`).
 */
export function deriveSubagentSessionDir(
  parentSessionFile: string | undefined,
  cwd: string,
): string {
  if (parentSessionFile) {
    const dir = dirname(parentSessionFile);
    const base = basename(parentSessionFile, ".jsonl");
    return join(dir, base, "tasks");
  }

  // Fallback: use a temp directory keyed by uid and cwd so different
  // projects don't collide when the parent session is not persisted.
  const encoded = cwd.replace(/[/\\]/g, "-").replace(/^[A-Za-z]:-/, "").replace(/^-+/, "");
  const root = join(tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`);
  return join(root, encoded, "tasks");
}
