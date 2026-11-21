# pi-notify

Desktop notifications for pi: when you run several pi instances in parallel, each one tells you when it stops and waits for you — a blocking prompt appears, or a run finishes — so you don't have to watch every terminal.

## Features

- **Waiting for input**: any blocking `ctx.ui` prompt (select / confirm / input / editor / custom, including prompts from other extensions) immediately sends a notification with the prompt title, prompt kind, and instance context. Urgency defaults to `critical`.
- **Task finished**: when the agent becomes fully idle (`agent_settled`), the notification shows the run duration and a plain-text summary of the last assistant message. Urgency defaults to `normal`.
- **Instance identification**: the title leads with the session name (or project directory name when unnamed). A second body line retains the project name when useful and always includes the process pid.
- **Readable summaries**: markdown markers and extra whitespace are removed. Summaries are limited to 160 grapheme clusters plus an ellipsis, preferring a nearby sentence or word boundary over splitting text or emoji.
- **Anti-spam**: completion notifications are skipped for runs shorter than a configurable minimum duration (default 10 s), so quick back-and-forth in a window you're already watching stays quiet. Aborted runs never notify.
- **`/notify` command**: toggle notifications per instance at runtime.
- **Failure-safe**: notification delivery is fire-and-forget; if spawning the notifier fails (e.g. `notify-send` or `powershell.exe` is missing), the extension warns once in the pi UI and stays silent afterwards — the agent loop is never blocked.

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

Requires pi >= 1.5.0 and one of the following backends:

- **Linux**: a working `notify-send` (or a custom command, see below).
- **Native Windows 10/11**: Windows PowerShell 5.1 (`powershell.exe`), included with Windows. Pi may be launched from Windows PowerShell 5.1 or PowerShell 7, but the notification helper always uses `powershell.exe` 5.1; pure `pwsh` delivery is not required or used. WSL is not covered by the Windows backend.

## Notification format

| Event | Title | Body | Urgency (default) |
|-------|-------|------|-------------------|
| `ui_prompt_start` | `<name> · Waiting for input` | `<subject>\n<context>` | `critical` |
| `agent_settled` (not aborted) | `<name> · Finished · <duration>` | `<summary>\n<context>` | `normal` |

- `<name>` is the session name set via `/name` or `pi.setSessionName()`, falling back to the working directory's basename.
- For a prompt, `<subject>` is its title, or its kind when untitled; `custom` prompts carry no title by contract, so they use the fixed subject `Interactive prompt` instead of the kind name. `<context>` contains the project basename when a distinct named session is active, the prompt kind when it is not already the subject, and `pid <pid>`.
- For completion, `<summary>` is the last assistant message's cleaned text. If no assistant text exists, the body contains only `<context>`. Duration is rounded to the nearest second and shown as seconds, minutes, or hours.
- The `\n` denotes an actual newline: the subject or summary stays on the first line, while instance metadata moves to the second line. Custom notifier commands receive both lines in the single body argument.

Example:

```text
review · Finished · 1m 23s
Updated foo.ts and fixed the notification bug…
proj · pid 4242
```

## Configuration

All configuration is via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_NOTIFY` | enabled | Set to `0` or `false` to start with notifications disabled |
| `PI_NOTIFY_MIN_DURATION_MS` | `10000` | Minimum run duration for completion notifications; `0` notifies on every settled run. Invalid or negative values fall back to the default |
| `PI_NOTIFY_URGENCY_PROMPT` | `critical` | Urgency for waiting-for-input notifications |
| `PI_NOTIFY_URGENCY_DONE` | `normal` | Urgency for completion notifications |
| `PI_NOTIFY_COMMAND` | `notify-send` on non-Windows; `powershell.exe` on Windows | Custom notifier executable; invoked as `<command> <title> <body>` without urgency |

Run duration is measured from the first `agent_start` of an idle period to `agent_settled`, and the notification fires when it is **>=** the threshold. The timer resets on every settle and on session replacement; waiting-for-input notifications are not subject to the threshold.

`/notify` toggles the current instance on/off and reports the new state in the pi UI. The toggle is in-memory only: `PI_NOTIFY` sets the initial state, and `session_start` (startup / reload / new / resume / fork) resets it.

### Platform delivery

- On Linux, the default command is `notify-send -a pi -u <urgency> <title> <body>`.
- On native Windows, the default command runs the packaged `src/windows-toast.ps1` through Windows PowerShell 5.1 with a process-scoped execution-policy bypass. The script builds a Toast XML document and passes text through XML text nodes rather than interpolating it into markup.
- Windows reuses the built-in Windows PowerShell AppUserModelID, so notifications may be attributed to **Windows PowerShell** in the banner, Action Center, and Windows notification settings. No Start-menu shortcut or independent pi AppUserModelID is installed. Banners must be enabled for that source.
- On Windows, `critical` maps to a long Toast duration (about 25 seconds); other urgency values use the short duration. This is an approximation, not a guarantee of the sticky behavior that a Linux notification daemon may give `critical`.
- A custom `PI_NOTIFY_COMMAND` replaces the platform default and keeps the original two-argument protocol on every platform.

## Behavior notes

- Works identically in all pi modes (tui / rpc / print / json); desktop delivery does not depend on the terminal UI.
- Prompts shown before `session_start` (e.g. project trust prompts from extensions) still notify, thanks to lazy initialization. Pi's own built-in trust prompt does not pass through the extension UI channel and is not covered.
- Notification bodies appear on your desktop (and possibly the lock screen, depending on desktop settings) and may contain session content.
- Out of scope: clicking a notification to focus its terminal, suppressing notifications while the window is focused, independent Windows branding, and WSL delivery. Window focus detection is not reliably available on Wayland. The minimum-duration threshold approximates focus-based suppression.

## UI surface

| Method | Guard | Outside TUI |
|--------|-------|-------------|
| `ctx.ui.notify` (toggle feedback, spawn-failure warning) | `none` | Fire-and-forget; may be silently dropped by the host. Core desktop notifications never depend on it |

## License

MIT
