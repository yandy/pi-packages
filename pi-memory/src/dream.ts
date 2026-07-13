import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ThinkLevel } from "./config";
import { runHeadlessAgent } from "./agent-runner";

/** Build dream consolidation task. (unchanged) */
export function buildDreamTask(memoryDir: string, maxLines: number): string {
	return `You are a memory consolidation agent. Your job is to read all memory files
and consolidate them into a clean, deduplicated memory store.

Phase 1 — Orient:
- List all files in ${memoryDir}
- Read MEMORY.md to understand current index
- Skim each topic file to understand its contents

Phase 2 — Gather Signal:
- Find duplicate entries within and across topic files
- Identify contradictory information
- Spot outdated or obsolete entries
- Note temporal references that should be absolute dates

Phase 3 — Consolidate:
- Merge duplicates into single entries
- Resolve contradictions — pick the most accurate version
- Convert relative dates (today, last week) to absolute dates
- Update outdated information
- Move entries to more appropriate topic files when needed
- Delete entries that are no longer relevant

Phase 4 — Prune & Index:
- For each topic file, update frontmatter:
  name: meaningful name for the topic
  description: specific summary that helps LLM match queries (be specific!)
  type: one of user, feedback, project, reference
  updated: today's date
- Generate a compact hook (~150 chars) for each topic summarizing its entries
- Rebuild MEMORY.md with one line per topic file (max ${maxLines} lines):
  - [Name](file.md) — hook
- Remove topic files that have no remaining entries

CRITICAL for hooks and descriptions:
- Only the MEMORY.md index is injected into future coding sessions.
  Topic file content is NOT seen by the coding agent unless explicitly
  read or auto-surfaced. The hook and description must be specific
  enough that the LLM can correctly decide relevance.
- Bad: "Debugging tips"
- Good: "SSH port 2222 on staging; MySQL 30s timeout; Redis auth fix"
- Each topic file's \`## Entry Title\` blocks contain the actual memory entries.
  The MEMORY.md line is just a pointer — only ONE line per topic file.
- When done, output a concise summary of changes (merged N, removed N, moved N, updated N).`;
}

export interface RunDreamOpts {
	model?: string;
	thinkLevel: ThinkLevel;
	memoryDir: string;
	modelRegistry: ModelRegistry;
	parentModel?: Model<any>;
}

/** Run dream consolidation via a headless agent. Fire-and-forget (caller decides await). */
export async function runDream(opts: RunDreamOpts): Promise<string> {
	const task = buildDreamTask(opts.memoryDir, 200);
	return runHeadlessAgent({
		task,
		cwd: opts.memoryDir,
		modelRegistry: opts.modelRegistry,
		model: opts.model,
		parentModel: opts.parentModel,
		thinkLevel: opts.thinkLevel,
		maxTurns: undefined,
	});
}
