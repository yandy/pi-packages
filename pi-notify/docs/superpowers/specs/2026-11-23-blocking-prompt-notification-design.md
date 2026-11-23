# Notify only for prompts that block agent progress

## Intent

Desktop waiting-for-input notifications exist for UI that prevents the agent from continuing until the operator responds. Operator-initiated pickers, settings menus, and read-only overlays do not block the agent loop and must never raise that notification.

## Problem

`pi-notify` currently treats every `ui_prompt_start` as a blocking wait and relies on a four-second delay to suppress alerts for prompts that close quickly. `UIPromptStartEvent` identifies only the UI primitive and title; it does not identify the initiator or say whether the agent is blocked. Delay therefore reduces the noise without representing the actual distinction.

Agent activity cannot supply the missing semantic. Extension commands may run while the agent is streaming, while approvals from background work may appear in an idle parent session.

## Goals

- Never notify in TUI for the `/subagents:sessions` picker or transcript overlay, `/subagents:settings` menus and inputs, or the `/todos` overlay.
- Preserve notifications for undeclared prompts, including blocking prompts from `pi-ask-user`, `pi-sandbox`, startup extensions, RPC/headless UI, and third-party extensions.
- Preserve the existing completion notifications and active-agent/custom-run suppression.
- Keep the four-second delay only as noise suppression for blocking prompts that are answered immediately.

## Non-goals

- Do not classify prompts by title, UI kind, agent activity, or tool activity.
- Do not change the host event shape or require a host release.
- Do not add a configuration knob or change notification wording.
- Do not change RPC/print fallback behavior.

## Approaches

1. **Explicit non-blocking declarations; undeclared prompts notify — chosen.** Producers synchronously emit `notify:non-blocking-prompt` immediately before the corresponding `ctx.ui` call. This represents the producer's knowledge of its own UI and preserves notifications from unknown blocking extensions.
2. **Explicit blocking declarations; undeclared prompts stay silent — rejected.** Every unmodified third-party blocking prompt would lose its notification.
3. **Host-provided initiator or blocking metadata — rejected for this change.** It requires a host release and still needs each producer to declare the same semantic.

## Contract

A non-blocking TUI producer emits the declaration and invokes the wrapped `ctx.ui.select`, `input`, or `custom` in the same synchronous block:

```ts
pi.events.emit("notify:non-blocking-prompt", {});
await ctx.ui.custom(...);
```

The host dispatches `ui_prompt_start` through a microtask, so the synchronous declaration arrives first. The event bus invokes the declaration handler synchronously up to its first await; the declaration handler does not await.

`pi-notify` stores declarations in a counter, not a boolean:

- each `ui_prompt_start` consumes at most one declaration;
- a declared start cancels any pending prompt notification and returns before notifier construction;
- `ui_prompt_end` only cancels the pending timer and never clears declarations, because events have no prompt identity and an end may belong to an earlier prompt;
- `session_shutdown` clears both the pending timer and all declarations;
- `session_start` does not clear declarations, preserving the existing startup-prompt ordering.

The counter keeps consecutive declarations distinct when another extension's asynchronous prompt handler delays event delivery. A declaration that does not correspond to an outermost prompt start is a producer contract violation. The host coalesces nested or overlapping UI into one outermost start, so declarations are limited to the serialized TUI operator path. RPC/headless calls remain undeclared because concurrent clients cannot guarantee that pairing; this preserves the default notification rather than risking a missed blocking alert.

After `session_shutdown`, the runner is closed to prompt starts already queued behind microtasks. A subsequent `session_start` reopens prompt handling for the new session without restoring cleared declarations.

## Producer changes

- `SessionNavigatorHandler` receives a required `announceNonBlockingPrompt` callback and invokes it immediately before the sessions picker and before the transcript overlay.
- `SubagentsSettingsHandler` receives the same required callback per invocation and invokes it before every settings select or input, including each subsequent level.
- `pi-subagents` wires the callback to `pi.events.emit("notify:non-blocking-prompt", {})` only when `ctx.mode === "tui"`; RPC/print/json callbacks stay silent.
- `/todos` emits directly before its TUI `ctx.ui.custom` call. Empty boards and non-TUI text fallbacks emit nothing.

## Known limits

- Undeclared third-party non-blocking UI retains the default alert; its producer must adopt the declaration contract to suppress it.
- The host emits prompt events only for the outermost prompt. A blocking prompt nested under an active viewer or dialog has no start event and cannot alert; extension code cannot recover it without host support.

## Verification

- Unit tests prove each producer emits exactly one declaration per actual prompt and none on early-return/fallback paths.
- `pi-notify` tests use a real `ExtensionRunner` and its wrapped `getUIContext()` so declaration and prompt events traverse the real microtask dispatch path.
- Integration cases cover persistent non-blocking overlays, consecutive non-blocking prompts, blocking prompts that still notify after the delay, prompt replacement, declarations surviving unrelated prompt-end events, TUI/RPC/print/json producer modes, and shutdown with a prompt start still queued.
- Run each changed package's tests, typecheck, and lint, followed by the repository-wide checks.
