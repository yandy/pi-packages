# Suppress notifications in active-agent sessions

## Intent

Prevent subagent activity from producing unintended desktop notifications in both child and parent sessions. Notifications produced by user-initiated runs in the user-attended top-level session keep their current behavior.

## Goals

- Recognize subagent sessions through the `<active_agent name="..."/>` system-prompt marker.
- Suppress both completion and waiting-for-input desktop notifications in those sessions.
- Handle both append-style and replace-style prompts.
- Preserve lazy initialization for prompts emitted before `session_start`.
- Suppress completion notifications for idle parent-session runs started by an extension custom message.
- Preserve the user origin of an existing run when steering or follow-up messages join it.
- Keep the change inside `pi-notify`.

## Non-goals

- Do not infer a generic session hierarchy from `parentSession`, paths, UI mode, or process state.
- Do not change `pi-subagents` or its extension-loading policy.
- Do not suppress waiting-for-input notifications in a top-level parent session; run-origin filtering applies only to completion notifications.
- Do not add a cross-process notification registry or lifecycle-event integration.

## Contract and constraints

`pi-subagents` emits `<active_agent name="..."/>` in both prompt modes and defines it as a public marker for downstream extensions. `<sub_agent_context>` and its natural-language description are append-only and must not be used as the detector.

The marker is a string contract rather than a host-provided structural session identity. A top-level prompt containing the same marker opts into the same suppression. A missing marker preserves existing behavior (fail-open).

## Approaches

1. **System-prompt marker — chosen.** Detect `<active_agent>` once per session, with lazy detection for pre-`session_start` events. This is local, concurrency-safe, and requires no shared registry.
2. **Child lifecycle registry.** Track `subagents:child:session-created` and `subagents:child:disposed` in a `globalThis` set. This uses explicit session IDs but requires cross-module state, event subscriptions, and cleanup.
3. **Filter the extension while creating child sessions.** This avoids loading `pi-notify` into children but modifies `pi-subagents` and couples its loader to another package.

The marker is preferred because it is the existing downstream-extension contract and has the smallest state and failure surface.

For the parent session, `before_agent_start` exposes the formal `messageType: "user" | "custom"` run-origin contract. Tracking that origin is preferred over matching package-specific custom types or lifecycle events. A custom follow-up merged into an active user run does not emit another `before_agent_start`, so it preserves the existing user origin.

## Design

Keep a per-extension-instance `activeAgentSession: boolean | undefined` value.

- `session_start` recomputes it from `ctx.getSystemPrompt()` so reload and session replacement refresh the decision.
- Notification handlers lazily compute and cache it when no `session_start` has occurred yet.
- Detection matches the full tag shape `<active_agent name="..."/>`, allowing surrounding prompt content.
- `ui_prompt_start` and `agent_settled` return before creating or using the desktop notifier when the cached value is true.
- `agent_settled` still calculates and resets run timing before applying the guard, preventing state from leaking into a later session.
- The environment-derived/user-controlled `enabled` flag remains independent; `/notify` does not override session or run-origin suppression.

Track `runOrigin: "user" | "custom" | undefined` separately from the session classification:

- `before_agent_start` assigns `runOrigin = event.messageType`; it fires once for a high-level run, not for low-level continuations.
- `session_start` resets the origin to `undefined`.
- `agent_settled` captures whether the origin was `custom`, resets the origin and timer, and suppresses completion before notifier construction.
- An undefined origin preserves compatibility for hosts or tests that emit settlement without a preceding start hook.
- Run-origin suppression applies only to `agent_settled`; top-level prompts still notify when user attention is required.

Update both READMEs with the session-level and run-origin suppression contracts without naming another extension package.

## Verification

Add extension-level tests proving:

- append-style surrounding content and replace-style leading markers both suppress prompt and completion notifications;
- a marked session is suppressed even when a prompt arrives before `session_start`;
- natural-language subagent text without `<active_agent>` does not suppress notifications;
- a later unmarked `session_start` restores normal notification behavior;
- `/notify` cannot override active-agent session suppression;
- an idle custom-message run suppresses completion and does not construct a notifier;
- a custom run resets its origin and timer before a following user run;
- queued follow-ups and low-level continuations without another `before_agent_start` retain user-run notification behavior;
- existing unmarked-session tests remain unchanged.

Run `npm test -w pi-notify`, `npm run typecheck -w pi-notify`, and `npm run lint -w pi-notify`.
