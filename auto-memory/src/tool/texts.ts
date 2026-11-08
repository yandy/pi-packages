/**
 * `memory` 工具的模型可见文案。
 *
 * 一份文本、多处落地：pi 有三个通道（`description` 进工具 schema、`promptSnippet` 进 system
 * prompt 的 `Available tools`、`promptGuidelines` 进 `Guidelines`），别的宿主可能只有 `description`
 * 一个通道（那就把 GUIDELINES 并进 system prompt 的一个 section，或干脆只用 description）。
 * **文案本身不属于任何宿主**，所以住在这里。
 *
 * 改动这里的任何一个字都会同时改掉所有宿主的提示词；适配层通常还有一道总量预算的钉子
 * （pi 侧是 `prompt-meta.test.ts` 的三通道 2750 字符）。
 */

/** 工具名。所有宿主必须用同一个名字：extract / dream 的 prompt 文本里是按名字引用它的。 */
export const MEMORY_TOOL_NAME = "memory";

/** pi 的 UI 标签（`ToolDefinition.label`）。其他宿主没有对应通道时忽略即可。 */
export const MEMORY_TOOL_LABEL = "Memory";

export const MEMORY_TOOL_DESCRIPTION =
	"Read/write persistent project memory. One memory = one file, and MEMORY.md holds exactly one index line per memory. action 'add' creates a memory, or overwrites the one whose name matches exactly; 'replace' rewrites an existing memory's content/description/type; 'remove' deletes it; 'list' shows every memory; 'search' queries memory entries (scope='memory', default) or past sessions (scope='sessions'). A memory's description is the only text a future session sees when deciding relevance, so it must be self-contained.";

export const MEMORY_TOOL_SNIPPET = "Read/write persistent project memory (one memory per file)";

export const MEMORY_TOOL_GUIDELINES: readonly string[] = Object.freeze([
	"Use memory to persist project facts, user preferences, and lessons learned across sessions. Each memory lives in its own file and occupies exactly one line of the MEMORY.md index.",
	"Always pass a description with action 'add' and 'replace'. It must be self-contained and specific (what, where, which value), because future sessions select memories from descriptions alone. Bad: \"Debugging tips\". Good: \"staging SSH listens on 2222, not 22\".",
	"Give each memory a unique, human-readable name. Adding a name that already exists overwrites that memory instead of creating a second one — use 'search' or 'list' first when you are unsure.",
	"Keep one fact per memory and put the detail in content, not in name or description; the index line stays short.",
	"The index has a hard capacity limit. When a write reports that MEMORY.md is over its limit, act on it: merge related memories, remove stale ones, and move detail into content.",
	"Use action 'search' with scope='sessions' to find past work in history sessions.",
	"Relevant memories are surfaced automatically at the start of a turn inside <relevant_memories>; use 'search' or 'list' to look for anything else.",
]);
