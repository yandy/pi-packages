# pi-coding-tools

Pi package enabling `ls`/`find`/`grep` built-in tools.

## Features

- **ls/find/grep**: Enables these built-in tools that are off by default.

## Installation

```bash
pi install npm:@yandy0725/pi-coding-tools
```

## Configuration

Configuration files control which tools are enabled. All default to `true`.

### Global config

`~/.pi/agent/coding-tools.json`:

```json
{
  "ls": true,
  "find": true,
  "grep": true
}
```

### Project config

`<project>/.pi/coding-tools.json` (overrides global):

```json
{
  "grep": false
}
```

### Fields

| Field | Default | Description |
|-------|---------|-------------|
| `ls` | `true` | Enable the `ls` built-in tool |
| `find` | `true` | Enable the `find` built-in tool |
| `grep` | `true` | Enable the `grep` built-in tool |
