# Subagent Cost — Design

- Date: 2026-11-15
- Package: pi-subagents
- Status: Proposed

## Intent

Subagent cost is invisible and unaccounted. A subagent runs in its own `AgentSession` with its own JSONL file; its usage (tokens and cost) lands only there. Two consequences:

1. No surface where a subagent's run is shown displays its cost — not the `/subagents:sessions` overlay, the Agents widget, the completion notification, or the tool result texts. Only token counts appear.
2. The parent session's total cost (footer `$x.xxx`, `/session`, `/usage`) does not include subagent cost, because the parent's stats scan only the parent session's own entries. Parallel background dispatch — the primary usage pattern this package exists for — is therefore systematically missing from the bill.

This change makes subagent cost visible wherever a run is shown, and aggregates every run's cost into the parent session's totals exactly once.

## Verified pi-core mechanics (constraints)

Evidence gathered against pi-coding-agent 1.1.0 (dist) + pi-ai 1.5.2, workspace devDeps are 0.80.2 — the peer range `>=0.80.2` covers both; code must compile against 0.80.2 and run against 1.5.2.

1. **`AgentSession.getSessionStats()`** aggregates over ALL session entries — assistant `usage`, `toolResult` messages' `usage`, standalone `type: "usage"` entries (e.g. cache warm), and `compaction` / `branch_summary` `usage` — including history compacted away. Returns `{ tokens: {input, output, cacheRead, cacheWrite, total}, cost: number, … }`. This is the exact accounting basis the parent footer uses for itself (`footer.js` `getSessionStats()`); using it for the child means displayed and aggregated cost share one definition, and cost survives child compaction.
2. **`SessionManager.appendUsage(kind, provider, model, usage, note?)`** is a public method on the exported `SessionManager` class. It appends a `type: "usage"` entry that does **not** participate in LLM context and is counted by the footer (`entry.type === "usage"`), `/session` totals, and `/usage` breakdown (grouped under its `provider`/`model` key). The core cache-warmer uses this exact call path (`appendUsage("cache_warm", …)`), including mid-run — appending entries while an agent run is active is an established pattern (compaction does the same).
3. **TUI renders only `kind === "cache_warm"` usage entries** in the transcript (`interactive-mode.js` `entry_appended` handler and `renderSessionEntries`). A `kind: "subagent"` usage entry produces no transcript noise — it only affects stats.
4. **The extension ctx exposes only `ReadonlySessionManager`** — a `Pick` that omits `appendUsage`. But the runtime object IS the full `SessionManager` (the same instance the tool ctx and `session_start` ctx carry). A feature-detected downcast against the exported class shape is therefore reliable in practice and degrades gracefully (skip + debug log) if upstream ever narrows the object.
5. **The official nested-LLM accounting channel** — tool `execute` returning `usage`, persisted on the toolResult message and counted in footer/`/session`/RPC totals (docs/extensions.md "Usage accounting") — only works where a tool call is in flight to carry the usage. A background agent that completes after `subagent` returned, whose result the model reads from the notification preview without ever calling `get_subagent_result`, has no tool result to carry its cost. This is not a corner case: it is the documented consumption pattern for notifications.
6. **Usage shapes**: `Usage = { input, output, cacheRead, cacheWrite, totalTokens, cost: { input, output, cacheRead, cacheWrite, total } }` (pi-ai 0.80.2; 1.5.2 adds optional `cost.totalFromProvider`). Consumers the appended entry feeds (`addUsageToTotals`, `getUsageCostBreakdown`, TUI) read only `usage.cost.total` and the token fields — the per-category cost fields can be zero-filled honestly (the source does not provide the split).
7. **Widget timer runs at 80 ms.** Cost display must not scan child entries per tick; `getSessionStats()` is O(entries). Cache keyed by `(sessionId, entryCount)` — entries are append-only, so entryCount changes iff stats change.
8. **Session teardown and quit both emit `session_shutdown` before disposing the session** — `teardownCurrent(reason)` (switch/new/fork) and `dispose()` (quit) each `await session.abort()` first, then emit `session_shutdown` (`reason: "resume"/"new"/"fork"/"quit"`), then `session.dispose()` (`agent-session-runtime.js`). pi-subagents' `handleSessionShutdown` unconditionally `abortAll()`s and `manager.dispose()`s (which disposes every child session and clears the maps), and the extension is re-instantiated per session (the `restoreEvicted` comment in `subagent-manager.ts`). So **no agent ever completes "in" another session**, and switch-then-resume is impossible. The real cross-boundary case: at shutdown, `abortAll()` only fires AbortControllers — in-flight runs unwind **asynchronously** and settle after the shutdown handler returns.
9. **On quit, the process exits before the async unwind settles** — in-flight run cost would be dropped. A synchronous settle inside `handleSessionShutdown` (after `abortAll()`, before `manager.dispose()`) captures cost-so-far before the process can exit; the later async settle computes the residual delta (usually zero — abort produces no further LLM calls) and no-ops. Exactly-once is preserved by the reported marker.
10. **Appending into the birth session's `SessionManager` after a switch is mechanically safe**: `appendUsage` is an in-memory append plus a synchronous JSONL line write; `AgentSession.dispose()` does not dispose the `SessionManager`. If the user switches back, the reloaded instance re-parses the whole file (all lines, including ours), so the cost is not lost — at worst a transient view misses the line until the next load. Upstream discourages reusing captured raw ctx objects after a switch; this design accepts that narrow reuse (settle residual deltas) because the alternative is dropping real cost.
11. **`Subagent.run()` terminal paths are `completeRun()` / `failRun()`; `resume()` terminal paths are `markCompleted` / `markError` inside `resume()`** (`resume()` does not call `onRunFinished`). Every path that ends a run with usage goes through exactly one of these four points; abort/timeout settle through `completeRun` (aborted), and a session that never got created has no usage to report.
12. **`parseSessionEntries` + `buildSessionContext`** power the evicted-agent file snapshot; the same parsed entries can be summed for cost with the same accounting basis as constraint 1 (usage entries + assistant/toolResult/compaction/branch_summary usage).
13. **`SubagentManager.dispose()` disposes child sessions and clears the maps** — the synchronous shutdown settle must run before it, while child sessions are still live (stats remain readable after dispose per constraint 10, but settling before is cleaner and keeps ordering obvious).

## Approaches considered

| Approach | Trade-off | Verdict |
|---|---|---|
| **A. Official channel only** — `subagent` / `get_subagent_result` / `steer_subagent` return the run's `usage` on their tool results | Zero casts; usage rides the documented nested-LLM path | Rejected — background agents whose result is consumed from the notification preview are never reported (constraint 5), which is the primary pattern |
| **B. Uniform `appendUsage` at run end** — every run's terminal point computes a delta vs. the last reported snapshot and appends a `usage` entry to the birth session's manager | One accounting path, exactly-once per run, covers foreground, background, resume, steer, error, timeout; needs one feature-detected downcast (constraint 4) | **Chosen** |
| **C. Hybrid** — official channel for foreground/resume, `appendUsage` for background | Official path where a tool call exists | Rejected — two accounting paths plus double-report guards; the cast is still required for the dominant background case, so it buys little |

## Design

### Cost source and delta bookkeeping

- **Source of truth**: the child session's `getSessionStats()` — tokens `{input, output, cacheRead, cacheWrite, total}` plus `cost: number` (constraint 1). One definition for display and aggregation.
- **Snapshot type** `SessionUsageSnapshot = { input, output, cacheRead, cacheWrite, totalTokens, cost }` in `lifecycle/usage.ts`, with pure helpers:
  - `usageDelta(current, last)` → delta snapshot (field-wise subtract; `last === undefined` → current);
  - `snapshotIsZero(s)` → all fields 0;
  - `toUsageEntryUsage(s)` → the pi-ai `Usage` shape for `appendUsage` (token fields real; `cost` = `{input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: s.cost}` — per constraint 6, only `cost.total` is read downstream).
- **Reported marker**: `SubagentState` gains `_reportedUsage?: SessionUsageSnapshot` — the last snapshot successfully appended to a parent session. Living on the state means the 10-minute cleanup sweep discards it with the record; a parallel map on the reporter would leak.
- **`SubagentSession.getUsageSnapshot()`**: cache keyed by `(sessionId, entryCount)` where `entryCount` comes from the child `sessionManager.getEntryCount()` — an O(1) probe on every 80-ms widget tick; `session.getSessionStats()` runs only when the count changed (constraints 1, 7). Also `getModelAttribution()` → `{ provider, model }` from `session.state.model` for the usage entry's attribution (falls back to `"unknown"` when absent).
- **Cost getters on `Subagent`**: `getCost(): number | undefined` (cached snapshot's cost; undefined before a session exists) — one accessor every display site reads.

### Settle: exactly once per run

`Subagent.settleUsage()` — called from the four terminal points (constraint 11): `completeRun()`, `failRun()`, and `resume()`'s success/error paths, after the status transition:

1. `usageSink` absent (no session ctx at spawn, or `appendUsage` not present — constraint 4) → skip, marker unchanged.
2. No `subagentSession` → skip (nothing spent).
3. `current = getUsageSnapshot()`; `delta = usageDelta(current, state.reportedUsage)`; `snapshotIsZero(delta)` → skip.
4. `sink.appendUsage("subagent", provider, model, toUsageEntryUsage(delta), \`subagent "${description}"\`)` inside try/catch — on throw: debug log, **marker unchanged** (the next terminal point re-reports the unreported delta).
5. On success: `state.reportedUsage = current`.

`usageSink` is captured **at spawn** as a narrow interface `{ appendUsage(kind, provider, model, usage, note?) }`, sourced from `runtime.currentCtx.sessionManager` at `SubagentManager.spawn()` time via a `getUsageSink()` option on the manager. Because the extension is re-instantiated per session (constraint 8), the spawn-time capture is always the birth session — the only session this extension instance ever serves. Both the tool path and the cross-extension service path funnel through `spawn()`, so one wiring point in `index.ts` covers both. The sink is stored on `SubagentExecution`; resume only ever happens within the same session as the original run, so there is no rebinding question to answer.

### Settle at session shutdown

`handleSessionShutdown` gains a synchronous settle between `abortAll()` and `manager.dispose()` (constraints 8, 9, 13): for every agent that still has a session, run the same `settleUsage()` — capturing cost-so-far before the process can exit (quit) or the switch completes. The async `completeRun` that follows computes the residual delta (usually zero after abort) and no-ops via the zero-delta skip. An in-flight streaming response whose `message_end` never lands before process exit is a bounded, accepted loss (at most one response per running agent).

Appended entries: kind `"subagent"`, no LLM context, no transcript rendering (constraints 2, 3), visible in `/usage` as the child model's own line, reconciling with the total.

### Display — one formatter

`formatCost(cost)` in `ui/display.ts`: `$${cost.toFixed(3)}` (footer's precision); shown only when `> 0` (subscription-priced models report 0 — hide rather than show `$0.000`).

| Surface | Placement | Source |
|---|---|---|
| Agents widget, running line | appended to the stats parts after tokens | `WidgetAgent.cost` ← `toWidgetAgent` reads `record.getCost()` |
| Agents widget, finished line | same | same |
| `/subagents:sessions` overlay | title line end: `Subagent session · model (thinking) · $0.042` | live: `getCost()` on `NavigableSubagent` via a `getCost` option on the overlay; evicted: computed once from the parsed file entries (constraint 12) by `sumSessionCost(entries)` in `session-navigation.ts` |
| Completion notification | stats line after tokens; `<cost_total>` inside `<usage>` XML | `NotificationDetails.cost`; `formatTaskNotification` reads `record.getCost()` |
| `get_subagent_result` text | `Cost: $0.042` in statsParts | `record.getCost()` |
| `steer_subagent` state text | same style in stateParts | `record.getCost()` |
| Foreground result text | `Agent completed in 12.3s (5 tool uses, 33.8k token, $0.042)`; `AgentDetails.cost` for the result renderer | `record.getCost()` |

### What the parent's totals absorb

An appended `usage` entry contributes its **tokens** to the parent footer's ↑↓RW counters too (constraint 2 — the host's documented semantic for nested LLM usage). This is accepted, not worked around: the parent's context-% math is unaffected (it reads parent context, not token counters).

## Non-goals

- No change to `LifetimeUsage` (widget token counts) — its issue-#38 semantics (cacheRead excluded from summed token display) stay exactly as they are; cost is a separate field with a separate source.
- No per-category cost split in the appended entry (the source is a scalar; zero-filled — constraint 6).
- No `SubagentsService`/`SubagentRecord` surface change — cost stays package-internal this round.
- No settings toggle for aggregation; no cost budgets.
- No changes to how the parent's own cost is computed.

## Anti-goals

- Two accounting paths for the same run (double-report or drop-between-paths bugs). The single `settleUsage` choke point and the marker-on-state design exist to make exactly-once structural, not convention-followed.
- Reporting deltas against a moving baseline — the marker updates only after a successful append (step 5), so a failed append can never silently discard cost.
- Cost display that reads child sessions uncached per widget tick (constraint 7).

## Tests

Per `docs/guides/testing.md` (narrow interfaces, stub objects, no `vi.mock`):

- `usage.ts`: `usageDelta` (fresh vs. resumed vs. undefined baseline), `snapshotIsZero`, `toUsageEntryUsage` (token fields real, cost split zeroed, total preserved).
- `settleUsage` (via `Subagent` with stubbed session/sink/state): appends once per terminal path; delta = current − last reported; zero delta appends nothing; append throw → marker unchanged, next settle re-reports the full unreported delta; no sink / no session → no-op; marker updated only on success.
- Sink capture: `SubagentManager.spawn` stores the `getUsageSink()` value at spawn (birth-session binding); absent sink degrades to no-op.
- Shutdown settle: `handleSessionShutdown` settles in-flight agents synchronously after `abortAll()` and before `manager.dispose()`; already-settled agents no-op (zero delta); the async terminal settle afterwards reports only the residual delta.
- Display: `formatCost` (precision, hidden at 0), widget running/finished lines include cost, notification details + XML, get/steer tool texts, foreground result text, overlay title with cost, `sumSessionCost` from parsed entries (assistant usage, usage entry, compaction usage, toolResult usage).
- `SubagentSession.getUsageSnapshot` caching: same entryCount → one `getSessionStats` call; new entry → refresh.

## Deviations

None yet.
