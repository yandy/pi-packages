# Design: Robust Frontmatter Parsing & Peer Dependencies

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

- **No frontmatter:** `parts.length < 3` → skip replacement silently
- **`---` in body text:** Only the first two `---` are consumed; further `---` preserved
- **Frontmatter with no `name:` line:** Regex simply won't match, content unchanged

## 2. Peer Dependencies

### Problem

Superpowers workflows reference subagent and todo/task tracking capabilities. Pi provides these via separate packages (`pi-subagents`, `pi-todo`). Declaring them as peer dependencies signals to consumers that these packages are expected to be available for full Superpowers functionality.

### Solution

Add `peerDependencies` to `pi-superpowers/package.json`:

```json
"peerDependencies": {
  "@yandy0725/pi-subagents": "*",
  "@yandy0725/pi-todo": "*"
}
```

`"*"` version range means any version is accepted — these are optional companion packages and version coupling is not required.

## Scope

Two files changed:
- `pi-superpowers/scripts/download-skills.mjs`: one line replaced with a small block
- `pi-superpowers/package.json`: add `peerDependencies` field

No code dependencies, no tests affected.
