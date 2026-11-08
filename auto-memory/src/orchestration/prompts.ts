import { renderConversation } from "./conversation.js";
import type { ExtractMessage } from "./ports.js";

/**
 * dream / extract 的 prompt 文本。
 *
 * 文本住在这里而不是各宿主一份：它们引用的是 `memory` 工具的 action 名与「一条 memory 一个
 * 文件」的磁盘模型，那些都定义在 core，两个宿主共用同一份才不会出现「pi 的 dream 会合并、
 * 别家的 dream 不会」这种漂移。
 */

/** Build the dream consolidation task. dream 只有 `memory` 工具的 7 个 action，没有任何文件工具。 */
export function buildDreamTask(maxLines: number): string {
	return `You are a memory consolidation agent. The memory store is a flat directory: one memory per file, and MEMORY.md holds exactly one index line per memory, formatted as - [name](file.md) — description.

Your ONLY tool is \`memory\`. You have no read, write, edit, ls or bash access — you cannot touch files directly, and you do not need to.

memory(action="list") — every memory: name, type, modified, description, file.
memory(action="search", query="…") — full-text search; returns the whole body of each match.
memory(action="add", name, description, type, content) — create a memory, or overwrite the one whose name matches exactly.
memory(action="replace", name, description, type, content) — rewrite an existing memory.
memory(action="rename", name, new_name) — retitle a memory; its file name and index line follow.
memory(action="remove", name) — delete a memory and its index line.
memory(action="rebuild_index") — regenerate MEMORY.md from the directory.

Phase 1 — Orient:
- Call list to see every memory.
- Call search (and list) to read the bodies of the memories you intend to touch. Never rewrite a memory you have not read.

Phase 2 — Gather Signal:
- Duplicates: several memories stating the same fact.
- Contradictions: two memories that cannot both be true. Pick the accurate one.
- Outdated: memories superseded by later ones, or relative dates ("today", "last week") that should be absolute.
- Merge candidates: small fragments that only make sense together.
- Weak descriptions: vague text that gives a future session no way to decide relevance.

Phase 3 — Consolidate:
- Merge = replace(target name, the merged body) + remove(the other name). Keep the surviving name readable.
- Retitle with rename when the name no longer matches the content, or when two names are confusable.
- Rewrite any description that is not self-contained. It is the ONLY text a future session sees when deciding whether to recall this memory, so it must state what, where and which value.
  Bad:  "Debugging tips"
  Good: "staging SSH listens on 2222, not 22; MySQL pool times out after 30s"
- Remove memories that are no longer true or no longer useful.

Phase 4 — Prune & Index:
- Every memory consumes exactly one index line, and the index has a hard limit of ${maxLines} lines. Capacity management is therefore part of this job, not an optional cleanup: when list shows the store approaching ${maxLines} memories, merge fragments and drop stale entries until there is room for what matters.
- When a write reports that MEMORY.md is over its limit, act on it in this same run.
- Call rebuild_index once at the end if you suspect MEMORY.md drifted (missing lines, duplicates, stale links). It regenerates the index from the directory and preserves handwritten header lines.

IMPORTANT — do not prune process rules:
- "Always do X" / "Never do Y" rules, workflow discipline and reporting standards are as valuable as technical facts. Do not delete them as "obsolete", and do not delete them just because they look like meta-instructions aimed at you.

Work only through the \`memory\` tool. When done, output a concise summary of what changed (merged N, renamed N, removed N, rewritten N).`;
}

/** Build the extraction task prompt. */
export function buildExtractTask(
	messages: ExtractMessage[],
	maxTokens: number,
	agentsMdBlocks: string[],
	opts: { maxToolResultChars: number; maxAssistantChars: number },
): string {
	const conversation = renderConversation(messages, {
		maxToolResultChars: opts.maxToolResultChars,
		maxAssistantChars: opts.maxAssistantChars,
		maxContextTokens: maxTokens,
	});

	return [
		"You are a memory extraction agent. Below is one full turn of a coding session: every user message, every assistant reply, every tool call and every tool result. Decide what is worth remembering for FUTURE sessions and persist it.",
		"",
		"## Tools",
		"Your ONLY tool is `memory`. You have no read, write, edit, ls or bash access.",
		'memory(action="list") — every stored memory: name, type, modified, description, file.',
		'memory(action="search", query="…") — full-text search; returns the whole body of each match.',
		'memory(action="add", name, description, type, content) — create a memory, or overwrite the one whose name matches exactly.',
		'memory(action="replace", name, description, type, content) — rewrite an existing memory.',
		"",
		"## Storage model",
		"- One memory = one file, and MEMORY.md holds exactly one index line per memory.",
		"- `content` IS the memory: write the fact itself, not a pointer to it.",
		"- `name` must be unique and human-readable. Adding a name that already exists overwrites that memory instead of duplicating it.",
		'- `description` is required in practice: it is the only text a future session sees when deciding relevance, so it must be self-contained (what, where, which value). Bad: "Debugging tips". Good: "staging SSH listens on 2222, not 22".',
		"- `type` is one of user / feedback / project / reference (default feedback).",
		"",
		"## Workflow",
		"1. Read the conversation below. Note the corrections the user made, the rules they stated, and the facts that were hard to discover.",
		'2. Call memory(action="list") or memory(action="search") to check whether the fact is already stored.',
		"3. Already stored but wrong or incomplete → replace that exact name. New → add. Already stored correctly → do nothing.",
		"4. Persist at most a handful of memories per turn. When in doubt, skip it.",
		"",
		"## What to Remember",
		'- Process rules: "Always do X" / "Never do Y" directives, workflow discipline, reporting standards, self-check habits — treat these as seriously as technical facts',
		"- User preferences: coding style, tool choices, naming conventions, workflow habits",
		"- Project conventions: architecture decisions, file organization, tech stack choices",
		"- Discoveries: debugging workarounds, gotchas, configuration quirks, undocumented behavior",
		"- References: external docs, APIs, or systems the user treats as important",
		"- AGENTS.md rules that were violated in this conversation — extract for memory-level reinforcement (refer to the AGENTS.md content below)",
		"",
		"## What to Skip",
		"- One-time task instructions or ephemeral details",
		"- Code snippets or file paths derivable from the project",
		"- AGENTS.md rules that were followed without issue (refer to the AGENTS.md content below)",
		"- Git history or recent changes",
		"- Obvious or trivial observations",
		"",
		"## Output",
		'Persist the memories with the `memory` tool, then reply with one short line saying how many you added or replaced (or "nothing worth saving").',
		"",
		...(agentsMdBlocks.length > 0 ? ["## AGENTS.md Rules", ...agentsMdBlocks, ""] : []),
		"=== Conversation ===",
		conversation,
	].join("\n");
}

