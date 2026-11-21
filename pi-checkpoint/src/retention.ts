import { CHECKPOINT_REFS_PREFIX } from "./refs.js";

export const RETENTION_DAYS = 30;
export const MAX_REFS_PER_REPO = 200;

const SECONDS_PER_DAY = 86_400;

export interface CheckpointRefRecord {
	name: string;
	committedAtSeconds: number;
}

export interface RetentionPolicy {
	nowSeconds: number;
	retentionDays: number;
	maxRefs: number;
}

export function isCheckpointRefName(name: string): boolean {
	const prefix = `${CHECKPOINT_REFS_PREFIX}/`;
	if (!name.startsWith(prefix)) return false;
	const segments = name.slice(prefix.length).split("/");
	return segments.length === 2 && segments.every((segment) => segment.length > 0);
}

export function selectRefsToDelete(records: readonly CheckpointRefRecord[], policy: RetentionPolicy): string[] {
	const candidates = records.filter((record) => isCheckpointRefName(record.name));
	const newest = [...candidates]
		.sort(
			(left, right) =>
				right.committedAtSeconds - left.committedAtSeconds ||
				(left.name < right.name ? 1 : left.name > right.name ? -1 : 0),
		)
		.slice(0, Math.max(0, policy.maxRefs));

	const retained = new Set<string>();
	for (const record of newest) {
		const ageSeconds = policy.nowSeconds - record.committedAtSeconds;
		if (ageSeconds <= policy.retentionDays * SECONDS_PER_DAY) retained.add(record.name);
	}

	return candidates
		.map((record) => record.name)
		.filter((name) => !retained.has(name))
		.sort();
}
