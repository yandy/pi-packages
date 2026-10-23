# pi-superpowers

Superpowers skills for pi — structured development workflows for building software.

## Installation

```bash
pi install npm:@yandy0725/pi-superpowers
```

## Companion Packages

Superpowers workflows may dispatch subagents or track tasks. For full functionality, install:

```bash
pi install npm:@yandy0725/pi-subagents
pi install npm:@yandy0725/pi-todo
```

## Skills

This package bundles the following skills from [Superpowers](https://github.com/obra/superpowers), each prefixed with `supo-`:

| Skill | Description |
|-------|-------------|
| `/skill:supo-brainstorming` | Explore user intent, requirements and design before implementation |
| `/skill:supo-systematic-debugging` | Systematic debugging process for finding root causes |
| `/skill:supo-writing-plans` | Write lean implementation plans from specs |
| `/skill:supo-test-driven-development` | Test-first development workflow |
| `/skill:supo-using-git-worktrees` | Isolated workspace creation via git worktrees |
| `/skill:supo-verification-before-completion` | Verify work before claiming completion |
| `/skill:supo-diagnosing-superpowers` | Investigate what went wrong in a session and report it with evidence |
| `/skill:supo-writing-skills` | Author, edit, and pressure-test skills before deployment |
| ... | and more |

## Slash Commands

- `/supo <task>` — Dispatch to the appropriate Superpowers workflow

## Development

Skills are vendored from upstream, never written here. Moving to a new upstream release is two steps:

1. Edit `skills.config.json`:
   - `ref` — the upstream tag to track (e.g. `v7.0.1`); it can be any tag, branch or commit-ish that exists in the upstream repo
   - `skills` — keep this list in sync with the upstream `skills/` directory: add names for new skills, remove names for ones upstream deleted
2. Run:

```bash
npm run download-skills
```

The script clones the [obra/superpowers](https://github.com/obra/superpowers) repo at `ref` (cached under `/tmp/pi-superpowers-cache`), copies each listed skill directory with the `supo-` prefix, rewrites SKILL.md frontmatter names and cross-references, and deletes any `supo-*` directory whose skill is no longer listed. Re-running it is idempotent, so it is safe after a partial edit.

Then review the diff: upstream releases sometimes restructure a skill (files moved into `references/`, docs removed) or change behavior a README description still describes.

## License

MIT
