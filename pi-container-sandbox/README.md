# pi-container-sandbox

pi coding-agent extension that runs every read/write/edit/bash op inside a per-session Docker container.

- Host project cwd is mounted read-write at `/workspace`
- Agent runs as non-root `pi` user (uid 1000)
- No host `$HOME`, SSH keys, cloud creds, browser state, or Docker socket
- Resource limits via size tiers (`small`/`medium`/`large`)
- Optional reusable named containers
- One command namespace: `/sandbox ...`

## Quick Start

```bash
npm install
npm run build-image        # build the sandbox image
pi -e ./index.ts            # run pi with sandbox
```

## Commands

| Command | Description |
|---------|-------------|
| `/sandbox` | Alias for `/sandbox status` |
| `/sandbox status` | Show container status, resources, host cwd |
| `/sandbox start` | Manually start session container |
| `/sandbox stop` | Stop and destroy current container |
| `/sandbox keep [name]` | Save container name for reuse across sessions |
| `/sandbox exec <cmd>` | Execute command inside container |
| `/sandbox doctor` | Verify core tools available in container |
| `/sandbox config` | Show `.pi/agent/sandbox.json` contents |
| `/sandbox allow <path>` | Grant read access to external host path |
| `/sandbox paths` | List persisted path approvals |
| `/sandbox paths revoke <path>` | Revoke path approval |
| `/sandbox tiers [list]` | List available resource tiers |
| `/sandbox tiers set <tier>` | Switch resource tier |

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--container` | `true` | Enable sandbox |
| `--no-container` / `--noc` | `false` | Disable sandbox |
| `--container-size` | `medium` | Resource tier: `small`, `medium`, `large` |
| `--sandbox-name` | — | Named container for reuse |
| `--sandbox-persist` | `false` | Keep container after pi exits |
| `--sandbox-cache` | — | Docker volume mounted at `/cache` |
| `--container-image` | — | Override image ref |
| `--container-net` | `true` | Allow outbound network |
| `--no-container-net` | `false` | Disable network |
| `--container-keep` | `false` | Don't stop container on exit |
| `--container-mount-skills` | `true` | Mount agent skill directories at `/skills` |
| `--container-mount-paths` | — | Extra mount paths (comma-separated) |
| `--container-allow-paths` | — | External path read allowlist |
| `--container-memory` | — | Override memory limit |
| `--container-cpus` | — | Override CPU limit |
| `--container-swap` | — | Override swap limit |
| `--container-pids-limit` | — | Override PIDs limit |

## Configuration

### `.pi/agent/sandbox.json` (project-level)

```json
{
  "image": "pi-container-sandbox",
  "tag": "latest",
  "containerName": null,
  "tier": "medium",
  "persist": false,
  "cacheVolume": null
}
```

### Resource Tiers

| tier | memory | cpus | swap |
|------|--------|------|------|
| small | 1g | 1 | 512m |
| medium | 4g | 2 | 2g |
| large | 8g | 4 | 4g |

## Development

```bash
npm install            # install dependencies
npm run typecheck     # tsc --noEmit
npm test              # vitest run (51 tests)
npm run build-image   # build sandbox Docker image
```
