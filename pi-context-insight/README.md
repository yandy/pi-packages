# pi-context-insight

Generate a standalone, offline HTML insight report for the current Pi session: what the model saw at every request, how the context grew, which tools/files/commands ran, and what each delegated agent did.

## Features

- **One command, one self-contained file** — `/insight` writes a single HTML with inline CSS, JS and JSON; no external resources, model call, or network access
- **Per-request reconstruction** — every assistant message is replayed to the prompt the model received (system sections, tool schemas, messages, tool results), with deltas against the previous request
- **Context browser** — drill from the summary bar into any request and expand each item to its actual text, JSON schema or tool output; DNA (read-order) list included
- **Timeline with milestone flags** — stacked per-step bars in total or delta mode, step/turn granularity, compaction/edit/model/skill/delegation flags, and the single longest and biggest-growth step
- **Token, timing and occupancy cards** — 16-category split with cache-hit and billed totals, model/tool/overhead time with idle removed, window occupancy with compaction reserve
- **Activity** — tool outcomes with source attribution, file operations with estimated line deltas, command executions with status, exit code and program distribution
- **Agent family** — nested delegation records, per-member cards and compact child reports, without double counting forwarded usage
- **Two modes** — the default report embeds raw content; `--short` carries the same structure with no text bodies at all
- **English or Chinese UI**, chosen when the report is generated and switchable in the page

## Install

```bash
pi install npm:@yandy0725/pi-context-insight
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["@yandy0725/pi-context-insight"]
}
```

Requires pi >= 1.5.0.

## Command

```text
/insight                                  # full report, default filename
/insight --short                          # no raw text anywhere in the file
/insight --lang zh                        # Chinese UI (default: LANG/LC_ALL, else en)
/insight --short --lang zh out/report.html
```

Without a path the command writes `pi-insight-<session-file-basename>.html` in the current working directory (in-memory sessions use the session id). A custom path is resolved against the working directory, overwritten if it exists, and parent directories are not created. The browser is never opened automatically. Unknown or duplicated options are rejected with a usage message.

An empty session (no user or assistant message yet) is refused with `Nothing to report yet - start a conversation first`, matching `/export`.

## Report contents

| Section | What it shows |
|---|---|
| Overview | Session metadata, six KPIs (tokens, cost, cache hit, calls, active time, subagents), per-model ledger and usage rows |
| Tokens | Donut plus 16 category rows: six system-prompt sections, tool definitions, user, injected, skill injections, compaction, thinking, answers, tool calls, tool results, and an "unrecorded at request time" residual |
| Timing | Model / tool / overhead ring, wall clock, idle excluded, tokens-per-second badge and a per-step active-time strip |
| Current context | Occupancy against the window, category bar, compaction reserve and max-output reserve, compaction trigger line |
| Timeline | One stacked bar per request; total/delta, step/turn, adaptive, duration curve, overview ribbon, DNA mode, milestone flags |
| Request detail | User / In / Response chips for the selected or hovered step, plus actual prompt, output and cache hit |
| Browser | Step selector, category rows with count, tokens, share and signed delta, expandable items with bodies, tool source chips, DNA list |
| Events | Compaction, context edit, branch summary, model/thinking switch, skill, injection, delegation, child completion, ask, todo |
| Activity | Tools (with source and per-step distribution), files (read/write/search/image, line deltas, operation log), commands (status, exit code, duration, program tally) |
| Agents | Family cards, delegation table with brief and final result, compact child reports |
| Notes | Estimation rules, aggregation scope, the truncation list applied to this report, and the privacy reminder |

## Data semantics

### Scope

Usage, activity and events aggregate **every session entry** (including compacted history and other branches). The current composition and the per-step rebuild follow the **active branch** only.

### Estimated versus actual

- Estimates use the host's own density heuristic (`@earendil-works/pi-ai/utils/estimate`), so category values agree with the context ring in the pi UI.
- Actual values come from provider usage: prompt is `input + cacheRead + cacheWrite`, cache hit is `cacheRead / prompt`.
- Extension content injected at request time (for example through the `context` hook) is not persisted, so the estimated total can be lower than the actual prompt. The difference is shown as its own residual row when it exceeds 2% of the estimate.
- Cost is `usage.cost.total`; per-category cost is an allocation by token share and is labelled as an estimate. `provider`, `estimate` and `mixed` bases are labelled.
- Durations prefer `durationMs`; values derived from timestamp gaps carry `≈`. Gaps of 120 s or more and `ask_user` wait time are excluded from active time.

### Parent and child accounting

The headline ledger is the parent session's, which already includes forwarded child usage. Each child report is computed from its own transcript and is **never added again**. Delegation records without a completion record are shown as `untracked` — running, foreground, finished without a record, or interrupted; the report does not guess.

### Limits

Timeline keeps up to 4000 steps; per-step detail is materialised for the last 300 steps plus any step carrying an event; each category renders 200 rows per step; bodies are clipped at 8000 characters (4000 for tool results, 2000 for commands); the payload is capped at 16 MB with progressive degradation. Every truncation that fired is listed in the report's notes.

## Privacy

The default report **contains raw prompts, tool output, command output and file content previews**: review it before sharing. `--short` carries no raw text at all — bodies are never written into the file, so there is nothing to hide in the source.

The page is fully offline: a restrictive CSP, no external requests, no `eval`, and all session text is escaped at generation time.

## UI surface

| Method | Guard | Outside TUI (RPC / headless) |
|---|---|---|
| `notify` | none | Fire-and-forget; RPC clients may forward or drop it, and print/JSON modes produce no notification. HTML generation succeeds independently of notification delivery |

## License

MIT — the repository root LICENSE covers this package.
