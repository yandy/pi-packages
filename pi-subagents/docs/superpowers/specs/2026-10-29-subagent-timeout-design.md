# Subagent Timeout — Design

- Date: 2026-10-29
- Package: pi-subagents
- Status: Proposed

## Intent

Add a wall-clock timeout to subagents: a run that exceeds its time budget is hard-aborted immediately. The motivating failure is a subagent stuck inside a long-running tool execution (e.g. inefficient or looping code run via bash), which otherwise occupies a concurrency slot and burns tokens indefinitely. The timeout is a forced-termination backstop for extreme cases — not a soft deadline and not a scheduling hint.

## Verified pi-core mechanics (constraints)

These shape the design and rule out alternatives:

1. **`AgentSession.steer()` cannot interrupt a tool execution.** Steer messages are "delivered after the current assistant turn finishes executing its tool calls, before the next LLM call." While an agent is blocked inside a tool that never returns, a steer is never delivered. → Any soft/wrap-up phase is useless in the primary failure mode.
2. **`abort()` terminates a stuck tool execution.** The run's AbortSignal is passed into every `tool.execute(id, args, signal, …)`; built-in tools kill their child processes on abort, the turn loop settles, and `session.prompt()` resolves. → Hard abort is the effective mechanism.

## Chosen behavior: pure hard timeout

- At the deadline the run is aborted immediately — same mechanism as the max-turns hard abort. No steer phase, no grace period.
- Timing starts when the run actually starts (`Subagent.run()` after `markRunning`); wait time in the concurrency queue does not count.
- The parent receives the partial output, prefixed with an explicit timeout note.
- The tool description must frame `timeout` as a hard cutoff returning possibly-truncated output — a safety net against runaway tasks.

### Approaches considered

| Approach | Trade-off | Verdict |
|---|---|---|
| Two-phase: steer "wrap up" at T, abort at T+grace (mirrors `max_turns` soft/hard) | Productive-but-slow agents get a wrap-up summary | Rejected — steer cannot deliver while blocked in a tool (constraint 1), so the grace period only delays the kill in the primary failure mode |
| Pure hard abort at T | Simple, predictable; kills stuck tools exactly at budget | **Chosen** — timeout is a backstop for extreme cases; partial output plus an explicit note is acceptable |
| Adaptive: abort now if `activeTools` non-empty, else steer+grace | Saves the grace delay for stuck agents | Rejected — extra behavioral branch; misclassifies tools that would return moments later |

## Configuration

Mirrors `max_turns` resolution semantics exactly — agent frontmatter > per-call param > global default (`agentConfig?.timeout ?? params.timeout ?? settings.defaultTimeoutSeconds`, the same `??` chain `maxTurns` uses, so a frontmatter value locks the cap and cannot be overridden per call):

| Layer | Field | Shape | Default |
|---|---|---|---|
| Tool call | `timeout` on the `subagent` tool | number, seconds, ≥ 1 | unset (unlimited) |
| Agent config | `timeout` in `.pi/agents/*.md` frontmatter | number, seconds, ≥ 0 (0 = unlimited) | unset |
| Global settings | `defaultTimeoutSeconds` in `subagents.json` | integer, seconds, 0–86400 (0 = unlimited) | 0 (unlimited) |

- Domain unit is seconds everywhere; converted to ms only at the `setTimeout` call site.
- `normalizeTimeoutSeconds(s)`: `null/undefined/0 → undefined` (unlimited); otherwise `max(1, s)`. Lives in `turn-limits.ts` next to `normalizeMaxTurns` (file header broadened to run limits).

## Tool parameter wording

```ts
timeout: Type.Optional(Type.Number({
	description:
		"Hard wall-clock limit in seconds. When exceeded, the agent is terminated immediately and only partial output is returned. Use as a safety net for tasks that could run away (long builds, hanging commands); omit for unlimited.",
	minimum: 1,
}))
```

Guidelines list gains one line: `Use timeout (seconds) as a hard safety net for tasks that might run away — the agent is killed at the deadline and output may be truncated.`

## Execution design

- `resolveAgentInvocationConfig` reads `params.timeout` + `agentConfig.timeout` → `timeoutSeconds`; `resolveSpawnConfig` computes `effectiveTimeoutSeconds = normalizeTimeoutSeconds(resolved ?? settings.defaultTimeoutSeconds)` and records normalized per-call seconds on `AgentInvocation` (for display tags).
- `AgentSpawnConfig` / `SubagentExecution` gain `timeoutSeconds`; threaded through `spawn`/`spawnAndWait` from both foreground-runner and background-spawner.
- **Timer lives in `Subagent.run()`**: started after `markRunning`, cleared in `completeRun` and `failRun` (both terminal paths — covers normal completion, manual abort, error). The timer handle is `unref()`d so it never holds the event loop.
- **On fire**: set an internal `_timedOut` flag, then fire `this.abortController.abort()` **without** `markStopped()`. The existing `forwardAbortSignal` wiring inside `runTurnLoop` turns that into `session.abort()`, which kills in-flight tool executions.
- **Turn-loop aborted flag must also derive from the run signal**: today `TurnLoopResult.aborted` is set only by the turn-limit watcher. `runTurnLoop` must additionally treat `opts.signal?.aborted` as aborted, so an externally-triggered abort (timeout) completes through the `markAborted` path — final status `"aborted"`, not `"stopped"` (which reads as "stopped by user"). The parent-signal abort path is unaffected (it marks stopped before the loop settles, and the state guard preserves that).
- **`forwardAbortSignal` must handle an already-aborted signal**: `addEventListener("abort", …)` on a fired signal never fires the listener, so a timeout (or parent abort) landing in the window before `runTurnLoop` wires the listener would be silently dropped. An already-aborted signal must abort the session immediately. (This gap exists for the parent signal today; fixing it is a strict improvement.)
- **Session-creation gap**: if the timeout fires before `runTurnLoop` starts (during workspace prep / session creation), the controller has no listener. After `createSubagentSession` resolves, `run()` checks `_timedOut` and fails the run fast with a timeout error (disposing the session). A never-settling factory/provider promise remains out of scope — same behavior as today.

## Status and result

- No new lifecycle status. A timed-out run ends `"aborted"` with the result text prefixed: `⏱ Timed out after {N}s — output may be truncated.`
- The `"aborted"` label is attributed to max turns in three places — `getStatusNote` (tools/helpers.ts), `getStatusLabel` (observation/notification.ts), and `renderFailed` (tools/result-renderer.ts). All three generalize "max turns exceeded" → "hard limit exceeded" since aborted now covers both max-turns and timeout kills.

## Touchpoints

- `src/config/invocation-config.ts` — param/frontmatter merge
- `src/config/custom-agents.ts` — frontmatter `timeout` parsing
- `src/tools/spawn-config.ts` — precedence + effective value
- `src/tools/agent-tool.ts` — param schema, description wording, guidelines
- `src/tools/foreground-runner.ts`, `src/tools/background-spawner.ts` — thread `timeoutSeconds` into spawn opts
- `src/lifecycle/subagent-manager.ts` — `AgentSpawnConfig` field
- `src/lifecycle/subagent.ts` — timer start/clear, `_timedOut` flag, result note, creation-gap check
- `src/lifecycle/subagent-session.ts` — `aborted` derived from signal
- `src/lifecycle/turn-limits.ts` — `normalizeTimeoutSeconds`
- `src/settings.ts` — `defaultTimeoutSeconds` (sanitize, snapshot, apply)
- `src/service/service.ts` + `src/service/service-adapter.ts` — `SpawnOptions.timeoutSeconds` passthrough (cross-extension callers get the same backstop)
- `src/ui/subagents-settings.ts` — settings menu entry
- `src/ui/display.ts` — invocation tag `timeout: {N}s`
- `src/types.ts` — `AgentConfig.timeout`, `AgentInvocation.timeout`
- `README.md` — param table, frontmatter example, settings docs

## Non-goals

- No soft/wrap-up phase (steer cannot deliver mid-tool — verified).
- No timeout enforcement on `resume` (parent-synchronous path with its own signal).
- No per-tool-call timeout inside the child session — the child can pass `timeout` to its own bash calls; the subagent-level timeout is the backstop.
- No new lifecycle status value.

## Tests

- `turn-limits`: normalize (0/undefined → unlimited, < 1 → 1, fractional passes through).
- `subagent` (fake timers): fires → session aborted, status `"aborted"`, result carries timeout note; completes before deadline → timer cleared, no abort; queued agent → timer starts only when the slot opens; fires during session creation → run fails fast after creation.
- `subagent-session`: `aborted` derived from `opts.signal.aborted` when no turn-limit watcher fired.
- `spawn-config` / `invocation-config` precedence: param > frontmatter > settings default.
- `settings`: sanitize bounds (0–86400), apply + persist round-trip.
- `custom-agents`: frontmatter `timeout` parsed, non-numeric ignored.
