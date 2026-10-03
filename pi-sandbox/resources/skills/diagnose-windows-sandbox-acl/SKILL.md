---
name: diagnose-windows-sandbox-acl
description: 'Use on Windows when a pi-sandbox confined command fails with a file-permission error that contradicts the mode: workspace writes, listing, or plainly readable paths are denied. One bundled command inspects the path and every ancestor and repairs the Windows file permissions it proves in the same run. Expected confinement denials (writes outside the workspace, any write in read-only) need no repair.'
---

# Diagnose Windows sandbox ACL failures

**Write every approval request in plain words, in the user's language.** The prompt is all the user reads before widening access, so it must stand alone: which folder the script touches, that it adds the signed-in user's full-control entry where a right is missing and removes foreign package entries, that file contents and owners are unchanged, and that the printed recovery command undoes each change. Keep error codes, `WRITE_DAC`/`WRITE_OWNER`, `S-1-15-2-*` SIDs, `icacls`, ACL, ACE, verdict names and switches out of the request: write Windows file permissions, not ACL or ACE. Ask once, for one command.

## What this covers

pi-sandbox's Windows backend grants its write capability by editing the workspace's and `%TEMP%`'s Windows file permissions. A denial is worth diagnosing only when it contradicts the mode: a workspace write or listing fails, or a path you can read outside the sandbox cannot be read inside it. Explain expected denials instead — writes outside the workspace, any write in `read-only`, piped grandchild `spawn EPERM`, and PowerShell ConstrainedLanguage errors in `read-only`.

## One command diagnoses and repairs

The script has no modes. `-Path`, `-AllowRoot` and `-Out` read the path and every ancestor and repair what the observations prove, in the same run:

- directories on that chain that lack effective `WRITE_DAC` or `WRITE_OWNER` receive a full-control allow entry for the signed-in user, because pi-sandbox cannot provision its capability grant without them;
- explicit AppContainer package allow entries (`S-1-15-2-*`, except the well-known groups ending in 1 or 2) are removed at their sources, ancestor first, which also removes those packages' access;
- a directory pi-sandbox cannot provision — the state its provisioning error reports on the workspace root — or the authorized root itself also has its subtree searched for those entries in the same run, so a deeper entry needs no second request. That bounded walk reports `truncated` and unreadable directories; if truncated, pass the still-failing deeper path once more.

Every change is backed up, then verified by re-reading it. `-AllowRoot` bounds all of it: an object is changed only when it is that directory or strictly inside it, so a workspace root can repair itself. Never split this into a diagnostic call and a repair call, never ask twice for one repair, and never pass a mode switch that does not exist.

```powershell
& '<skill-directory>\scripts\diagnose-windows-sandbox-acl.ps1' -Path '<failing-path>' -AllowRoot '<authorized-directory>' -Out '<recovery-directory>'
exit $LASTEXITCODE
```

Substitute full, quoted paths. Keep `-Out` persistent and user-owned, preferably beside the failing workspace; never use the skill resource directory, which pi may drop when the extension reloads. Pass one path per invocation.

## Run it unconfined

The script writes permissions, which the confined token cannot do — run it confined and it would report the sandbox's own restriction as a missing right. Run it with the `danger-full-access` permission: either ask the user to switch this session with `/permission danger-full-access`, or retry with `sandbox_permissions: "danger-full-access"` and a one-sentence justification (pi-sandbox honors that only after a real denial in this session, which is exactly this situation). Widening access does not elevate the Windows token. If approval is refused or unavailable, report the path as undiagnosed and stop.

## Read the output

Every record reaches stdout, the `acl-report-*.jsonl` file under `-Out`, and the final `RECAP` line, which carries the verdicts, changes, verifications, refusals and scans. Tool output keeps only its tail, so read the recap first, and read specific records from the report when it is not enough. Trust `verification` records, never `completed` actions. Decide from `details.nextAction`:

| `nextAction` | Meaning |
|---|---|
| `verify_original_confined_operation` | Repairs verified; repeat the original operation confined. |
| `stop` | Nothing repaired, or a refusal ended the run. Report and stop. |
| `restore_pending_then_stop` | Rollback unverified. Run the printed recovery commands in order, then stop. |

A deny entry's presence alone does not establish causation, and the script never removes one; pi-sandbox's `S-1-4-*` capability grants and the Everyone `DeleteSubdirectoriesAndFiles` deny are expected, not conflicts. A deny that blocks the repair ends the run without a repair (`REPAIR_REFUSED`, or `GRANT_FAILED`) after restoring what it attempted. Each change leaves two files in `-Out` (`acl-backup-<id>.json` and its `.ps1`), and the run prints the matching `ROLLBACK` command.

## After a repair, and when it stops

Repeat the original failed operation confined. A verified repair is not undone because the original operation fails for a further reason: continue from the new observations, and if a deeper path is still denied, run the same one command there — again one call, one approval.

**Stop after any failed or refused repair, or failed verification.** The script already restored that invocation's changes; do not repeat it or start another repair, and never remove a deny entry by hand.

**A stopped run still owes the user a decision.** Name the blocking object and the right or entry it lacks, what changed and what was rolled back, the recovery commands in order, and the report path. Only the user can lift confinement, so ask them to switch this session to `danger-full-access` (`/permission danger-full-access`) temporarily, and say what that opens: keep working under it, or ask you to keep investigating this file-permission problem, since the report already records the mechanism and the evidence. Then ask them to send this session as feedback, quoting the report records that matter.

## Never

- edit permissions by hand, change an owner, erase a deny entry, or replace child permissions recursively;
- run the script elevated, through UAC or `runas`;
- widen `-AllowRoot` to reach an ancestor, or repeat a denied or failed call.

Report in the user's language: analyzed paths, changes, verification, recovery commands, next step. Label an authorized unconfined run as such, not as a sandbox repair.
