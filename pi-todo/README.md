# pi-todo

A minimal pi package that adds a single `todo` tool with an editor-overhead widget for visual task tracking.

## Features

- **One tool**, three actions: `set` (plan all tasks), `update` (change one task), `list` (review progress)
- **Update discipline in the prompt**: the tool description and guidelines pin down *when* to update (one `in_progress` at a time, mark `done` immediately)
- **Feedback on every update**: `update` returns progress plus the next task (`✓ #2 写单测 done (2/5 done) · next: #3 修 CI`), not a bare `OK`
- **Context re-injection**: at the start of each run the current list is fed back to the model as a hidden message, so it keeps updating instead of forgetting the plan (needs a recent pi host)
- **3 states**: `pending` → `in_progress` → `done`
- **Dependencies**: optional `blockedBy` array, with self-dependency and cycle detection
- **Compact widget** above the editor: `○` pending · `◉` in_progress · `✓` done · `🔒` blocked
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

The widget hides automatically when every task is done. The status snapshot injected at the start of each run is invisible in the UI (`display: false`).
