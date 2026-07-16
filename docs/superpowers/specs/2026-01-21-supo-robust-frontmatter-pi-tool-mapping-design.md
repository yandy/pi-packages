# Design: Robust Frontmatter Parsing & Pi Tool Mapping

## 1. Robust Frontmatter `name` Replacement

### Problem

`scripts/download-skills.mjs` line 52 uses a naive regex to replace the `name` field in SKILL.md frontmatter:

```js
content = content.replace(/^name:\s*(.+)$/m, `name: supo-${name}`);
```

This regex matches any line starting with `name:`, regardless of whether it's inside the YAML frontmatter block (`---` delimiters) or in the body text. In practice this is unlikely to cause issues today, but it's fragile and could silently corrupt content if `name:` appears in markdown body text.

### Solution

Parse the `---` delimiters explicitly, and only apply the replacement inside the frontmatter block:

```js
const parts = content.split('---');
if (parts.length >= 3) {
  parts[1] = parts[1].replace(/^name:\s*(.+)$/m, `name: supo-${name}`);
  content = parts.join('---');
}
```

- `parts[0]` is empty (content before first `---`)
- `parts[1]` is the frontmatter body
- `parts[2..]` is everything after the closing `---`
- Only `parts[1]` gets the `name:` replacement
- No new dependencies required

### Edge Cases

- **No frontmatter:** `parts.length < 3` → skip replacement silently (shouldn't happen for SKILL.md files but safe)
- **`---` in body text:** Only the first two `---` are consumed; any further `---` in body are preserved in `parts[2..]`
- **Frontmatter with no `name:` line:** Regex simply won't match, content unchanged

## 2. Pi Tool Mapping Section in `supo.md`

### Problem

The Superpowers prompt references Claude Code-specific concepts (e.g., `Skill` tool, `Task`, `TodoWrite`) that don't exist in Pi. Agents need guidance on how to map Superpowers instructions to Pi-native tools.

### Solution

Append a `## Pi tool mapping` section to `prompts/supo.md` explaining:

- Skills: use `read` to load SKILL.md, or let human invoke `/skill:name`
- Coding tools: `read`, `write`, `edit`, `bash`, plus optional `grep`, `find`, `ls`
- Subagents: use `subagent` from `pi-subagents` if available, otherwise explain the gap
- Task tracking: use installed todo/task tool if available, otherwise use plan files or `TODO.md`

### Content

```
## Pi tool mapping

Pi has native skills but does not expose Claude Code's `Skill` tool. When a Superpowers instruction says to invoke a skill, use Pi's native skill system instead: load the relevant `SKILL.md` with `read` when the skill applies, or let a human invoke `/skill:name` explicitly.

Pi's built-in coding tools are lowercase: `read`, `write`, `edit`, `bash`, plus optional `grep`, `find`, and `ls`. Use those for the corresponding actions: read a file, create or edit files, run shell commands, search file contents, find files by name, and list directories.

Pi does not ship a standard subagent tool. If a subagent tool such as `subagent` from `pi-subagents` is available, use it for Superpowers subagent workflows. If no subagent tool is available, do the work in this session or explain the missing capability instead of inventing `Task` calls.

Pi does not ship a standard task-list tool. If an installed todo/task tool is available, use it. Otherwise track work in plan files or a repo-local `TODO.md` when task tracking is needed. Treat older `TodoWrite` references as this task-tracking action.
```

## Scope

Two files changed:
- `pi-superpowers/scripts/download-skills.mjs`: one line replaced with a small block
- `pi-superpowers/prompts/supo.md`: one section appended at end

No dependencies, no tests affected.
