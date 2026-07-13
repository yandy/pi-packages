/**
 * agent-types.ts — Register a single minimal agent type for pi-memory subagents.
 *
 * Writes `memory-agent.md` to ~/.pi/agent/agents/ so pi-subagents
 * picks it up as a custom agent type with restricted tools and replace-mode prompt.
 * Written during extension factory (before pi-subagents initializes its registry).
 *
 * One type serves three tasks:
 *   - side-query:    thinking=off,  maxTurns=1
 *   - extractMemories: thinking=high, maxTurns=5
 *   - dream:         thinking=high  (unlimited turns)
 *
 * On first install (before pi restart), pi-subagents auto-falls-back to
 * general-purpose. No manual action needed.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

const AGENTS_DIR = join(homedir(), CONFIG_DIR_NAME, "agent", "agents");

const DEFINITION = `---
description: Memory maintenance agent — file read/write only (no bash/websearch)
tools: read, write, edit, ls
prompt_mode: replace
---
`;

export function ensureAgentTypes(): void {
	try {
		mkdirSync(AGENTS_DIR, { recursive: true });
	} catch {
		return;
	}

	const path = join(AGENTS_DIR, "memory-agent.md");
	if (!existsSync(path)) {
		try {
			writeFileSync(path, DEFINITION, "utf8");
		} catch {}
	}
}
