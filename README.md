# pi-packages

Monorepo for @yandy pi packages. Uses npm workspaces.

## Packages

| Package | Description | npm |
|---|---|---|
| [pi-coding-tools](./pi-coding-tools) | apply_patch tool + ls/find/grep built-in tools | `@yandy0725/pi-coding-tools` |
| [pi-container-sandbox](./pi-container-sandbox) | Docker sandbox extension | `@yandy0725/pi-container-sandbox` |
| [pi-web-tools](./pi-web-tools) | web_search + web_fetch tools | `@yandy0725/pi-web-tools` |

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
