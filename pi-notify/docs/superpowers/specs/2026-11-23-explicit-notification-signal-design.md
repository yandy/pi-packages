# Explicit notification signals with automatic run completion

## Intent

`pi-notify` delivers desktop notifications for explicit extension requests and for run completion. Extensions that need user attention emit a notification signal; UI that has no signal stays silent. `pi-notify` no longer infers waiting-for-input semantics from host prompt events.

This separates notification intent from desktop delivery. Producers know when an interaction genuinely needs attention; `pi-notify` owns instance decoration, platform backends, the global enable switch, and automatic run-completion policy.

## Goals

- Expose one public `pi.events` channel for explicit desktop notification requests.
- Give the channel a small, stable, presentation-oriented payload contract.
- Let `pi-notify` add session, project, and pid context to every notification.
- Preserve automatic run-completion notifications and their existing guards.
- Remove prompt-start inference, non-blocking declarations, prompt pairing state, and deferred prompt delivery.
- Keep `pi-notify` optional: producers do not import or depend on it at runtime.

## Non-goals

- No delivery acknowledgement, persistence, retry queue, or cross-process event transport.
- No notification actions, click-to-focus, history, or deduplication.
- No semantic taxonomy such as `approval` or `background-task` in the public payload.
- No host API changes.
- No compatibility behavior for `notify:non-blocking-prompt`; the channel becomes unused.
- No automatic notification for `ui_prompt_start`, including prompts from unmodified third-party extensions.

## Anti-goals

- A signal must not become a reliable-message guarantee that controls producer control flow.
- Producers must not supply session names, project names, pids, or an `ExtensionContext` in the payload.
- Automatic run policy must not suppress an otherwise valid explicit request.
- Internal follow-up steps of an interaction already being answered must not generate a stream of desktop notifications.

## Constraints

- Use the existing shared `pi.events` bus. Its payload is `unknown`, so the consumer validates at runtime.
- Event handlers receive only the payload, not an `ExtensionContext`.
- Event delivery is fire-and-forget. If no consumer is installed, notifications are disabled, or the session is closed, a request is dropped.
- Existing platform delivery remains fire-and-forget and must never block the agent loop.
- The existing `/notify` switch and `PI_NOTIFY` setting apply to both explicit and automatic notifications.

## Approaches

### 1. Presentation-oriented signal plus a shared internal delivery pipeline — chosen

Producers send a title, optional body, and optional urgency. The public slot and the automatic completion path call the same internal rendering and delivery function. Completion calls it directly rather than re-emitting the public signal.

This keeps the public contract independent of producer business semantics, gives the completion path direct access to its event context, and avoids event loops or duplicate forwarding.

### 2. Semantic signal payload

Producers send values such as `{ kind: "approval", detail: "..." }`, and `pi-notify` owns kind-specific templates and urgency. This centralizes wording but couples `pi-notify` to other packages' business concepts and makes adding a kind a cross-package change.

### 3. Re-emit automatic completion through the public bus

The `agent_settled` path emits `notify:request` and consumes it through the same slot as external producers. This provides a single ingress and makes completion requests observable, but loses the event's direct `ExtensionContext`, requires additional context state, and creates avoidable forwarding and duplication risks.

## Public contract

Channel:

```ts
const NOTIFY_REQUEST = "notify:request";
```

Payload:

```ts
type NotifyUrgency = "low" | "normal" | "critical";

interface NotifyRequest {
	/** Short display subject; no instance metadata. */
	title: string;
	/** Optional user-facing detail; no instance metadata. */
	body?: string;
	/** Defaults to "normal". */
	urgency?: NotifyUrgency;
}
```

Example:

```ts
pi.events.emit("notify:request", {
	title: "Approval required",
	body: "A sandbox escalation is waiting for a decision",
	urgency: "critical",
});
```

The contract is structural and documented; producers do not import constants or types from `pi-notify`. New optional fields may be added compatibly. Unknown fields are ignored.

Runtime validation requires:

- a non-null object payload;
- a string `title` that is non-empty after trimming;
- `body`, when present, to be a string;
- `urgency`, when present, to be exactly `low`, `normal`, or `critical`.

Invalid requests are dropped without throwing into the event bus or constructing a notifier. A valid title is trimmed; body content is otherwise preserved. No implicit delay, minimum duration, abort, run-origin, or active-agent guard applies to explicit requests.

## Rendering and delivery

A shared internal function accepts a validated request plus the available context:

```text
title = <instanceName> · <request.title>
body  = <request.body>
        <instanceContext>
```

- `instanceName` is the current session name, falling back to the project basename.
- `instanceContext` retains the current project/pid formatting and omits a redundant project name.
- An absent or empty body produces only the context line.
- Explicit urgency defaults to `normal`; automatic completion continues to use `PI_NOTIFY_URGENCY_DONE`.
- Explicit summary truncation or markdown cleanup is not applied; producers own their content. Existing cleanup remains specific to automatic completion summaries.

The existing notifier backends and custom command protocol remain unchanged.

## Context lifecycle

The extension keeps the current `ExtensionContext` from `session_start` and replaces it on subsequent session starts. The public slot uses that context for `cwd` and UI error reporting; `pi.getSessionName()` and the process pid supply the remaining metadata.

An explicit request arriving before the first `session_start` uses `process.cwd()` as the project fallback. Desktop delivery remains possible; a UI warning cannot be shown until a context exists. `session_shutdown` clears the stored context and closes the slot to late requests. A later `session_start` reopens it. No request is buffered while context, configuration, or the consumer is unavailable.

Automatic `agent_settled` delivery uses the context supplied by that event directly.

## Automatic run completion

The existing completion producer remains inside `pi-notify`:

- `before_agent_start` records whether the run originated from a user or custom message.
- `agent_start` starts the current idle-period timer.
- `agent_settled` computes and resets run state, then applies the existing active-agent, custom-origin, aborted, enabled, and minimum-duration guards.
- An eligible run constructs the existing `Finished · <duration>` subject, cleaned assistant summary, and configured done urgency, then calls the shared rendering and delivery function directly.

Completion requests are not emitted on `notify:request` and are not exposed as public bus traffic.

## Producer adoption

### Blocking interactions

A producer emits immediately before opening the first UI that can wait for input, after all early returns and pre-abort checks. One logical interaction episode emits at most once. Subsequent freeform input, optional comments, multi-select rounds, or denial-reason prompts do not emit again because the operator has just answered the preceding step.

First-party adoption covers:

- `pi-ask-user`: one critical request before each tool invocation's initial blocking custom/dialog UI; no request for its internal follow-up steps or no-UI error path.
- `pi-sandbox`: one critical request before the initial approval selection, for both direct and brokered approval; no additional request for the denial-reason step.

For brokered sandbox approval, the signal is emitted on the event bus belonging to the parent instance that displays the UI, not on the requesting child's bus. This makes instance decoration and delivery policy belong to the visible prompt's instance.

Specific user-facing wording stays with each producer; the public payload does not encode prompt kinds.

### Non-blocking UI

`pi-subagents` and `pi-todo` remove their `notify:non-blocking-prompt` emissions and now-unused wiring. They do not emit `notify:request` for operator-driven pickers, settings, or read-only overlays.

Unmodified third-party UI stays silent until its producer opts in.

## Removed machinery and configuration

Remove from `pi-notify`:

- `ui_prompt_start` and `ui_prompt_end` handlers;
- `notify:non-blocking-prompt` handling and its counter;
- the pending prompt timer, four-second delay, and prompt cancellation state;
- prompt-specific title/kind formatting;
- `urgencyPrompt` and `PI_NOTIFY_URGENCY_PROMPT`.

Retain:

- active-agent detection for automatic completion;
- run-origin and duration tracking;
- session configuration reload and notifier reset;
- `/notify`, `PI_NOTIFY`, `PI_NOTIFY_MIN_DURATION_MS`, `PI_NOTIFY_URGENCY_DONE`, and `PI_NOTIFY_COMMAND`;
- platform notifier behavior and failure reporting when a UI context is available.

## Documentation

- `pi-notify` English and Chinese READMEs describe the public channel, payload, rendering, immediate fire-and-forget semantics, and the remaining automatic completion behavior.
- Producer READMEs document only their own emitted signal and payload behavior.
- Remove obsolete non-blocking declaration documentation and tests from packages that produced it.
- Historical design documents remain unchanged.

## Verification

### `pi-notify`

- Valid explicit requests deliver immediately with default and explicit urgency.
- Rendering covers named/unnamed sessions, redundant project omission, body omission, multiline bodies, and pid context.
- Invalid payloads are dropped without notifier construction or thrown errors.
- Disabled and post-shutdown requests are dropped; a new session reopens delivery.
- Pre-session requests use the cwd fallback.
- Host prompt start/end events and legacy non-blocking declarations produce no notification and retain no pending state.
- Existing completion tests continue to prove timing, summary, duration threshold, active-agent/custom/aborted suppression, and done urgency.
- Backend tests remain unchanged except for configuration surface changes.

### Producers

- `pi-ask-user` emits once per actual initial interaction, with no emission on early returns, no-UI paths, or internal follow-up steps.
- `pi-sandbox` emits once at the actual direct or parent UI endpoint, with no emission for an already-aborted request or denial-reason follow-up.
- `pi-subagents` and `pi-todo` no longer emit the legacy declaration.
- Run affected package tests, typecheck, and lint, followed by repository-wide checks.

## Known limits

- Explicit notifications can remain visible after the user answers because there is no cancellation channel.
- A producer that repeatedly emits can repeatedly notify; throttling and episode boundaries belong to that producer.
- No consumer receives delivery status, and producers must not branch on whether notification delivery succeeded.
- Startup backend failures before any `ExtensionContext` is available cannot surface through `ctx.ui.notify`.

## Builder discretion

Implementation may choose private module boundaries and helper names, concrete producer notification wording, and the narrow dependency-injection seams needed for tests. These choices must not change the public payload, context ownership, episode-level producer behavior, or automatic completion policy above.
