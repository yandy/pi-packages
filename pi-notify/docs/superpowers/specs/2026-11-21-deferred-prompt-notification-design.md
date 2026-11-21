# Defer waiting-for-input notifications

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
- The payload is built at prompt-open time, so the notification describes the prompt that opened, not whatever state arrives later.
- The `enabled` flag is re-checked at delivery: `/notify` between open and delivery wins.
- `session_start` and `session_shutdown` discard a pending alert, so a replaced or closed session never notifies.
- Active-agent session suppression happens first: a suppressed prompt never schedules a delivery.
- The delay is `PROMPT_NOTIFY_DELAY_MS = 4000`.

## Approaches

1. **Initiator field on `UIPromptStartEvent` — rejected here.** Cleanest semantics, but it requires a host change and a release before the noise stops.
2. **Notify only while an agent run is in flight — rejected.** Silences startup trust prompts and the approvals a background subagent raises through an idle parent session.
3. **Deferred delivery cancelled by `ui_prompt_end` — chosen.** Needs no host metadata, cannot silence a prompt that is genuinely waiting, and degrades to a few seconds of latency for the alerts that matter.

## Design

Keep a per-extension-instance `pendingPromptTimer`.

- `ui_prompt_start`: after the active-agent, notifier, and `enabled` guards, cancel any pending timer, build the payload, and schedule delivery in `PROMPT_NOTIFY_DELAY_MS`. The timer is `unref`'d so a pending alert never holds the process open.
- Delivery clears the slot, re-checks `enabled`, and calls `notifier.notify`.
- `ui_prompt_end`: cancel the pending timer unconditionally; a no-op when nothing was scheduled.
- `session_start`: cancel alongside the existing per-session resets.
- `session_shutdown`: cancel so a session that goes away does not alert afterwards.

The existing completion path is untouched.

## Verification

Add extension-level tests proving:

- the alert is delivered only after the delay elapses, with the same title, body, and urgency as before;
- an operator answering before the delay (the `/subagents:sessions` shape) produces no alert;
- a replacing prompt keeps a single pending alert describing the later prompt;
- `/notify` between open and delivery suppresses the alert;
- `session_start` and `session_shutdown` discard a pending alert;
- existing suppression, threshold, and toggle tests keep passing with the delay-driven harness helper.

Run `npm test -w pi-notify`, `npm run typecheck -w pi-notify`, and `npm run lint -w pi-notify`.
