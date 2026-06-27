# pi-permission-system

Permission enforcement extension for the [Pi](https://pi.dev) coding agent. Provides centralized, deterministic permission gates over tool, bash, MCP, skill, and special operations.

## Features

- **allow / ask / deny** at tool-call time with UI confirmation dialogs
- **Hides disallowed tools** before the agent starts — no wasted turns probing for blocked tools
- **Bash command control** with wildcard pattern matching (`git *: ask`, `rm -rf *: deny`)
- **MCP and skill access gating** at server, tool, and skill-name granularity
- **Cross-cutting `path` rules** — deny `.env`, `~/.ssh/*` across all tools and bash at once, with symlink-resolved matching
- **External directory guard** — prompts before file tools or bash reach outside the working tree
- **Fails closed** — internal gate error blocks the tool; unparseable bash commands prompt instead of passing silently
- **Subagent `ask` forwarding** — `ask` policies work in child sessions via parent UI
- **Native `@yandy0725/pi-subagents` integration** — in-process child sessions register automatically

## Install

```bash
pi install npm:@yandy0725/pi-permission-system
```

## Quick Start

1. Create the global config at `~/.pi/agent/extensions/pi-permission-system/config.json`:

```jsonc
{
  "permission": {
    "*": "allow",
    "path": {
      "*": "allow",
      "*.env": "deny",
      "*.env.*": "deny",
      "*.env.example": "allow"
    },
    "bash": {
      "*": "ask",
      "rm -rf *": "deny",
      "sudo *": "ask"
    },
    "external_directory": "ask"
  }
}
```

2. Start Pi — the extension automatically loads and enforces your policy.

## Permission States

| State | Behavior |
|-------|----------|
| `allow` | Permits the action silently |
| `deny` | Blocks the action with an error message |
| `ask` | Prompts the user for confirmation via UI |

When the dialog prompts, you can approve once or approve a pattern for the rest of the session.

## Configuration

Config lives in one JSON file per scope:

| Scope | Path |
|-------|------|
| Global | `~/.pi/agent/extensions/pi-permission-system/config.json` |
| Project | `<cwd>/.pi/extensions/pi-permission-system/config.json` |

Project overrides global. Four layers compose with most-restrictive-wins: `path` → `external_directory` → per-tool patterns → `bash` command patterns.

The `path` surface applies to **all** file access — tools, bash, MCP, and extensions alike — making it the right place for sensitive file patterns like `.env` or `~/.ssh/*`. It matches both the path as referenced and its symlink-resolved form.

The `external_directory` surface decides whether reaching outside the working tree is allowed:

```jsonc
{
  "permission": {
    "external_directory": {
      "*": "ask",
      "~/.cargo/registry/*": "allow"
    }
  }
}
```

## Development

```bash
npm run typecheck        # tsc --noEmit
npm run check            # biome check
npm test                 # vitest run
```

## Acknowledgments

This project is a friendly fork of [@gotgenes/pi-permission-system](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system) by [Chris Lasher](https://github.com/gotgenes), which began as a fork of [MasuRii/pi-permission-system](https://github.com/MasuRii/pi-permission-system). Thank you to all original authors for their work that made this package possible.

## License

MIT
