# Notify only for prompts that block an agent loop

## Intent

pi-notify exists for one situation: an instance stopped and is waiting for the operator. Blocking prompts raised by a tool (`ask_user`, a sandbox approval) are exactly that. Prompts the operator's own slash command opens — a picker, a settings menu, a read-only viewer — are not: the operator is at the keyboard by definition, and nothing in the agent loop is waiting on that answer.

So the only criterion is **does this prompt block an agent loop?** Blocking prompts alert; non-blocking ones never do, however long they stay open.

## Problem

`ui_prompt_start` carries only `kind` and `title`, so the two classes look identical: `/subagents:sessions` opens a `select` picker and a `custom` overlay (`/todos` opens one too, `/subagents:settings` opens a `select` plus `input` menus), while `ask_user` opens a `custom` prompt and a sandbox approval opens `select`/`input`. All of them arrive as the same event.

The previous deferral (`2026-11-21-deferred-prompt-notification-design.md`) only dropped alerts for prompts answered within 4 s. That is wrong for a viewer — designed to stay open for minutes — and it never was a criterion: it is a bet on how fast the operator answers.

Deriving blocking-ness from run state does not work either:

- an extension command executes immediately even while the session is streaming (`AgentSession.prompt` handles registered commands before the streaming check), so a picker can open mid-run;
- the viewer is meant to be opened mid-run (`pi-subagents/docs/superpowers/specs/2026-11-09-streaming-transcript-tail-design.md`: "an overlay opened while a message is already streaming shows that message immediately"), often while a foreground subagent tool is in flight;
- a background subagent's approval is raised in an **idle** parent session, so run state would miss the one case that must notify.

## Criterion

| Prompt | Blocks an agent loop? | Notifies |
|---|---|---|
| `ask_user` — TUI `custom`, RPC/print `select` + `input` | yes, its tool call | yes |
| `pi-sandbox` approval — local tool, and the cross-session channel into the parent | yes, the asking tool | yes |
| `/subagents:sessions` picker | no — the agent is idle or busy elsewhere | never |
| `/subagents:sessions` transcript overlay | no, read-only | never |
| `/subagents:settings` menus | no | never |
| `/todos` overlay | no, read-only | never |
| built-in pickers (`/model`, `/resume`, `/settings`, `/fork`, `/tree`) | no | never (and not observable — see Known limits) |

Only the package opening the prompt holds this fact. Hence a contract instead of an inference.

## Approach

1. **Gate on run state — rejected.** Disproved above: it fires for viewers opened mid-run and misses approvals raised into an idle parent.
2. **Gate on a tool being in flight — rejected.** A closer proxy, but it also fires for a command prompt opened while some unrelated tool happens to run, and it still misses the cross-session approval in an idle parent.
3. **Drop every `custom` prompt, keep every dialog — rejected.** Wrong on both sides: `ask_user` is `custom` and must alert, while `/subagents:sessions` and `/subagents:settings` open plain dialogs and must not.
4. **The package declares the prompt non-blocking (`notify:non-blocking-prompt`) — chosen.** The only component that knows says so, one announcement covers the next prompt, everything unannounced keeps the default (alert after the delay).

Announcing is opt-in, so the failure direction stays safe: a third-party prompt that says nothing is treated as possibly blocking and alerts, rather than being silently ignored.

## Design

pi-notify:

- `NON_BLOCKING_PROMPT_CHANNEL = "notify:non-blocking-prompt"`, subscribed once per extension instance. Announcements are **counted, not flagged**: one command can announce twice in a row (picker, then viewer), and the two starts can be delivered out of order when another extension's `ui_prompt_start` handler yields — a flag would collapse both announcements and leak an alert for the second prompt. Each start consumes at most one announcement.
- `ui_prompt_start` reads and clears the flag on **every** prompt and returns early when it was set — the declaration, not the `kind`, decides. The early return also cancels the alert still pending for the prompt this one replaced: that prompt's `ui_prompt_end` cannot be relied on, because `ExtensionRunner.emit()` awaits every handler and another extension can hold the end past the delay.
- `ui_prompt_end` deliberately does **not** clear the flag: the event carries no identity, so an end belonging to an earlier prompt can arrive between an announcement and its own start. `session_shutdown` clears it.
- Unannounced prompts keep the 4 s deferral, now purely antispam: a blocking prompt answered immediately must not raise a sticky `critical` banner. The delay is no longer what separates the two classes.

Publishers (`pi-subagents`, `pi-todo`):

- Duplicate the channel string (like every cross-package `pi.events` contract) and emit it synchronously immediately before each prompt they open: the picker, the overlay, the settings menu, and each value prompt.
- `SessionNavigatorHandler` and `SubagentsSettingsHandler` take the emitter as a required parameter, so a caller cannot forget it, and pi-notify stays out of their dependencies.
- `/todos` announces only on the overlay path, not on its RPC/print fallback (which emits a `notify`, not a prompt).

Ordering: the host emits the prompt event through `queueMicrotask`, so an announcement emitted in the same synchronous block as the prompt call is always observed before that start.

## Known limits

- A third-party non-blocking prompt that does not announce still alerts after the delay. Adopting the contract is one `pi.events.emit`.
- An announcement that is not followed by any prompt lingers until the next start consumes it — and that next prompt may be blocking (`ask_user`), which is then silenced. Announcing must therefore happen in the same synchronous block as the prompt call; in-tree publishers have nothing in between.
- The channel is a string contract: the host does not police it, so a package can declare a blocking prompt non-blocking and silence it.
- An announcement is paired with its prompt by *order of delivery*, not by identity: `UIPromptStartEvent` has no id and no initiator. The pairing holds because the announcement and the prompt call share one synchronous block, and because the prompt's start is delivered in the microtask drain that follows. `emit()` awaits handlers one event at a time but never serializes one event against another, so the remaining way to break it is an extension registered **before** pi-notify whose `ui_prompt_start` handler delays *different* events by *different* amounts: an older prompt's start can then land after a newer announcement, consume it, and silence a blocking prompt while alerting for the declared one. A uniformly slow handler does not reorder anything — each resumption is queued in emit order. No in-tree extension handles that event besides pi-notify, so the case is unreachable today; the host-side fix is a prompt id in the event. The counter keeps the two announcements of one command apart; it cannot repair mis-pairing.
- A prompt opened while another prompt is already open emits nothing: `withUIPrompt` guards on depth and only the outermost prompt produces `ui_prompt_start` / `ui_prompt_end`. So a blocking prompt nested under an open viewer — a background subagent's approval arriving while the operator reads a transcript — is invisible to pi-notify and never alerts. Nothing on the extension side can recover it; the host would have to stop collapsing nested prompts.
- Built-in pickers draw themselves on the TUI without passing through the extension UI channel (`interactive-mode.js` `showSelector()`), so Pi emits no prompt event for them. Under this criterion their silence is correct and their absence from the event stream is harmless; the cost is that no extension can learn about them at all.

## Verification

Unit tests (`pi-notify/tests/extension.test.ts`):

- an announced `custom` prompt never alerts past the delay, idle or mid-run;
- announced dialogs (`select` picker, `input` menu) never alert;
- one announcement covers exactly one prompt;
- a stale announcement silences the next prompt (documented limit, pinned on purpose);
- an unannounced `custom` prompt still alerts with the `Interactive prompt` subject (that is `ask_user`'s shape).

Host-scheduling tests (`pi-notify/tests/host-ordering.test.ts`) drive the real `ExtensionRunner` and its `queueMicrotask` dispatch:

- the `/subagents:sessions` chain (picker → announced viewer) alerts for neither prompt;
- a declared picker left open past the delay stays silent — this is what pins the picker's own announcement;
- both announcements survive a slow `ui_prompt_start` handler that delays the first one;
- a `non-blocking → blocking → non-blocking` sequence (picker, `ask_user`, viewer) alerts exactly once, for the blocking prompt, with and without a slow start handler;
- a blocking prompt opened while a declared overlay is open produces no alert at all (pinned known limit: the host emits nothing for nested prompts);
- the same holds when another extension's `ui_prompt_end` handler holds `emit()` past the delay;
- an unrelated prompt end delivered between the announcement and the start does not lose the announcement;
- an unannounced `custom` prompt still alerts.

Publisher tests: `SessionNavigatorHandler` announces before the picker and before the overlay (strict call order) and only for the prompts it actually opens; `SubagentsSettingsHandler` announces before the menu and again before the value prompt (the select is asserted to sit between the two announcements); `/todos` announces before its overlay with a strict call order and not on the fallback path.
