# pi-sandbox

pi coding-agent extension: process-level sandbox (bwrap / landlock / seatbelt) — workspace writable, everything else readable, fail-closed.

## Install

```bash
# From npm
pi install npm:@yandy0725/pi-sandbox

# Or from a local checkout
pi install .
```

## How it works

bash commands are wrapped in a platform sandbox runner and spawned locally (**path transparent**: host paths work as-is); the write/edit tools run an in-process write fence before execution; read is unrestricted.

| Platform | Runner | Mechanism |
|---|---|---|
| Linux | `bwrap` (preferred) | `--ro-bind / /` whole filesystem read-only + workspace rw bind + `--tmpfs /tmp` |
| Linux | `landlock-run` (fallback, precompiled binary shipped with the package) | Landlock LSM allow list: `/` read-only, workspace + `/tmp` writable |
| macOS | `sandbox-exec` (built in) | Seatbelt SBPL: `deny file-write*` + workspace/temp exceptions |
| Other | none | **fail-closed**: confined commands are always refused, never silently run bare |

## Three permission modes

| Mode | File effects |
|---|---|
| `read-only` | only `/dev/null` writable |
| `workspace-write` (default) | working directory + `/tmp` + `os.tmpdir()` writable, everything else read-only |
| `danger-full-access` | sandbox bypassed entirely (explicit escape hatch) |

Network is always allowed (no network isolation).

## /permission command

- `/permission` — show the current status (mode and source, selected runner and enforcement, workspace)
- `/permission <read-only|workspace-write|danger-full-access>` — switch mode, **process-wide**: the next tool call in the parent session and in every subagent child session adopts it immediately

## Escalation approval (model-initiated)

bash/write/edit take two optional parameters: `sandbox_permissions` (`workspace-write` or `danger-full-access`) + `justification` (a one-sentence reason). After an operation is denied by the sandbox, the model may retry the exact same call once with these two parameters, which opens an approval prompt (Allow once / Deny); approval applies to that one call only. A subagent child session's escalation (foreground or background) is forwarded to the parent session's prompt (in-process pi-subagents, and the parent must have UI); with no parent channel available (headless, cross-process subagents) escalation is always refused (fail-closed) — widen the process mode with `/permission` to unblock it.

## Configuration

`~/.pi/agent/sandbox.json` (global) and `<project>/.pi/sandbox.json` (project), merged field by field: project > global > defaults:

```json
{
  "mode": "workspace-write",
  "runnerCommand": null,
  "runnerFailureSignatures": null,
  "probeTimeoutMs": 5000
}
```

| Field | Default | Notes |
|---|---|---|
| `mode` | `workspace-write` | default permission mode; invalid values fall back to the default with a warning |
| `runnerCommand` | `null` | custom bwrap-compatible runner argv (must be paired with the next field) |
| `runnerFailureSignatures` | `null` | fatal diagnostic signatures for the custom runner (non-empty single lines) |
| `probeTimeoutMs` | `5000` | runner capability probe timeout (positive) |

## Security notes

- Confined processes can **read** everything you can read on the host (including `~/.ssh` and the like) — that is this sandbox's design semantics (same as the deepseek harness); root-only files stay protected by file permissions
- Under bwrap, `/tmp` inside bash is a **private tmpfs recreated for every command**: host `/tmp` is invisible from inside, and anything written there is gone when the command exits — keep scratch files that later commands (or the read/write tools) need inside the workspace
- Confined child processes force `LC_MESSAGES=C` (so denial diagnostics stay classifiable) and do not touch your `LANG`/`LC_CTYPE`
- Confined bash runs in its own process group (detached): timeout/abort kills the whole group, but if pi itself is hard-killed (e.g. SIGKILL), background grandchildren spawned by the command may survive (pi's internal child-tracking API is not available to extensions)
- The landlock fallback is partial enforcement on older kernel ABIs (the status output says so)

## Migrating from pi-container-sandbox 1.x

- Config files stay where they are (`~/.pi/agent/sandbox.json`, `<project>/.pi/sandbox.json`); legacy `image`/`runtime`/`host` sections are ignored with a warning — rewrite them as the new fields above as needed
- The container runtime (docker/podman), image builds, `runtime.mounts`, the `/sandbox` command, `--container*` flags, and the external-path approval flow are not part of this package
- Need container-grade isolation (separate filesystem/network namespaces)? Install `@yandy0725/pi-container-sandbox` — it keeps the container implementation
- `pi-sandbox` and `@yandy0725/pi-container-sandbox` are **mutually exclusive**: both take over `bash`/`write`/`edit` and both read the same `sandbox.json` (with incompatible schemas) — enable only one at a time, and uninstall or disable the other before switching

## Development

```bash
npm test              # unit + integration (integration auto-skips without a runner)
npm run typecheck
./tests/e2e.sh
```

### Verifying escalation forwarding with a local build

The parent session can load a local pi-sandbox via `pi -e <path>`, but **`-e` only affects the parent**: pi-subagents builds a separate resource loader for each child session, so the child **re-discovers** extensions from `agentDir` and the project `.pi/`. If `~/.pi/agent/settings.json` still declares `npm:@yandy0725/pi-sandbox`, the child loads the published build and forwarding **fails silently** (the child only reports `requires approval, but no approval channel is available`). Make both sides discover the same build:

```bash
AG=$(mktemp -d); cp ~/.pi/agent/auth.json "$AG/" 2>/dev/null || true
cat > "$AG/settings.json" <<EOF
{ "packages": ["<repo>/pi-sandbox", "<repo>/pi-subagents"] }
EOF
cd <writable project dir> && PI_CODING_AGENT_DIR="$AG" pi
```

Observations and the verification record live in `docs/superpowers/specs/2026-09-30-escalation-approval-forwarding-design.md` §11.

## License

MIT
