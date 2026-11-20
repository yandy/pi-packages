# pi-notify

Desktop notifications for pi: when you run several pi instances in parallel, each one tells you when it stops and waits for you — a blocking prompt appears, or a run finishes — so you don't have to watch every terminal.

## Features

- **Waiting for input**: any blocking `ctx.ui` prompt (select / confirm / input / editor / custom, including prompts from other extensions) immediately sends a notification with the prompt title and urgency `critical`, so it stays on screen until dismissed.
- **Task finished**: when the agent becomes fully idle (`agent_settled`), a notification with urgency `normal` carries a plain-text summary (whitespace-collapsed, truncated to 160 chars + `…`) of the last assistant message.
- **Instance identification**: every notification title contains the session name (falling back to the project directory name) and the process pid, e.g. `myproj (pid 4242)`.
- **Anti-spam**: completion notifications are skipped for runs shorter than a configurable minimum duration (default 10 s), so quick back-and-forth in a window you're already watching stays quiet. Aborted runs never notify.
- **`/notify` command**: toggle notifications per instance at runtime.
- **Failure-safe**: notification delivery is fire-and-forget; if spawning the notifier fails (e.g. `notify-send` missing), the extension warns once in the pi UI and stays silent afterwards — the agent loop is never blocked.

## Install

```bash
pi install npm:@yandy0725/pi-notify
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:@yandy0725/pi-notify"]
}
```

Requires pi >= 1.5.0 and a working `notify-send` (or a custom command, see below).

## Notification format

| Event | Title | Body | Urgency (default) |
|-------|-------|------|-------------------|
| `ui_prompt_start` | `Waiting for input — <name> (pid <pid>)` | Prompt title, or its kind when untitled | `critical` |
| `agent_settled` (not aborted) | `Task finished — <name> (pid <pid>)` | Last assistant message summary; empty when none | `normal` |

`<name>` is the session name set via `/name` or `pi.setSessionName()`, falling back to the basename of the working directory.

## Configuration

All configuration is via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_NOTIFY` | enabled | Set to `0` or `false` to start with notifications disabled |
| `PI_NOTIFY_MIN_DURATION_MS` | `10000` | Minimum run duration for completion notifications; `0` notifies on every settled run. Invalid or negative values fall back to the default |
| `PI_NOTIFY_URGENCY_PROMPT` | `critical` | Urgency for waiting-for-input notifications |
| `PI_NOTIFY_URGENCY_DONE` | `normal` | Urgency for completion notifications |
| `PI_NOTIFY_COMMAND` | `notify-send` | Custom notifier executable; invoked as `<command> <title> <body>` (urgency is not passed) |

Run duration is measured from the first `agent_start` of an idle period to `agent_settled`, and the notification fires when it is **>=** the threshold. The timer resets on every settle and on session replacement; waiting-for-input notifications are not subject to the threshold.

`/notify` toggles the current instance on/off and reports the new state in the pi UI. The toggle is in-memory only: `PI_NOTIFY` sets the initial state, and `session_start` (startup / reload / new / resume / fork) resets it.

## Behavior notes

- Works identically in all pi modes (tui / rpc / print / json); desktop delivery does not depend on the terminal UI.
- Prompts shown before `session_start` (e.g. project trust prompts from extensions) still notify, thanks to lazy initialization. Pi's own built-in trust prompt does not pass through the extension UI channel and is not covered.
- Notification bodies appear on your desktop (and possibly the lock screen, depending on your desktop settings) and may contain session content.
- Out of scope: clicking a notification to focus its terminal, and suppressing notifications while the window is focused — neither is reliably available on Wayland. The minimum-duration threshold approximates the latter.

## UI surface

| Method | Guard | Outside TUI |
|--------|-------|-------------|
| `ctx.ui.notify` (toggle feedback, spawn-failure warning) | `none` | Fire-and-forget; may be silently dropped by the host. Core desktop notifications never depend on it |

## License

MIT
