# pi-todo

A minimal pi package that adds a single `todo` tool with an editor-overhead widget for visual task tracking.

## Features

- **One tool**, three actions: `set` (plan all tasks), `update` (change one task), `list` (review progress)
- **Update discipline in the prompt**: the tool description and guidelines pin down *when* to update (one `in_progress` per in-flight task, mark `done` immediately)
- **Feedback on every update**: `update` returns progress, the next task, and the tasks still in flight (`✓ #2 写单测 done (2/5 done) · next: #3 修 CI · ◉ still in flight: #4 发布`), not a bare `OK`
- **3 states**: `pending` → `in_progress` → `done`
- **Dependencies**: optional `blockedBy` array, with self-dependency and cycle detection
- **Compact widget** above the editor: `○` pending · `◉` in_progress · `✓` done · `🔒` blocked — windowed around the in-flight task when the board grows, with an always-visible progress line
- **Branch-safe persistence**: state is reconstructed from the session branch, so `/fork` and `/resume` keep the right todos

## Install

```bash
pi install npm:@yandy0725/pi-todo
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:@yandy0725/pi-todo"]
}
```

## Tool reference

```
todo(action: "set" | "update" | "list", items?, id?, status?, title?, blockedBy?)
```

- `set` — replace the whole list with `items` (use at planning time)
- `update` — update the task referenced by `id` (`status`, `title`, `blockedBy` optional)
- `list` — return the current list

### Task ids

- The tool owns ids: `set` assigns `1..n` by position and ignores any `id` present in the items it receives.
- `update`'s `id` must match one of those ids exactly (send `3`, not `#3`); `blockedBy` takes exact ids too.
- A wrong id is never guessed at: the error echoes the current board (titles clipped, up to 20 lines) so it can be corrected without an extra `list` call.
- `set` replaces the whole list, so ids are renumbered — trust the ids echoed by the latest `set`/`update`.

### Parallel work and subagents

The board belongs to **one session**: a subagent runs its own `todo` instance and can neither see nor update yours. So keep the parent as the only writer — hand item #2 to a subagent, and mark it yourself.

Parallel dispatch is supported:

- mark an item `in_progress` when you dispatch it, `done` when its result comes back; several items may be `in_progress` at once
- `next` never suggests a task that is already in flight, and every ack names the other tasks still in flight (`· ◉ still in flight: #2 修 CI`, folded to ` +N` past two), so a stale `in_progress` item cannot go unnoticed
- `set` replaces the board and renumbers ids; if items were in flight it appends a `⚠ ids renumbered` line naming them, because your in-hand references just broke

The widget hides automatically when every task is done.

## Widget and full view

The **widget** above the editor is a compact summary capped at 8 lines. When the board is longer than that budget it renders a window instead of getting truncated:

- the window anchors on the first `in_progress` task (or the first unfinished one when nothing is in flight), fills forward, and spends any leftover rows on earlier tasks;
- `↑ n` / `↓ n` mark how many tasks are hidden on each side;
- the last line is always the overall progress (`✓ 6/18 · ○ 11 · 🔒 1`);
- every line is clipped to the terminal width with an ellipsis, so nothing wraps and no host-side `widget truncated` ever appears.

The widget hides when the list is empty or every task is done. RPC clients get the same window as plain lines (component widgets are TUI-only), so titles are not width-clipped there.

The **full view** is a command: `/todos` opens the complete list in an overlay (`↑`/`↓` or `j`/`k` to move, `g`/`G` for the ends, `Esc` or `q` to close); the header carries the progress plus a `(current/total)` position marker whenever the list is longer than the window. It is read-only — nothing in it changes the board. Outside the TUI the command falls back to a notification carrying the full list: RPC forwards it, while print and JSON modes have no UI and produce no output.
