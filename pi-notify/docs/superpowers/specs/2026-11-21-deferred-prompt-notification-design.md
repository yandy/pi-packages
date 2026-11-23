# Defer waiting-for-input notifications

> The non-goal below — never gate a prompt on an in-flight run — still holds. The 4 s deferral it
> introduced is kept by [2026-11-23-blocking-prompt-notification-design.md](2026-11-23-blocking-prompt-notification-design.md)
> as antispam only: prompts that block an agent loop now alert after the delay, prompts declared
> non-blocking never alert, and run state decides neither.

## Intent

A blocking prompt that the operator answered immediately is not a request for attention. Today every `ui_prompt_start` raises a desktop notification instantly, so a slash command that opens its own picker (for example `/subagents:sessions`) alerts the operator about a wait they themselves started and are looking at.

## Problem

Pi's `ExtensionRunner` wraps every `ctx.ui` primitive — `select`, `confirm`, `input`, `editor`, and `custom` — and emits `ui_prompt_start` for the outermost one. The event carries only `kind` and `title`; it says nothing about who opened the prompt.

Built-in pickers (`/model`, `/settings`) mount TUI overlays directly and never emit the event, which is why only extension commands disturb the operator.

The notification therefore cannot filter by initiator. It can, however, observe whether the prompt is still open: a picker the operator is looking at closes within a fraction of a second, while a prompt that genuinely needs them stays open.

## Goals

- Notify for a blocking prompt only once it has stayed open for a fixed delay.
- Never notify for a prompt that closed before the delay elapsed.
- Keep every notification that the previous behavior produced for prompts nobody answered, including startup trust prompts and approvals raised in an idle parent session.
- Keep the change inside `pi-notify`.

## Non-goals

- Do not infer the initiator (command, tool, or background extension) — the host does not expose it.
- Do not gate on an in-flight agent run (`agent_start` → `agent_settled`). A background subagent's approval is raised in an idle parent session and must still notify.
- Do not change the host, `pi-subagents`, or any other package.
- Do not make the delay configurable; it is behavior, not a knob.

## Contract and constraints

- `ui_prompt_start` opens one pending notification; `ui_prompt_end` cancels it.
- Pi emits `ui_prompt_start` / `ui_prompt_end` only for the outermost prompt of a nesting (`withUIPrompt` depth guard), so a single pending slot is sufficient. A second start cancels the first outright rather than queueing.
- The payload is built at prompt-open time, so the notification describes the prompt that opened, not whatever state arrives later. The notifier instance is captured with it, because a later `session_start` resets the module-level notifier and must not swallow an alert already scheduled.
- The `enabled` flag is re-checked at delivery: `/notify` between open and delivery wins.
- `session_shutdown` discards a pending alert. `session_start` deliberately does **not**: every replacement path emits `session_shutdown` on the outgoing runner first (and reload builds fresh extension instances), so nothing stale can survive, while cancelling on `session_start` would drop the alert for the startup prompt Pi emits before it.
- Active-agent session suppression happens first: a suppressed prompt never schedules a delivery.
- The delay is `PROMPT_NOTIFY_DELAY_MS = 4000`.

## Approaches

1. **Initiator field on `UIPromptStartEvent` — rejected here.** Cleanest semantics, but it requires a host change and a release before the noise stops.
2. **Notify only while an agent run is in flight — rejected.** Silences startup trust prompts and the approvals a background subagent raises through an idle parent session.
3. **Deferred delivery cancelled by `ui_prompt_end` — chosen.** Needs no host metadata, cannot silence a prompt that is genuinely waiting, and degrades to a few seconds of latency for the alerts that matter.

## Design

Keep a per-extension-instance `pendingPromptTimer`.

- `ui_prompt_start`: after the active-agent, notifier, and `enabled` guards, cancel any pending timer, build the payload, and schedule delivery in `PROMPT_NOTIFY_DELAY_MS`. The timer is `unref`'d so a pending alert never holds the process open.
- Delivery clears the slot, re-checks `enabled`, and calls the captured notifier.
- `ui_prompt_end`: cancel the pending timer unconditionally; a no-op when nothing was scheduled.
- `session_start`: cancel nothing; keep the pending alert (see the contract above).
- `session_shutdown`: cancel so a session that goes away does not alert afterwards.

The existing completion path is untouched.

## Known limits

Cancellation rides on `ui_prompt_end`, which Pi emits only for the outermost prompt of a nesting and through a microtask. If the prompt opens and closes in the same tick before this handler runs — possible when an earlier-registered extension's `ui_prompt_start` handler yields first — the cancel is missed and the alert is delivered anyway. `UIPromptStartEvent` carries no initiator, so the extension cannot close that window itself; a host-provided initiator field would be the real fix.

## Verification

Add extension-level tests proving:

- the alert is delivered only after the delay elapses, with the same title, body, and urgency as before;
- an operator answering before the delay (the `/subagents:sessions` shape) produces no alert;
- a replacing prompt keeps a single pending alert describing the later prompt;
- `/notify` between open and delivery suppresses the alert, and re-enabling before delivery still delivers;
- a prompt still open when `session_start` fires keeps its alert;
- `session_shutdown` (and a replacement that emits it first) discards a pending alert;
- existing suppression, threshold, and toggle tests keep passing with the delay-driven harness helper.

Run `npm test -w pi-notify`, `npm run typecheck -w pi-notify`, and `npm run lint -w pi-notify`.
