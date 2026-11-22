# pi-checkpoint

Read-only Git checkpoints for pi: capture the complete workspace before and after each full agent run, then inspect that run's net diff directly from the conversation timeline. The current branch, `HEAD`, real Git index, and working-tree files are never changed by capture.

## Features

- **Run-level history**: one checkpoint spans `before_agent_start → agent_settled`, not every model response or tool call. Retries, compaction retries, steering, and queued follow-ups in the same busy period belong to the same run.
- **Real net changes**: tracked modifications, deletions, mode changes, and non-ignored untracked files are captured across the whole current worktree, even when pi starts in a repository subdirectory.
- **Conversation correlation**: completed, aborted, and no-change runs produce durable session entries. Entries do not enter the LLM context.
- **Read-only inspection**: collapsed entries show a change summary; expanded entries show refs, short commit IDs, and a bounded patch preview.
- **Failure isolation**: Git failures create an error record without failing the agent run. Preview failures do not invalidate an already captured snapshot.

## Install

```bash
pi install npm:@yandy0725/pi-checkpoint
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:@yandy0725/pi-checkpoint"]
}
```

Requires pi >= 1.5.0 and the `git` executable.

## What a checkpoint means

At run start, the extension captures **baseline B**. At final settlement, it captures **result R**, including work completed before an abort. A run with no file changes still gets a result commit.

```text
HEAD before the run (when present)
        ↑
   baseline B ──────→ result R
   tree = before      tree = after
                       ↑
             refs/pi/checkpoint/.../<runId>
```

Each run has one ref:

```text
refs/pi/checkpoint/<base64url(sessionId)>/<runId>
```

`R` has `B` as its only parent, so the run's net workspace diff is:

```bash
git diff <baselineCommit> <resultCommit>
# Equivalently, while the ref points at R:
git diff <full-ref>^1 <full-ref>
```

This is a **state diff, not author attribution**. Manual edits, external processes, commits, and branch switches that happen during the run are included alongside LLM-driven changes.

Capture uses a temporary `GIT_INDEX_FILE`, `read-tree`, `add -A`, `write-tree`, `commit-tree`, and atomic `update-ref`. It does not stage files in the real index, move `HEAD`, invoke normal commit hooks, or restore/clean the worktree.

## Inspect a run

The TUI timeline shows entries such as:

```text
[checkpoint #3] 2 files changed, 8 insertions(+), 1 deletion(-)
```

Expand the entry to inspect the patch. Previews are capped at **128 KiB**; truncation is marked and never removes data from the Git objects. Empty diffs show `No workspace changes`, and aborted runs are marked `aborted`.

Use the command:

```text
/checkpoint 3
```

New successful entries record the common Git dir of the repository that holds the snapshot, so the query can verify the snapshot from any checkout. The lookup has three outcomes:

1. **Available** — the recorded ref still resolves to the run's recorded result commit. The command prints the ref, the baseline/result commit IDs, and a runnable command that carries the recorded repository:
   ```bash
   git --git-dir=<commonDir> diff <baselineCommit> <resultCommit>
   ```
2. **Confirmed unavailable** — the recorded ref is gone or resolves to another commit. The command states that and prints only the retained summary and preview; it never prints a diff command that cannot run.
3. **Unconfirmed** — the check itself failed (no `git`, not a Git worktree, an unexpected Git error, an interrupted child). The command says availability cannot be confirmed; it does not claim the snapshot was pruned.

Entries written before the field existed have no `commonDir`; the lookup then falls back to the current directory and uses hedged wording (`may have been pruned or belong to a different repository`). No argument or an invalid number prints usage. Lookup is scoped to the current conversation branch. No LLM tool is registered.

Use the command to inspect or prune stale checkpoints:

```text
/checkpoint prune [--dry-run]
```

`prune --dry-run` builds the exact same selection as a real pass and reports it without changing any ref; `prune` executes it. See [Retention](#retention).

## Limits and retention

- **Ignored files are not captured.** All other untracked files are written into the local Git object database. Ignore sensitive files before running the extension; do not treat hidden refs as encryption or a secret boundary.
- Hidden refs do not appear in normal branch history, but `git log --all`, `git for-each-ref`, backups, object-database copies, and mirror operations can still expose them.
- Submodule internals are not recursively captured. Only the superproject's gitlink state is represented.
- Sparse checkout, `assume-unchanged` / `skip-worktree`, and unusual nested repositories follow Git plumbing behavior. Capture reports an error rather than claiming a snapshot it could not represent.
- If the process exits before `agent_settled`, a baseline-only ref may remain. The extension does not invent a result; that ref is never pruned automatically and must be removed by hand (see [Retention](#retention)).
- Outside a Git worktree, or when `git` is unavailable, capture is skipped with at most one warning per session. Later runs probe again.

### Retention

Each run owns exactly one ref, so a repository accumulates one ref per run. Retention bounds the *completed* refs:

- A completed ref is kept only if its commit date is at most **30 days** old **and** it is among the newest **200** completed refs of the repository. Both conditions must hold, so date truncation and count truncation intersect and the stricter one wins.
- `RETENTION_DAYS = 30` and `MAX_REFS_PER_REPO = 200` are code constants; there is no setting for them.
- Only refs whose latest commit is this package's **result** snapshot are candidates. A ref that still points at a **baseline** snapshot — an in-progress run or crash residue — is never deleted automatically and never consumes the count budget.

A ref counts as a completed result only when all of these hold:

- its subject is exactly `pi-checkpoint result ref=<that ref>`, and the commit has exactly one parent;
- that parent is a commit whose subject is exactly `pi-checkpoint baseline ref=<that ref>`, so the result is linked to a baseline this package wrote for the same ref — a copied subject alone is not enough;
- when the current session recorded the run, the entry's exact `baselineCommit` and `resultCommit` also match.

The boundary: any local writer can create commits with those subjects and that parent link, and Git cannot prove provenance. The structural check prevents accidental collisions (another tool's commit, a hand-written commit reusing the subject, a result commit for a different ref); a deliberately forged pair of commits under `refs/pi/checkpoint/` is indistinguishable from a checkpoint and may be pruned. The namespace is treated as owned by the extension.

Pruning is per repository (`git-common-dir`) and therefore across sessions: a sweep can delete old checkpoints that belong to a different session, including from a linked worktree, which shares the same refs namespace. Session entries and previews of those runs are not affected.

- `session_start` runs one silent, best-effort sweep per session per repository, bounded by a 10 s timeout. A missing worktree, a missing `git`, a Git failure or a timeout never surfaces: no notification, no session entry, no failed run.
- `/checkpoint prune` forces a sweep immediately and reports `Pruned N checkpoint ref(s) (E older than 30 days, O beyond the newest 200); M kept`, or `Checkpoint prune skipped: ...` / `Checkpoint prune failed: ...`. `/checkpoint prune --dry-run` reports the same plan as `Checkpoint prune (dry run): would delete N of C completed checkpoint ref(s) (...); M would be kept` without deleting anything.
- `M` counts completed refs that remain. Baseline-only refs and unrecognized refs are in none of `N`, `E`, `O` or `M`; when baseline-only refs exist the message adds how many were left untouched.
- Deletion is one `git update-ref --stdin` batch of conditional `delete <ref> <commit>` lines, applied only to completed refs shaped `refs/pi/checkpoint/<sessionKey>/<runId>`. Git applies the batch atomically and rejects every line whose ref no longer points at the enumerated commit, so a ref rewritten between the listing and the delete survives; a rejected batch is retried once from a fresh listing.
- A listing that was truncated or killed is never used: a partial `git for-each-ref` output selects nothing and deletes nothing. The same holds for the baseline lookup: a truncated, killed, non-zero, or ambiguous lookup selects nothing.
- Baseline-only refs never expire automatically, so crash residue can accumulate without bound. This is an accepted limitation: the extension cannot distinguish an abandoned baseline from a run that is still alive in another process, and deleting an active run's baseline would make its result capture fail. Remove abandoned baselines yourself when you know no run is using them:
  ```bash
  git for-each-ref --format='%(subject) %(refname)' refs/pi/checkpoint
  git update-ref -d <full-ref>
  ```
  Delete only refs whose subject starts with `pi-checkpoint baseline `; a `result` ref is a completed run and is handled by retention.

**No restore command, and no garbage collection of its own.** The package never runs `git gc`, `repack` or `prune`. A deleted ref makes its commits unreachable, and Git's own auto-gc reclaims them after `gc.pruneExpire` (default two weeks); until then the objects are still present.

Session entries are never modified or deleted, so a pruned run keeps its stored summary and patch preview in the timeline. `/checkpoint <n>` verifies the ref against the entry instead of assuming the snapshot is intact: an available snapshot keeps the diff command, a missing or moved ref prints only the retained summary and preview, and a failed check says availability is unconfirmed. Deleting a ref does not delete objects, so an available diff command usually keeps working until Git's auto-gc runs.

## UI surface

| Method | Guard | Outside TUI |
|--------|-------|-------------|
| `pi.registerEntryRenderer` (timeline checkpoint entries) | `none` (renderer is only consumed by TUI) | Session entries and Git refs are still persisted in every mode; the visual timeline is unavailable |
| `ctx.ui.notify` (command output, warnings) | `none` | RPC delivery is fire-and-forget and may be dropped; print/json display is not guaranteed. Carries `/checkpoint <n>` output, `/checkpoint prune` results (including prune failures) and capture warnings. Core capture and the automatic `session_start` sweep never depend on notification delivery; the sweep emits no UI at all |

## License

MIT
