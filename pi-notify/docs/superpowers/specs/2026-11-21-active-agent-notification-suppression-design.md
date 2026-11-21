# Suppress notifications in active-agent sessions

## Intent

Prevent the `pi-notify` instance loaded into a subagent session from emitting desktop notifications. Notifications produced by the user-attended top-level session keep their current behavior.

## Goals

- Recognize subagent sessions through the `<active_agent name="..."/>` system-prompt marker.
- Suppress both completion and waiting-for-input desktop notifications in those sessions.
- Handle both append-style and replace-style prompts.
- Preserve lazy initialization for prompts emitted before `session_start`.
- Keep the change inside `pi-notify`.

## Non-goals

- Do not infer a generic session hierarchy from `parentSession`, paths, UI mode, or process state.
- Do not change `pi-subagents` or its extension-loading policy.
- Do not suppress custom-message-triggered runs in the parent session; run origin is a separate policy decision.
- Do not add a cross-process notification registry or lifecycle-event integration.

## Contract and constraints

`pi-subagents` emits `<active_agent name="..."/>` in both prompt modes and defines it as a public marker for downstream extensions. `<sub_agent_context>` and its natural-language description are append-only and must not be used as the detector.

The marker is a string contract rather than a host-provided structural session identity. A top-level prompt containing the same marker opts into the same suppression. A missing marker preserves existing behavior (fail-open).

## Approaches

1. **System-prompt marker — chosen.** Detect `<active_agent>` once per session, with lazy detection for pre-`session_start` events. This is local, concurrency-safe, and requires no shared registry.
2. **Child lifecycle registry.** Track `subagents:child:session-created` and `subagents:child:disposed` in a `globalThis` set. This uses explicit session IDs but requires cross-module state, event subscriptions, and cleanup.
3. **Filter the extension while creating child sessions.** This avoids loading `pi-notify` into children but modifies `pi-subagents` and couples its loader to another package.

The marker is preferred because it is the existing downstream-extension contract and has the smallest state and failure surface.

## Design

Keep a per-extension-instance `activeAgentSession: boolean | undefined` value.

- `session_start` recomputes it from `ctx.getSystemPrompt()` so reload and session replacement refresh the decision.
- Notification handlers lazily compute and cache it when no `session_start` has occurred yet.
- Detection matches the full tag shape `<active_agent name="..."/>`, allowing surrounding prompt content.
- `ui_prompt_start` and `agent_settled` return before creating or using the desktop notifier when the cached value is true.
- `agent_settled` still calculates and resets run timing before applying the guard, preventing state from leaking into a later session.
- The environment-derived/user-controlled `enabled` flag remains independent; `/notify` does not override session suppression.

Update both READMEs with the session-level suppression contract without naming another extension package.

## Verification

Add extension-level tests proving:

- append-style surrounding content and replace-style leading markers both suppress prompt and completion notifications;
- a marked session is suppressed even when a prompt arrives before `session_start`;
- natural-language subagent text without `<active_agent>` does not suppress notifications;
- a later unmarked `session_start` restores normal notification behavior;
- `/notify` cannot override active-agent session suppression;
- existing unmarked-session tests remain unchanged.

Run `npm test -w pi-notify`, `npm run typecheck -w pi-notify`, and `npm run lint -w pi-notify`.
