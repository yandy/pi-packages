# Keep read-only overlay prompts out of waiting-for-input alerts

## Intent

A viewer the operator opens through their own command — `/subagents:sessions` picking a subagent, `/todos` showing the full list — is not a request for attention. It must not raise a "Waiting for input" desktop notification no matter how long it stays open, whether the agent is idle or still streaming.

## Problem

`/subagents:sessions` mounts its transcript viewer with `ctx.ui.custom`, so Pi wraps it in `withUIPrompt` and emits `ui_prompt_start` with `kind: "custom"`. The previous deferral (`2026-11-21-deferred-prompt-notification-design.md`) drops the alert only when the prompt closes within 4 s; a read-only viewer is *designed* to stay open for minutes, so after 4 s the operator gets `Waiting for input / Interactive prompt` for a window they are actively reading.

`UIPromptStartEvent` carries only `kind` and `title`, so pi-notify cannot tell a viewer from a question by looking at the event, and it says nothing about the initiator.

Gating `custom` prompts on a run in flight does **not** work either: an extension command executes immediately even while the session is streaming (`AgentSession.prompt` handles registered commands before the streaming check), and the operator routinely opens a viewer mid-run — the streaming viewer exists precisely for that (`pi-subagents/docs/superpowers/specs/2026-11-09-streaming-transcript-tail-design.md`: "an overlay opened while a message is already streaming shows that message immediately"). Run state therefore cannot separate a viewer from a question.

## Goals

- Do not notify for a read-only overlay, however long it stays open and whatever the agent is doing.
- Keep notifying when Pi is genuinely blocked on an extension prompt: interactive tools (`ask_user`) and approvals.
- Keep the change small: the viewer's own package is the only place that knows its UI is read-only.

## Non-goals

- Do not infer the initiator or the prompt's read-only-ness from the event, from run state, from tool activity, or from the host.
- Do not change the host, the 4 s deferral, the completion path, or the active-agent suppression.
- Do not make the channel payload meaningful or the announcement sticky.

## Contract and constraints

- Pi emits `ui_prompt_start` only for `select` / `confirm` / `input` / `editor` / `custom`, and a titled dialog is always one of the first four — `custom` carries no title by contract.
- `custom` is arbitrary extension UI. In-tree it has two shapes: read-only viewers mounted by operator commands (`/todos`, `/subagents:sessions`) and interactive tools that block a run on an answer (`ask_user` in TUI mode).
- Only the mounting package knows which shape it is mounting.
- `pi.events` is a process-wide channel bus extensions already use for cross-package contracts (`subagents:child:*`, `ask:answered`), and `pi.events.on` subscriptions are dropped automatically when an extension instance is invalidated.

## Approaches

1. **Gate `custom` prompts on a run in flight — rejected.** Does not hold: extension commands run during streaming, so a viewer opened mid-run would alert again, and a foreground subagent tool is the most likely moment to open one.
2. **Drop every `custom` prompt — rejected.** It silences `ask_user`, the "the agent is blocked on your decision" case the package exists for.
3. **Ask the host for an initiator or a passive flag — out of scope.** Cleaner semantics, but it needs a host change and a release before the noise stops.
4. **The viewer announces itself (`notify:passive-prompt`) — chosen.** The one component that knows the prompt is read-only says so, one announcement covers the prompt that immediately follows, and every other prompt keeps the current behavior.

Announcing is opt-in, so the failure direction stays safe: an extension that says nothing keeps the default (a `custom` prompt alerts after 4 s), which is the right default for an unknown blocking prompt.

## Design

pi-notify:

- `PASSIVE_PROMPT_CHANNEL = "notify:passive-prompt"` is exported and subscribed once per extension instance.
- A handler sets `passivePromptPending`.
- `ui_prompt_start` reads and clears the flag on **every** prompt, whatever its kind, then returns early when the flag was set and the prompt is `custom`. A stale announcement therefore cannot silence a later alert, and an announcement never suppresses a titled dialog.
- `ui_prompt_end` and `session_shutdown` clear the flag alongside the pending timer.

Viewers (`pi-subagents`, `pi-todo`):

- The package duplicates the channel string (like every cross-package `pi.events` contract) and emits it synchronously immediately before `ctx.ui.custom(...)`.
- `SessionNavigatorHandler` takes the emitter as a required parameter, so a caller cannot forget the announcement and pi-notify stays out of the viewer's dependencies.

Ordering is safe because the host emits the prompt event through `queueMicrotask`: an announcement emitted in the same synchronous block as the `ui.custom` call is always observed first.

## Known limits

- A third-party read-only viewer that does not announce still alerts after the delay. Adopting the contract is one `pi.events.emit`.
- An announcement that is not followed by a prompt (a package emitting and then throwing before `ui.custom`) lingers until the next `ui_prompt_start`, which consumes it.
- The channel is a string contract: the host does not police it, so a package can announce a blocking prompt as passive and silence it.

## Verification

Extension-level tests prove:

- an announced `custom` prompt never alerts, past the delay, both idle and mid-run;
- an announcement is one-shot, does not survive `ui_prompt_end`, and does not silence a titled dialog;
- a `custom` prompt without an announcement still alerts with the `Interactive prompt` subject (that is `ask_user`'s shape);
- `SessionNavigatorHandler` announces immediately before `ui.custom` and not when it skips the overlay;
- `/todos` announces before its overlay and not on the RPC/print fallback.
