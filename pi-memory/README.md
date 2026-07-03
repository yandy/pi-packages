# pi-memory

File-system driven persistent memory layer for pi coding agent. Stores project knowledge across sessions — facts, preferences, debugging history — in plain Markdown files under `~/.pi/memory/<project-hash>/`.

## Features

- **One `memory` tool**, four actions: `add` (append entry), `remove` (delete entry by title), `read` (load topic or entry), `search` (query memory or session history)
- **Topic-based file organization**: each `memory add` writes to a named `.md` file under the project's memory directory
- **`MEMORY.md` index** — auto-generated table of contents with line/byte capacity limits
- **Snapshot injection**: on every new session, the memory index is appended to the system prompt, keeping the agent aware of past work
- **`/dream` command**: launches a headless agent to deduplicate, merge, and consolidate all memory files
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

Create `pi-memory.json` in the agent directory (`~/.pi/agent/pi-memory.json`) or the project `.pi/` directory (if trusted):

```json
{
  "enabled": true,
  "memoryDir": "~/.pi/memory",
  "memIndexMaxLines": 200,
  "memIndexMaxBytes": 25600,
  "dream": {
    "nudgeAfterSessions": 5,
    "nudgeAfterHours": 24,
    "model": "auto"
  },
  "sessionSearch": {
    "maxSessions": 10,
    "maxMatches": 5
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Toggle the entire memory system on/off |
| `memoryDir` | `~/.pi/memory` | Root directory for all memory data |
| `memIndexMaxLines` | `200` | Max lines in `MEMORY.md` before capacity errors |
| `memIndexMaxBytes` | `25600` | Max bytes in `MEMORY.md` before capacity errors |
| `dream.nudgeAfterSessions` | `5` | Sessions since last dream before nudge is shown |
| `dream.nudgeAfterHours` | `24` | Hours since last dream before nudge is shown |
| `dream.model` | `"auto"` | Model for dream consolidation (`"auto"` = same as current, or `"provider/id"`) |
| `sessionSearch.maxSessions` | `10` | Max sessions to scan when searching history |
| `sessionSearch.maxMatches` | `5` | Max matches to return from history search |

Project-level config (`.pi/pi-memory.json`) is only loaded when the project is trusted.

## Tool reference

```
memory(action: "add" | "remove" | "search" | "read",
        content?, topic?, title?,
        entry?, query?, scope?)
```

### `add`

Appends an entry to a topic file and adds a new line to the MEMORY.md index (no upsert — multiple entries per topic).

- **`content`** (required) — knowledge text to persist
- **`topic`** (required) — target filename, e.g. `"debugging.md"`. Auto-created if new
- **`title`** (required) — short title for the index line and entry heading

### `remove`

Deletes an entry by exact title match on the MEMORY.md index. Removes both the index line and the corresponding `##` block from the topic file. When the last entry in a topic is removed, the topic file is deleted.

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

Launch a headless agent that reads all memory files, deduplicates entries, merges contradictions, updates outdated info, and reorganizes `MEMORY.md` to be concise. The model used can be configured via `dream.model` in `pi-memory.json` (`"auto"` uses the current conversation model; `"provider/id"` picks a specific model).

A confirmation dialog is shown before the consolidation begins. The result summary is shown as a notification when done.

Dream meta (timestamp, session count at dream) is persisted in `.dream-meta.json` inside the memory directory.

## File layout

```
~/.pi/memory/
  <12-char-sha256>/
    MEMORY.md            — index: one line per topic file
    .dream-meta.json     — last dream timestamp + session count
    debugging.md         — user-created topic files
    preferences.md
    ...
```

The hash is derived from the project's git root (or absolute path), ensuring each project gets its own memory namespace.

## Snapshot semantics

On every `session_start`, the `MEMORY.md` index is read and appended to the system prompt via `before_agent_start`. If the index exceeds `memIndexMaxLines` or `memIndexMaxBytes`, it is truncated with a `[truncated]` marker — the agent still gets the most relevant portion. This snapshot is a static copy at the start of the session; changes made via the `memory` tool during a session do not update the snapshot for that session, but take effect on the next one.
