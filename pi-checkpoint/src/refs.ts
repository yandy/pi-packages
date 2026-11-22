export const CHECKPOINT_REFS_PREFIX = "refs/pi/checkpoint";

export type CheckpointCommitKind = "baseline" | "result";

export function checkpointRef(sessionId: string, runId: string): string {
	return `${CHECKPOINT_REFS_PREFIX}/${Buffer.from(sessionId, "utf8").toString("base64url")}/${runId}`;
}

/**
 * The single commit message this package writes for a snapshot. A ref is only eligible for pruning
 * when its commit and its commit's parent both carry the message matching that same ref, so a
 * hand-written commit cannot claim a checkpoint by copying one subject.
 */
export function checkpointCommitSubject(kind: CheckpointCommitKind, ref: string): string {
	return `pi-checkpoint ${kind} ref=${ref}`;
}

/** Snapshot commits a session entry asserts for one ref; pruning cross-checks these when available. */
export interface RecordedCheckpointCommit {
	ref: string;
	baselineCommit: string;
	resultCommit: string;
}
