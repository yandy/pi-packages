# pi-checkpoint

Read-only Git checkpoints for pi: capture the complete workspace before and after each full agent run, then inspect that run's net diff directly from the conversation timeline. The current branch, `HEAD`, real Git index, and working-tree files are never changed by capture.

## Features

- **Run-level history**: one checkpoint spans `before_agent_start → agent_settled`, not every model response or tool call. Retries, compaction retries, steering, and queued follow-ups in the same busy period belong to the same run.
- **Real net changes**: tracked modifications, deletions, mode changes, and non-ignored untracked files are captured across the whole current worktree, even when pi starts in a repository subdirectory.
- **Conversation correlation**: completed, aborted, and no-change runs produce durable session entries. Entries do not enter the LLM context.
- **Read-only inspection**: collapsed entries show a change summary; expanded entries show refs, short commit IDs, and a bounded patch preview.
- **Failure isolation**: Git failures create an error record without failing the agent run. Preview failures do not invalidate an already captured snapshot.
- **Bounded retention**: completed checkpoint refs are swept per Git common dir by age and count. Session entries keep their summary and preview after a snapshot is pruned.

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

Expand the entry to inspect the patch. Previews are capped at **16 KiB**; truncation is marked and never removes data from the Git objects. Empty diffs show `No workspace changes`, and aborted runs are marked `aborted`. The renderer does not query Git, so the timeline does not report whether a snapshot still exists.

Use the command:

```text
/checkpoint 3
```

It verifies that the recorded ref still resolves to the recorded result commit, and only then reports the full hidden ref, baseline/result commit IDs, and a ready-to-run command:

```bash
git diff <baselineCommit> <resultCommit>
```

If the ref is missing or points at another commit, it prints `snapshot unavailable` with the reason plus the retained shortstat and preview (a legacy preview larger than 16 KiB is truncated again for display); a missing snapshot is never presented as a usable diff command. If Git cannot run the verification, it reports `snapshot unconfirmed` instead of claiming the snapshot was pruned. Entries record the Git common dir; older entries without it are verified in the current working directory and use wording that does not assert where the snapshot went.

No argument or an invalid number prints usage. Lookup is scoped to the current conversation branch. No LLM tool is registered.

## Retention and pruning

The full Git snapshot is kept only while the retention policy allows it. The session entry — run number, shortstat, patch preview, commit IDs and ref — is never rewritten or deleted by pruning.

### Policy

Defaults are `retentionDays: 30` and `maxRefs: 1000`. The patch preview is fixed at 16 KiB and has no configuration surface.

```json
{
  "retentionDays": 30,
  "maxRefs": 1000
}
```

- Only the global file `~/.pi/agent/checkpoint.json` is read. Project-level configuration is ignored: a file inside the repository must not be able to impose a destructive retention policy on a shared Git common dir.
- A missing file uses both defaults. Each field accepts a positive integer or `null`; `null` disables that dimension, and `null` for both disables pruning entirely (the manual command then reports that pruning is disabled).
- Config is read at `session_start` and on every manual `/checkpoint prune`; the file is not watched. Automatic sweeps within a session reuse the policy loaded at session start.
- Invalid JSON, a wrong field type, or a non-integer/non-positive/unsafe value fails closed: a warning without file content, no ref deletion, and capture keeps working. Invalid config never falls back to the defaults.

### Scope and selection

- One sweep covers a single Git common dir, so all sessions and linked worktrees of the same repository share one budget. Ref ownership is not inferred from session files and no per-session share is reserved.
- Only completed refs are candidates: the ref must point at a commit whose subject is `pi-checkpoint result ref=<full-ref>`. Baseline-only refs (`pi-checkpoint baseline ...`), unknown subjects, tags, trees and blobs are never auto-deleted and do not consume the `maxRefs` completed budget; a baseline-only ref may belong to an in-flight run or to a crash, and age alone cannot distinguish them.
- TTL first: completed refs whose committer time is older than `retentionDays` are selected and never consume the `maxRefs` budget.
- LRU second: the remaining refs are sorted oldest first (ties by full ref name) and the oldest ones beyond `maxRefs` are selected.
- The two selections are deduplicated into one plan. `--dry-run` uses the identical plan and changes no ref.
- `maxRefs` is the target after each successful sweep, not a cross-process hard limit: concurrent runs and baseline-only refs can leave the actual count temporarily above it.

### Deletion safety

Deletion is a single `git update-ref --stdin` transaction, and every `delete` line carries the full object ID seen during enumeration as the expected old value. A ref updated by another process after enumeration makes the transaction fail: nothing is reported as deleted, there is no retry without the expected object ID, and the next sweep enumerates again. A truncated or unparsable ref enumeration also deletes nothing.

### Automatic sweeps

A sweep is requested for the current repository at `session_start` and after each settled run, once its checkpoint entry has been appended. Nothing is swept outside a Git worktree, when `git` is unavailable, or when both policy dimensions are `null`. Sweeps for one common dir run one at a time; extra automatic requests coalesce into at most one queued sweep.

Automatic notifications are best effort and never affect capture or the agent loop. A sweep that deleted refs reports the count with the TTL/overflow breakdown; failures report a warning; sweeps that delete nothing stay silent.

### Manual pruning

`/checkpoint prune` reloads the global config and applies the same plan in the current repository. `--dry-run` reports the plan without touching refs: the number of completed refs considered, expired count, overflow count, and the number of unique refs that would be deleted. Applying reports how many of the completed refs were deleted, with the same breakdown.

Invalid arguments, invalid config, a disabled policy (`retentionDays` and `maxRefs` both `null`), or a non-Git working directory delete nothing and produce a warning.

Baseline-only refs are never pruned automatically or by the command. Remove a stale one explicitly once no run is using it:

```bash
git update-ref -d <full-ref>
```

### Git object reclamation is deferred

Pruning deletes refs only. The extension never runs `git gc`, `git prune`, `repack`, or `pack-refs`, and does not promise that disk usage drops immediately: unreachable objects remain until normal Git garbage collection reclaims them under Git's own rules.

## Limits

- **Ignored files are not captured.** All other untracked files are written into the local Git object database. Ignore sensitive files before running the extension; do not treat hidden refs as encryption or a secret boundary.
- Hidden refs do not appear in normal branch history, but `git log --all`, `git for-each-ref`, backups, object-database copies, and mirror operations can still expose them.
- Submodule internals are not recursively captured. Only the superproject's gitlink state is represented.
- Sparse checkout, `assume-unchanged` / `skip-worktree`, and unusual nested repositories follow Git plumbing behavior. Capture reports an error rather than claiming a snapshot it could not represent.
- If the process exits before `agent_settled`, a baseline-only ref may remain. The extension does not invent a result and never prunes baseline-only refs; remove one explicitly when no run is using it:

  ```bash
  git update-ref -d <full-ref>
  ```

- There is no restore command. Completed refs are pruned by the retention policy above, but session entries remain as historical metadata even after their Git snapshot is gone.
- Outside a Git worktree, or when `git` is unavailable, capture is skipped with at most one warning per session. Later runs probe again.

## UI surface

| Method | Guard | Outside TUI |
|--------|-------|-------------|
| `pi.registerEntryRenderer` (timeline checkpoint entries) | `none` (renderer is only consumed by TUI) | Session entries and Git refs are still persisted in every mode; the visual timeline is unavailable |
| `ctx.ui.notify` (query output, prune results, retention and pruning warnings) | `none` | RPC delivery is fire-and-forget and may be dropped; print/json display is not guaranteed. Pruning adds no terminal components, dialogs, or RPC-specific UI branches, and capture or pruning never depends on notification delivery |

## License

MIT
