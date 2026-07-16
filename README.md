# pi-packages

English | [中文](./README.zh.md)

Monorepo for @yandy pi packages. Uses npm workspaces.

## Packages

| Package | Description | npm |
|---|---|---|
| [pi-ask-user](./pi-ask-user) | Interactive ask_user tool with searchable split-pane UI, multi-select, and freeform | `@yandy0725/pi-ask-user` |
| [pi-coding-tools](./pi-coding-tools) | AST/LSP code-intel tools (ast_grep_search/lsp_symbols/lsp_hover/lsp_navigate) + ls/find/grep | `@yandy0725/pi-coding-tools` |
| [pi-container-sandbox](./pi-container-sandbox) | Docker sandbox extension | `@yandy0725/pi-container-sandbox` |
| [pi-dingtalk](./pi-dingtalk) | DingTalk integration (AI table, calendar, approval, docs, etc.) | `@yandy0725/pi-dingtalk` |
| [pi-lark](./pi-lark) | Lark/Feishu integration | `@yandy0725/pi-lark` |
| [pi-memory](./pi-memory) | File-system driven persistent memory layer for pi coding agent | `@yandy0725/pi-memory` |
| [pi-permission-system](./pi-permission-system) | Permission system for tool access control | `@yandy0725/pi-permission-system` |
| [pi-subagents](./pi-subagents) | In-process sub-agent core with background execution and typed API | `@yandy0725/pi-subagents` |
| [pi-superpowers](./pi-superpowers) | Superpowers structured development workflows (brainstorming, TDD, debugging, etc.) | `@yandy0725/pi-superpowers` |
| [pi-todo](./pi-todo) | Minimal todo tool with editor-overhead widget | `@yandy0725/pi-todo` |
| [pi-vision-tools](./pi-vision-tools) | `describe_image` tool — delegate image analysis to a vision model | `@yandy0725/pi-vision-tools` |
| [pi-web-tools](./pi-web-tools) | websearch + webfetch tools | `@yandy0725/pi-web-tools` |

## Related

- [picode](https://github.com/yandy/picode) — Pre-configured config collection optimized for coding scenarios with pi. Includes curated settings, model configurations, agent definitions, skills, keybindings, and memory management.

## Development

```bash
npm ci                    # Install all dependencies (root + all workspaces)
npm run typecheck         # Type-check all packages
npm run lint              # Biome lint
npm run format            # Format all packages
npm test                  # Run all tests
```

## Release

See [docs/guides/release.md](docs/guides/release.md).
