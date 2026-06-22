# pi-container-sandbox

A [pi](https://pi.dev/docs/latest/extensions) extension that runs the agent's
`bash`, `read`, `write`, `edit` tools and the user's `!` bash inside a
per-session Docker container, so coding side effects are sandboxed.

## Quick start

Requires Docker (any recent version) running and accessible to your user
(you need read/write on `/var/run/docker.sock` or Docker Desktop).

```bash
# Install from npm
pi install npm:@yandy0725/pi-container-sandbox

# Or install from a local checkout
pi install .

# Or run directly
npm install && npm run build-image
pi -e ./index.ts
```

On first use the extension auto-builds the bundled sandbox image
(`pi-container-sandbox:latest`) using the local `docker/Dockerfile`. Subsequent
runs reuse the image.

```bash
# In any project
pi
# /sandbox         # show container info
# !pwd             # runs inside the container, prints /workspace
# !ls              # lists the project root inside the container
```

## What runs where

| Tool / command | Where it runs |
|---|---|
| `bash` (agent)   | inside the container, cwd `/workspace` |
| `read`           | inside the container (external paths granted via `allow` are read from host directly) |
| `write`          | inside the container |
| `edit`           | inside the container (read ops: same as `read`; write ops: inside container) |
| `!` user bash    | inside the container |
| `bash` (whitelisted) | on the host (see `hostCommands` in config) |
| `find`, `grep`, `ls` | pi's host defaults (use `bash` tool to call inside container) |

The project cwd is bind-mounted **read-write** at `/workspace` inside the
container. Edits the agent makes are visible on the host and vice versa.
Agent skill directories are mounted **read-only** at `/skills/`.

> **Note:** `/sandbox allow` and `--container-allow-paths` only affect the
> `read` tool (and `edit`'s read operations). To write to paths outside the
> project cwd, use `--container-mount-paths` to bind-mount them into the
> container.

The sandbox container is removed when pi exits, unless you set
`--sandbox-persist` or `--container-keep`.

## Commands

| Command | Description |
|---|---|
| `/sandbox` / `/sandbox status` | Show container id, resources, host cwd |
| `/sandbox start` | Manually start a sandbox container |
| `/sandbox stop` | Stop and remove the container (blocked if keep/persist is active) |
| `/sandbox keep [name]` | Save container name for reuse across sessions |
| `/sandbox exec <cmd>` | Execute a command inside the container |
| `/sandbox doctor` | Verify core tools available in the container |
| `/sandbox config` | Show `.pi/agent/sandbox.json` contents |
| `/sandbox allow <path>` | Grant read access to an external host path |
| `/sandbox paths [revoke <path>]` | List or revoke persisted path approvals |
| `/sandbox tiers [set <tier>]` | List or switch resource tiers |

## Configuration

### `.pi/agent/sandbox.json` (project-level)

```json
{
  "image": "pi-container-sandbox",
  "tag": "latest",
  "containerName": null,
  "tier": "medium",
  "persist": false,
  "cacheVolume": null,
  "hostCommands": ["git", "docker"]
}
```

`hostCommands` (optional string array): Commands in this list run directly
on the host instead of inside the container. Matches by command name
(the first word of the bash command). For example, listing `"git"` means
`git status`, `git diff`, etc. all execute on the host.

### Resource Tiers

| tier | memory | cpus | swap |
|------|--------|------|------|
| small | 1g | 1 | 512m |
| medium | 4g | 2 | 2g |
| large | 8g | 4 | 4g |

Use `--container-size` flag or `/sandbox tiers set` to switch.

### CLI Flags

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

## External File Read

When the agent tries to **read** a file outside the project cwd (e.g. system
config files), the sandbox prompts for interactive approval. Paths can be
pre-approved via `--container-allow-paths` flag or `/sandbox allow` command.
Approved paths are persisted in `.pi/agent/path-approvals.json`.

Once a path is allowed, the `read` tool reads it directly from the **host
filesystem** (bypassing the container). Only the `read` tool and `edit`'s read
operations are affected — `write`, `edit`'s write operations, and `bash` are
**not** affected and always run inside the container.

### Mechanism distinction

| Tool | External read | External write |
|------|--------------|----------------|
| `read` | `--container-allow-paths` / `/sandbox allow` | — |
| `edit` (read ops) | `--container-allow-paths` / `/sandbox allow` | — |
| `edit` (write ops) | — | `--container-mount-paths` |
| `write` | — | `--container-mount-paths` |
| `bash` | — | `--container-mount-paths` |

- **allow**: Lightweight read-only access from host. Paths are matched by
  prefix (e.g., allowing `/etc` permits reading any file under `/etc`).
- **mount**: Bind-mounts a host directory into the container at the same path,
  granting full read/write access inside the container. Use for write
  operations or when the tool needs to operate on external paths inside the
  container.

## Resource limits (defaults)

- Memory: 4 GiB (medium tier)
- CPUs: 2
- PIDs: 512
- No caps: `--cap-drop ALL`
- No new privileges: `--security-opt no-new-privileges`
- User: non-root (uid 1000)
- Network: default (container can reach the internet)
- No Docker socket inside the container

## Troubleshooting

### `Sandbox not ready: Docker not available`

Make sure Docker is running:

```bash
docker ps
```

If Docker is running but the extension can't reach it, your user may not
have permission on `/var/run/docker.sock`. On Linux, add yourself to the
`docker` group.

### Image build fails

The auto-build pulls down several tools (rg, fd, bat, node, uv, bun, etc.)
and verifies them by SHA-256. If one of those downloads fails (e.g. behind
a corporate proxy), the build will fail. Pre-build manually:

```bash
npm run build-image
```

### Agent edits don't show up on the host

The bind mount is at `/workspace` in the container, mapped to your project
cwd on the host. Check `docker inspect <container-name> | grep -A 5 Mounts`.

### I want to drop into the container

```bash
docker exec -it <container-name> bash
```

Find the container name from `/sandbox status` or `docker ps --filter name=pi-sbx-`.

## Development

```bash
# From repo root:
npm ci                    # Install all dependencies
npm run typecheck         # Type-check all packages
npm test                  # Run all tests

# Package-specific:
npm run build-image --workspace=pi-container-sandbox
pi -e ./index.ts          # Run the extension locally (from this dir)
bash tests/e2e.sh         # Run E2E tests (requires Docker + pi CLI)
```

## How it works

`pi-container-sandbox` is a pi extension. On `session_start` it ensures
`pi-container-sandbox:latest` exists (building it from the bundled
`docker/Dockerfile` if needed), then starts a long-lived container with
the project cwd bind-mounted at `/workspace`. It replaces pi's coding
tools (`bash`, `read`, `write`, `edit`) with versions whose I/O routes
through dockerode Docker Engine API calls into the container. The user's
`!` bash uses the same adapter via the `user_bash` event.

The container is torn down on `session_shutdown` / SIGINT / process exit
(unless `keep` is set). If Docker is unreachable, the extension gracefully
degrades to pi's default host tools with a notification.

## License

MIT
