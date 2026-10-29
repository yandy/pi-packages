# pi-subagents

A [pi](https://pi.dev) extension providing a focused, in-process sub-agent core — autonomous agents that run inside the same pi runtime (no spawned subprocesses), plus a typed API and lifecycle events other extensions build on.

## Features

- **In-process & native** — agents share the same pi runtime: same tool names, calling conventions, and UI patterns
- **Parallel background agents** — spawn multiple agents with automatic queuing (configurable concurrency, default 4)
- **Live widget UI** — persistent widget showing animated spinners, live tool activity, token counts, and colored status icons
- **Custom agent types** — define agents in `.pi/agents/<name>.md` with YAML frontmatter: system prompts, model, thinking, tools
- **Mid-run steering** — inject messages into running agents to redirect work without restarting
- **Session resume** — pick up where an agent left off, preserving full conversation context
- **Graceful turn limits** — agents get a "wrap up" warning before hard abort
- **Case-insensitive types** — `"explore"`, `"Explore"`, `"EXPLORE"` all work
- **Fuzzy model selection** — specify models by name (`"haiku"`, `"sonnet"`) instead of full IDs
- **Model tiers** — map `fast` / `standard` / `advanced` to real models in config; the agent is guided to pick the configured model per task
- **Context inheritance** — optionally fork the parent conversation into a sub-agent
- **Styled notifications** — background results render as themed notification boxes
- **Event bus** — lifecycle events (`subagents:created`, `started`, `completed`, `failed`, `steered`, `compacted`) via `pi.events`

## Install

```bash
pi install npm:@yandy0725/pi-subagents
```

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
| `general-purpose` | all | inherit | Harness-rendered prompt for the child's own tool set — same conventions, plus the sub-agent bridge |
| `Explore` | read, bash, grep, find, ls | haiku (fallback: inherit) | Fast codebase exploration (read-only) |

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

Agents are discovered from `.pi/agents/<name>.md` (project) and `~/.pi/agent/agents/<name>.md` (global). Project-level overrides global.

`max_turns` and `timeout` (wall-clock seconds, `0` = unlimited) lock their limits for the agent type: a frontmatter value wins over the per-call parameter.

### Prompt mode

`prompt_mode` decides how the agent body relates to the system prompt of the agent that invokes it:

| Value | Assembled system prompt | Use when |
|-------|------------------------|----------|
| `append` (default) | Harness-rendered prompt for the child's own tool set + `bridge + <active_agent> + environment` + body wrapped in `<agent_instructions>` | The agent should keep the caller's conventions and only add a role on top |
| `replace` | A fixed generic base + `<active_agent>` + environment + your body — the caller's rendered prompt is never reused, but the harness still appends the skills index, the date, and the child's own working directory | The agent needs a self-contained spec: read-only auditors, evaluators, non-coding roles |

`replace` is a clean room on purpose: it does not inherit the caller's rendered prompt (its tool list and tool guidelines), the project context files (`AGENTS.md`), or `SYSTEM.md` / `APPEND_SYSTEM.md`, because those describe a different toolset and role. Anything the agent needs — including house rules such as language or tool preferences — must be restated in its body. Prompt mode never widens or narrows capabilities: only the `tools` allowlist does that.

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
| `resume` | string | no | Agent ID to resume a previous session |
| `inherit_context` | boolean | no | Fork parent conversation into agent |

### `get_subagent_result`

Check status and retrieve results from a background agent.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_id` | string | yes | Agent ID to check |
| `wait` | boolean | no | Wait for completion |
| `verbose` | boolean | no | Include full conversation log |

### `steer_subagent`

Send a steering message to a running agent.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_id` | string | yes | Agent ID to steer |
| `message` | string | yes | Message to inject into agent conversation |

## Model Tiers

Instead of hardcoding model IDs, you can map capability tiers to concrete models in
`subagents.json`. The mapping feeds the `subagent` tool's prompt guidelines, which tell the
agent which model to pass via the `model` parameter — there is no `model_tier` tool
parameter.

| Tier | Intent |
|------|--------|
| `fast` | Cheapest and fastest, least capable (flash / mini / haiku class) |
| `standard` | Balanced default (sonnet class) |
| `advanced` | Most capable, most expensive (opus class) |

The mapping lives in `subagents.json` — `~/.pi/agent/subagents.json` (global) and
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
without a mapping are omitted from the guidelines — nothing is silently substituted for
them. If an agent type pins `model` in its frontmatter, that model always wins.

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

Settings set via `/subagents:settings` persist in `<cwd>/.pi/subagents.json` (project) and can be overridden globally in `~/.pi/agent/subagents.json`. The same files also hold the [`modelTiers`](#model-tiers) mapping; saving other settings preserves it.

| Setting | Meaning |
|---------|---------|
| `maxConcurrent` | Background agents allowed to run at once |
| `defaultMaxTurns` | Default max agentic turns (`0` = unlimited) |
| `defaultTimeoutSeconds` | Default hard wall-clock timeout in seconds (`0` = unlimited, max `86400`) |
| `graceTurns` | Turns allowed after the wrap-up steer |

`defaultMaxTurns` / `defaultTimeoutSeconds` sit at the bottom of the precedence chain: agent frontmatter wins over the per-call parameter, which wins over these defaults.

## Events

Lifecycle events emitted via `pi.events` for other extensions to consume:

| Event | When |
|-------|------|
| `subagents:created` | Background agent registered |
| `subagents:started` | Agent transitions to running |
| `subagents:completed` | Agent finished successfully |
| `subagents:failed` | Agent errored, stopped, or aborted |
| `subagents:steered` | Steering message sent |
| `subagents:compacted` | Agent session compacted |
| `subagents:settings_loaded` | Persisted settings applied |
| `subagents:settings_changed` | Settings mutation applied |

## Development

```bash
npm run typecheck        # tsc --noEmit
npm run lint             # biome lint
npm test                 # vitest run
```

## Acknowledgments

This project is a friendly fork of [@gotgenes/pi-subagents](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-subagents) by [Chris Lasher](https://github.com/gotgenes), which began as a fork of [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents). Thank you to all original authors for their work that made this package possible.

## License

MIT
