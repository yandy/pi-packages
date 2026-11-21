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

## Limits and retention

- **Ignored files are not captured.** All other untracked files are written into the local Git object database. Ignore sensitive files before running the extension; do not treat hidden refs as encryption or a secret boundary.
- Hidden refs do not appear in normal branch history, but `git log --all`, `git for-each-ref`, backups, object-database copies, and mirror operations can still expose them.
- Submodule internals are not recursively captured. Only the superproject's gitlink state is represented.
- Sparse checkout, `assume-unchanged` / `skip-worktree`, and unusual nested repositories follow Git plumbing behavior. Capture reports an error rather than claiming a snapshot it could not represent.
- If the process exits before `agent_settled`, a baseline-only ref may remain. The extension does not invent a result or automatically delete it.
- There is no restore command and no automatic pruning. Deleting a checkpoint is an explicit Git operation:

  ```bash
  git update-ref -d <full-ref>
  ```

  Session entries remain as historical metadata. Unreferenced objects may eventually be reclaimed by normal Git garbage collection.
- Outside a Git worktree, or when `git` is unavailable, capture is skipped with at most one warning per session. Later runs probe again.

## UI surface

| Method | Guard | Outside TUI |
|--------|-------|-------------|
| `pi.registerEntryRenderer` (timeline checkpoint entries) | `none` (renderer is only consumed by TUI) | Session entries and Git refs are still persisted in every mode; the visual timeline is unavailable |
| `ctx.ui.notify` (command output, warnings) | `none` | RPC delivery is fire-and-forget and may be dropped; print/json display is not guaranteed. Core capture never depends on notification delivery |

## License

MIT
