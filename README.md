# pi-packages

Monorepo for @yandy pi packages. Uses npm workspaces.

## Packages

| Package | Description | npm |
|---|---|---|
| [pi-coding-tools](./pi-coding-tools) | AST/LSP code-intel tools (ast_grep_search/lsp_symbols/lsp_hover/lsp_navigate) + ls/find/grep | `@yandy0725/pi-coding-tools` |
| [pi-container-sandbox](./pi-container-sandbox) | Docker sandbox extension | `@yandy0725/pi-container-sandbox` |
| [pi-todo](./pi-todo) | Minimal todo tool with editor-overhead widget | `@yandy0725/pi-todo` |
| [pi-vision-tools](./pi-vision-tools) | `describe_image` tool — delegate image analysis to a vision model | `@yandy0725/pi-vision-tools` |
| [pi-web-tools](./pi-web-tools) | websearch + webfetch tools | `@yandy0725/pi-web-tools` |

## Development

```bash
npm ci                    # Install all dependencies (root + all workspaces)
npm run typecheck         # Type-check all packages
npm run check             # Lint + format check all packages
npm run format            # Format all packages
npm test                  # Run all tests
```

## Release

See `RELEASE.md` in each package directory.
