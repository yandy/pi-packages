# pi-superpowers Design Spec

## Overview

`pi-superpowers` is a Pure Skills pi package that bundles [Superpowers](https://github.com/obra/superpowers) skills for use with pi. It provides:

1. A maintainer script to download skills from upstream
2. Skills with `superpowers-` name prefix (colons not valid per pi skill name rules)
3. A `/superpowers` prompt-template that forces structured workflow execution

## Package Type

Pure Skills — no runtime code, no extensions.

## Directory Structure

```
pi-superpowers/
├── .gitignore
├── README.md
├── README.zh.md
├── package.json
├── skills.config.json              # Skill list + repo config
├── scripts/
│   └── download-skills.mjs         # Download script (maintainer tool)
├── prompts/
│   └── superpowers.md              # /superpowers slash command
└── skills/
    ├── superpowers-brainstorming/
    │   ├── SKILL.md                # name: superpowers-brainstorming
    │   ├── visual-companion.md
    │   └── scripts/
    │       └── ...
    ├── superpowers-systematic-debugging/
    │   ├── SKILL.md                # name: superpowers-systematic-debugging
    │   ├── root-cause-tracing.md
    │   └── ...
    └── ...                         # One dir per skill in config
```

## Components

### 1. skills.config.json

The single source of truth for which skills to download and where from.

```json
{
  "repo": "https://github.com/obra/superpowers",
  "ref": "main",
  "skills": [
    "brainstorming",
    "dispatching-parallel-agents",
    "executing-plans",
    "finishing-a-development-branch",
    "receiving-code-review",
    "requesting-code-review",
    "subagent-driven-development",
    "systematic-debugging",
    "test-driven-development",
    "using-git-worktrees",
    "using-superpowers",
    "verification-before-completion",
    "writing-plans",
    "writing-skills"
  ]
}
```

Fields:

| Field | Description |
|-------|-------------|
| `repo` | Git remote URL of the Superpowers upstream |
| `ref` | Git ref (branch, tag, or commit hash) to pin |
| `skills` | Array of skill directory names to download |

### 2. scripts/download-skills.mjs

Maintainer-only script. Run via `npm run download-skills`.

#### Behavior

1. **Clone/Pull**: Check `/tmp/pi-superpowers-cache` for existing clone.
   - If exists: `git fetch && git checkout <ref> && git pull`
   - If not: `git clone --branch <ref> <repo> /tmp/pi-superpowers-cache`
2. **Read config**: Parse `skills.config.json` for `skills` list.
3. **Copy skills**: For each skill name in the list:
   - Copy entire directory (`<cache>/skills/<name>/`) to `skills/superpowers-<name>/`
   - In `skills/superpowers-<name>/SKILL.md` YAML frontmatter: `name:` → `name: superpowers-<name>`
   - In `skills/superpowers-<name>/SKILL.md` body text: global regex replace `superpowers:([a-z-]+)` → `superpowers-$1` across all cross-references (upstream uses colon, pi requires hyphen)
   - Preserve all other files as-is (scripts/, references/, markdown docs, etc.)
4. **Clean stale**: Remove any `skills/superpowers-<name>/` directories not in the config.

#### Notes

- Skills are committed to git and shipped in the npm package. The script is NOT a postinstall hook.
- Running the script overwrites local skills with upstream versions. No overlay/patch system.
- The cache directory persists between runs to save bandwidth.

### 3. prompts/superpowers.md

A prompt-template accessible via `/superpowers <task description>` slash command.

#### Content Design

A static file that acts as a **workflow entry point**. When the user runs `/superpowers <task>`, the template expands with the task and instructs the LLM to assess the task type and follow the appropriate Superpowers workflow:

| Task Type | Workflow |
|-----------|----------|
| New feature / creative work | brainstorming → writing-plans → implementation → finishing |
| Bug fix | systematic-debugging → test-driven-development → verification → finishing |
| Code review | receiving-code-review |
| Unknown / ambiguous | default to New Feature workflow |

The template is a **static file** (not auto-generated). It uses `$ARGUMENTS` to receive the user's task and `argument-hint` to show the expected input.

#### Template Structure

```markdown
---
description: Execute the appropriate Superpowers workflow for a task
argument-hint: "<task description>"
---

Assess the task below and follow the corresponding Superpowers workflow.

Task: $ARGUMENTS

## Workflow Selection

Determine the task type and follow the matching workflow. Do NOT skip phases.

### New Feature / Creative Work

1. Load `/skill:superpowers-using-git-worktrees` — create or verify isolated workspace
2. Load `/skill:superpowers-brainstorming` — explore requirements, propose design, get approval
3. Load `/skill:superpowers-writing-plans` — create implementation plan, get approval
4. Load `/skill:superpowers-subagent-driven-development` (or `/skill:superpowers-executing-plans`) — execute plan task-by-task
5. Load `/skill:superpowers-finishing-a-development-branch` — merge, PR, or clean up

### Bug Fix

1. Load `/skill:superpowers-using-git-worktrees` — create or verify isolated workspace
2. Load `/skill:superpowers-systematic-debugging` — find root cause, propose fix
3. Load `/skill:superpowers-test-driven-development` — write failing test, implement fix
4. Load `/skill:superpowers-verification-before-completion` — verify fix works
5. Load `/skill:superpowers-finishing-a-development-branch` — merge, PR, or clean up

### Code Review

1. Load `/skill:superpowers-receiving-code-review` — process review feedback

## Rules

- Each phase completes and gets user approval before the next starts
- Never skip phases, even for "simple" tasks
- If unsure about task type, default to the New Feature workflow
```

### 4. package.json

```jsonc
{
  "name": "@yandy0725/pi-superpowers",
  "version": "0.1.0",
  "description": "Superpowers skills for pi — structured development workflows",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/yandy/pi-packages",
    "directory": "pi-superpowers"
  },
  "type": "module",
  "keywords": ["pi-package", "superpowers", "skills"],
  "publishConfig": { "access": "public" },
  "files": ["skills/", "prompts/"],
  "scripts": {
    "download-skills": "node scripts/download-skills.mjs"
  },
  "pi": {
    "skills": ["./skills"],
    "prompts": ["./prompts"]
  }
}
```

Key points:
- No `devDependencies` (no build/test step for Pure Skills)
- No `extensions` field
- `files` includes `skills/` and `prompts/` but NOT `scripts/` or `skills.config.json`
- `pi.skills` and `pi.prompts` both declared
- Skill names and directories both use `superpowers-` prefix (hyphen), per pi's name rules (only lowercase letters, numbers, hyphens)

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Pure Skills (no code) | No runtime logic needed; only skills + prompt-template |
| `superpowers-` prefix on skill names and directory names | Consistency: dir name matches skill name; `/skill:superpowers-brainstorming`
| Clone entire skill directory | Skills have supporting files (scripts, references, docs) that must travel together |
| Git clone + cache | Saves bandwidth on repeated runs; `ref` pinning ensures reproducibility |
| Manual script (not postinstall) | Script is a maintainer tool; skills are committed and shipped in the package |
| Static prompt-template | `/superpowers <task>` is a fixed workflow entry point, not a generated catalog |
| `repo` + `ref` in config | Enables pinning to specific upstream versions for reproducible builds |

## CI/CD Registration

As a Pure Skills package:

- `.github/workflows/publish.yml`: add `pi-superpowers-v*` case
- `.github/workflows/test.yml`: add `pi-superpowers` to `paths-filter`
- No `vitest.config.ts` entry needed (no tests)
- Root `package.json` `workspaces` array: add `"pi-superpowers"`

## Acceptance Criteria

1. `npm run download-skills` clones upstream, copies skills with `superpowers-` prefix
2. `skills/` contains one directory per skill in config
3. Each SKILL.md has `name: superpowers-<original-name>` in frontmatter
4. `/superpowers <task>` accepts task description and instructs LLM to classify task type and follow the appropriate workflow (New Feature, Bug Fix, or Code Review)
5. `npm publish` (dry-run) includes `skills/` and `prompts/` in tarball
