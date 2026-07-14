# pi-memory

File-system driven persistent memory layer for pi coding agent. Stores project knowledge across sessions — facts, preferences, debugging history — in plain Markdown files under `~/.pi/memory/<project-hash>/`.

Aligned with Claude Code's auto memory mechanism: per-topic MEMORY.md index, automatic topic file surfacing based on relevance, per-turn memory extraction, and typed memory categories.

## Features

- **One `memory` tool**, four actions: `add` (append entry), `remove` (delete entry by title), `read` (load topic or entry), `search` (query memory or session history)
- **Topic-based file organization**: each `memory add` writes a `## entry` block to a named `.md` file under the project's memory directory
- **`MEMORY.md` index** — one compact line per topic file with a relevance hook: `- [Name](file.md) — summary`
- **Memory types**: four categories — `user`, `feedback` (default), `project`, `reference` — stored in topic file frontmatter
- **Auto-surfacing** ⭐: on every user message, a side-query LLM selects up to N relevant topic files and injects their content into the agent's context. No manual `memory read` needed. Session-level deduplication prevents re-injecting the same topic.
- **Extract memories** ⭐: after each agent run, an async subagent analyzes the conversation and automatically writes learnings to memory — preferences, conventions, debugging insights
- **Snapshot injection**: on every new session, the MEMORY.md index is appended to the system prompt, keeping the agent aware of past work
- **`/dream` command**: launches a headless agent with a four-phase consolidation (Orient → Gather → Consolidate → Prune) to deduplicate, merge, and rebuild all memory files
- **Dream nudge**: after N sessions or N hours, a gentle notification suggests running `/dream`
- **`/memory` command**: show status, toggle on/off, inspect index and topic files
- **Session search**: the `memory search scope=sessions` action queries past conversation history
- **Branch-safe**: memory directory is keyed by the git root (or absolute path), so forks share memory naturally
- **Path traversal protection**: topic files are validated against escaping the memory directory

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

## Configuration

Create `memory.json` in the agent directory (`~/.pi/agent/memory.json`) or the project `.pi/` directory (if trusted):

```json
{
  "enabled": true,
  "memoryDir": "~/.pi/memory",
  "memIndexMaxLines": 200,
  "memIndexMaxBytes": 25600,
  "defaults": {
    "model": "deepseek/deepseek-v4-flash",
    "sessionPersistence": { "enabled": false }
  },
  "dream": {
    "nudgeAfterSessions": 5,
    "nudgeAfterHours": 24,
    "model": "auto",
    "thinkLevel": "high",
    "sessionPersistence": { "enabled": false }
  },
  "sessionSearch": {
    "maxSessions": 10,
    "maxMatches": 5
  },
  "autoSurfacing": {
    "enabled": true,
    "model": "auto",
    "thinkLevel": "off",
    "maxFiles": 5,
    "maxTopicBytes": 4096,
    "maxInjectionBytes": 20480,
    "sessionPersistence": { "enabled": false }
  },
  "extractMemories": {
    "enabled": true,
    "model": "auto",
    "thinkLevel": "high",
    "maxContextTokens": 2000,
    "sessionPersistence": { "enabled": false }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Toggle the entire memory system on/off |
| `memoryDir` | `~/.pi/memory` | Root directory for all memory data |
| `memIndexMaxLines` | `200` | Max lines in `MEMORY.md` before capacity errors |
| `memIndexMaxBytes` | `25600` | Max bytes in `MEMORY.md` before capacity errors |
| `defaults.model` | — | Shared model fallback for all sub-tasks. Per-task `model` overrides |
| `defaults.sessionPersistence.enabled` | `false` | Shared session persistence fallback (default: in-memory). Per-task overrides |
| `defaults.sessionPersistence.sessionDir` | `memoryDir/sessions/` | Custom session directory for persisted headless agent sessions |
| `dream.nudgeAfterSessions` | `5` | Sessions since last dream before nudge is shown |
| `dream.nudgeAfterHours` | `24` | Hours since last dream before nudge is shown |
| `dream.model` | — | Model for dream consolidation (`"provider/id"`). Falls back to `defaults.model` → parent model |
| `dream.thinkLevel` | `"high"` | Thinking effort for dream subagent: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"` |
| `dream.sessionPersistence.enabled` | `false` | Persist dream agent sessions to disk (debug/audit). Falls back to `defaults.sessionPersistence.enabled` |
| `dream.sessionPersistence.sessionDir` | `memoryDir/sessions/` | Custom session directory for dream sessions |
| `sessionSearch.maxSessions` | `10` | Max sessions to scan when searching history |
| `sessionSearch.maxMatches` | `5` | Max matches to return from history search |
| `autoSurfacing.enabled` | `true` | ⭐ Enable per-turn topic file auto-injection |
| `autoSurfacing.model` | — | ⭐ Model for side-query relevance selection. Falls back to `defaults.model` → parent model |
| `autoSurfacing.thinkLevel` | `"off"` | ⭐ Thinking effort for side-query (recommended: `"off"` for lightweight selection) |
| `autoSurfacing.sessionPersistence.enabled` | `false` | Persist side-query agent sessions to disk. Falls back to `defaults.sessionPersistence.enabled` |
| `autoSurfacing.maxFiles` | `5` | ⭐ Max topic files to inject per turn |
| `autoSurfacing.maxTopicBytes` | `4096` | ⭐ Max bytes per injected topic file (truncated) |
| `autoSurfacing.maxInjectionBytes` | `20480` | ⭐ Max total bytes of injected content per turn |
| `extractMemories.enabled` | `true` | ⭐ Enable per-turn memory extraction |
| `extractMemories.model` | — | ⭐ Model for the extraction subagent. Falls back to `defaults.model` → parent model |
| `extractMemories.thinkLevel` | `"high"` | ⭐ Thinking effort for extraction: `"off"` / `"minimal"` / `"low"` / `"medium"` / `"high"` / `"xhigh"` |
| `extractMemories.sessionPersistence.enabled` | `false` | Persist extract agent sessions to disk. Falls back to `defaults.sessionPersistence.enabled` |
| `extractMemories.maxContextTokens` | `2000` | ⭐ Max tokens of conversation to analyze |

Project-level config (`.pi/memory.json`) is only loaded when the project is trusted.

## How it works

### MEMORY.md index

MEMORY.md is a compact **pointer index** — one line per topic file, not per entry:

```
- [Debugging](debugging.md) — SSH uses port 2222; MySQL 30s timeout on staging
- [API Conventions](api.md) — REST handlers in src/api/handlers/; standard error format
```

Only the index is injected into the system prompt on every session (first 200 lines / 25KB). Topic file content is **not** loaded at session start — it's surfaced on demand via auto-surfacing or explicit `memory read`.

### Topic file format

Each topic file uses YAML frontmatter with four fields:

```yaml
---
name: Debugging Tips
description: Common debugging patterns, SSH ports, MySQL timeout configs
type: feedback
updated: 2026-07-13
---

## SSH Gotcha
staging uses port 2222, key at ~/.ssh/staging

## MySQL Timeout
connection timeout after 30s on staging
```

The `description` field is critical — the auto-surfacing side-query uses it to determine relevance. Make it specific.

### Memory types

| Type | Meaning | Example |
|------|---------|---------|
| `user` | User role, preferences, knowledge | "User is a data scientist focused on observability" |
| `feedback` | Lessons, corrections, confirmations (default) | "Use real DB not mocks — burned last quarter" |
| `project` | Project state, deadlines, incidents | "Merge freeze starts 2026-03-05 for mobile release" |
| `reference` | Pointers to external systems | "Bug tracker = Linear INGEST project" |

### Auto-surfacing

On every user message (`before_agent_start` hook):
1. Scan all topic files, extract their frontmatter metadata
2. A side-query LLM selects up to `maxFiles` relevant topic files based on the user's query
3. Already-injected topics are skipped (session-level dedup)
4. Selected topic file content is injected as context — the agent sees relevant memories automatically

### Extract memories

After each agent run (`agent_end` hook):
1. An async subagent is forked with the conversation transcript
2. It analyzes whether there are learnings worth persisting
3. If yes, it writes directly to memory files — preferences, conventions, debugging insights
4. The subagent runs independently; its results benefit future sessions

Memory extraction is selective: it ignores one-time tasks, code snippets derivable from the project, and anything already in CLAUDE.md.

## Tool reference

```
memory(action: "add" | "remove" | "search" | "read",
        content?, topic?, title?, type?,
        entry?, query?, scope?)
```

### `add`

Appends a `## entry` block to a topic file. If the topic already exists in the index, the MEMORY.md hook is updated to summarize all entries. For new topics, a new index line is created.

- **`content`** (required) — knowledge text to persist
- **`topic`** (required) — target filename, e.g. `"debugging.md"`. Auto-created if new
- **`title`** (required) — descriptive, self-contained title for the entry. Only the MEMORY.md index line is injected into future prompts (topic file content is NOT), so the title alone must convey what was learned
- **`type`** (optional) — memory category: `"user"`, `"feedback"` (default), `"project"`, `"reference"`

### `remove`

Deletes an entry by title. Searches across all topic files for the matching `##` block. Updates the MEMORY.md hook for the affected topic. When the last entry in a topic is removed, the topic file and its index line are deleted.

- **`entry`** (required) — exact entry title to remove

### `read`

Loads memory content. Either an entire topic file or a single entry block.

- **`topic`** (optional) — topic name, e.g. `"debugging"` or `"debugging.md"`. Loads the entire topic file
- **`entry`** (optional) — entry title. Returns the specific `## Entry Title` block

### `search`

Queries either memory files or session history. Memory search returns the full entry block (entire `##` section) for each match.

- **`query`** (required) — search keyword
- **`scope`** (optional) — `"memory"` (default, scans topic files) or `"sessions"` (scans session history)

## Commands

### `/memory`

Show memory status (enabled/disabled, directory, index line count, topic files, last dream timestamp).

```
/memory        — show status
/memory on     — enable memory
/memory off    — disable memory
```

### `/dream`

Launch a headless agent that reads all memory files and consolidates them in four phases:

1. **Orient** — list files, read MEMORY.md, skim topic files
2. **Gather Signal** — find duplicates, contradictions, outdated entries
3. **Consolidate** — merge duplicates, resolve contradictions, update dates
4. **Prune & Index** — rebuild frontmatter, generate hooks, rebuild MEMORY.md

The model used can be configured via `dream.model` in `memory.json`.

A confirmation dialog is shown before the consolidation begins. The result summary is shown as a notification when done.

## File layout

```
~/.pi/memory/
  <12-char-sha256>/
    MEMORY.md            — compact index: one line per topic file
    .dream-meta.json     — last dream timestamp + session count
    debugging.md         — topic files with frontmatter + ## entries
    preferences.md
    ...
```

The hash is derived from the project's git root (or absolute path), ensuring each project gets its own memory namespace.

## Snapshot semantics

On every `session_start`, the `MEMORY.md` index is read and appended to the system prompt via `before_agent_start`. If the index exceeds `memIndexMaxLines` or `memIndexMaxBytes`, it is truncated with a `[truncated]` marker — the agent still gets the most relevant portion. This snapshot is a static copy at the start of the session.

Topic file content is surfaced separately via **auto-surfacing** (automatic, per-turn, relevance-based) or explicit `memory read`.
