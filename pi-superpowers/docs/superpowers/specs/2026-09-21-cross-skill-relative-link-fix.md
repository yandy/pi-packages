# Design: Cross-Skill Relative Paths & Bundling `writing-skills`

## 1. Bundling `writing-skills`

### Problem

`skills/test-driven-development/writing-good-tests.md` (Principle 1, "Behavior, not text") contains an
advisory pointer to `superpowers:writing-skills`:

> Documents that instruct agents are tested by the consuming agent's behavior (superpowers:writing-skills);
> prose for humans earns no test at all.

The transform rewrites it to `supo-writing-skills`, but that skill was never tracked (removed when the
package was scaffolded), so the reference dangled. The pointer documents the technique of testing
agent-facing documents by observing the consuming agent's behavior — the methodology that lives in
`writing-skills`.

### Solution

Add `"writing-skills"` to `skills.config.json`. Nothing else is required: the reference is plain text with
no functional dependency, and the skill is self-contained (SKILL.md + `testing-skills-with-subagents.md`,
`anthropic-best-practices.md`, `persuasion-principles.md`, `examples/CLAUDE_MD_TESTING.md`,
`graphviz-conventions.dot`, `render-graphs.js`). `render-graphs.js` uses only node builtins plus a system
`graphviz` binary — no npm dependencies.

## 2. Cross-Skill Relative Paths Were Not Rewritten

### Problem

The transform prefixes every skill directory with `supo-`, but only rewrote the colon form
`superpowers:<skill>`. Relative paths of the form `../<skill>/...` were left pointing at directories that
no longer exist. Every such reference was broken:

| Location | Reference | Status |
|----------|-----------|--------|
| `subagent-driven-development/SKILL.md` (link, dot labels) | `../requesting-code-review/code-reviewer.md` | broken since v6.2.0 (shipped in v0.4.0) |
| `executing-plans/SKILL.md` (link, inline code, command) | `../requesting-code-review/`, `../subagent-driven-development/scripts/*`, `../using-superpowers/references/` | introduced by the v6.4.1 upgrade |
| `writing-skills/SKILL.md` (links) | `../using-superpowers/references/{codex,gemini}-tools.md` | would be introduced by adding the skill |
| `writing-skills/render-graphs.js` (usage hint) | `../subagent-driven-development` | idem |
| `executing-plans/scripts/task-start`, `task-done` (**hard-coded path resolution**) | `$(dirname "$0")/../../subagent-driven-development/scripts` | broken since the v6.4.1 upgrade (shipped in v6.4.1) |

Two references are executable commands the agent is told to run
(`../subagent-driven-development/scripts/sdd-workspace`, `.../review-package`), so the dangling path
affected behavior, not just navigation. Worse, `executing-plans/scripts/task-start` and `task-done`
resolve their helper directory at runtime as
`sdd="$(cd "$(dirname "$0")/../../subagent-driven-development/scripts" && pwd)"`; with `set -euo pipefail`
the missing directory made both scripts fail outright (`exit 127`), so inline plan execution could not
start. Rewriting these paths is what restores them.

### Solution

Extend the transform in `scripts/download-skills.mjs`:

1. **Scan every text file**, not just `.md` — `TEXT_FILE_EXTENSIONS = {"", .md, .js, .cjs, .ts, .sh, .dot, .html}`
   (`""` covers extensionless scripts such as `sdd-workspace`, `task-brief`, `task-start`, `task-done`).
   Directories are excluded via `statSync(...).isFile()`, since `extname()` also returns `""` for them.
2. **Rewrite `../<skill>` → `../supo-<skill>`**, driven by the same `skills` list as the rest of the
   transform. The pattern asserts a path boundary after the name
   (`(?![a-zA-Z0-9._-])`) so it matches both `../<skill>/file` and a bare `../<skill>`, without
   rewriting longer names or non-path text. The upstream placeholder `../some-skill` (an argument
   placeholder, not a tracked skill) is left untouched by construction.
3. Frontmatter `name:` rewriting and the `superpowers:` colon rewrite remain `.md`-only.

`.md` content, including `dot` flowchart labels, is rewritten too, so diagrams stay consistent.

## Scope

- `skills.config.json`: add `writing-skills` (14 → 15 skills)
- `scripts/download-skills.mjs`: text-file scan + cross-skill relative path rewrite
- `README.md`, `README.zh.md`: document `supo-writing-skills`
- `skills/`: regenerated from upstream v6.4.1

## Notes / Known Limitations

- **`.skills-ref` early exit**: the script skips the transform when `.skills-ref` already equals `config.ref`
  and every configured skill exists. Changing transform logic therefore requires deleting `.skills-ref`
  first, otherwise the run silently reports "no changes needed". This is pre-existing behavior, unchanged here.
- **Content-level pi adaptation** is out of scope by design (no overlay/patch system): e.g.
  `writing-skills/SKILL.md` states that personal skills live in `~/.claude/skills/` and links only the
  codex/gemini reference docs, not pi's `references/pi-tools.md`. The pi mapping lives in
  `supo-using-superpowers/references/pi-tools.md` and is surfaced by that skill's Platform Adaptation section.
- **Upstream paths are not parameterized**: the rewrite only handles `../<skill>` (siblings). Paths such as
  `../../<skill>` or absolute paths do not currently occur upstream; they would need the same treatment if
  they appear.
