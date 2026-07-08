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
| `general-purpose` | all | inherit | Full parent system prompt — same rules, same conventions |
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
---

You are a security auditor. Review code for vulnerabilities...
```

Agents are discovered from `.pi/agents/<name>.md` (project) and `~/.pi/agent/agents/<name>.md` (global). Project-level overrides global.

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

## Commands

| Command | Description |
|---------|-------------|
| `/subagents:settings` | Configure concurrency, turn limits |
| `/subagents:sessions` | View a subagent's session transcript |

## Concurrency

Background agents are subject to a configurable concurrency limit (default: 4). Excess agents queue automatically. Foreground agents bypass the queue.

## Persistent Settings

Settings set via `/subagents:settings` persist in `<cwd>/.pi/subagents.json` (project) and can be overridden globally in `~/.pi/agent/subagents.json`.

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

## Permission System Integration

When `@yandy0725/pi-permission-system` is installed, the package integrates automatically:
- Per-agent permission policies via YAML frontmatter
- Tool filtering before agent start
- `ask`-state forwarding from child to parent UI

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
