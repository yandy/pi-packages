# pi-memory

File-system driven persistent memory layer for pi coding agent. Stores project knowledge across sessions — facts, preferences, debugging history — as plain Markdown files under `~/.pi/memory/<git|local>/<project>/`.

Aligned with Claude Code's auto memory mechanism: **one memory = one file**, a `MEMORY.md` index with exactly one line per memory, relevance-based auto-surfacing, per-turn memory extraction, and typed memory categories.

> ## ⚠️ Breaking changes
>
> **In 2.5.0:**
>
> - **Windows directory names changed shape.** `local/<project>` keys now split on `\` as well as `/`, so a Windows project directory is one readable component (`C_3a__Users__you__proj`) instead of a nested tree (`C_3a/Users/you/proj`). Memories stored under the old nested layout are orphaned: run `/memory` inside the project to read the new `Dir:` path, then create that directory if it does not exist and move the old project directory's contents into it (in PowerShell: `New-Item -ItemType Directory -Force "<new dir>"` then `Move-Item "<old project dir>\*" "<new dir>"`); the empty intermediate directories left behind can be ignored. `git/<host>__<owner>__<repo>` names are unchanged on POSIX; on Windows they are unchanged too unless the key's first `.`-delimited label is a reserved device name, or the key contains a backslash, or it ends in a dot or a space — those few names are sanitised now (see [Windows](#windows)). POSIX output is byte-identical to before.
> - **Entry files whose stem is a Windows reserved device name now get a `_` prefix** (`name: "CON"` → `_CON.md`) on every platform, so the name is safe in a shared `git/` directory. Only newly created files are affected — existing entries keep their file names.
>
> **In 2.4.0:**
>
> - **The package-level `enabled` switch is gone.** `memory.json` has no top-level `enabled` any more: a leftover key is ignored, and `{"enabled": false}` no longer disables anything — it used to skip model validation too, so a disabled config often had no model configured. Disable the extension the way you disable any pi package — by not loading it — see [Disabling the extension](#disabling-the-extension). `dream` is now a required task in every session.
> - **`/memory` no longer prints a `Memory: enabled|disabled` line.** The healthy status block is 7 lines starting with `Dir:`, and the old disabled state no longer exists — only *healthy* and *misconfigured* remain. Module switches (`autoSurfacing.enabled`, `extractMemories.enabled`) are unchanged.
>
> **In 2.3.0:**
>
> - **The injected index window is now the newest 50 lines / 16 KiB.** `memIndexInjectMaxLines` 200 → 50 and `memIndexInjectMaxBytes` 25600 → 16384. The write capacity is unchanged (200 lines / 25600 bytes), so memories older than the newest 50 index lines no longer reach the system prompt — they stay reachable through auto-surfacing and the `memory` tool. Configs that already set `memIndexInjectMax*` are unaffected.
>
> **In 2.2.0:**
>
> - **`extractMemories.enabled` now defaults to `false`.** Per-turn extraction is opt-in: once enabled, every turn ends with a headless model call. Configs that already set `"extractMemories": { "enabled": true }` are unaffected.
>
> **In 2.1.0:**
>
> - **Models must be configured explicitly.** There is no shipped default and no parent-model fallback: `defaults.model` (or a per-task `model`) must exist and be resolvable, or `session_start` reports a config error and initialises **nothing**. See [Model configuration](#model-configuration).
> - **`/memory on` and `/memory off` are gone.** `enabled` is a `memory.json` switch read once at session start — changing it needs a session restart. **That key has since been removed** — it is ignored if present; see [Disabling the extension](#disabling-the-extension).
> - **Automatic 1.x → 2.0 migration has been removed.** Legacy topic files stay on disk untouched but are **invisible** to the memory system (they fail `parseEntryFile`'s five-field v2 frontmatter check). See [1.x data](#1x-data).
>
> **In 2.0.0:**
>
> - The index is now **one line per memory** (1.x had one line per *topic file*, with many `## entries` inside it).
> - Each memory lives in **its own file** with five frontmatter fields: `name`, `description`, `type`, `created`, `modified` (1.x used `updated`).
> - The index is injected as a **system-prompt section** (`memory_index`) that is frozen for the whole session, instead of being appended to the system prompt string.

## Features

- **One `memory` tool, five actions** for the main agent: `add`, `replace`, `remove`, `list`, `search`. Two more — `rename` and `rebuild_index` — exist **only inside `/dream`'s own headless session** and never appear in the main agent's or the extractor's schema.
- **One memory = one file** — no more multi-entry `## section` blocks; `name` is the lookup key, adding an existing `name` overwrites it (idempotent).
- **`MEMORY.md` index** — exactly one line per memory: `- [Name](file.md) — description`. The separator is an **em dash** (`—`, U+2014) with one space on each side.
- **`memory_index` prompt section, frozen per session** ⭐ — the index goes into `event.systemPromptOptions.sections["memory_index"]` and its value **does not change for the rest of the session**; only compaction re-reads it from disk. Because pi diffs sections and appends nothing when they are unchanged, the system prompt stays byte-identical turn after turn and the provider's prefix cache keeps hitting. `resume` / `fork` / `reload` replay the **recorded** value from the transcript instead of reading disk, so restoring a session does not rewrite its head.
- **Injection sanitising** — everything injected (index lines, surfaced entry bodies and names) has invisible/bidi characters stripped and `<` `>` escaped, so a memory can never forge `</relevant_memories>`, `<system>`, `<project_instructions>`, `<active_agent …>` or `<memory_index>`. Sanitising happens **at injection time only**: your files on disk are never rewritten (they stay readable and hand-editable).
- **Auto-surfacing** ⭐ — on every user turn a lightweight side query selects up to `maxFiles` **entries** (selected from `description` alone) and injects their bodies inside `<relevant_memories>`. Already-injected files are deduplicated per session; the manifest is served from an in-process `mtime` cache, so a turn costs one `readdir` plus one `stat` per file. Disabled inside subagents.
- **Extract memories** ⭐ — after each run an async headless agent receives a **structured rendering of the whole conversation** (every user message in full, assistant text and tool calls, tool results with error flags), not just two messages. It writes through the same `memory` primitives, under a whole-round logical lock it never waits for: if a dream is running, that turn is simply skipped. This feature is **off by default** — set `extractMemories.enabled: true` to turn it on.
- **`/dream`** — a headless consolidation agent (Orient → Gather Signal → Consolidate → Prune & Index) that merges duplicates, resolves contradictions, renames entries and rebuilds the index. It has **no raw file access**: it only gets the seven `memory` actions, holds the logical lock for the whole round, and snapshots the entire directory on entry.
- **Dream nudge** — after N sessions or N hours a notification suggests `/dream`.
- **`/memory`** — full status (directory, index capacity, entry count, last dream, lock state including the holder), plus `unlock`.
- **Two-level locking** — an in-process logical lock carries the *logical* scope (one primitive call, or a whole dream round); the cross-process `.lock` file is held for **milliseconds only** and is **never reclaimed automatically**. There is no TTL, no heartbeat and no takeover, so mutual exclusion is a hard guarantee; the price is that a lock left behind by a crashed process must be removed by a human (`/memory unlock`).
- **Snapshots** — every write leaves a rollback point under `.backups/<ts>-<label>/`, keeping the last `lock.snapshotKeep` (directories named `migrate-*` — whole-directory snapshots from an earlier 1.x migration, whose `originals/` subdirectory holds the pre-2.0 topic files — are never pruned). `/dream` is the exception: it snapshots the whole directory **once on entry**, and the primitives inside that round skip their per-file snapshots (one round, one rollback point).
- **Session search** — `memory search scope=sessions` queries past conversation history.
- **Readable, clone-safe layout** — memory lives under `~/.pi/memory/git/<host__owner__repo>/` for git repos with an http(s)/ssh/git remote (including scp-style and `git+ssh`/`git+https`), and `~/.pi/memory/local/<absolute-path>/` otherwise — clones and worktrees of the same repo share memory (a fork has its own remote, so it gets its own directory).

## Install

```bash
pi install npm:@yandy0725/pi-memory
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:@yandy0725/pi-memory"]
}
```

## Storage layout

```
~/.pi/memory/git/github.com__owner__repo/
  MEMORY.md            — the index: one line per memory (em dash separator)
  SSH-port-on-staging.md
  Test-command.md      — one file per memory
  .lock                — cross-process write lock (held for milliseconds, never auto-reclaimed)
  .backups/            — rollback points: <ISO-ts>-<label>/ (plus migrate-<ts>/ whole-directory snapshots from earlier 1.x migrations)
  .dream-meta.json     — last dream timestamp + session count (drives the nudge)
  sessions/            — persisted headless sessions, only when sessionPersistence is enabled
```

### Entry file

```yaml
---
name: SSH port on staging
description: staging SSH listens on 2222, not 22; key at ~/.ssh/staging
type: project
created: 2026-07-13
modified: 2026-10-02T08:14:03.120Z
---

staging 的 SSH 用 2222 端口，密钥在 ~/.ssh/staging。
```

- `name` — unique, human-readable title; the lookup key for `replace` / `remove` / `rename`. Adding the same `name` again overwrites that memory instead of creating a second one.
- `description` — **one self-contained line**. It is the only text a future session sees when the side query decides relevance, so it must make sense without the body. Bad: `Debugging tips`. Good: `staging SSH listens on 2222, not 22`.
- `type` — `user` | `feedback` (default) | `project` | `reference`.
- `created` — `YYYY-MM-DD`, written once and preserved across overwrites.
- `modified` — ISO 8601, **always written by the store**; callers cannot pass it in.

File names are derived from `name` (unsafe characters replaced, 100-byte cap, `-2` / `-3` … only when a *file name* collides). `MEMORY.md` can never be targeted by an entry.

### MEMORY.md index

```
# Memory Index

- [SSH port on staging](SSH-port-on-staging.md) — staging SSH listens on 2222, not 22
- [Test command](Test-command.md) — run npm test, not npm run test
```

Writes are **surgical**: only the target line changes, hand-written headings, groups and comments are preserved byte-for-byte, and line order is stable. The one exception is line endings: CRLF (or lone CR) is normalised to LF before parsing, so the first write to a CRLF file rewrites it with LF. The injected index uses the same normalisation — a CRLF file never sends `\r` into the system prompt.

### Memory types

| Type | Meaning | Example |
|------|---------|---------|
| `user` | User role, preferences, knowledge | "User is a data scientist focused on observability" |
| `feedback` | Lessons, corrections, confirmations (default) | "Use real DB not mocks — burned last quarter" |
| `project` | Project state, deadlines, incidents | "Merge freeze starts 2026-03-05 for mobile release" |
| `reference` | Pointers to external systems | "Bug tracker = Linear INGEST project" |

### Capacity: 200 index lines ≈ 199 memories

The index holds at most `memIndexMaxLines` (200) non-empty lines and `memIndexMaxBytes` (25600) bytes. Those 200 lines are **index lines, not memories**: `rebuildIndex` guarantees at least one header line — an existing hand-written header is kept verbatim (trailing blank lines before the first entry are dropped), otherwise it writes `# Memory Index` — and hand-written headings, groups and comments count too. A rebuilt index therefore holds at most about **199 memories per project directory** (fewer if you keep hand-written headings). Exceeding the limit does **not** fail the write: the write succeeds and the tool returns an actionable warning telling the model to merge or drop entries (everything past the limit is invisible on the next load).

**What reaches the model is a separate, smaller window:** `memIndexInjectMaxLines` / `memIndexInjectMaxBytes` (default 50 lines / 16384 bytes). The window is taken from the **newest** end of the index, i.e. from the **bottom of the file**: `memory(action="add")` appends, and `/dream`'s `rebuild_index` re-sorts by `modified`. Two exceptions matter — `memory(action="replace")` rewrites its line **in place**, so an edited older memory keeps its position (and can stay outside the window) until the next `/dream` re-sort; and hand-written headings, groups or notes at the top of the file are positional rather than chronological, so a curated top block is the first thing the window drops. A full index therefore injects the **50 newest memories** (the `# Memory Index` header and its blank line fall outside the window once it truncates); an index of 48 memories or fewer is injected whole. Omitted memories are **not lost**: auto-surfacing, `memory(action="search")` and `/dream` consolidation still see them. `/memory` prints both budgets apart: `Index:` is the write capacity (disk truth), `Inject:` is the window that goes into the system prompt.

This is why `/dream` is no longer optional housekeeping — it is **capacity management**. Two thresholds matter: prompt visibility ends at the injection window, so consolidate **before you pass ~48 memories** if you want every entry in the system prompt, while 199 is only the hard write limit past which the index itself has to shrink.

## Configuration

Create `memory.json` in the agent directory (`~/.pi/agent/memory.json`) or the project `.pi/` directory (only when the project is trusted):

```json
{
  "memoryDir": "~/.pi/memory",
  "memIndexMaxLines": 200,
  "memIndexMaxBytes": 25600,
  "memIndexInjectMaxLines": 50,
  "memIndexInjectMaxBytes": 16384,
  "lock": { "timeoutMs": 5000, "snapshotKeep": 5 },
  "defaults": { "model": "provider/model-id", "sessionPersistence": { "enabled": false } },
  "dream": { "nudgeAfterSessions": 5, "nudgeAfterHours": 24, "thinkLevel": "high" },
  "sessionSearch": { "maxSessions": 10, "maxMatches": 5 },
  "autoSurfacing": {
    "enabled": true,
    "thinkLevel": "off",
    "maxFiles": 3,
    "maxEntryBytes": 3072,
    "maxInjectionBytes": 10240
  },
  "extractMemories": {
    "enabled": false,
    "thinkLevel": "high",
    "maxContextTokens": 2000,
    "maxToolResultChars": 500,
    "maxAssistantChars": 2000
  }
}
```

> Every `model` value must resolve in your registry — there is no default. A missing or unresolvable model makes `session_start` report a config error and initialise nothing. See [Model configuration](#model-configuration).

| Key | Default | Description |
|-----|---------|-------------|
| `memoryDir` | `~/.pi/memory` | Root directory for all memory data. `~`, `~/` and (on Windows) `~\` are expanded; relative values are resolved against the working directory |
| `memIndexMaxLines` | `200` | Write capacity: max non-empty lines in `MEMORY.md` (the `# Memory Index` header and hand-written headings count too, so this is not exactly the memory count) |
| `memIndexMaxBytes` | `25600` | Write capacity: max bytes of `MEMORY.md` |
| `memIndexInjectMaxLines` | `50` | Injection window: max lines of the index put into the `memory_index` section. The window keeps the **newest** lines and drops the **oldest** ones — the index is pure chronological order, so a smaller window never hides the memory you just wrote. **`0` (either key) injects no index at all** — the `memory_index` section stays empty |
| `memIndexInjectMaxBytes` | `16384` | Injection window: max bytes of the index section (older lines are dropped first, with a `[truncated: …]` marker at the **top**) |
| `lock.timeoutMs` | `5000` | How long a write waits for the logical lock (single primitive) or the cross-process `.lock`. Also the upper bound `session_shutdown` waits for in-flight writes |
| `lock.snapshotKeep` | `5` | Rollback points kept in `.backups/` (directories named `migrate-*` — whole-directory snapshots from an earlier 1.x migration, whose `originals/` subdirectory holds the pre-2.0 topic files — are never pruned) |
| `defaults.model` | `— (required)` | Shared model for dream / extract / side query. **No default**: every task that will run must resolve a model, otherwise `session_start` fails (see [Model configuration](#model-configuration)). A per-task `model` overrides it |
| `defaults.sessionPersistence.enabled` | `false` | Shared fallback: headless sub-sessions (extract / dream / side query) stay in memory by default |
| `defaults.sessionPersistence.sessionDir` | `<project memory dir>/sessions/` | Custom directory for persisted headless sessions |
| `dream.nudgeAfterSessions` | `5` | Sessions since the last dream before the nudge is shown |
| `dream.nudgeAfterHours` | `24` | Hours since the last dream before the nudge is shown |
| `dream.model` | — | Model for dream consolidation (`"provider/id"`). Falls back to `defaults.model`; required unless `defaults.model` is set (must be resolvable, no parent-model fallback) |
| `dream.thinkLevel` | `"high"` | Thinking effort for the dream agent: `off` / `minimal` / `low` / `medium` / `high` / `xhigh` |
| `dream.sessionPersistence.*` | inherits `defaults` | Persist dream sessions to disk (debug/audit) |
| `sessionSearch.maxSessions` | `10` | Max sessions to scan for `search scope=sessions` |
| `sessionSearch.maxMatches` | `5` | Max matches to return from history search |
| `autoSurfacing.enabled` | `true` | ⭐ Enable per-turn entry auto-injection |
| `autoSurfacing.model` | — | ⭐ Model for the relevance side query. Falls back to `defaults.model`; required unless `defaults.model` is set (must be resolvable, no parent-model fallback) |
| `autoSurfacing.thinkLevel` | `"off"` | ⭐ Thinking effort for the side query (`"off"` keeps it cheap) |
| `autoSurfacing.maxFiles` | `3` | ⭐ Max entries to inject per turn |
| `autoSurfacing.maxEntryBytes` | `3072` | ⭐ Max bytes of a single injected entry body (truncated). Replaces 1.x's `maxTopicBytes`, which is ignored |
| `autoSurfacing.maxInjectionBytes` | `10240` | ⭐ Max total bytes of injected content per turn |
| `autoSurfacing.sessionPersistence.*` | inherits `defaults` | Persist side-query sessions to disk |
| `extractMemories.enabled` | `false` | ⭐ Enable per-turn memory extraction. **Off by default** (opt-in): once enabled, every turn ends with a headless model call |
| `extractMemories.model` | — | ⭐ Model for the extraction agent. Falls back to `defaults.model`; required unless `defaults.model` is set (must be resolvable, no parent-model fallback) |
| `extractMemories.thinkLevel` | `"high"` | ⭐ Thinking effort for extraction |
| `extractMemories.maxContextTokens` | `2000` | ⭐ Budget for the rendered conversation (`× 4` characters; the middle is trimmed first, head and tail are kept, user messages are dropped last) |
| `extractMemories.maxToolResultChars` | `500` | ⭐ Per-message cap for a rendered `tool_result` |
| `extractMemories.maxAssistantChars` | `2000` | ⭐ Per-message cap for rendered assistant text (user messages are never truncated) |
| `extractMemories.sessionPersistence.*` | inherits `defaults` | Persist extract sessions to disk |

Persisted headless sessions default to `<project memory dir>/sessions/` — inside the project's memory directory, not inside your working copy.

### Disabling the extension

pi-memory has no package-level switch of its own — the former top-level `enabled` key in `memory.json` is **gone** and is now ignored if present. Disable the extension the way you disable any pi package, by not loading it:

Project-only (`.pi/settings.json` in the project root — read only after project trust is granted):

```json
{ "packages": [{ "source": "npm:@yandy0725/pi-memory", "extensions": [] }] }
```

A project entry replaces the personal entry, so the extension is not loaded in that project. Globally: `pi remove npm:@yandy0725/pi-memory`, or toggle the package's resources with `pi config` (project scope writes `autoload: false` plus `extensions: ["-index.ts"]`). Module switches (`autoSurfacing.enabled`, `extractMemories.enabled`) still turn off individual behaviors while the extension stays loaded.

## Model configuration

Every task that will run must resolve a model — **there is no shipped default and no parent-model fallback**. `defaults.model` satisfies all of them; a per-task `model` (`dream.model`, `extractMemories.model`, `autoSurfacing.model`) overrides it.

| Task | Required when |
|------|---------------|
| `dream` | always required — every session validates it at startup |
| `extractMemories` | `extractMemories.enabled` is true |
| `autoSurfacing` | `autoSurfacing.enabled` is true |

At `session_start` pi-memory resolves every required model against the model registry. If one is missing or cannot be resolved, it initialises **nothing**: it shows an error notification `pi-memory config error:` followed by one `- <error>` line per problem, and `/memory` reports `Memory: misconfigured` and `Dir: not initialized`, followed by the same lines. The two possible messages are:

- `no model for <task> — set "<task>.model" or "defaults.model" in memory.json`
- `model "<value>" for <task> is not resolvable (unknown id or missing credentials)`

Fix `memory.json` and restart the session — the config is read once at session start. In headless/print sessions a config error is silent (no notification is shown), so check `/memory` in an interactive session.

## How it works

### Session lifecycle

| Event | What pi-memory does |
|---|---|
| `session_start` | Load config → validate the required models (a failure means nothing is initialised) → resolve the memory directory → **pick the index value and freeze it** (disk for `startup`/`new`; the recorded transcript value for `resume`/`fork`/`reload`) → register the `memory` tool (once, five actions) → rebuild the manifest cache → dream nudge |
| `before_agent_start` | Write the frozen value into `sections["memory_index"]` (**unconditionally, every turn**), then auto-surfacing (main session, not a subagent) |
| `agent_end` | With `extractMemories.enabled`, fire the async extractor; notify `Extracted N memories.` when it wrote something, or `Extract failed: …` once per session |
| `session_compact` | Clear the injected-file set **and re-read the index from disk** — the only in-session refresh point |
| `session_shutdown` | Wait for in-flight writes to finish (bounded by `lock.timeoutMs`) so a quit does not leave a stale `.lock` |

### Why the index is frozen

pi builds the system prompt from ordered sections and appends a *patch* message only for sections whose value changed; when nothing changed it appends nothing at all. A custom section is inserted **last**, so `memory_index` is the final part of the system prompt with the entire conversation after it. If its value changed mid-session, the folded head would be rewritten and everything after it would lose its prefix cache. Hence: one value per session, refreshed only at compaction (where the middle of the conversation is being rewritten anyway).

The accepted trade-off: memories written during this session are **not** visible in this session's index. The tool result already confirms the write, and the next session sees it.

If the host pi is older than the sections API, pi-memory falls back to appending the index to the system prompt string — same functionality, worse caching.

### Auto-surfacing

1. Build the manifest from the store's `mtime` cache: `[type] file.md — description`, newest first, capped at 200 entries and 4000 characters (the description budget is split evenly, never below 80 characters each).
2. A side query (`maxTurns: 1`, no tools) returns up to `maxFiles` file names from that manifest; anything not in the manifest is dropped.
3. The selected entries' **bodies** (frontmatter excluded) are truncated to `maxEntryBytes`, sanitised, and injected as one `display: false` custom message wrapped in `<relevant_memories>`; the total stops at `maxInjectionBytes`.
4. Injected file names are remembered for the session, and the set is cleared on compaction. You get a `Recalled: N entries` notification.

### Extract memories

> **Off by default.** Set `"extractMemories": { "enabled": true }` in `memory.json` first (config is read once at `session_start`, so a restart is needed), and make sure `extractMemories.model` or `defaults.model` resolves.

The extractor receives a structured rendering instead of a lossy two-message summary:

```
=== Conversation ===
[1] user: <full text>
[2] assistant: <text> | tool_call: memory({"action":"list"})
[3] tool_result: <summary, capped at maxToolResultChars>
[4] user: <correction>
```

It runs with the five main-agent actions (never `rename` / `rebuild_index`), no file tools, `maxTurns: 5`, and a 120s timeout. If the logical lock is busy (a dream owns the round) it **skips the turn** rather than queueing — the next `agent_end` will come.

### Locking

| Level | Scope | Behaviour |
|---|---|---|
| In-process logical lock (per memory dir) | one primitive call; or a whole dream round | Waits up to `lock.timeoutMs`, then throws a readable error naming the directory. `extract` uses the non-waiting form and skips the turn |
| Cross-process `.lock` | milliseconds per retried call around the physical write (a retry storm can hold it for a few seconds) | Acquired with `open(…, "wx")` (`O_CREAT|O_EXCL`) — the **create** is atomic on NTFS, ReFS, exFAT/FAT32 and in a network share's namespace, so the lock excludes processes on every machine using that share; in a sync-client folder it only excludes same-machine processes (see [Windows](#windows)). The holder record is written immediately after the file is created. **Never reclaimed automatically**: no TTL, no heartbeat, no takeover |

A crash inside a write can therefore leave a `.lock` behind, and nothing will ever delete it for you — that is the deliberate price of a hard mutual-exclusion guarantee. The error names the pid, op and start time; `/memory unlock` is the one sanctioned way to clear it.

## Tool reference

```
memory(action: "add" | "replace" | "remove" | "list" | "search",
       name?, description?, content?, type?, query?, scope?)
```

`description` is the only relevance signal a future session gets — always pass a self-contained one with `add` and `replace`.

### `add`

Creates a memory, or **overwrites the one whose `name` matches exactly** (idempotent; `created` is preserved).

- `name` (required) — unique, human-readable title
- `content` (required) — the memory body; it becomes the whole entry file
- `description` (optional) — one self-contained line; defaults to the first sentence of `content`
- `type` (optional) — `user` / `feedback` (default) / `project` / `reference`

### `replace`

Rewrites an existing memory's `content` / `description` / `type`. Looks the entry up by `name`. Renaming is `rename`, which is dream-only.

### `remove`

Deletes the entry matched by `name` — file, index line, and the memory itself. Fails loudly if the entry cannot be found or the file cannot be removed (no silent "deleted").

### `list`

One line per memory: `- name (type, modified …) — description [file]`.

### `search`

- `query` (required)
- `scope` (optional) — `memory` (default: name, description and body of every entry) or `sessions` (past conversation history)

### Dream-only actions

`rename` (`name` + `new_name`; the file name and the index line follow, keeping the line's position) and `rebuild_index` (rebuild from disk, preserving a hand-written header). They are registered **only** inside `/dream`'s headless session, so neither the main agent nor the extractor can call them.

## Commands

### `/memory`

```
/memory          — status
/memory unlock   — remove a left-behind .lock (asks for confirmation first)
```

Status output:

```
Dir: /home/you/.pi/memory/git/github.com__owner__repo
Index: 38/200 lines, 2841/25600 bytes, 1 unrecognized lines
Inject: 39/50 lines, 2841/16384 bytes
Entries: 37
Modules: dream=on(provider/model-a) extractMemories=off autoSurfacing=on(provider/model-b)
Last dream: 2026-10-01T22:10:04.882Z
Lock: free
```

- `Index` uses the **write** capacity (`memIndexMax*`) and reports how many non-empty lines could not be parsed as index lines (the `# Memory Index` header and hand-written headings count). CRLF (or lone CR) line endings are normalised to LF before parsing, and the next write emits LF too, so a `MEMORY.md` re-saved by a Windows editor does **not** raise this count.
- `Inject` uses the **injection** window (`memIndexInjectMax*`) and counts the window's lines and bytes — the index text that goes into the `memory_index` section, taken from the **newest** end (the truncation marker itself is not counted). It is computed by the same window code that produces the injected value, so the two cannot drift. Note the two lines count different things: `Index` counts **non-empty** lines, `Inject` counts **every** line of the window, so on a canonical index (LF endings, trailing newline, one blank line after the header) `Inject` reports one more line than `Index` and the same byte count. The value in the system prompt is **frozen for the session** (see [Why the index is frozen](#why-the-index-is-frozen)): a memory written after `session_start` appears in `Index` immediately but in `Inject` only after compaction or in the next session.
- `Modules` reports the activation state of the three model-driven features as `on(<effective model>)` / `off`. The effective model is the task's own `model`, otherwise `defaults.model`. `dream` has no switch of its own — it is always available in a healthy session.
- `Lock` is `free`, `held by <op> (pid N on <hostname>, started <ISO>)`, or `unreadable — run /memory unlock`. `/memory unlock` shows the same holder line in its confirmation prompt.
- If a required model is missing or cannot be resolved, nothing is initialized and `/memory` reports `Memory: misconfigured` and `Dir: not initialized`, followed by one `- <error>` line per problem. The same errors are shown as an error notification at session start.

### `/dream`

Asks for confirmation, snapshots the whole directory, then runs a headless agent through four phases:

1. **Orient** — `list`, read the relevant entries
2. **Gather Signal** — find duplicates (several entries for one fact), contradictions, stale items
3. **Consolidate** — merge with `replace` + `remove`, rename with `rename`
4. **Prune & Index** — `rebuild_index` as a backstop

It cannot touch files directly: it only has the seven `memory` actions. A summary notification arrives when it finishes, `Dream failed: …` when it does not. The model is configurable via `dream.model`.

## 1.x data

Automatic 1.x → 2.0 migration has been removed. Legacy topic files (frontmatter with `updated` and without `created`/`modified`, so they fail the five-field v2 frontmatter check) stay on disk untouched and are **invisible to the memory system** — `parseEntryFile` requires the five v2 frontmatter fields, so such files never appear in the index, injections, `list`/`read`/`search`, and `/dream` cannot see them either (dream only has the `memory` tool). To recover their content by hand, split each `## ` section into its own file with v2 frontmatter (`name`, `description`, `type`, `created`, `modified`). Directories created by an earlier migration are still never pruned: `.backups/migrate-*/originals/` holds the pre-2.0 topic files, and `.backups/migrate-*/MEMORY.md` the index as it was then.

## File layout

```
~/.pi/memory/
  git/
    github.com__yandy__pi-packages/    ← https://github.com/yandy/pi-packages.git
      MEMORY.md            — the index: one line per memory
      SSH-port-on-staging.md
      Test-command.md      — one file per memory
      .lock  .backups/  .dream-meta.json
  local/
    home__yandy__workspace__scratch/   ← non-git directory /home/yandy/workspace/scratch
```

Directory names are derived as follows:

- git repos whose remote is http(s), ssh (including scp-style `[user@]host:owner/repo`, where the user is optional) or `git://`, plus the `git+ssh://` / `git+https://` aliases → `git/<host>__<owner>__<repo>`; port, credentials, trailing `/` and `.git` are stripped and the host is lowercased
- remote URLs are read from the raw git config (`remote.<name>.url`; `origin` first, then alphabetical, first usable URL wins), so `url.*.insteadOf` rewrites do not change the mapping
- scheme forms apply WHATWG URL normalization (IDN hosts become punycode, percent-encoding and `.`/`..` folding apply, credentials/queries/fragments are dropped), while scp forms keep the path as written — equivalent remotes written differently can map to different directories
- everything else — non-git directories, git repos without a remote, `file://`, UNC (`\\server\share\repo.git`), relative and local-path remotes → `local/<absolute-path>` (git repos use the repository root). A Windows drive-letter remote (`Z:\repos\foo.git`) counts as a **local path on Windows**, matching how git treats it there; the same string on POSIX is scp syntax (the drive letter is a host) and still maps to a `git/` name, also matching git
- `/` becomes `__`; characters that are not portable in file names (`<>:"|?*`, control characters) become `_XX` hex escapes
- names longer than 120 UTF-8 bytes are truncated to 100 bytes on a code-point boundary plus a `__<hash8>` suffix
- names are platform-aware: on Windows a backslash is a separator, and names avoid reserved device names and trailing dots/spaces; on POSIX a backslash stays an ordinary character and these Windows-only rules do not apply. The one rule applied everywhere is the `_` prefix for entry file stems that look like a device name (see [Windows](#windows))

The mapping is not injective: underscores are kept as-is, so `/home/a__b` and `/home/a/b` both map to `home__a__b` (and share one memory directory). Changing or renaming a remote, adding a remote that sorts before the one currently in use, or moving a local directory changes the memory directory, orphaning the old one.

**Older legacy layout:** versions before 1.x stored memory under `~/.pi/memory/<12-char-sha256>/`; those directories are no longer read or written. To migrate a project manually, compute the old hash with `printf '%s' "$(git rev-parse --show-toplevel)" | sha256sum | cut -c1-12` (use `$PWD` outside a git repo), then `mv` that directory to the new location (run `/memory` inside the project to see the new path) and split its topic files by hand (see [1.x data](#1x-data)).

## Windows

pi-memory runs natively on Windows — no WSL required.

- **Directory names.** The name derived from a project key is always a single, legal Windows component: `\` counts as a separator (so `C:\Users\you\proj` → `C_3a__Users__you__proj`), a trailing dot or space is hex-escaped (`proj.` → `proj_2e`), and a name whose first `.`-delimited label is a reserved device name gets a `_` prefix (`nul` → `_nul`). Directory names are identical across platforms for an ordinary remote's `git/` key (`github.com__owner__repo`), so a shared `memoryDir` keeps working when the same repository is opened from Linux and Windows. Keys whose first label collides with a reserved device name (`aux.example.com/...`), that contain a backslash, or that end in a dot or a space can still differ between platforms.
- **Repository root.** The root comes from `git rev-parse --show-toplevel`, so a repository subdirectory maps to the same memory directory as the repository root. Note the root is taken from git's output as-is: it must be a native Windows path, which Git for Windows prints (`C:/...`). A cygwin/MSYS build of `git` prints POSIX-style paths (`/cygdrive/c/...`), which would place the memory directory under a wrong prefix — put Git for Windows' `git.exe` first on `PATH` if you have several git builds installed.
- **`memoryDir`.** `~`, `~/` and (on Windows) `~\` are expanded; relative values are resolved to absolute paths. Windows paths and UNC shares both work.
- **Locking.** The cross-process lock is created with `open(…, "wx")` (`CREATE_NEW`). On a network share that primitive is atomic in the share's single namespace, so the lock excludes processes on every machine using that share — a `memoryDir` on a non-NTFS volume is supported. In a **sync-client folder** (OneDrive, Dropbox, …) there is no single namespace: each machine keeps its own copy, so the lock only excludes processes on the same machine — do not share one `memoryDir` between machines that way; use a network share when you need cross-machine exclusion. A transient `EPERM`/`EACCES`/`EBUSY` from an antivirus scanner, an editor or a file indexer is retried with a short backoff; a persistent failure still reports the original error.
- **Line endings.** Every memory file pi-memory reads tolerates CRLF and lone CR (they are normalised to LF before parsing), and every write emits LF. A `MEMORY.md` or entry file re-saved by Notepad or another Windows editor therefore neither disappears from the index nor inflates the unrecognised-line count.
- **Known limitation.** A file whose name is a reserved device name (for example `con.md`, created by hand or by an older version on another platform) is skipped on Windows instead of being read, because opening that name reaches the console device rather than the file. Rename it (using a `\\?\` path) or re-create the memory under a new name. While such a file exists, adding a memory whose name derives to it (`CON` now derives `_CON.md`) creates a second file and a second same-named index line; the next `rebuild_index` — which dream runs regularly — drops the stale line.

## Notifications

| When | Notification |
|---|---|
| `memory add` succeeds (interactive session) | `Saved: <name>` |
| Auto-surfacing injected entries | `Recalled: <N> entries` |
| The extractor wrote memories | `Extracted <N> memory.` / `Extracted <N> memories.` |
| The extractor failed | `Extract failed: <message>` — at most once per session |
| `/dream` finished / failed | the headless agent's summary / `Dream failed: <message>` |

Headless sessions (`hasUI === false`) never notify.
