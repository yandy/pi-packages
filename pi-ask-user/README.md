# pi-ask-user

A Pi package that adds an interactive `ask_user` tool for collecting user decisions during an agent run.

## Features

- Searchable single-select option lists with wrapped titles and descriptions
- Responsive split-pane details preview on wide terminals with single-column fallback on narrow terminals
- Multi-select option lists
- Optional freeform responses
- User-toggleable extra context on structured selections
- Context display support
- Configurable display mode: `overlay` (modal, default) or `inline` (rendered directly in the flow)
- Runtime overlay toggle: press the configured overlay-toggle key (`alt+o` by default, configurable via env var or `ask-user.json`) while the prompt is open to temporarily hide/show the popup so you can read prior agent output, then press it again to bring it back
- Pi-TUI-aligned keybinding and editor behavior
- Custom TUI rendering for tool calls and results
- System prompt integration via `promptSnippet` and `promptGuidelines`
- Optional timeout for auto-dismiss in both overlay and fallback input modes, plus a default 5-minute deadline for dialog prompts in non-TUI (RPC) modes so an unresponsive host cannot hang the turn. A local timeout or tool abort always wins the settlement: the result is `cancelled: true` with `details.cancelReason`, even if the host resolves or rejects afterwards
- Structured `details` on all results for session state reconstruction
- Graceful fallback when interactive UI is unavailable: RPC/headless sessions keep structured single- and multi-select via the dialog protocol
- Bundled `ask-user` skill for mandatory decision-gating in high-stakes or ambiguous tasks

## Bundled skill: `ask-user`

This package ships a skill at `skills/ask-user/SKILL.md` that nudges/mandates the agent to use `ask_user` when:

- architectural trade-offs are high impact
- requirements are ambiguous or conflicting
- assumptions would materially change implementation

The skill follows a "decision handshake" flow:

1. Gather evidence and summarize context
2. Ask one focused question via `ask_user`
3. Wait for explicit user choice
4. Confirm the decision, then proceed

See: `skills/ask-user/references/ask-user-skill-extension-spec.md`.

## Install

```bash
pi install npm:@yandy0725/pi-ask-user
```

Requires pi >= 1.5.0.

## Tool name

The registered tool name is:

- `ask_user`

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `question` | `string` | *required* | The question to ask the user |
| `context` | `string?` | — | Relevant context summary shown before the question |
| `options` | `(string \| {title, description?})[]?` | `[]` | Multiple-choice options |
| `allowMultiple` | `boolean?` | `false` | Enable multi-select mode |
| `allowFreeform` | `boolean?` | `true` | Add a "Type something" freeform option |
| `allowComment` | `boolean?` | `true` | Expose a user-toggleable extra-context option in the custom UI (`ctrl+g` or the toggle row) and collect an optional comment in fallback dialogs |
| `timeout` | `number?` | — (300000 ms for dialogs in non-TUI modes) | Auto-dismiss after N ms and return `null` if the prompt times out. An explicit value always wins over the non-TUI default |

Appearance options (`displayMode`, `overlayToggleKey`, `commentToggleKey`) are **not** model-visible parameters. They are user preferences resolved from env vars and `ask-user.json` — see [Display mode](#display-mode) and [Shortcuts](#shortcuts). They remain accepted by the internal `AskParams` type for SDK/direct callers, but an LLM tool call cannot set them.

## Example usage shape

```json
{
  "question": "Which option should we use?",
  "context": "We are choosing a deploy target.",
  "options": [
    "staging",
    { "title": "production", "description": "Customer-facing" }
  ],
  "allowMultiple": false,
  "allowFreeform": true,
  "allowComment": true
}
```

## Personal preferences via environment variables

Configure your defaults globally by setting these in your shell profile (`~/.zshrc`, `~/.bash_profile`, etc.):

```bash
export PI_ASK_USER_DISPLAY_MODE=inline
export PI_ASK_USER_OVERLAY_TOGGLE_KEY=alt+h
export PI_ASK_USER_COMMENT_TOGGLE_KEY=alt+c
```

### Display mode

Effective order:

1. `PI_ASK_USER_DISPLAY_MODE` (if set to `"overlay"` or `"inline"`)
2. Project config file `.pi/ask-user.json` `displayMode` field (if exists)
3. User config file `~/.pi/agent/ask-user.json` `displayMode` field (if exists)
4. Fallback default: `"overlay"`

(A per-call `displayMode` still wins over all of the above for SDK/direct callers, but the field is no longer part of the model-visible tool schema.)

Unrecognised values are silently ignored and fall back to `"overlay"`.

## Personal preferences via config files

In addition to environment variables, you can use JSON config files:

**Locations:**
- User-level (global): `~/.pi/agent/ask-user.json`
- Project-level: `.pi/ask-user.json`

Fields in the project-level file override same-named fields in the user-level file. Priority: env var > project config > user config > default.

**Example `~/.pi/agent/ask-user.json`:**

```json
{
  "displayMode": "inline",
  "overlayToggleKey": "alt+h",
  "commentToggleKey": "alt+c"
}
```

All fields are optional. Missing files or malformed JSON are silently ignored, equivalent to no configuration.

### Shortcuts

Effective order for both `overlayToggleKey` and `commentToggleKey`:

1. Matching env var (`PI_ASK_USER_OVERLAY_TOGGLE_KEY` / `PI_ASK_USER_COMMENT_TOGGLE_KEY`)
2. Project config file `.pi/ask-user.json` (if exists)
3. User config file `~/.pi/agent/ask-user.json` (if exists)
4. Built-in defaults: `alt+o` and `ctrl+g`

(A per-call parameter still wins for SDK/direct callers, but these fields are no longer part of the model-visible tool schema.)

Pass `"off"`, `"none"`, or `"disabled"` (at any level) to disable the shortcut entirely. Invalid specs are silently dropped and the next source is used. Specs follow the Pi-TUI [`KeyId`](https://github.com/earendil-works/pi-mono/blob/main/packages/tui/src/keys.ts) format: `[mod+]...key` where modifiers are `ctrl`, `shift`, `alt`, `super`, in any order, joined by `+` (e.g. `ctrl+g`, `alt+shift+x`, `escape`, `tab`).

## Controls

While an `ask_user` prompt is open:

| Key | Action |
|-----|--------|
| `alt+o` (configurable via `overlayToggleKey`) | Hide/show the overlay popup so you can read the agent's prior output. Available in `overlay` mode only. The first time you hide it, a notification reminds you which key brings it back. |
| `ctrl+g` (configurable via `commentToggleKey`) | Toggle the optional comment/extra-context row (when `allowComment: true`). |
| `enter` | Confirm the focused option, submit a freeform response, or submit/skip an optional comment. |
| `esc` | Clear the search filter, exit freeform/comment mode, or cancel the prompt. |
| `↑` / `↓`, `ctrl+k` / `ctrl+j` | Navigate options. `ctrl+k` / `ctrl+j` (vim-style) work while typing in searchable prompts without disturbing the filter. |
| `pgup` / `pgdn` | Scroll the question/context region when it is taller than the popup. The popup never exceeds 85% of the terminal height, so options and the help line always stay visible; a `↑ n lines above` / `↓ n lines below` indicator marks the hidden content. Only in option-select mode (the editor owns these keys in freeform/comment mode). |

If you prefer never to see the overlay, set `PI_ASK_USER_DISPLAY_MODE=inline` globally or `"displayMode": "inline"` in `ask-user.json`.

## RPC / headless fallback

When the rich TUI is unavailable (`ctx.ui.custom()` returns `undefined`, e.g. `pi --rpc`), the tool collects the same answers through the dialog protocol (`select` / `input`):

- **Single select** — one `select` dialog listing the option titles, plus a freeform row when `allowFreeform` is set.
- **Multi select** — repeated `select` rounds. Every round lists the options as numbered checkbox rows (`1. [✓] Red`, `2. [ ] Blue`); picking a row toggles it, picking it again unchecks it. A `✓ Done selecting` row appears once at least one option is checked, and a freeform row appears when `allowFreeform` is set. The dialog title carries the full option list with descriptions and the current selection.
- **Comment** — with `allowComment`, an `input` dialog follows the selection; submitting nothing skips it.
- **Cancellation** — only a cancelled dialog (or a timeout) produces `cancelled: true`.

The user never types option titles, so a mismatch cannot be mistaken for a cancellation. Only the rows offered in that round are accepted: the freeform row counts only when `allowFreeform` is set, and `✓ Done selecting` only once something is checked. A value that is not among the offered choices — an unoffered sentinel, a row from an earlier round, or any unknown string — returns `isError: true` with `cancelled: false`, echoes the raw answer in `details.rawInput`, and lists the offered choices in the error text.

Results collected this way carry `details.fallback: "dialogs"`.

## Result details

All tool results include a structured `details` object for rendering and session state reconstruction:

```typescript
type AskResponse =
  | { kind: "selection"; selections: string[]; comment?: string }
  | { kind: "freeform"; text: string };

interface AskToolDetails {
  question: string;
  context?: string;
  options: QuestionOption[];
  response: AskResponse | null;
  cancelled: boolean;
  /** Present when the RPC/headless dialog protocol collected the answer. */
  fallback?: "dialogs";
  /** Failure description; a failed ask keeps `cancelled: false`. */
  error?: string;
  /** Verbatim dialog answer that matched none of the offered choices. */
  rawInput?: string;
  /** Set when the tool settled the prompt itself; absent for a user/host cancel. */
  cancelReason?: "timeout" | "abort";
}
```

## RPC / headless hosts

In RPC mode (`pi --mode rpc`) `ctx.ui.custom()` returns `undefined`, so `ask_user` falls back to the
extension UI dialog protocol (`select()` / `input()`).

**Hard requirement: an RPC client must implement the dialog methods `select`, `confirm`, `input`, and
`editor`.** Each emits an `extension_ui_request` and waits for an `extension_ui_response` with the
matching `id`. Pi only arms a timer or an abort listener when the request carries `timeout` / `signal`,
so a client that silently drops these requests stalls any tool call that asks the user something.
See the host's `docs/rpc-extension-ui.md` for the wire format.

`ask_user` defends itself against a silent client:

- Every dialog call carries both a `timeout` and an `AbortSignal`, so a conforming host can show a
  countdown and dismiss the prompt when the turn is aborted.
- In non-TUI modes a default deadline of **300000 ms (5 minutes)** applies when the caller did not pass
  `timeout`; an explicit `timeout` always wins. TUI mode keeps waiting indefinitely — a real user is
  present and can press `esc`.
- The tool also races its own deadline and the tool's abort signal against the host promise, so it
  settles even if the host ignores both options. On expiry the host-facing signal is aborted so a
  conforming host tears down its prompt.
- A recorded local timeout/abort has the final say: a host that resolves — or rejects — from inside the
  abort listener, or after the local cancel, cannot turn the result into an answer or a host error. Late
  rejections are absorbed instead of surfacing as unhandled rejections. A host failure with no local
  cancel still returns a structured `isError` result on every dialog path, including the option-less
  freeform `input`.
- Settlement is reported as `cancelled: true` plus `details.cancelReason`: `"timeout"` when the
  deadline expired, `"abort"` when the call was interrupted, and absent when the user (or host) cancelled.
  The rich inline/overlay UI reports the same reasons; its explicit `timeout` and tool abort settle the
  prompt and are cleaned up (timer + abort listener) on every exit — answer, cancel, timeout, abort, or
  an exception while building the component — and late callbacks cannot re-settle it.

## Credits

This project is based on [pi-ask-user](https://github.com/edlsh/pi-ask-user) by [Enzo Lucchesi](https://github.com/edlsh). Thank you to the original author for the excellent work.

## UI surface

`ask_user` builds on host UI primitives whose support differs per run mode:

| Method | Guard | Outside TUI (RPC / headless) |
|---|---|---|
| `custom` (rich inline / overlay question component) | `hasUI` | RPC returns `undefined` immediately, so the tool falls back to the `select` / `input` dialog protocol below. An explicit `timeout` or a tool abort settles the prompt as `cancelled: true` with `details.cancelReason: "timeout"` / `"abort"` (rendered as `Timed out` for timeouts), and clears the timer and abort listener on every exit |
| `onTerminalInput` (overlay toggle key) | `mode === "tui"` (registered only inside the component path) | Not registered |
| `select` / `input` (dialog fallback, freeform questions) | `hasUI` | Forwarded as `extension_ui_request`; the client should answer. Every call carries `timeout` + `signal`, and the tool races its own deadline (default 300000 ms outside TUI) and the tool's abort signal, so an unresponsive client settles as `cancelled: true` with `details.cancelReason: "timeout"` instead of hanging the turn. A local cancel also wins over a host resolve/reject that arrives afterwards |
| `notify` (`ask_user hidden — press …`) | `mode === "tui"` | Not reached |
| `hasUI === false` (print / json) | `hasUI` | Returns an `Ask requires interactive mode …` error result so the model can ask in plain text instead |

## License

MIT
