

# pi-packages

English | [中文](./README.zh.md)

Monorepo for @yandy pi packages. Uses npm workspaces.

## Packages

| Package | Description | npm |
|---|---|---|
| [pi-ask-user](./pi-ask-user) | Interactive ask_user tool with searchable split-pane UI, multi-select, and freeform | `@yandy0725/pi-ask-user` |
| [pi-coding-tools](./pi-coding-tools) | AST/LSP code-intel tools (ast_grep_search/ast_grep_replace/lsp_symbols/lsp_hover/lsp_navigate) | `@yandy0725/pi-coding-tools` |
| [pi-context-insight](./pi-context-insight) | Standalone offline HTML reports for session context, usage, activity, and child-agent insights | `@yandy0725/pi-context-insight` |
| [pi-sandbox](./pi-sandbox) | Process-level sandbox (bwrap/landlock/seatbelt/windows-acl): workspace writable, everything else readable, fail-closed | `@yandy0725/pi-sandbox` |
| [pi-subagents](./pi-subagents) | In-process sub-agent core with background execution and typed API | `@yandy0725/pi-subagents` |
| [pi-todo](./pi-todo) | Minimal todo tool with editor-overhead widget | `@yandy0725/pi-todo` |
| [pi-vision-tools](./pi-vision-tools) | `describe_image` tool — delegate image analysis to a vision model | `@yandy0725/pi-vision-tools` |
| [pi-web-tools](./pi-web-tools) | websearch + webfetch tools | `@yandy0725/pi-web-tools` |

## Development

```bash
npm ci                    # Install all dependencies (root + all workspaces)
npm run typecheck         # Type-check all packages
npm run lint              # Biome lint
npm run format            # Format all packages
npm test                  # Run all tests
```

## License

MIT — the single [LICENSE](./LICENSE) at the repository root covers every package in this monorepo.
Packages do not keep their own copy: `prepack` injects the root license into each published tarball.
