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

It reports the full hidden ref, baseline/result commit IDs, and a ready-to-run command:

```bash
git diff <baselineCommit> <resultCommit>
```

No argument or an invalid number prints usage. Lookup is scoped to the current conversation branch. No LLM tool is registered.

Use the command to prune stale checkpoints now:

```text
/checkpoint prune
```

It forces one retention sweep and reports the counts; see [Retention](#retention).

## Limits and retention

- **Ignored files are not captured.** All other untracked files are written into the local Git object database. Ignore sensitive files before running the extension; do not treat hidden refs as encryption or a secret boundary.
- Hidden refs do not appear in normal branch history, but `git log --all`, `git for-each-ref`, backups, object-database copies, and mirror operations can still expose them.
- Submodule internals are not recursively captured. Only the superproject's gitlink state is represented.
- Sparse checkout, `assume-unchanged` / `skip-worktree`, and unusual nested repositories follow Git plumbing behavior. Capture reports an error rather than claiming a snapshot it could not represent.
- If the process exits before `agent_settled`, a baseline-only ref may remain. The extension does not invent a result; that ref is subject to the same retention rules as any other.
- Outside a Git worktree, or when `git` is unavailable, capture is skipped with at most one warning per session. Later runs probe again.

### Retention

Each run owns exactly one ref, so a repository accumulates one ref per run. Retention bounds that count:

- A ref is kept only if its commit date is at most **30 days** old **and** it is among the newest **200** refs of the repository. Both conditions must hold, so date truncation and count truncation intersect and the stricter one wins.
- `RETENTION_DAYS = 30` and `MAX_REFS_PER_REPO = 200` are code constants; there is no setting for them.

Pruning is per repository (`git-common-dir`) and therefore across sessions: a sweep can delete old checkpoints that belong to a different session, including from a linked worktree, which shares the same refs namespace. Session entries and previews of those runs are not affected.

- `session_start` runs one silent, best-effort sweep per session per repository, bounded by a 10 s timeout. A missing worktree, a missing `git`, a Git failure or a timeout never surfaces: no notification, no session entry, no failed run.
- `/checkpoint prune` forces a sweep immediately and reports `Pruned N checkpoint ref(s); M kept`, `Checkpoint prune skipped: ...` or `Checkpoint prune failed: ...`. `M` counts the refs the sweep enumerated as eligible and kept; malformed or undated entries under the prefix are in neither number.
- Deletion is one `git update-ref --stdin` batch of conditional `delete <ref> <commit>` lines, applied only to refs shaped `refs/pi/checkpoint/<sessionKey>/<runId>`. Git applies the batch atomically and rejects every line whose ref no longer points at the enumerated commit, so a ref rewritten between the listing and the delete survives; a rejected batch is retried once from a fresh listing.
- A listing that was truncated or killed is never used: a partial `git for-each-ref` output selects nothing and deletes nothing.
- The sweep does not track active runs. Safety comes from timing instead: a run's baseline commit is recent and among the newest refs, so the age and count rules leave its ref alone. The residual risk is a run whose baseline is no longer among the retained refs when a sweep runs: a session that started a run and then sat idle for over 30 days, or a repository where at least 200 newer checkpoints appeared while that run was still open. The sweep may delete that ref, and the run's own result capture then fails and records a capture error instead of a result.
- A checkpoint can still be deleted by hand: `git update-ref -d <full-ref>`.

**No restore command, and no garbage collection of its own.** The package never runs `git gc`, `repack` or `prune`. A deleted ref makes its commits unreachable, and Git's own auto-gc reclaims them after `gc.pruneExpire` (default two weeks); until then the objects are still present.

Session entries are never modified or deleted, so a pruned run keeps its stored summary and patch preview in the timeline. `/checkpoint <n>` still prints the commit IDs and the `git diff` command, and appends `Checkpoint #N: checkpoint objects were pruned; only the stored preview remains` once the ref is gone. A failing existence check stays silent; only a definite "ref missing" produces that note.

## UI surface

| Method | Guard | Outside TUI |
|--------|-------|-------------|
| `pi.registerEntryRenderer` (timeline checkpoint entries) | `none` (renderer is only consumed by TUI) | Session entries and Git refs are still persisted in every mode; the visual timeline is unavailable |
| `ctx.ui.notify` (command output, warnings) | `none` | RPC delivery is fire-and-forget and may be dropped; print/json display is not guaranteed. Carries `/checkpoint <n>` output, `/checkpoint prune` results (including prune failures) and capture warnings. Core capture and the automatic `session_start` sweep never depend on notification delivery; the sweep emits no UI at all |

## License

MIT
