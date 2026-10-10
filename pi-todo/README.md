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

### Task ids and references

- In `set`, `items[].id` may be omitted: short ids `1..n` are assigned by position (numbers already used by explicit ids are skipped); explicit ids — including uuids from older sessions — are kept as-is.
- `update`'s `id` accepts an exact id, a 1-based position, a unique id prefix, or a title fragment (case- and whitespace-insensitive).
- On an ambiguous or unmatched reference the error lists the candidates or the whole board, so the model can correct itself without calling `list`.
- Auto ids are positional and `set` replaces the whole list: after replanning, trust the ids echoed by the latest `set`/`update`.

The widget hides automatically when every task is done. The status snapshot injected at the start of each run is invisible in the UI (`display: false`).
