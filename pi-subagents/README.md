# pi-subagents

A [pi](https://pi.dev) extension providing a focused, in-process sub-agent core — autonomous agents that run inside the same pi runtime (no spawned subprocesses), plus a typed API and lifecycle events other extensions build on.

## Features

- **In-process & native** — agents share the same pi runtime: same tool names, calling conventions, and UI patterns
- **Parallel background agents** — spawn multiple agents with automatic queuing (configurable concurrency, default 4)
- **Live widget UI** — persistent widget showing animated spinners, live tool activity, token counts, USD cost, and colored status icons
- **Parent-session accounting** — child model usage joins the parent footer, `/session`, and `/usage` totals, including background and resumed agents
- **Custom agent types** — define agents in `.pi/agents/<name>.md` with YAML frontmatter: system prompts, model, thinking, tools
- **Mid-run steering** — inject messages into running agents to redirect work without restarting
- **Session resume** — re-prompt the same child session before it is released (10 minutes after the agent finishes), keeping its context
- **Graceful turn limits** — agents get a "wrap up" warning before hard abort
- **Case-insensitive types** — `"explore"`, `"Explore"`, `"EXPLORE"` all work
- **Fuzzy model selection** — specify models by name (`"haiku"`, `"sonnet"`) instead of full IDs
- **Model tiers** — map `fast` / `standard` / `advanced` to real models in config; the agent is guided to pick the configured model per task
- **Context inheritance** — optionally prepend the parent conversation, rendered as text, to the sub-agent's prompt
- **Styled notifications** — background results render as themed notification boxes
- **Event bus** — parent-level and child-session lifecycle events via `pi.events` (see [Events](#events))

## Install

```bash
pi install npm:@yandy0725/pi-subagents
```

Requires pi >= 1.5.0.

## Quick Start

The parent agent spawns sub-agents using the `subagent` tool:

```text
subagent({
  subagent_type: "Explore",
  prompt: "Find all files that handle authentication",
  description: "Find auth files",
  run_in_background: true,
})
```

Foreground agents block until complete. Background agents return an ID immediately and notify on completion.

## Default Agent Types

| Type | Tools | Model | Description |
|------|-------|-------|-------------|
| `general-purpose` | inherit the parent's tools, dispatch tools stripped | inherit | Harness-rendered prompt for the child's own tool set — same conventions, plus the sub-agent bridge |
| `Explore` | read, grep, find, ls | inherit (overridable per call) | Fast codebase exploration (read-only) |

## Custom Agents

Define custom agent types by creating `.md` files in `.pi/agents/<name>.md`:

```markdown
---
description: Security Code Reviewer
tools: read, grep, find, bash
model: anthropic/claude-opus-4-6
thinking: high
max_turns: 30
timeout: 300
---

You are a security auditor. Review code for vulnerabilities...
```

Agents are discovered from `<cwd>/.pi/agents/<name>.md` (project) and `$PI_CODING_AGENT_DIR/agents/<name>.md` (global, default `~/.pi/agent/agents/`). Project-level overrides global; the file name is the agent type name.

### Frontmatter fields

| Field | Value | Default | Meaning |
|-------|-------|---------|---------|
| `description` | string | file name | One-line description shown in the `subagent` tool's type list |
| `display_name` | string | type name | Short name used in the widget, notifications, and results |
| `tools` | CSV / `+name` / `-name` / `none` | inherit parent | Tool set — see below |
| `model` | string | inherit parent | `provider/modelId` or fuzzy name; when pinned, wins over the per-call `model` |
| `thinking` | string | inherit parent | off / minimal / low / medium / high / xhigh |
| `max_turns` | integer | unlimited | Cap for this type; wins over the per-call `max_turns` |
| `timeout` | integer | unlimited | Wall-clock seconds cap (`0` = unlimited); wins over the per-call `timeout` |
| `prompt_mode` | `append` / `replace` | `append` | How the body relates to the base prompt — see the next section |
| `inherit_context` | boolean | unset | Default when a call omits `inherit_context` |
| `run_in_background` | boolean | unset | Default when a call omits `run_in_background` |
| `enabled` | boolean | `true` | `false` keeps the type in the registry but makes it unspawnable and hides it from type lists |

`inherit_context` / `run_in_background` set this type's strategy, and a value written here **locks** it: like `max_turns` and `timeout`, the frontmatter wins over the per-call argument. The built-in agents deliberately omit both so the caller decides; omitted, they default to `false`.

`max_turns` and `timeout` (wall-clock seconds, `0` = unlimited) lock their limits for the agent type: a frontmatter value wins over the per-call parameter.

### The `tools` allowlist

`tools` decides the agent's tool set. There are four spellings:

| Frontmatter | Agent gets |
|-------------|------------|
| field omitted | The parent session's **currently active** tools, minus this package's dispatch tools (`subagent`, `get_subagent_result`, `steer_subagent`) |
| `tools: none`, or `tools:` (empty) | **Zero tools**: the model only produces text and no tool call is accepted |
| `tools: read, grep` | Exactly those tools, by exact name |
| `tools: -edit, -write, +powershell` | The inherited set edited in order (`-name` removes, `+name` adds), then the dispatch tools stripped |

There is no "hand the model every built-in tool" fallback: an omitted field inherits what the parent session has bound at that moment, so a tool the parent hid with `/tools` or `--tools` is not available to the child either.

Every list entry must be an exact tool name — `*` is rejected. Mixing plain names with `+name` / `-name` entries is rejected as well. Both errors name the agent type and are raised before any session is created.

That rule and the new default are breaking for agents written against the previous release: an omitted `tools` used to mean a fixed list of built-in tool names rather than inheritance, and a `*` entry used to be forwarded to the host verbatim, where it silently matched. If an agent relied on the old omitted-field list, state the set, or narrow the inherited one with `-name`.

The dispatch tools of this package are stripped from every form, so a child can never spawn children. An empty list is never treated as "unset" and never falls back to anything.

```markdown
---
tools: -edit, -write, -bash     # read-only research: inherit everything except the writers
---
```

Inheriting keeps the child in step with the parent, at the cost of listing those tools in its prompt; naming a list (or `none`) pins the capability to the agent type.

### Prompt mode

`prompt_mode` decides how the agent body relates to the system prompt of the agent that invokes it:

| Value | Assembled system prompt | Use when |
|-------|------------------------|----------|
| `append` (default) | Harness-rendered prompt for the child's own tool set — which honors `SYSTEM.md` as the base and keeps `APPEND_SYSTEM.md` ahead of our section, and loads `AGENTS.md` — plus `bridge + <active_agent> + environment` + body wrapped in `<agent_instructions>` | The agent should keep the caller's conventions and only add a role on top |
| `replace` | `<active_agent>` + environment + your body, nothing else — the caller's rendered prompt is never reused (an empty body falls back to a minimal, capability-neutral prompt), but the harness still appends the skills index, the date, and the child's own working directory | The agent needs a self-contained spec: read-only auditors, evaluators, non-coding roles |

`replace` is a clean room on purpose: nothing rendered for the caller reaches the agent — not its prompt, tool list or tool guidelines, not the project context files (`AGENTS.md`), not `SYSTEM.md` / `APPEND_SYSTEM.md` — because those describe a different toolset and role. It gets no tool list of its own either: the prompt carries no tool list and no tool guidelines, while the harness still passes the agent's tools to the model directly. That is why prompt mode never widens or narrows capabilities: only the `tools` allowlist does that. Anything the agent needs — including house rules such as language or tool preferences, and tool-usage conventions — must be restated in its body.

`append` is the other side of that line: neither mode inherits the caller's tool list. `append` gets the base prompt the harness renders from the agent's **own** tool set (its own tools and guidelines), then the bridge and your body are appended.

## Tools

### `subagent`

Launch a sub-agent.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | yes | The task for the agent |
| `description` | string | yes | Short 3-5 word summary (shown in UI) |
| `subagent_type` | string | yes | Agent type (built-in or custom) |
| `model` | string | no | Model override (`provider/modelId` or fuzzy name) |
| `thinking` | string | no | off / minimal / low / medium / high / xhigh |
| `max_turns` | number | no | Max agentic turns (unlimited by default) |
| `timeout` | number | no | Hard wall-clock limit in seconds; the agent is killed at the deadline and partial output is returned (unlimited by default) |
| `run_in_background` | boolean | no | Run without blocking |
| `resume` | string | no | Agent ID to resume a previous session (limits in "Session resume" below) |
| `inherit_context` | boolean | no | Prepend the parent conversation, rendered as text, to this prompt (not a fork of the parent branch) |

### `get_subagent_result`

Check status and retrieve results from a background agent.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_id` | string | yes | Agent ID to check |
| `wait` | boolean | no | Wait for completion; only effective while the agent is **running** — a queued agent returns immediately |
| `verbose` | boolean | no | Include full conversation log |

### `steer_subagent`

Send a steering message to a running agent.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_id` | string | yes | Agent ID to steer |
| `message` | string | yes | Message to inject into agent conversation |

## Model Tiers

Instead of hardcoding model IDs, you can map capability tiers to concrete models in
`subagents.json`. The mapping is listed in the `subagent` tool's `model` parameter
description, alongside a prompt guideline telling the agent to pick the configured
tier when a task calls for a specific cost or capability level — there is no
`model_tier` tool parameter.

| Tier | Intent |
|------|--------|
| `fast` | Cheapest and fastest, least capable (flash / mini / haiku class) |
| `standard` | Balanced default (sonnet class) |
| `advanced` | Most capable, most expensive (opus class) |

The mapping lives in `subagents.json` — `$PI_CODING_AGENT_DIR/subagents.json` (global, default `~/.pi/agent/subagents.json`) and
`<cwd>/.pi/subagents.json` (project). The two layers merge **per tier**, so a project can
override one tier without restating the others:

```json
{
  "modelTiers": {
    "fast": "deepseek-flash",
    "standard": "deepseek-flash",
    "advanced": "qwen3.8-max"
  }
}
```

Because the agent copies the mapped value into `model`, it goes through the same resolver as
any other model value: `provider/modelId` and fuzzy names (e.g. `"haiku"`) both work. Tiers
without a mapping are omitted from the description and its guideline — nothing is silently
substituted for them. If an agent type pins `model` in its frontmatter, that model always wins.

## Commands

| Command | Description |
|---------|-------------|
| `/subagents:settings` | Configure concurrency, turn limits, timeouts |
| `/subagents:sessions` | View a subagent's session transcript |

The session viewer renders the transcript read-only with Pi's own per-entry
components and follows the running agent live. Tool results appear in Pi's
collapsed form (summaries and previews), so a `read` call is represented by its
call line only. The viewer has no expand key, so the "… to expand" hints some
tools print do not apply here.

The viewer follows the live tail: the newest lines stay pinned to the bottom until you scroll up.
Upward keys (`↑`/`k`, `PgUp`/`shift+up`, `Home`) **unconditionally** pause following — streaming can
add lines between a keypress and the render, so a "was I at the bottom?" test against that stale
value would snap a viewport you just left back down. A downward key that lands on the bottom
(`↓`/`j`, `PgDn`/`shift+down`) resumes following, and `end` jumps to the bottom and force-resumes;
`q`/`Esc` closes. The paused state has **no visual indicator** (the footer keeps showing
`<n> lines · <pct>%` and the key hints).

## Concurrency

Background agents are subject to a configurable concurrency limit (default: 4). Excess agents queue automatically. Foreground agents bypass the queue.

## Persistent Settings

Settings set via `/subagents:settings` persist in `<cwd>/.pi/subagents.json` (project) and can be overridden globally in `$PI_CODING_AGENT_DIR/subagents.json` (default `~/.pi/agent/subagents.json`). The same files also hold the [`modelTiers`](#model-tiers) mapping; saving other settings preserves it.

| Setting | Meaning |
|---------|---------|
| `maxConcurrent` | Background agents allowed to run at once |
| `defaultMaxTurns` | Default max agentic turns (`0` = unlimited) |
| `defaultTimeoutSeconds` | Default hard wall-clock timeout in seconds (`0` = unlimited; the settings file requires an integer in `0`–`86400`, out-of-range values are dropped) |
| `graceTurns` | Turns allowed after the wrap-up steer |

`defaultMaxTurns` / `defaultTimeoutSeconds` sit at the bottom of the precedence chain: agent frontmatter wins over the per-call parameter, which wins over these defaults.

The `86400` ceiling only constrains the **settings file** (`sanitize` drops non-integers or values outside `0`–`86400`). The per-call `timeout` parameter only requires ≥ 1 and frontmatter only a non-negative integer; neither is capped.

## Events

Two levels of events are emitted via `pi.events` for other extensions to consume.

Agent-level events (state changes of one agent run):

| Event | When | Scope |
|-------|------|-------|
| `subagents:created` | Agent registered | **Background only** (before queue admission) |
| `subagents:started` | Agent transitions to running (including out of the queue) | Background and foreground |
| `subagents:completed` | Agent finished successfully | **Background only** |
| `subagents:failed` | Agent errored, stopped, or aborted (also when aborting a queued agent) | **Background only** |
| `subagents:steered` | Steering message sent | Running agents, foreground or background |
| `subagents:compacted` | Agent session compacted | Background and foreground |
| `subagents:settings_loaded` | Persisted settings applied | Once at extension load |
| `subagents:settings_changed` | Settings mutation applied | Every settings write |

Foreground runs never emit `completed` / `failed`: the `subagent` tool returns their result directly.
Use a background agent when you need completion events.

Child-session events (the child session itself being created and torn down — not the same thing as a run):

| Event | When |
|-------|------|
| `subagents:child:spawning` | A child run starts, before its session exists |
| `subagents:child:session-created` | Child session created, immediately before extension binding (payload carries `sessionId`; subscribers must register synchronously) |
| `subagents:child:completed` | The child prompt resolved (normal, steered to wrap up, or hard-aborted) |
| `subagents:child:disposed` | The child session record is torn down (eviction sweep, session switch, extension shutdown, bind failure) — **not** emitted at the end of every run |

## Session resume

`resume` can only continue a session that is **still alive in memory**: once the record is cleaned up (see below)
the call returns not found, and an agent whose session was never created returns no active session. Resuming just
re-prompts the same session, so these parameters have **no effect** on that call: `model`, `thinking`,
`max_turns`, `timeout`, `inherit_context` (the session was created with the original configuration). Resume also has
no turn or wall-clock guard — only the parent's abort signal applies.

## Transcripts and cleanup

A child transcript lives inside the parent session directory:
`<parent session dir>/<parent file name without .jsonl>/tasks/`. When the parent session is not persisted
(headless / API mode) it falls back to `$TMPDIR/pi-subagents-<uid>/<encoded cwd>/tasks/`.

10 minutes after an agent finishes it is cleaned up: the session is disposed (emitting `subagents:child:disposed`).
Only sessions that reached disk leave a navigable record behind for `/subagents:sessions` to re-read.

## Execution constraints for children

- Children cannot spawn grandchildren: `subagent` / `get_subagent_result` / `steer_subagent` are removed from the active
  tool set at bind time, including when another extension registered them.
- Children always run in the parent session's cwd; the `subagent` tool has no `cwd` parameter.

## Cross-extension API

Other extensions can drive the sub-agent core without the tools (the package exports an entry point):

```ts
const { getSubagentsService } = await import("@yandy0725/pi-subagents");
const svc = getSubagentsService();
const id = svc?.spawn("Explore", "Check for stale TODOs", { description: "Find stale TODOs", foreground: true });
```

| Method | Description |
|--------|-------------|
| `spawn(type, prompt, options?)` | Start an agent and return its ID immediately (throws outside a session) |
| `getRecord(id)` | Serializable snapshot of current state (no live session objects) |
| `listAgents()` | All tracked agents, most recent first |
| `abort(id)` | Abort a running or queued agent |
| `steer(id, message)` | Send a steering message to a running agent |
| `waitForAll()` | Wait for all running and queued agents to complete |
| `hasRunning()` | Whether any agents are running or queued |

`SpawnOptions`: `description`, `model`, `maxTurns`, `timeoutSeconds` (`0`/omitted = unlimited, normalized at the API
boundary), `thinkingLevel`, `inheritContext`, `foreground`, `bypassQueue`. The two queue-related options differ:
`bypassQueue` only skips the concurrency limiter, while `foreground` also means "not background" (no
`created` / `completed` / `failed` events and no completion notification). `spawn` still returns the ID immediately
in both cases; read results through `getRecord`.

## Development

```bash
npm run typecheck        # tsc --noEmit
npm run lint             # biome lint
npm test                 # vitest run
```

## Acknowledgments

This project is a friendly fork of [@gotgenes/pi-subagents](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-subagents) by [Chris Lasher](https://github.com/gotgenes), which began as a fork of [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents). Thank you to all original authors for their work that made this package possible.

## UI surface

Both slash commands and the running-agents widget call host UI primitives directly. The widget registers a **component factory**, which only TUI mode accepts; the commands use dialogs, which RPC forwards but the client may ignore:

| Method | Guard | Outside TUI (RPC / headless) |
|---|---|---|
| `setWidget(factory)` (running / finished agents widget) | none | RPC drops component factories silently, so the widget never appears. print / json have no UI at all |
| `setStatus` (agents summary line) | none | Forwarded fire-and-forget; may be dropped |
| `select` / `input` / `notify` (`/subagents:settings`) | none | Forwarded; no `timeout` is passed, so an unresponsive client keeps the command pending. print / json get no-op dialogs, so the menu exits silently |
| `select` (`/subagents:sessions`) | none | Forwarded; no timeout |
| `custom` (transcript overlay) | none | RPC returns `undefined` immediately: picking a session shows nothing. Same in print / json |

## License

MIT
