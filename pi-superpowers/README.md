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
| `/skill:supo-writing-plans` | Write comprehensive implementation plans from specs |
| `/skill:supo-test-driven-development` | Test-first development workflow |
| `/skill:supo-using-git-worktrees` | Isolated workspace creation via git worktrees |
| `/skill:supo-verification-before-completion` | Verify work before claiming completion |
| ... | and more |

## Slash Commands

- `/supo <task>` — Dispatch to the appropriate Superpowers workflow

## Development

To update skills from upstream:

```bash
npm run download-skills
```

This clones the [obra/superpowers](https://github.com/obra/superpowers) repo, copies skill directories with `supo-` prefix, and updates SKILL.md frontmatter and cross-references.

## License

MIT
