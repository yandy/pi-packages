# pi-memory

File-system driven persistent memory layer for pi coding agent. Stores project knowledge across sessions — facts, preferences, debugging history — as plain Markdown files under `~/.pi/memory/<git|local>/<project>/`.

Aligned with Claude Code's auto memory mechanism: **one memory = one file**, a `MEMORY.md` index with exactly one line per memory, relevance-based auto-surfacing, per-turn memory extraction, and typed memory categories.

> ## ⚠️ 2.0.0 is a breaking storage change
>
> - The index is now **one line per memory** (1.x had one line per *topic file*, with many `## entries` inside it).
> - Each memory lives in **its own file** with five frontmatter fields: `name`, `description`, `type`, `created`, `modified` (1.x used `updated`).
> - The index is injected as a **system-prompt section** (`memory_index`) that is frozen for the whole session, instead of being appended to the system prompt string.
>
> The first `session_start` after the upgrade **migrates an existing 1.x directory automatically**: it snapshots the whole directory into `.backups/migrate-<ts>/`, copies the original topic files into `originals/`, splits every `## entry` into its own file, rebuilds the index, and only then writes the `.migrated` marker. If any step fails, the marker is not written, the backup stays, and the next session retries. See [Migration from 1.x](#migration-from-1x).

## Features

- **One `memory` tool, five actions** for the main agent: `add`, `replace`, `remove`, `list`, `search`. Two more — `rename` and `rebuild_index` — exist **only inside `/dream`'s own headless session** and never appear in the main agent's or the extractor's schema.
- **One memory = one file** — no more multi-entry `## section` blocks; `name` is the lookup key, adding an existing `name` overwrites it (idempotent).
- **`MEMORY.md` index** — exactly one line per memory: `- [Name](file.md) — description`. The separator is an **em dash** (`—`, U+2014) with one space on each side.
- **`memory_index` prompt section, frozen per session** ⭐ — the index goes into `event.systemPromptOptions.sections["memory_index"]` and its value **does not change for the rest of the session**; only compaction re-reads it from disk. Because pi diffs sections and appends nothing when they are unchanged, the system prompt stays byte-identical turn after turn and the provider's prefix cache keeps hitting. `resume` / `fork` / `reload` replay the **recorded** value from the transcript instead of reading disk, so restoring a session does not rewrite its head.
- **Injection sanitising** — everything injected (index lines, surfaced entry bodies and names) has invisible/bidi characters stripped and `<` `>` escaped, so a memory can never forge `</relevant_memories>`, `<system>`, `<project_instructions>`, `<active_agent …>` or `<memory_index>`. Sanitising happens **at injection time only**: your files on disk are never rewritten (they stay readable and hand-editable).
- **Auto-surfacing** ⭐ — on every user turn a lightweight side query selects up to `maxFiles` **entries** (selected from `description` alone) and injects their bodies inside `<relevant_memories>`. Already-injected files are deduplicated per session; the manifest is served from an in-process `mtime` cache, so a turn costs one `readdir` plus one `stat` per file. Disabled inside subagents.
- **Extract memories** ⭐ — after each run an async headless agent receives a **structured rendering of the whole conversation** (every user message in full, assistant text and tool calls, tool results with error flags), not just two messages. It writes through the same `memory` primitives, under a whole-round logical lock it never waits for: if a dream or migration is running, that turn is simply skipped.
- **`/dream`** — a headless consolidation agent (Orient → Gather Signal → Consolidate → Prune & Index) that merges duplicates, resolves contradictions, renames entries and rebuilds the index. It has **no raw file access**: it only gets the seven `memory` actions, holds the logical lock for the whole round, and snapshots the entire directory on entry.
- **Dream nudge** — after N sessions or N hours a notification suggests `/dream`.
- **`/memory`** — full status (switch, directory, index capacity, entry count, last dream, migration state, lock state including the holder), plus `on` / `off` / `unlock`.
- **Two-level locking** — an in-process logical lock carries the *logical* scope (one primitive call, or a whole dream/migration round); the cross-process `.lock` file is held for **milliseconds only** and is **never reclaimed automatically**. There is no TTL, no heartbeat and no takeover, so mutual exclusion is a hard guarantee; the price is that a lock left behind by a crashed process must be removed by a human (`/memory unlock`).
- **Snapshots** — every write leaves a rollback point under `.backups/<ts>-<label>/`, keeping the last `lock.snapshotKeep` (migration backups use a `migrate-` prefix and are never pruned). `/dream` is the exception: it snapshots the whole directory **once on entry**, and the primitives inside that round skip their per-file snapshots (one round, one rollback point).
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
  .backups/            — rollback points: <ISO-ts>-<label>/, plus migrate-<ts>/ for the upgrade
  .migrated            — marker written as the last step of the 1.x → 2.x migration
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

Writes are **surgical**: only the target line changes, hand-written headings, groups and comments are preserved byte-for-byte, and line order is stable. The one exception is line endings: CRLF (or lone CR) is normalised to LF before parsing, so the first write to a CRLF file rewrites it with LF.

### Memory types

| Type | Meaning | Example |
|------|---------|---------|
| `user` | User role, preferences, knowledge | "User is a data scientist focused on observability" |
| `feedback` | Lessons, corrections, confirmations (default) | "Use real DB not mocks — burned last quarter" |
| `project` | Project state, deadlines, incidents | "Merge freeze starts 2026-03-05 for mobile release" |
| `reference` | Pointers to external systems | "Bug tracker = Linear INGEST project" |

### Capacity: 200 index lines ≈ 199 memories

The index holds at most `memIndexMaxLines` (200) non-empty lines and `memIndexMaxBytes` (25600) bytes. Those 200 lines are **index lines, not memories**: `rebuildIndex` guarantees at least one header line — a hand-written header is kept verbatim, otherwise it writes `# Memory Index` — and hand-written headings, groups and comments count too. A rebuilt index therefore holds at most about **199 memories per project directory** (fewer if you keep hand-written headings). Exceeding the limit does **not** fail the write: the write succeeds and the tool returns an actionable warning telling the model to merge or drop entries (everything past the limit is invisible on the next load).

This is why `/dream` is no longer optional housekeeping — it is **capacity management**. Run it (or accept the nudge) before you approach 199 memories.

## Configuration

Create `memory.json` in the agent directory (`~/.pi/agent/memory.json`) or the project `.pi/` directory (only when the project is trusted):

```json
{
  "enabled": true,
  "memoryDir": "~/.pi/memory",
  "memIndexMaxLines": 200,
  "memIndexMaxBytes": 25600,
  "memIndexInjectMaxLines": 200,
  "memIndexInjectMaxBytes": 25600,
  "lock": { "timeoutMs": 5000, "snapshotKeep": 5 },
  "defaults": { "model": "deepseek/deepseek-flash", "sessionPersistence": { "enabled": false } },
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
    "enabled": true,
    "thinkLevel": "high",
    "maxContextTokens": 2000,
    "maxToolResultChars": 500,
    "maxAssistantChars": 2000
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Toggle the entire memory system on/off |
| `memoryDir` | `~/.pi/memory` | Root directory for all memory data |
| `memIndexMaxLines` | `200` | Write capacity: max non-empty lines in `MEMORY.md` (the `# Memory Index` header and hand-written headings count too, so this is not exactly the memory count) |
| `memIndexMaxBytes` | `25600` | Write capacity: max bytes of `MEMORY.md` |
| `memIndexInjectMaxLines` | `200` | Injection budget: max lines of the index put into the `memory_index` section. Same scale as the write capacity on purpose — a smaller budget would hide memories that were written successfully |
| `memIndexInjectMaxBytes` | `25600` | Injection budget: max bytes of the index section (truncated with a `[truncated: …]` marker) |
| `lock.timeoutMs` | `5000` | How long a write waits for the logical lock (single primitive) or the cross-process `.lock`. Migration uses a fixed 30s because it rewrites the whole directory inside the lock. Also the upper bound `session_shutdown` waits for in-flight writes |
| `lock.snapshotKeep` | `5` | Rollback points kept in `.backups/` (directories named `migrate-*` are never pruned) |
| `defaults.model` | `"deepseek/deepseek-flash"` | Shared model for all sub-tasks (dream / extract / side query); a per-task `model` overrides it, and an unresolvable or unset model falls back to the parent session's model |
| `defaults.sessionPersistence.enabled` | `false` | Shared fallback: headless sub-sessions (extract / dream / side query) stay in memory by default |
| `defaults.sessionPersistence.sessionDir` | `<project memory dir>/sessions/` | Custom directory for persisted headless sessions |
| `dream.nudgeAfterSessions` | `5` | Sessions since the last dream before the nudge is shown |
| `dream.nudgeAfterHours` | `24` | Hours since the last dream before the nudge is shown |
| `dream.model` | — | Model for dream consolidation (`"provider/id"`). Falls back to `defaults.model` → parent model |
| `dream.thinkLevel` | `"high"` | Thinking effort for the dream agent: `off` / `minimal` / `low` / `medium` / `high` / `xhigh` |
| `dream.sessionPersistence.*` | inherits `defaults` | Persist dream sessions to disk (debug/audit) |
| `sessionSearch.maxSessions` | `10` | Max sessions to scan for `search scope=sessions` |
| `sessionSearch.maxMatches` | `5` | Max matches to return from history search |
| `autoSurfacing.enabled` | `true` | ⭐ Enable per-turn entry auto-injection |
| `autoSurfacing.model` | — | ⭐ Model for the relevance side query. Falls back to `defaults.model` → parent model |
| `autoSurfacing.thinkLevel` | `"off"` | ⭐ Thinking effort for the side query (`"off"` keeps it cheap) |
| `autoSurfacing.maxFiles` | `3` | ⭐ Max entries to inject per turn |
| `autoSurfacing.maxEntryBytes` | `3072` | ⭐ Max bytes of a single injected entry body (truncated). Replaces 1.x's `maxTopicBytes`, which is ignored |
| `autoSurfacing.maxInjectionBytes` | `10240` | ⭐ Max total bytes of injected content per turn |
| `autoSurfacing.sessionPersistence.*` | inherits `defaults` | Persist side-query sessions to disk |
| `extractMemories.enabled` | `true` | ⭐ Enable per-turn memory extraction |
| `extractMemories.model` | — | ⭐ Model for the extraction agent. Falls back to `defaults.model` → parent model |
| `extractMemories.thinkLevel` | `"high"` | ⭐ Thinking effort for extraction |
| `extractMemories.maxContextTokens` | `2000` | ⭐ Budget for the rendered conversation (`× 4` characters; the middle is trimmed first, head and tail are kept, user messages are dropped last) |
| `extractMemories.maxToolResultChars` | `500` | ⭐ Per-message cap for a rendered `tool_result` |
| `extractMemories.maxAssistantChars` | `2000` | ⭐ Per-message cap for rendered assistant text (user messages are never truncated) |
| `extractMemories.sessionPersistence.*` | inherits `defaults` | Persist extract sessions to disk |

Persisted headless sessions default to `<project memory dir>/sessions/` — inside the project's memory directory, not inside your working copy.

## How it works

### Session lifecycle

| Event | What pi-memory does |
|---|---|
| `session_start` | Load config → resolve the memory directory → run the 1.x migration if needed → **pick the index value and freeze it** (disk for `startup`/`new`; the recorded transcript value for `resume`/`fork`/`reload`) → register the `memory` tool (once, five actions) → rebuild the manifest cache → dream nudge |
| `before_agent_start` | Write the frozen value into `sections["memory_index"]` (**unconditionally, every turn**), then auto-surfacing (main session, not a subagent) |
| `agent_end` | Fire the async extractor; notify `Extracted N memories.` when it wrote something, or `Extract failed: …` once per session |
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

The extractor receives a structured rendering instead of a lossy two-message summary:

```
=== Conversation ===
[1] user: <full text>
[2] assistant: <text> | tool_call: memory({"action":"list"})
[3] tool_result: <summary, capped at maxToolResultChars>
[4] user: <correction>
```

It runs with the five main-agent actions (never `rename` / `rebuild_index`), no file tools, `maxTurns: 5`, and a 120s timeout. If the logical lock is busy (a dream or a migration owns the round) it **skips the turn** rather than queueing — the next `agent_end` will come.

### Locking

| Level | Scope | Behaviour |
|---|---|---|
| In-process logical lock (per memory dir) | one primitive call; or a whole dream / migration round | Waits up to `lock.timeoutMs` (migration: 30s), then throws a readable error naming the directory. `extract` uses the non-waiting form and skips the turn |
| Cross-process `.lock` | milliseconds, around the physical write | Acquired with `link` (atomic), **never reclaimed automatically**: no TTL, no heartbeat, no takeover |

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
/memory on       — enable
/memory off      — disable
/memory unlock   — remove a left-behind .lock (asks for confirmation first)
```

Status output:

```
Memory: enabled
Dir: /home/you/.pi/memory/git/github.com__owner__repo
Index: 38/200 lines, 2841/25600 bytes, 1 unrecognized lines
Entries: 37
Last dream: 2026-10-01T22:10:04.882Z
Migration: migrated at 2026-09-30T09:12:44.120Z (18 entries from 4 files)
Lock: free
```

- `Index` uses the **write** capacity (`memIndexMax*`) and reports how many non-empty lines could not be parsed as index lines (the `# Memory Index` header and hand-written headings count). CRLF (or lone CR) line endings are normalised to LF before parsing, and the next write emits LF too, so a `MEMORY.md` re-saved by a Windows editor does **not** raise this count.
- `Migration` is `migrated at …`, `not needed` (the marker says nothing had to be moved) or `pending` (no marker / unreadable marker → the next `session_start` retries).
- `Lock` is `free`, `held by <op> (pid N, started <ISO>)`, or `unreadable — run /memory unlock`.
- In a session started with `enabled: false`, nothing is initialized at boot: `/memory` reports `Memory: disabled` plus `Dir: not initialized (run /memory on)`, `/memory on` initializes the store on the spot (and registers the `memory` tool for this session), and `/memory unlock` works without a store. If initialization fails, `/memory on` says so (`Failed to initialize memory: …`) and leaves the switch off.

### `/dream`

Asks for confirmation, snapshots the whole directory, then runs a headless agent through four phases:

1. **Orient** — `list`, read the relevant entries
2. **Gather Signal** — find duplicates (several entries for one fact), contradictions, stale items
3. **Consolidate** — merge with `replace` + `remove`, rename with `rename`
4. **Prune & Index** — `rebuild_index` as a backstop

It cannot touch files directly: it only has the seven `memory` actions. A summary notification arrives when it finishes, `Dream failed: …` when it does not. The model is configurable via `dream.model`.

## Migration from 1.x

Automatic, on the first `session_start` after the upgrade:

1. take the logical lock for the whole round (30s);
2. snapshot the directory into `.backups/migrate-<ts>/` and copy the original topic files into `.backups/migrate-<ts>/originals/`;
3. for every legacy file (one with ≥ 2 `## ` sections, or with an `updated` frontmatter field): split each `## entry` into its own file, carrying over `type` and turning `updated` into `created` / `modified`; names that collide across files get a ` (2)`, ` (3)` suffix;
4. `rebuildIndex()`;
5. delete the original topic files (they stay in `originals/`);
6. write `.migrated`;
7. notify `Migrated N memories from M topic files. Backup at <path>`.

A file whose frontmatter already has a `modified` field is **never** treated as a legacy topic file, even when its body contains several `## ` headings — that guard is what keeps a normal v2 entry from being split apart.

A re-run is safe: the marker is only written at the very end, and an entry whose name **and** body already exist is reused instead of being duplicated. If a step fails, nothing is marked, the backup is kept, and the error is reported — the next session retries.

**Manual rollback:**

```bash
cd ~/.pi/memory/git/github.com__owner__repo        # the directory /memory prints
ls .backups/migrate-*/originals/                   # pick the run you want to undo
cp .backups/migrate-<ts>/originals/*.md .           # restore the 1.x topic files
rm .migrated                                       # let the migration run again
rm <generated entry files>                          # the ones listed by /memory (Entries) and not in originals/
```

## File layout

```
~/.pi/memory/
  git/
    github.com__yandy__pi-packages/    ← https://github.com/yandy/pi-packages.git
      MEMORY.md            — the index: one line per memory
      SSH-port-on-staging.md
      Test-command.md      — one file per memory
      .lock  .backups/  .migrated  .dream-meta.json
  local/
    home__yandy__workspace__scratch/   ← non-git directory /home/yandy/workspace/scratch
```

Directory names are derived as follows:

- git repos whose remote is http(s), ssh (including scp-style `[user@]host:owner/repo`, where the user is optional) or `git://`, plus the `git+ssh://` / `git+https://` aliases → `git/<host>__<owner>__<repo>`; port, credentials, trailing `/` and `.git` are stripped and the host is lowercased
- remote URLs are read from the raw git config (`remote.<name>.url`; `origin` first, then alphabetical, first usable URL wins), so `url.*.insteadOf` rewrites do not change the mapping
- scheme forms apply WHATWG URL normalization (IDN hosts become punycode, percent-encoding and `.`/`..` folding apply, credentials/queries/fragments are dropped), while scp forms keep the path as written — equivalent remotes written differently can map to different directories
- everything else — non-git directories, git repos without a remote, `file://` or local-path remotes → `local/<absolute-path>` (git repos use the repository root; a Windows-style drive-letter remote such as `C:/repos/foo.git` is treated as scp-style on POSIX, matching git)
- `/` becomes `__`; characters that are not portable in file names (`<>:"|?*`, control characters) become `_XX` hex escapes
- names longer than 120 UTF-8 bytes are truncated to 100 bytes on a code-point boundary plus a `__<hash8>` suffix
- names target POSIX filesystems: a backslash is an ordinary character, and no Windows device-name or trailing-dot handling is applied

The mapping is not injective: underscores are kept as-is, so `/home/a__b` and `/home/a/b` both map to `home__a__b` (and share one memory directory). Changing or renaming a remote, adding a remote that sorts before the one currently in use, or moving a local directory changes the memory directory, orphaning the old one.

**Older legacy layout:** versions before 1.x stored memory under `~/.pi/memory/<12-char-sha256>/`; those directories are no longer read or written. To migrate a project manually, compute the old hash with `printf '%s' "$(git rev-parse --show-toplevel)" | sha256sum | cut -c1-12` (use `$PWD` outside a git repo), then `mv` that directory to the new location (run `/memory` inside the project to see the new path) and let the 1.x → 2.x migration split its topic files.

## Notifications

| When | Notification |
|---|---|
| `memory add` succeeds (interactive session) | `Saved: <name>` |
| Auto-surfacing injected entries | `Recalled: <N> entries` |
| The extractor wrote memories | `Extracted <N> memory.` / `Extracted <N> memories.` |
| The extractor failed | `Extract failed: <message>` — at most once per session |
| The 1.x migration ran | `Migrated <N> memories from <M> topic files. Backup at <path>` |
| The migration failed | `Memory migration failed: <message>` |
| `/dream` finished / failed | the headless agent's summary / `Dream failed: <message>` |

Headless sessions (`hasUI === false`) never notify.
