# Keep read-only overlay prompts out of waiting-for-input alerts

## Intent

A viewer the operator opens through their own command — `/subagents:sessions` picking a subagent, `/todos` showing the full list — is not a request for attention. It must not raise a "Waiting for input" desktop notification no matter how long it stays open.

## Problem

`/subagents:sessions` mounts its transcript viewer with `ctx.ui.custom`, so Pi wraps it in `withUIPrompt` and emits `ui_prompt_start` with `kind: "custom"`. The previous deferral (`2026-11-21-deferred-prompt-notification-design.md`) drops the alert only when the prompt closes within 4 s; a read-only viewer is *designed* to stay open for minutes, so after 4 s the operator gets `Waiting for input / Interactive prompt` for a window they are actively reading.

`UIPromptStartEvent` carries only `kind` and `title`, so pi-notify cannot tell a viewer from a question by looking at the event.

## Goals

- Do not notify for a read-only overlay opened from the operator's own command, regardless of how long it stays open.
- Keep notifying when Pi is genuinely blocked on an extension prompt: interactive tools (`ask_user`) and approvals.
- Keep the change inside `pi-notify`.

## Non-goals

- Do not infer the initiator or the prompt's read-only-ness from the event; the host does not expose either.
- Do not change the host, `pi-subagents`, or `pi-todo`.
- Do not change the 4 s deferral, the completion path, or the active-agent suppression.

## Contract and constraints

- Pi emits `ui_prompt_start` only for `select` / `confirm` / `input` / `editor` / `custom`, and a titled dialog is always one of the first four — `custom` carries no title by contract.
- `custom` is arbitrary extension UI. In-tree it has two shapes: read-only viewers mounted by operator commands (`/todos`, `/subagents:sessions`) and interactive tools that block a run on an answer (`ask_user` in TUI mode).
- Approvals raised while an idle session is not running a turn use `select` / `confirm` / `input` (`pi-sandbox` escalation), not `custom`. They stay unaffected by any gate on `custom`.
- `agent_start` → `agent_settled` delimits a run in flight; `runStartedAt` already tracks it for the completion path. A `custom` prompt raised by a tool is always inside that window, because the tool call cannot return before the prompt does.

## Approaches

1. **Drop every `custom` prompt — rejected.** It silences `ask_user`, which is precisely the "the agent is blocked on your decision" case the package exists for.
2. **Ask the host for an initiator or a read-only flag — out of scope.** Cleaner semantics, but it needs a host change and a release before the noise stops.
3. **Gate `custom` prompts on a run in flight — chosen.** The two shapes separate cleanly along that axis: a viewer is opened by an operator command while the session is idle, an interactive tool only ever runs inside a run.

The earlier spec rejected gating prompts on an in-flight run outright, because a background subagent's approval may be raised in an idle parent session. That rejection still holds for titled dialogs, which is why the gate is narrowed to `custom` instead of applied to every kind.

## Design

In the `ui_prompt_start` handler, after the active-agent guard:

```
if (event.kind === "custom" && runStartedAt === undefined) return;
```

Nothing else changes: a `custom` prompt that passes the gate is scheduled, described, and cancelled exactly like before, and titled dialogs keep the previous behavior — a picker left open still means a stuck instance, so it still alerts.

## Known limits

- A third-party extension that raises a genuinely blocking `custom` prompt outside a run stays silent. No in-tree prompt does; such an extension should use `select` / `confirm` / `input`, or let the prompt happen inside a tool call.
- A read-only viewer opened while a run is in flight still alerts. Not reachable today: `AgentSession._throwIfExtensionCommand` rejects an extension command whenever the session is streaming, so a viewer can only mount while idle.

## Verification

Extension-level tests prove:

- a `custom` prompt opened while idle (the `/subagents:sessions` overlay) never alerts, even past the delay;
- a `custom` prompt opened by a tool inside a run still alerts with the `Interactive prompt` subject;
- after a run settles, a `custom` prompt is silent again;
- a titled dialog opened while idle still alerts.
