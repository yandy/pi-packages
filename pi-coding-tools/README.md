# pi-coding-tools

Pi package providing the `apply_patch` tool and enabling `ls`/`find`/`grep` built-in tools.

## Features

- **apply_patch**: Apply Codex-style patches to files (add/update/delete/move) using a freeform grammar — no JSON wrapping needed.
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
  "applyPatch": true,
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
| `applyPatch` | `true` | Register the `apply_patch` tool |
| `ls` | `true` | Enable the `ls` built-in tool |
| `find` | `true` | Enable the `find` built-in tool |
| `grep` | `true` | Enable the `grep` built-in tool |

## Patch Format

The `apply_patch` tool uses Codex text format:

```
*** Begin Patch
*** Add File: new.txt
+Hello, World!
*** Update File: existing.ts
@@ function foo() {
-old line
+new line
*** Delete File: old.txt
*** End Patch
```

See the [Codex apply_patch documentation](https://github.com/code-yeongyu/pi-apply-patch) for full syntax details.
