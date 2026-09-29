# pi-container-sandbox

pi coding-agent extension: confine agent file effects with a process-level sandbox — workspace writable, everything else readable (deepseek harness workspace-write semantics). No containers since 2.0.

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

bash/write/edit take two optional parameters: `sandbox_permissions` (`workspace-write` or `danger-full-access`) + `justification` (a one-sentence reason). After an operation is denied by the sandbox, the model may retry the exact same call once with these two parameters, which opens an approval prompt (Allow once / Deny); approval applies to that one call only. With no UI channel (headless, background subagent), escalation is always refused (fail-closed).

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
- Confined child processes force `LC_MESSAGES=C` (so denial diagnostics stay classifiable) and do not touch your `LANG`/`LC_CTYPE`
- The landlock fallback is partial enforcement on older kernel ABIs (the status output says so)

## Migrating from 1.x

- The container runtime (docker/podman), image builds, the `runtime.mounts`/`image`/`host` config groups, the `/sandbox` command, `--container*` flags, and the external-path approval flow are all removed
- Legacy `image`/`runtime`/`host` sections in `sandbox.json` are ignored with a warning; rewrite them as the new fields above as needed
- If you need container-grade isolation (separate filesystem/network namespaces), stay on 1.x

## Development

```bash
npm test              # unit + integration (integration auto-skips without a runner)
npm run typecheck
./tests/e2e.sh
```

## License

MIT
