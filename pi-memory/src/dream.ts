import { access } from "node:fs/promises";
import { getSubagentsService, type SubagentsService, type WorkspaceProvider } from "@yandy0725/pi-subagents";

/** Build dream consolidation task.
 *  Session context strategy: cwd = memoryDir (via WorkspaceProvider).
 *  Dream agent sees only the memory files, no parent conversation history.
 *  Tool scope: full file read/write/edit (needed for consolidation). */
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
	model: string;
	thinkLevel: string;
	memoryDir: string;
	signal?: AbortSignal;
	// biome-ignore lint/suspicious/noExplicitAny: pi events API handler
	events?: { on(channel: string, handler: (data: any) => void): () => void };
	service?: SubagentsService;
}

export async function runDream(opts: RunDreamOpts): Promise<string> {
	const service = opts.service ?? getSubagentsService();
	if (!service) throw new Error("pi-subagents not available — install @yandy0725/pi-subagents");

	const events = opts.events;
	if (!events) throw new Error("events required for dream — pass pi.events");

	const model = opts.model === "auto" ? undefined : opts.model;
	const task = buildDreamTask(opts.memoryDir, 200);

	// Register workspace provider so the subagent runs in memoryDir
	const provider: WorkspaceProvider = {
		async prepare(_ctx) {
			await access(opts.memoryDir).catch(() => {
				throw new Error(`Memory directory not found: ${opts.memoryDir}`);
			});
			return {
				cwd: opts.memoryDir,
				dispose: () => undefined,
			};
		},
	};
	const unregister = service.registerWorkspaceProvider(provider);

	// Spawn the dream subagent
	const agentId = service.spawn(
		"memory-agent",
		task,
		model ? { model, thinkingLevel: opts.thinkLevel } : { thinkingLevel: opts.thinkLevel },
	);

	// Wait for completion/failure via pi-subagents events (abort-while-queued
	// is handled: pi-subagents guarantees events fire for all terminal states).
	return await new Promise<string>((resolve, reject) => {
		let settled = false;

		const cleanup = () => {
			if (settled) return;
			settled = true;
			unsubCompleted();
			unsubFailed();
			unregister();
			opts.signal?.removeEventListener("abort", onAbort);
		};

		const onCompleted = (data: { id: string }) => {
			if (data.id !== agentId) return;
			cleanup();
			const record = service.getRecord(agentId);
			resolve(record?.result ?? "Dream completed.");
		};

		const onFailed = (data: { id: string; error?: string }) => {
			if (data.id !== agentId) return;
			cleanup();
			reject(new Error(data.error ?? "Dream agent failed"));
		};

		const onAbort = () => {
			service.abort(agentId);
		};

		const unsubCompleted = events.on("subagents:completed", onCompleted);
		const unsubFailed = events.on("subagents:failed", onFailed);

		opts.signal?.addEventListener("abort", onAbort, { once: true });
	});
}
