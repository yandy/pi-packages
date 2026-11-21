export const CHECKPOINT_REFS_PREFIX = "refs/pi/checkpoint";

export function checkpointRef(sessionId: string, runId: string): string {
	return `${CHECKPOINT_REFS_PREFIX}/${Buffer.from(sessionId, "utf8").toString("base64url")}/${runId}`;
}
