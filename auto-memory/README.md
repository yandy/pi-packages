# auto-memory

Harness-agnostic, file-system driven persistent memory for AI coding agents. One memory = one
Markdown file, a `MEMORY.md` index with exactly one line per memory, two-level locking, snapshot
rollback, and the LLM orchestration around them (consolidation, per-turn extraction, relevance
surfacing) — with **no dependency on any harness**.

Adapters own the host-specific half: when to inject, how to render, which model to call. This
package owns the half that must be identical everywhere, so two harnesses pointed at the same
machine share one memory.

## What lives here

| Layer | Contents |
|---|---|
| **Disk format** | one Markdown file per memory with YAML frontmatter (`name` / `description` / `type` / `created` / `modified`); `MEMORY.md` with exactly one index line per memory (`- [Name](file.md) — description`, em dash); file names derived from `name` |
| **Store** | `MemoryStore` — `listEntries` / `readEntry` / `readIndex` / `searchEntries` / `addEntry` / `replaceEntry` / `removeEntry` / `renameEntry` / `rebuildIndex`, plus the logical-lock API |
| **Concurrency & recovery** | a cross-process `.lock` held for milliseconds and never auto-reclaimed; an in-process logical lock per primitive call or per whole dream round; transient-error retry; `.backups/<ts>-<label>/` rollback points |
| **Paths & safety** | git-remote normalisation to a single legal directory component, directory-escape assertion, injection sanitising, Windows reserved-name handling |
| **Orchestration** | `runDream`, `runExtract`, `runSideQuery` and their prompt text, over the two ports below |
| **Injection policy** | index windowing (newest N lines / bytes), entry truncation, capacity reporting, `scanEntries`, `renderSurfacedBlock` — pure functions that return strings |
| **Tool contract** | the action sets, the JSON Schema, the model-facing text, and `createMemoryActionHandler` |
| **Config** | defaults, deep-merge over an explicit file list, `~` expansion, model-config validation, `defaultMemoryRoot()` |

No LLM call, no UI, no host API: `src/**` imports only `node:*` and relative paths, and
`tests/neutrality.test.ts` fails the build if that ever changes.

## Default memory root

```
$XDG_DATA_HOME/auto-memory        # or ~/.local/share/auto-memory
```

`defaultMemoryRoot()` is the reason two harnesses can share one memory: the rule contains no host
name and no platform branch, so every adapter computes the same directory independently. A relative
`XDG_DATA_HOME` is ignored per the XDG spec — a relative root would make "which project uses which
directory" depend on the cwd. Override it with `memoryDir` in the adapter's config.

Under that root the layout is `<git|local>/<project>/`, derived from the git remote (or the absolute
path when there is none), so clones and worktrees of one repository share memory.

## Storage layout

```
~/.local/share/auto-memory/git/github.com__owner__repo/
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

## Locking

| Level | Scope | Behaviour |
|---|---|---|
| In-process logical lock (per memory dir) | one primitive call; or a whole dream round | Waits up to `lock.timeoutMs`, then throws a readable error naming the directory. `extract` uses the non-waiting form and skips the turn |
| Cross-process `.lock` | milliseconds per retried call around the physical write (a retry storm can hold it for a few seconds) | Acquired with `open(…, "wx")` (`O_CREAT|O_EXCL`) — the **create** is atomic on NTFS, ReFS, exFAT/FAT32 and in a network share's namespace, so the lock excludes processes on every machine using that share; in a sync-client folder it only excludes same-machine processes (see [Windows](#windows)). The holder record is written immediately after the file is created. **Never reclaimed automatically**: no TTL, no heartbeat, no takeover |

A crash inside a write can therefore leave a `.lock` behind, and nothing will ever delete it for you — that is the deliberate price of a hard mutual-exclusion guarantee. The error names the pid, op and start time; the harness's memory-unlock command is the one sanctioned way to clear it.

## Adapting to a new harness

Two ports. Everything else — the disk format, the locks, the snapshots, the project-directory
derivation, the dream/extract/side-query orchestration and their prompts, and the `memory` tool's
JSON Schema, text and dispatch — is already here.

```ts
export interface HeadlessRunRequest {
  task: string;                 // prompt text, generated by this package
  cwd: string;                  // the memory directory
  model: string;                // opaque: this package never interprets or validates it
  effort?: string;              // opaque: your thinking/reasoning level
  maxTurns?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  builtinTools: "none" | "file-io";
  memoryTool: {                 // null = inject no tool
    actions: readonly MemoryAction[];
    skipLogicalLock?: boolean;
    skipSnapshot?: boolean;
    onWrite?: (info: { action: MemoryAction; name?: string }) => void;
  } | null;
  sessionPersistence?: { enabled: boolean; sessionDir?: string };
}

export interface HeadlessAgentPort {
  /** null = the round did not run (host declined or timed out). */
  run(req: HeadlessRunRequest): Promise<string | null>;
}

export interface HostTranscriptPort {
  searchSessions(cwd: string, query: string,
                 cfg: { maxSessions: number; maxMatches: number }): Promise<string>;
  toExtractMessages(raw: unknown[]): ExtractMessage[];
}
```

`runDream(opts, { headless })`, `runExtract(opts, { headless, transcript })` and
`runSideQuery(opts, { headless })` take the ports explicitly — there is no module-level singleton.

**Watch the allowlist trap.** If your harness's `tools` option is an allowlist that also filters
custom tools, then "no builtin tools, only the `memory` tool" must be expressed some other way.
pi's is `noTools: "builtin"`; passing `tools: []` there silently strips the `memory` tool, so dream
can call nothing yet still "succeeds".

### What this package deliberately does not own

| Concern | Why it stays in the adapter |
|---|---|
| **When** to inject, and per-session dedupe state | pi freezes the index for the whole session to keep the provider's prefix cache hitting; a harness that re-evaluates prompt sections per assembly has the opposite requirement. One state machine cannot hold both |
| Prompt-cache optimisations (recording/replaying the frozen value) | pure host machinery |
| Tool schema conversion, UI rendering, notifications | host-specific schema DSL and UI channels |
| Model resolution and validation | host-specific registry; `model`/`effort` are opaque strings here |
| Where config files live, and whether the project is trusted | host knowledge; `loadConfigFrom(files)` takes an explicit list |
| Counting sessions to decide when to nudge | needs the host's session store |

### Mapping used by the pi adapter

| Need | core | pi |
|---|---|---|
| Index into the system prompt | `buildIndexSection`, `truncateIndexForInjection`, `indexInjectionCapacity` | `systemPromptOptions.sections["memory_index"]` + transcript replay |
| Per-turn surfaced memories | `scanEntries`, `runSideQuery`, `renderSurfacedBlock` | message injection, per-session dedupe |
| The `memory` tool | `memoryToolSchema`, `MEMORY_TOOL_*`, `createMemoryActionHandler` | typebox + `ToolDefinition` + pi-tui rendering + `ctx.ui.notify` |
| dream / extract rounds | `runDream`, `runExtract`, prompts | `createAgentSession` via `createPiHeadlessAgent` |
| Past-session search | `HostTranscriptPort.searchSessions` | `SessionManager` |

## Windows

`auto-memory` runs natively on Windows — no WSL required.

- **Directory names.** The name derived from a project key is always a single, legal Windows component: `\` counts as a separator (so `C:\Users\you\proj` → `C_3a__Users__you__proj`), a trailing dot or space is hex-escaped (`proj.` → `proj_2e`), and a name whose first `.`-delimited label is a reserved device name gets a `_` prefix (`nul` → `_nul`). Directory names are identical across platforms for an ordinary remote's `git/` key (`github.com__owner__repo`), so a shared `memoryDir` keeps working when the same repository is opened from Linux and Windows. Keys whose first label collides with a reserved device name (`aux.example.com/...`), that contain a backslash, or that end in a dot or a space can still differ between platforms.
- **Repository root.** The root comes from `git rev-parse --show-toplevel`, so a repository subdirectory maps to the same memory directory as the repository root. Note the root is taken from git's output as-is: it must be a native Windows path, which Git for Windows prints (`C:/...`). A cygwin/MSYS build of `git` prints POSIX-style paths (`/cygdrive/c/...`), which would place the memory directory under a wrong prefix — put Git for Windows' `git.exe` first on `PATH` if you have several git builds installed.
- **`memoryDir`.** `~`, `~/` and (on Windows) `~\` are expanded; relative values are resolved to absolute paths. Windows paths and UNC shares both work.
- **Locking.** The cross-process lock is created with `open(…, "wx")` (`CREATE_NEW`). On a network share that primitive is atomic in the share's single namespace, so the lock excludes processes on every machine using that share — a `memoryDir` on a non-NTFS volume is supported. In a **sync-client folder** (OneDrive, Dropbox, …) there is no single namespace: each machine keeps its own copy, so the lock only excludes processes on the same machine — do not share one `memoryDir` between machines that way; use a network share when you need cross-machine exclusion. A transient `EPERM`/`EACCES`/`EBUSY` from an antivirus scanner, an editor or a file indexer is retried with a short backoff; a persistent failure still reports the original error.
- **Line endings.** Every memory file this package reads tolerates CRLF and lone CR (they are normalised to LF before parsing), and every write emits LF. A `MEMORY.md` or entry file re-saved by Notepad or another Windows editor therefore neither disappears from the index nor inflates the unrecognised-line count.
- **Known limitation.** A file whose name is a reserved device name (for example `con.md`, created by hand or by an older version on another platform) is skipped on Windows instead of being read, because opening that name reaches the console device rather than the file. Rename it (using a `\\?\` path) or re-create the memory under a new name. While such a file exists, adding a memory whose name derives to it (`CON` now derives `_CON.md`) creates a second file and a second same-named index line; the next `rebuild_index` — which dream runs regularly — drops the stale line.

## Development

```sh
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run lint      # biome
npm run build     # tsc -p tsconfig.build.json → dist/ (ESM + .d.ts)
```

`src/**` is the source of truth inside the monorepo; `dist/` is what a plain Node process consumes
(a published package cannot ship `.ts` — Node refuses type-stripping under `node_modules`).
Relative imports carry explicit `.js` extensions so the emitted ESM resolves.

## License

MIT
