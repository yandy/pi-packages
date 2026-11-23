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
- `pi.events` is the channel bus of one resource loader — the bus extensions already use for cross-package contracts (`subagents:child:*`, `ask:answered`). It is **not** process-wide: each `DefaultResourceLoader` creates its own unless one is passed in, and `pi-subagents` builds child sessions with their own loader, so a parent and a child session do not share announcements today. `pi.events.on` subscriptions are dropped automatically when an extension instance is invalidated.

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
- `ui_prompt_start` reads and clears the flag on **every** prompt, whatever its kind, then returns early when the flag was set and the prompt is `custom`. Consuming on every start keeps one viewer from silencing the next prompt, and an announcement never suppresses a titled dialog.
- The early return also drops the alert still pending for the prompt the viewer replaced. That prompt's `ui_prompt_end` cannot be relied on: `ExtensionRunner.emit()` awaits every handler, so another extension can hold the end past the 4 s delay — the picker's alert would then fire while the viewer is open.
- `ui_prompt_end` deliberately does **not** clear the flag: the event carries no identity, so an end belonging to an earlier prompt can arrive between a viewer's announcement and its own start. `session_shutdown` clears it.

Viewers (`pi-subagents`, `pi-todo`):

- The package duplicates the channel string (like every cross-package `pi.events` contract) and emits it synchronously immediately before `ctx.ui.custom(...)`.
- `SessionNavigatorHandler` takes the emitter as a required parameter, so a caller cannot forget the announcement and pi-notify stays out of the viewer's dependencies.

Ordering is safe because the host emits the prompt event through `queueMicrotask`: an announcement emitted in the same synchronous block as the `ui.custom` call is always observed before that start. The converse interleaving — the announced start arriving before the replaced prompt's end — is why the passive branch cancels the pending alert itself.

## Known limits

- A third-party read-only viewer that does not announce still alerts after the delay. Adopting the contract is one `pi.events.emit`.
- An announcement that is not followed by any prompt (a package emitting and then never calling `ui.custom`) lingers until the next start consumes it — and that next prompt may be a blocking `custom` (`ask_user`), which is then silenced. Announcing must therefore happen in the same synchronous block as the mount; in-tree publishers have nothing in between.
- The channel is a string contract: the host does not police it, so a package can announce a blocking prompt as passive and silence it.

## Verification

Unit tests (`tests/extension.test.ts`) prove:

- an announced `custom` prompt never alerts past the delay, both idle and mid-run;
- an announcement is one-shot and does not silence a titled dialog;
- a stale announcement silences the next `custom` prompt (the documented limit, pinned on purpose);
- a `custom` prompt without an announcement still alerts with the `Interactive prompt` subject (that is `ask_user`'s shape).

Host-scheduling tests (`tests/host-ordering.test.ts`) drive the real `ExtensionRunner` and its `queueMicrotask` dispatch instead of injecting events, and prove:

- the `/subagents:sessions` chain (picker → announced viewer) alerts for neither prompt;
- the same holds when another extension's `ui_prompt_end` handler holds `emit()` past the delay;
- an unrelated prompt end delivered between the announcement and the start does not lose the announcement;
- an unannounced `custom` prompt still alerts.

Viewer tests prove `SessionNavigatorHandler` announces immediately before `ui.custom` — and not when it skips the overlay — that `/todos` announces before its overlay with a strict call order and not on the RPC/print fallback.
