# pi-sandbox

pi coding-agent extension: process-level sandbox (bwrap / landlock / seatbelt / windows-acl) — workspace writable, everything else readable, fail-closed.

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
| Linux | `bwrap` (preferred) | `--ro-bind / /` whole filesystem read-only + rw binds of the workspace and the host `/tmp` |
| Linux | `landlock-run` (fallback, precompiled binary shipped with the package) | Landlock LSM allow list: `/` read-only, workspace + `/tmp` writable |
| macOS | `sandbox-exec` (built in) | Seatbelt SBPL: `deny file-write*` + workspace/temp exceptions |
| Windows | `windows-acl` (built in, `partial` enforcement) | Restricted-token sandbox: `WRITE_RESTRICTED` token + capability-SID ACL grants on the workspace and `%TEMP%` + Low mandatory integrity label; **powershell tool only** (`bash` is refused in confined modes) |
| Other | none | **fail-closed**: confined commands are always refused, never silently run bare |

### Windows

The `windows-acl` runner starts each confined command from a `WRITE_RESTRICTED` token whose integrity level is lowered to Low. In `workspace-write` the token also carries capability SIDs granted write access to the workspace and the host `%TEMP%`, with an inheritable `NO_WRITE_UP` label on both roots; `read-only` grants no write capability. Enforcement is **`partial`**, with three structural gaps inherited from the reference implementation:

- **an NTFS hard link aliases the file object**: a hard link to an authorized file inside the workspace is equally writable from outside it
- **reads are unconfined**: like every other runner here, a confined process can read everything you can read
- **files tagged by another AppContainer tool's package SID are unreadable** to the Low-integrity child (remove the foreign ACE or reinstall the tree to recover)

The confined shell is the **`powershell` tool only**. On Windows (pi >= 1.0.0) pi-sandbox registers its confined `bash` with `exposure: "hidden"`, which makes it *registered but unreachable*: the model never sees it, and naming it (`defaultTools`, `--tools`, `setActiveTools()`) does not activate it. Keeping the registration is deliberate — extension tools shadow same-named built-ins, so the `bash` name stays occupied by this definition and no unconfined built-in `bash` can be reached on Windows; should a future host change how `hidden` is honored, that definition still refuses every confined call (fail-closed, never spawned). `bash` is never run unconfined here unless you explicitly switch to `danger-full-access`, the only bypass (where it runs bare, as everywhere else).

Known limitation: **`defaultTools` cannot deselect an extension-registered tool** (`-name` entries only remove built-ins, and extension tools are auto-activated unless their definition opts out). pi-sandbox does not ask you to configure around this: on Windows the `bash` name is withdrawn from the model at the definition level (`exposure: "hidden"`), so there is nothing to configure away. If `powershell` is not active (a host older than 1.0.0, which ships no `powershell` tool, or a selection that leaves it out), `/permission` shows `shell: powershell only (not activated)`, and pi-sandbox hints once at activation when `bash` is still in the active list (older hosts); `{ "defaultTools": ["+powershell"] }` (requires pi >= 1.0.0) adds it back.

**Supported Windows range.** Same as the upstream design this backend ports (deepseek-harness): **no new OS floor** — the mechanism is a `WRITE_RESTRICTED` token plus a Low mandatory label, both legacy APIs — which is exactly why that route was chosen over `mxc` (Windows 11 24H2+). End-to-end verification in this repository ran on **Windows 10 Enterprise LTSC 2019 (build 17763.316)**: the automated e2e suite and the manual acceptance checklist are green there. Newer builds are expected to work (nothing in the backend depends on them), but have not been exercised here yet. Note the upstream *tests* run on Windows Server 2025, so its test fixtures are not portable to older builds; this package's Windows fixtures deliberately use version-independent primitives.

PowerShell language mode follows startup constraints, not the ACL boundary: under `read-only` PowerShell may degrade to ConstrainedLanguage (`Add-Type`/COM/reflection fail) because `%TEMP%` is not writable; `workspace-write` keeps FullLanguage.

**`NUL` is writable in both modes** — an environment property of the device (its DACL grants Everyone read/write/execute), not a capability grant, so it holds regardless of which roots the token was granted. It is reachable only through the device spellings: `cmd`'s `> NUL` and Node's `\\.\NUL`. A *relative* `NUL` is not the device: libuv builds NT paths and does not apply the Win32 device-name mapping, so `writeFileSync('NUL', …)` is an ordinary file named `NUL` in the child's cwd — allowed inside the workspace, denied outside it, exactly like any other name.

**Standing security-descriptor changes.** Granting is idempotent but never revoked: after pi exits, the ACEs, the world `FILE_DELETE_CHILD` deny and the Low mandatory label on the workspace and `%TEMP%` remain. This relaxes those trees for **any** Low-integrity process running as the same user, and clearing an inheritable label later does not walk back what already propagated to child objects. Switching back to `read-only` makes the capability ACEs inert (that token carries no capability SID) but does not remove them. The first grant eagerly propagates across the whole `%TEMP%` tree (seconds on a large tree); later calls hit the exact-match fast path. `%TEMP%` and `TMP` themselves are **not** rewritten — the sandbox's writable temp root is the host `%TEMP%`.

**The `%TEMP%` cost.** `%TEMP%` is a shared user tree: its subdirectories inherit the deny ACE, so a third party that opens its own temp subdirectory with `GENERIC_ALL`/`FullControl` is refused. DELETE-based deletes, `MAXIMUM_ALLOWED` and ordinary read/write opens are unaffected.

**Denial classification is English-only.** The denial dialects the tool matches to inject the `[sandbox: …]` denial marker, the escalation hint and the denial ledger are English Win32/`cmd`/PowerShell message text, matched against the child's **stderr**. On a localized Windows those messages are localized: the sandbox still denies the access (enforcement is language-independent), but the tool may not annotate the denial and denial-first escalation will not arm. Treat a missing marker as a classification gap, not as a confinement failure.

`koffi` (the FFI layer for the Win32 calls) is a regular dependency, loaded lazily and only on Windows — the Win32 binding table is never materialized elsewhere.

The bundled `diagnose-windows-sandbox-acl` skill (diagnoses and repairs cases where Windows file permissions block pi-sandbox's grants) is contributed to pi **on Windows only**. Its repair modifies security descriptors, so it needs an unconfined caller — run it from an approved `danger-full-access` (or by hand).

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

## Escalation approval (model-initiated, denial-first)

bash/write/edit take two optional parameters: `sandbox_permissions` (`workspace-write` or `danger-full-access`) + `justification` (a one-sentence reason). Approval is **denial-first**:

- A strictly wider request is honored only when this session already had a **real sandbox denial** of the same kind (bash ↔ `command`, write/edit ↔ `operation`); otherwise the escalation fields are **ignored**, the call runs at the current mode, and the result carries a `[sandbox: escalation fields were ignored …]` note so the model learns that the request did not take effect;
- a denial record is **consumed once**: one denial buys exactly one escalation retry (approval still applies to that one call only);
- placeholder parameters are normalized per field: omission and JSON `null` both mean "no request", and the parameter schema declares `null` explicitly — so models on strict-schema providers (where pi marks both fields as required) have a valid "no escalation" value to send; a `"null"` or blank string in `justification` is normalized the same way. String placeholders (`"null"` / empty / whitespace) get one more layer of protection: the tools' `prepareArguments` strips them **before** pi validates the arguments — strict-schema models often write the required-but-optional fields as the string `"null"`, and this keeps such calls running instead of failing with an error that has nothing to do with the sandbox.

The prompt offers **Allow once / Deny**; after choosing Deny you may type an **optional reason** (press Enter to skip) that is passed back to the model with the rejection, so it understands why instead of retrying a rewritten command. A subagent child session's escalation (foreground or background) is forwarded to the parent session's prompt (in-process pi-subagents, and the parent must have UI); with no parent channel available (headless, cross-process subagents) escalation is always refused (fail-closed) — widen the process mode with `/permission` to unblock it.

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
- Under bwrap, bash's `/tmp` **is the host `/tmp`** (rw bind, matching the write/edit fence and the landlock/macOS runners): confined commands can modify or delete the host's temporary files — including live session sockets and pi's own temp files — and the host's `/tmp` permissions apply as-is. If the host `/tmp` is not writable, neither is the sandbox's
- On Windows the sandbox's temp root is the host `%TEMP%` (the `windows-acl` runner grants the real path and does not rewrite `TMP`/`TEMP`): confined commands can modify or delete the host's temporary files there — the same "the host tmp is the host tmp" semantics as the bwrap bind above
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
