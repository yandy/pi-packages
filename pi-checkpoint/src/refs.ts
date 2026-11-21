export const CHECKPOINT_REFS_PREFIX = "refs/pi/checkpoint";

export type CheckpointCommitKind = "baseline" | "result";

export function checkpointRef(sessionId: string, runId: string): string {
	return `${CHECKPOINT_REFS_PREFIX}/${Buffer.from(sessionId, "utf8").toString("base64url")}/${runId}`;
}

/** The commit subject that identifies a checkpoint commit for a ref. */
export function checkpointCommitSubject(kind: CheckpointCommitKind, ref: string): string {
	return `pi-checkpoint ${kind} ref=${ref}`;
}

/**
 * Only result commits written by this package are prune candidates. The ref is part of the
 * comparison so a commit cannot be claimed as the result of a different checkpoint ref.
 */
export function isCheckpointResultSubject(ref: string, subject: string): boolean {
	return subject === checkpointCommitSubject("result", ref);
}
