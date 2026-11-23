# pi-notify

Desktop notifications for pi: extensions explicitly request attention through a shared event, and pi-notify also notifies when a run finishes. When several pi instances run in parallel, each notification identifies its originating session and process.

## Features

- **Explicit requests**: any extension can emit `notify:request` on `pi.events`; without that signal, prompts and other UI stay silent. Valid requests are delivered immediately.
- **Task finished**: when the agent becomes fully idle (`agent_settled`), the notification shows the run duration and a plain-text summary of the last assistant message. Urgency defaults to `normal`.
- **Instance identification**: pi-notify adds the session name (or project directory name when unnamed), a distinct project name, and the process pid. Producers never supply this metadata.
- **Readable completion summaries**: markdown markers and extra whitespace are removed. Summaries are limited to 160 grapheme clusters plus an ellipsis, preferring a nearby sentence or word boundary over splitting text or emoji.
- **Completion anti-spam**: runs shorter than a configurable minimum duration (default 10 s) and aborted runs do not notify.
- **Active-agent completion suppression**: sessions whose system prompt contains an `<active_agent name="..."/>` marker do not emit automatic completion notifications. Detection is recomputed on `session_start`; explicit requests are unaffected.
- **Custom-run suppression**: completion notifications are skipped for runs whose `before_agent_start` reports `messageType: "custom"`. Steering or follow-ups merged into an existing user run preserve that run's normal completion notification.
- **`/notify` command**: toggle all notifications per instance at runtime.
- **Failure-safe**: delivery is fire-and-forget; if spawning the notifier fails, the extension warns once in the pi UI when a context is available and never blocks the agent loop.

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

| Source | Title | Body | Urgency (default) |
|--------|-------|------|-------------------|
| `notify:request` | `<name> · <request.title>` | `<request.body>\n<context>` | `normal` |
| `agent_settled` (eligible run) | `<name> · Finished · <duration>` | `<summary>\n<context>` | `normal` |

- `<name>` is the session name set via `/name` or `pi.setSessionName()`, falling back to the working directory's basename.
- `<context>` contains the project basename when a distinct named session is active and always ends with `pid <pid>`.
- An omitted or empty explicit body produces only the context line. Explicit bodies are otherwise preserved; producers own their wording and formatting.
- For completion, `<summary>` is the last assistant message's cleaned text. If no assistant text exists, the body contains only `<context>`. Duration is rounded to the nearest second and shown as seconds, minutes, or hours.
- The `\n` denotes an actual newline. Custom notifier commands receive the combined body in one argument.

Example:

```text
review · Finished · 1m 23s
Updated foo.ts and fixed the notification bug…
proj · pid 4242
```

### Explicit request contract

Emit a presentation-oriented payload on the shared extension event bus:

```ts
pi.events.emit("notify:request", {
  title: "Approval required",
  body: "A sandbox escalation is waiting for a decision",
  urgency: "critical",
});
```

```ts
interface NotifyRequest {
  /** Short display subject, without session/project/pid metadata. */
  title: string;
  /** Optional user-facing detail, without instance metadata. */
  body?: string;
  /** "low" | "normal" | "critical"; defaults to "normal". */
  urgency?: "low" | "normal" | "critical";
}
```

The title must be non-empty after trimming. Body and urgency must have the documented types when present; unknown fields are ignored. Invalid payloads are dropped without throwing or constructing a notifier.

Requests are immediate and fire-and-forget. They are dropped while notifications are disabled or after session shutdown, and are not buffered for later delivery. Explicit requests do not use the completion minimum-duration, aborted, custom-origin, or active-agent guards. There is no cancellation, acknowledgement, retry, or delivery-status signal.

Producers should emit once when a logical interaction starts needing attention, not for every internal follow-up step. The producer does not need to import or depend on this package; if no consumer is installed, the event has no desktop side effect.

## Configuration

All configuration is via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_NOTIFY` | enabled | Set to `0` or `false` to start with notifications disabled |
| `PI_NOTIFY_MIN_DURATION_MS` | `10000` | Minimum run duration for completion notifications; `0` notifies on every settled run. Invalid or negative values fall back to the default |
| `PI_NOTIFY_URGENCY_DONE` | `normal` | Urgency for completion notifications |
| `PI_NOTIFY_COMMAND` | `notify-send` on non-Windows; `powershell.exe` on Windows | Custom notifier executable; invoked as `<command> <title> <body>` without urgency |

Run duration is measured from the first `agent_start` of an idle period to `agent_settled`, and completion fires when it is **>=** the threshold. The timer resets on every settle and on session replacement. Explicit requests are not subject to this threshold.

`/notify` toggles the current instance on/off and reports the new state in the pi UI. The toggle is in-memory only: `PI_NOTIFY` sets the initial state, and `session_start` (startup / reload / new / resume / fork) resets it.

### Platform delivery

- On Linux, the default command is `notify-send -a pi -u <urgency> <title> <body>`.
- On native Windows, the default command runs the packaged `src/windows-toast.ps1` through Windows PowerShell 5.1 with a process-scoped execution-policy bypass. The script builds a Toast XML document and passes text through XML text nodes rather than interpolating it into markup.
- Windows reuses the built-in Windows PowerShell AppUserModelID, so notifications may be attributed to **Windows PowerShell** in the banner, Action Center, and Windows notification settings. No Start-menu shortcut or independent pi AppUserModelID is installed. Banners must be enabled for that source.
- On Windows, `critical` maps to a long Toast duration (about 25 seconds); other urgency values use the short duration. This is an approximation, not a guarantee of the sticky behavior that a Linux notification daemon may give `critical`.
- A custom `PI_NOTIFY_COMMAND` replaces the platform default and keeps the original two-argument protocol on every platform.
- Delivery is fire-and-forget: no notification blocks pi or keeps it alive. A helper that cannot be started at all disables notifications for the rest of the session with one warning when a UI context is available; a helper that starts and then exits non-zero is reported once with its stderr, and the next notification gets its own attempt.

## Behavior notes

- Works identically in all pi modes (tui / rpc / print / json); desktop delivery does not depend on the terminal UI.
- An explicit request before the first `session_start` uses `process.cwd()` for project metadata. A backend failure at that stage cannot surface through `ctx.ui.notify` because no extension context is available yet.
- Notification bodies appear on your desktop (and possibly the lock screen, depending on desktop settings) and may contain session content.
- Out of scope: clicking a notification to focus its terminal, suppressing notifications while the window is focused, independent Windows branding, and WSL delivery. Window focus detection is not reliably available on Wayland. The minimum-duration threshold approximates focus-based suppression for completion notifications.

## UI surface

| Method | Guard | Outside TUI |
|--------|-------|-------------|
| `ctx.ui.notify` (toggle feedback, notifier-failure warning) | `none` | Fire-and-forget; may be silently dropped by the host. Core desktop notifications never depend on it |

## License

MIT
