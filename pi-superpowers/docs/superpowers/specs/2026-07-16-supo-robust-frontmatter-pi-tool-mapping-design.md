# Design: Robust Frontmatter Parsing & Companion Package Docs

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

## 2. Pi Tool Mapping in `supo.md`

### Problem

Superpowers instructions reference Claude Code-specific concepts (e.g., `Skill` tool, `Task`, `TodoWrite`) that don't exist in Pi. Agents need guidance on how to map Superpowers actions to Pi-native tools.

### Solution

Append a `## Pi Tool Mapping` section to `prompts/supo.md`:

```markdown
## Pi Tool Mapping

Skills speak in actions ("dispatch a subagent", "create a todo", "read a file"). On Pi these resolve to the tools below.

| Action skills request | Pi equivalent |
| --- | --- |
| Dispatch a subagent (`Subagent (general-purpose):` template) | Use an installed subagent tool such as `subagent` from `pi-subagents` if available |
| Task tracking ("create a todo", "mark complete") | Use an installed todo/task tool if available, otherwise track tasks in the plan or `TODO.md` |
```

## 3. Companion Package Install Instructions

### Problem

Superpowers workflows dispatch subagents (`pi-subagents`) and track tasks (`pi-todo`), but users may not know these companion packages are needed for full functionality.

### Solution

Add a "Companion Packages" section to both README files, after the Installation section:

**README.md:**
```markdown
## Companion Packages

Superpowers workflows may dispatch subagents or track tasks. For full functionality, install:

```bash
pi install npm:@yandy0725/pi-subagents
pi install npm:@yandy0725/pi-todo
```
```

**README.zh.md:**
```markdown
## 配套包

Superpowers 工作流可能会分派子代理或跟踪任务。如需完整功能，请安装：

```bash
pi install npm:@yandy0725/pi-subagents
pi install npm:@yandy0725/pi-todo
```
```

## Scope

Four files changed:
- `pi-superpowers/scripts/download-skills.mjs`: one line replaced with a small block
- `pi-superpowers/prompts/supo.md`: append Pi Tool Mapping section
- `pi-superpowers/README.md`: add Companion Packages section
- `pi-superpowers/README.zh.md`: add 配套包 section

No dependencies, no tests affected.
