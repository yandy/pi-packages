# pi-todo

A minimal pi package that adds a single `todo` tool with an editor-overhead widget for visual task tracking.

## Features

- **One tool**, three actions: `set` (plan all tasks), `update` (change one task), `list` (review progress)
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
- `update` — update the task with `id` (`status`, `title`, `blockedBy` optional)
- `list` — return the current list

The widget hides automatically when every task is done.
