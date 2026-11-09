# Streaming Transcript Tail — Design

- Date: 2026-11-09
- Package: pi-subagents
- Status: Proposed

## Intent

The `/subagents:sessions` overlay repaints once per *finished message*, not per token. The live transcript source reads `AgentSession.messages`, which is `agent.state.messages` — and pi's agent core pushes an assistant message into that array only at `message_end`. While a response streams, the in-flight partial lives in `agent.state.streamingMessage` (not exposed by `AgentSession`) and in the `message_start` / `message_update` event payloads.

Measured with a faux stream emitting a delta every 100 ms: for the whole 600 ms of streaming, `state.messages` stayed at 1 entry (the user's prompt) and the transcript's tail text remained the prompt; both changed only at `message_end`. On a real turn (seconds to tens of seconds) the overlay therefore looks frozen and then dumps a whole message.

The only thing moving today is the `◍` activity line. It reads `SubagentState._responseText`, a string accumulated from `text_delta` events — a second, lossy representation of the same streaming message (no thinking blocks, no tool-call arguments, no `stopReason`). This change moves the structured partial into the state object and **retires `_responseText`**: one live representation, not two.

## Goals

- The overlay shows the assistant response — text, thinking, tool-call arguments — while it streams.
- Keep the `TranscriptSource` shape a message-list snapshot: `getMessages()` stays the only data entry point, so the evicted-agent `fileSnapshotSource` is untouched.
- Preserve the incremental-rendering invariant: each streaming delta refreshes only the tail in place.
- Retire the duplicate live representation: the structured partial becomes the single source for both the transcript and the activity line.
- Parse session events in exactly one place. Today the observer and the overlay both subscribe to the same session; after this change the observer is the only consumer of raw events and the only writer of live state, so no consumer's correctness can depend on listener order.

## Non-goals

- Streaming tool output during execution (`tool_execution_update` partial results). The viewer deliberately renders tool results in pi's collapsed state with no expand key (`README.zh.md:159`; approved as D2 in #163). The call line already appears with the streaming tail, so what a partial would add is a growing *collapsed preview* — in the area the design deliberately minimizes. A viewer that refuses to expand a finished tool result has no use for its intermediate states.
- Changing the 120 ms sync throttle, the widget's layout, or the activity line's wording.
- Evicted agents (static file snapshot) — no streaming concept there.
- `TurnLoopResult.responseText` (the turn loop's returned text in `subagent-session.ts`) — a different concept. Its own `text_delta` accumulator is gone: the value is now derived from the session's finalized message history (the last non-empty assistant text), so the branch leaves exactly one text representation.

## Anti-goals

- Two live representations that can drift (the accumulated string and the structured partial). That is what this change removes.
- A shim in its place: a `responseText` getter derived from the tail keeps the old name alive after the data moved. Nothing outside this package reads it (constraint 11), so there is no compatibility obligation to serve; the only effect is that one concept keeps two names and `grep responseText` matches two different concepts.
- Correctness that depends on subscription order. "The observer happens to be registered first" is an implicit invariant: a future refactor that subscribes a consumer earlier silently reintroduces a duplicated frame.
- Any change that makes the overlay re-materialize the streaming message instead of refreshing it (`rebuilt > 0`) — the O(transcript) regression class fixed in #163.

## Verified constraints (evidence)

1. `state.messages` receives the assistant message only at `message_end`; `message_start` / `message_update` write `state.streamingMessage` instead — `pi-agent-core/dist/agent.js` `processEvents()`. Runtime proof: the faux-stream probe described in "Intent".
2. `message_update`'s `event.message` is a complete partial snapshot (`{ ...partialMessage }`), not a delta — no accumulation needed.
3. `AgentSession` exposes no `streamingMessage` getter (`grep streamingMessage` in pi-coding-agent/dist → only interactive-mode's own field), so the tail has to be captured from events.
4. `subscribeSubagentObserver` is the only session subscription whose lifetime covers the whole run (`subagent.ts:280`, `:346`); `record.subscribeToUpdates` (consumed only by `liveSource`, plus tests) is a second subscription on the same session today. Both receive the same events.
5. `message_end` is the single event that both appends the finalized message to `agent.state.messages` and marks the end of the in-flight partial. There is no other transition that touches either, so the pair "list grew / tail gone" is one atomic fact of that event — provided both are applied before anyone reads them.
6. `TranscriptBody` already refreshes a tail that changes identity on every delta, in place: measured 0.26 / 0.29 / 0.43 ms per delta at 241 / 601 / 1201 messages with `{appended: 0, refreshed: 1, rebuilt: 0}`; full re-materialization (the pre-#163 behaviour) is 8.6 / 27.4 / 53.6 ms.
7. `SubagentState` has no serialization or snapshot path (`grep toJSON|serialize|snapshot` → empty), so adding a field carries no persistence obligation.
8. The activity line needs only a short prefix: `truncateLine` (`display.ts:139-147`) takes the first non-empty line and cuts at 60 characters, and it already splits the whole string on every read. Deriving that text from the structured partial therefore adds no complexity class — the accumulator was O(1) on write only, never on read.
9. The activity line is rendered only for `running` agents (`widget-renderer.ts` `buildSections`: finished agents go through `renderFinishedLine`, never `renderRunningLines`), so removing the retained-after-`message_end` string cannot surface as a stale or "thinking…" line on finished agents.
10. Tool partial output cannot travel through the message-list seam. `updateResult(result, isPartial)` takes the partial flag as a second argument (`interactive-mode.js:130`), and it selects the pending background (line 206) and is handed to the tool's own renderer (line 248). A synthesized `toolResult` message cannot express "in flight", so partial output can only reach a component through a per-tool-call-id seam.
11. No external consumer of `responseText` exists. The package's public surface is `index.ts` → `getSubagentsService` / `SubagentsService`, and the cross-extension snapshot `SubagentRecord` (`service.ts:21-35`) carries no live-activity field at all — neither `responseText` nor `activeTools`. All five `responseText` call sites live inside this package.

## Approaches considered

| Approach | Trade-off | Verdict |
|---|---|---|
| A — capture in `liveSource`'s own closure | Live activity ends up with two owners: the state object and one consumer's closure, which see different event windows | Rejected: keeps the drift the retirement exists to remove |
| B — store the tail in `SubagentState`, retire `_responseText`, notify from the observer | One structured source for live activity; one session subscription; event parsing in one place | **Chosen** |
| B′ — store the tail in state but keep a derived `responseText` getter | One concept wearing two names; the getter conceals the new field from every call site | Rejected: the five unchanged call sites are the debt, not a benefit. `responseText` also collides with `TurnLoopResult.responseText`, so `grep` no longer identifies a single thing |
| C — `TranscriptBody` subscribes to events directly (mirror pi's interactive mode) | Breaks the snapshot seam (`fileSnapshotSource` has no events), duplicates the component lifecycle next to the existing `sync()` diff, re-wires the line cache | Rejected: two render paths for one transcript, and the per-entry diff logic would exist twice |

Chosen: **B**. The structured partial becomes the live-activity field, alongside `turnCount` and `activeTools`, and the observer becomes the single writer of live state plus the single notifier.

## Chosen design

1. **`SubagentState`**: add `streamingMessage?: SessionMessage` behind a getter, mutated only via `setStreamingMessage(message: SessionMessage | undefined)`; delete `_responseText`, `resetResponseText()`, `appendResponseText()`, and the `responseText` getter. Update the module header, which currently lists `responseText` among the live-activity fields.
2. **`record-observer`**: drive the field from the events it already receives — `message_start` sets it when the role is `assistant` and clears it otherwise; `message_update` sets it for `assistant`; `message_end` clears it. The two `responseText` lines go away, and the module header's event-mapping list is updated to match.
3. **`record-observer` gains an `onChange` callback**, invoked after the state mutation for every session event. This makes the observer the single writer *and* the single notifier, so a consumer can never observe a half-applied `message_end` (constraint 5) — the ordering invariant disappears instead of being documented.
4. **`Subagent`**: expose a `streamingMessage` getter delegating to state; drop the `responseText` getter. `subscribeToUpdates` becomes a listener set owned by the subagent, fed by the observer's `onChange`, with the signature simplified to `(fn: () => void) => (() => void) | undefined` — consumers no longer receive raw session events, and event shapes are interpreted in exactly one place.
5. **`describeActivity(activeTools, message?)`** (`display.ts`): takes the structured message and derives the activity text itself (join the `text` blocks, then the existing `truncateLine`). The derivation stays a pure function over a message rather than a state accessor, so the retired "text field" cannot grow back on `SubagentState`.
6. **`StreamingState`** (`session-navigation.ts`) carries `streamingMessage` instead of `responseText`; `WidgetAgent`/`AgentDetails` wiring and `foreground-runner` follow the same substitution.
7. **`liveSource`**: `getMessages()` returns the record's messages with the tail appended when one is in flight, and the record's array as-is otherwise. The branch exists to avoid an allocation on the idle path; no consumer may depend on array identity — tests assert content.

### Why the tail is cleared at `message_end` rather than kept

Keeping the finished message as the tail and skipping it when the list already holds it would push the same "is it already in the list?" guard into both the transcript source and the activity line. Clearing keeps one meaning per field: the list holds finished messages, `streamingMessage` holds the in-flight one, and no reader needs to disambiguate.

### No mid-stream gap

An overlay opened while a message is already streaming shows that message immediately: the observer subscribes at agent start and keeps `streamingMessage` current, so the state already holds the in-flight partial when the overlay reads it. This is why the tail belongs in state rather than in a consumer's closure, which would only see events after subscribing.

### Activity line semantics

`describeActivity` describes *current* activity. With no tool running and no message in flight it says "thinking…"; it no longer echoes the last finished response, which the transcript now shows in full. During tool execution `activeTools` is non-empty and takes precedence, so the visible difference is limited to the moment between an assistant message ending and the next one starting.

## What's left to the builder

- Method naming/JSDoc style, test placement, and fixture shape for the new field.
- Whether `describeActivity` gains a separate exported text-derivation helper or keeps it inline; either way the derivation lives in `display.ts` only.

## Tests

1. `SubagentState`: `setStreamingMessage` set/clear semantics; no accumulation API remains.
2. `record-observer`: the four event shapes drive the field (assistant start/update set it, non-assistant start clears it, end clears it), and `onChange` fires after the mutation — asserted from inside the callback against the state.
3. `describeActivity`: derives the first non-empty line from a message's text blocks; a thinking-only or tool-only message yields "thinking…"; long text truncates at 60 characters.
4. `liveSource`: the tail appears on `message_start`, follows `message_update`, and is gone after `message_end` with the finalized message present exactly once.
5. `TranscriptBody` (regression guard for existing behaviour): a tail that arrives as a new object on every delta yields `{appended: 0, refreshed: 1, rebuilt: 0}` and materializes the tool component once.
6. Overlay level: a growing tail repaints the new text without a full re-layout (reuse the existing layout counter), and the indicator line derives from the tail.
7. Updated fixtures/assertions wherever the old string was passed through: `agent-widget`, `widget-renderer`, `foreground-runner`, `session-navigation`, `session-navigator`.

## Verification

- `npx vitest run` in `pi-subagents` (full package suite).
- `npx tsc --noEmit`.
- `npx biome lint src tests`.
- `grep -rn "responseText" src/` returns only the `TurnLoopResult` concept, nothing from `SubagentState`.
- `grep -rn "subscribeToUpdates" src/` shows a single consumer path (the listener set fed by the observer), not a raw session subscription.
- Manual: spawn an agent, open `/subagents:sessions`, confirm text appears token by token, the overlay stays responsive, and the widget activity line follows the same text.
