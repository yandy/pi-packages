# pi-superpowers

Superpowers skills for pi — structured development workflows for building software.

## Installation

```bash
npm install @yandy0725/pi-superpowers
```

## Skills

This package bundles the following skills from [Superpowers](https://github.com/obra/superpowers), each prefixed with `superpowers-`:

| Skill | Description |
|-------|-------------|
| `/skill:superpowers-brainstorming` | Explore user intent, requirements and design before implementation |
| `/skill:superpowers-systematic-debugging` | Systematic debugging process for finding root causes |
| `/skill:superpowers-writing-plans` | Write comprehensive implementation plans from specs |
| `/skill:superpowers-test-driven-development` | Test-first development workflow |
| `/skill:superpowers-using-git-worktrees` | Isolated workspace creation via git worktrees |
| `/skill:superpowers-verification-before-completion` | Verify work before claiming completion |
| ... | and more |

## Slash Commands

- `/superpowers <task>` — Dispatch to the appropriate Superpowers workflow

## Development

To update skills from upstream:

```bash
npm run download-skills
```

This clones the [obra/superpowers](https://github.com/obra/superpowers) repo, copies skill directories with `superpowers-` prefix, and updates SKILL.md frontmatter and cross-references.

## License

MIT
