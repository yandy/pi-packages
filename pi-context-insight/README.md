# pi-context-insight

Generate a standalone, offline HTML insight report for the current Pi session. The report explains what the active context contains, how recorded usage evolved, which tools/files/commands were active, and what each discovered child agent did.

## Features

- **One command, one file** — `/insight` writes HTML with inline CSS and SVG; no JavaScript, external resources, model call, or network access
- **Session and model accounting** — prompt/output/cache tokens, cost, cache-hit rate, per-model totals, and a recorded-usage timeline
- **Current context composition** — system prompt, tool definitions, user/injected/compacted content, reasoning, answers, tool calls, and tool results
- **Activity analysis** — tool outcomes and durations, file operations and estimated line changes, command status and exit codes
- **Context events and timing** — compaction, context edits, branch summaries, model/thinking changes, wall time, and cumulative model/tool time
- **Child-agent reports** — independently analyzed child sessions with metadata, usage, context, timeline, activity, and events
- **Defensive output** — escaped content, a restrictive CSP, no raw prompt/reply/tool-result/command-output bodies, and bounded detail rows

## Install

```bash
pi install npm:@yandy0725/pi-context-insight
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:@yandy0725/pi-context-insight"]
}
```

Requires pi >= 1.5.0.

## Command

```text
/insight
/insight path/to/report.html
```

Without an argument, the command writes `pi-insight-<session-file-basename>.html` in the current working directory. An in-memory session uses `pi-insight-<session-id>.html`.

A custom path is resolved against the current working directory. The target is overwritten if it already exists, matching `/export`; parent directories are not created and the browser is not opened automatically.

## Report contents

| Section | What it shows |
|---|---|
| Overview | Session metadata, model, working directory, token/cost/cache KPIs, and warnings |
| Usage ledger | Session total, parent-direct and forwarded-child split, per-model totals, and individual usage records |
| Current context | Host context-window usage plus an estimated composition bar and category table |
| Recorded usage timeline | Stacked uncached-input/cache-write/cache-read/output bars, context-event markers, and timing summaries |
| Subagents | A collapsible full report for every safely discovered child session |
| Tools | Calls by tool and scope, success/error/missing/unfinished counts, and execution durations |
| Files | Read/write/edit/search activity and argument-based added/removed-line estimates |
| Commands | Shell command text, status, exit code, and duration without stdout/stderr |
| Context events | Compaction, branch summaries, context edits, model changes, thinking changes, and child completion records |
| Data notes | Accounting boundaries and the privacy review reminder |

Aggregates include all records. Each activity/event detail list renders at most 200 rows and reports the omitted count. Command text is clipped to 1000 characters including the ellipsis.

## Data semantics

### All history versus current context

Usage, tool/file/command activity, events, and timing aggregate **all session entries**, including compacted history and other branches. Current composition uses only the **active projection** after compaction and context edits.

### Recorded versus estimated values

- Timeline and ledger values come from recorded provider/usage entries. Prompt tokens are `input + cacheRead + cacheWrite`; total tokens are prompt plus output.
- Current composition is estimated from projected content. It is not rescaled to match provider totals, and unknown tool definitions are shown as `—`, never as zero.
- Host context usage is shown separately because provider serialization, caching, and trailing estimates can make its total differ from the composition estimate.
- Cost uses the recorded `usage.cost.total`; provider-reported, catalog-estimated, and mixed totals are labeled.
- Line changes are estimated from write/edit arguments, not from a fresh filesystem diff.

### Parent and child accounting

The headline total uses the parent session ledger, which already includes forwarded child usage. `Parent direct` excludes `kind: "subagent"` entries; `Subagents forwarded` contains only those entries.

Each child report is computed from its own JSONL session and is **not added back** to the headline total. Auxiliary usage can make a child ledger differ from the forwarded subset.

Child discovery combines completion records with standard `tasks/` session directories. Fork ancestry, realpath containment, JSONL suffixes, and child-header parent identity are checked before loading. Missing or invalid children produce warnings without blocking the parent report.

A child marked `untracked` has no completion record. It may be running, foreground, completed without a record, or interrupted; the report does not guess which.

## Privacy

The HTML does not include raw prompts, assistant replies, tool results, or command output. It can still contain working directories, file paths, command text, model names, and child descriptions. **Review the report before sharing it.**

## UI surface

| Method | Guard | Outside TUI (RPC / headless) |
|---|---|---|
| `notify` | none | Fire-and-forget; RPC clients may forward or drop it, and print/JSON modes produce no notification. HTML generation succeeds independently of notification delivery |

## License

MIT — the repository root LICENSE covers this package.
