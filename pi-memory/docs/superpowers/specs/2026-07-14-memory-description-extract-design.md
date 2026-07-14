# pi-memory: Fix Description & Extract Tool Integration

## Motivation

Two issues found in pi-memory:

1. **Description stale**: When entries are added to an existing topic via `memory add`, `doAdd` only updates the `updated` date in frontmatter. The `description` field stays frozen at its initial value (the first entry title), while `MEMORY.md`'s hook is regenerated from all entries. Same on `remove`. This causes drift.

2. **Extract bypasses validation**: The extract headless agent uses raw file I/O (`read`/`write`/`edit`/`ls`) to write memory files directly, skipping `doAdd`'s path sanitization, dedup, capacity checks, and atomic index updates. It should use `memory add/read/search` instead.

Additionally, the user specifies three distinct tool requirements per agent:
- **side-query**: zero tools
- **extract**: only `memory` tools (add/read/search)
- **dream**: only file I/O tools (read/write/edit/ls)

---

## Part 1: Fix Description Update Logic

### Current behavior (bug)

**`doAdd` on existing topic** (`memory-tool.ts`):
```ts
const refreshed = updateFrontmatterDate(raw, today());  // only date
const topicContent = appendContent(refreshed, p.title, p.content);
// description in frontmatter is never touched
```

**`doRemove`** similarly only refreshes date, never description.

Result: frontmatter `description` and `MEMORY.md` `hook` diverge over time.

### Fix

After modifying entries (add or remove), regenerate `description` from all remaining entry titles — same logic used for the hook:

```ts
const remaining = parseEntries(topicContent);
const newDesc = remaining.map(e => e.title).join("; ").slice(0, 150);
// Replace description line in frontmatter
const withDesc = replaceFrontmatterField(raw, "description", newDesc);
```

`description` and `hook` will always be the same value, generated from the same source (all entry titles).

### Files changed

| File | Change |
|------|--------|
| `pi-memory/src/memory-tool.ts` | `doAdd` existing-topic branch: regenerate description from all entries |
| `pi-memory/src/memory-tool.ts` | `doRemove` has-entries branch: regenerate description from remaining entries |
| `pi-memory/src/topic-file.ts` | Add `replaceFrontmatterField(raw, field, value)` helper |
| `pi-memory/tests/memory-tool.test.ts` | Test: description updates on add to existing topic |
| `pi-memory/tests/memory-tool.test.ts` | Test: description updates on remove from multi-entry topic |

---

## Part 2: Extract Uses Memory Tools (Approach C)

### Architecture

`agent-runner.ts` becomes a **generic headless runner** with parameterized tools. `createAgentSession` already separates built-in tool names (`tools: string[]`) from custom tool definitions (`customTools: ToolDefinition[]`). `HeadlessAgentOpts` mirrors this dual channel:

```
runHeadlessAgent({ tools?, customTools? })
  ├── side-query (inject.ts): tools: [], customTools: []
  ├── extract (extract.ts):   tools: [], customTools: createMemoryTools(memoryDir)
  └── dream (dream.ts):       tools: FILE_IO_TOOLS (default), customTools: []
```

### Step 1: Rename `MEMORY_AGENT_TOOLS` → `FILE_IO_TOOLS`

`agent-config.ts`:
```ts
// Before
export const MEMORY_AGENT_TOOLS = ["read", "write", "edit", "ls"] as const;

// After
export const FILE_IO_TOOLS = ["read", "write", "edit", "ls"] as const;
```

Update all imports in `agent-runner.ts` and test files.

### Step 2: Add `tools` and `customTools` to `HeadlessAgentOpts`

`agent-runner.ts`:
```ts
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface HeadlessAgentOpts {
  // ... existing fields
  /** Built-in tool name allowlist. Defaults to FILE_IO_TOOLS. Pass [] for no built-in tools. */
  tools?: string[];
  /** Custom tool definitions. Defaults to []. */
  customTools?: ToolDefinition[];
}
```

In `createAgentSession`:
```ts
// NOTE: SDK default tools are ["read", "bash", "edit", "write"].
// We override with FILE_IO_TOOLS = ["read", "write", "edit", "ls"]
// because memory agents must not execute commands.
const created = await createAgentSession({
  tools: opts.tools ?? [...FILE_IO_TOOLS],
  customTools: opts.customTools ?? [],
  // ...
});
```

### Step 3: Create `createMemoryTools` factory

`pi-memory/src/memory-tool.ts` — new export:
```ts
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export function createMemoryTools(memoryDir: string, cfg: {
  maxLines: number; maxBytes: number;
}): ToolDefinition[] {
  // Returns three ToolDefinition objects: memory_add, memory_read, memory_search
  // Each tool.execute() calls doAdd/doRead/searchMemory directly.
  // No need for doRemove — extract agent doesn't delete.
}
```

Tool definitions mirror the existing `memory` tool's JSON schema for `add`/`read`/`search` actions but without the extension framework dependency.

### Step 4: Rewrite extract's `buildExtractTask`

Current prompt instructs LLM to "use ONLY file read/write/edit tools". New prompt:

> "Use the memory_add tool to persist learnings, memory_read to check existing topics, and memory_search to find related memories. Do NOT use file read/write/edit/ls tools."

Remove references to frontmatter format, MEMORY.md structure — the tools handle that.

### Step 5: Update callers

| Caller | File | Change |
|--------|------|--------|
| extract | `extract.ts` | `runHeadlessAgent({ tools: [], customTools: memTools, ... })` |
| side-query | `inject.ts` | `runHeadlessAgent({ tools: [], ... })` |
| dream | `dream.ts` | No change (accepts defaults) |

### Files changed

| File | Change |
|------|--------|
| `pi-memory/src/agent-config.ts` | Rename `MEMORY_AGENT_TOOLS` → `FILE_IO_TOOLS` |
| `pi-memory/src/agent-runner.ts` | Add `tools?` and `customTools?` to `HeadlessAgentOpts`; pass through to `createAgentSession` |
| `pi-memory/src/memory-tool.ts` | Export `createMemoryTools(memoryDir)` |
| `pi-memory/src/extract.ts` | Accept and pass `tools`; rewrite `buildExtractTask` |
| `pi-memory/src/inject.ts` | `runSideQuery` passes `tools: []` |
| `pi-memory/index.ts` | extract call site passes `customTools: createMemoryTools(memoryDir, cfg)` |
| `pi-memory/tests/agent-runner.test.ts` | Update for renamed constant; test `tools` parameter |
| `pi-memory/tests/extract.test.ts` | Update for new tool interface and prompt content |
| `pi-memory/tests/inject.test.ts` | Verify `tools: []` passed to `runHeadlessAgent` |

---

## Non-Goals

- Dream agent keeps file I/O tools (unchanged behavior)
- No changes to `MEMORY.md` format or hook generation logic
- No changes to auto-surfacing or side-query logic beyond `tools: []`
- No changes to config schema (extract `enabled`, `thinkLevel`, `maxContextTokens` remain)

---

## Testing Strategy

### Part 1 tests
- `doAdd` to existing topic → description regenerated from all entry titles
- `doAdd` first entry to new topic → description = entry title (no regression)
- `doRemove` from multi-entry topic → description regenerated from remaining
- `doRemove` last entry → topic deleted, no description to update

### Part 2 tests
- `runHeadlessAgent` without `tools` → defaults to `FILE_IO_TOOLS`
- `runHeadlessAgent` with `tools: [], customTools: [...]` → passed to `createAgentSession` correctly
- `buildExtractTask` no longer mentions `read`/`write`/`edit`/`ls`
- `buildExtractTask` instructs LLM to use memory tools
- `createMemoryTools` returns valid `ToolDefinition[]` with correct execute behavior
- `runSideQuery` passes `tools: []` to `runHeadlessAgent`
