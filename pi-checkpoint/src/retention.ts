import { resolveRepositoryContext } from "./checkpoint-store.js";
import { createGitRunner, type RunGit } from "./git.js";
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

export interface PruneResult {
	deleted: number;
	kept: number;
}

export interface PruneOptions {
	runGit?: RunGit;
	now?: () => Date;
	retentionDays?: number;
	maxRefs?: number;
	signal?: AbortSignal;
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

/**
 * Deletes stale checkpoint refs for the repository containing `cwd` in a single batched
 * `update-ref --stdin` call. Returns `null` when `cwd` is outside a Git worktree; any other Git
 * failure is thrown for the caller to handle.
 */
export async function pruneCheckpointRefs(cwd: string, options: PruneOptions = {}): Promise<PruneResult | null> {
	const runGit = options.runGit ?? createGitRunner();
	const repository = await resolveRepositoryContext(cwd, runGit);
	if (!repository) return null;

	const listing = await runGit(["for-each-ref", "--format=%(committerdate:unix) %(refname)", CHECKPOINT_REFS_PREFIX], {
		cwd: repository.worktreeRoot,
		env: { LC_ALL: "C" },
		signal: options.signal,
	});
	const records = parseRefListing(listing.stdout);
	const nowSeconds = Math.floor((options.now?.() ?? new Date()).getTime() / 1000);
	const deleteSet = selectRefsToDelete(records, {
		nowSeconds,
		retentionDays: options.retentionDays ?? RETENTION_DAYS,
		maxRefs: options.maxRefs ?? MAX_REFS_PER_REPO,
	});
	if (deleteSet.length === 0) return { deleted: 0, kept: records.length };

	await runGit(["update-ref", "--stdin"], {
		cwd: repository.worktreeRoot,
		signal: options.signal,
		stdin: deleteSet.map((name) => `delete ${name}\n`).join(""),
	});
	return { deleted: deleteSet.length, kept: records.length - deleteSet.length };
}

function parseRefListing(stdout: string): CheckpointRefRecord[] {
	const records: CheckpointRefRecord[] = [];
	for (const line of stdout.split("\n")) {
		const [rawSeconds, name] = line.trim().split(" ", 2);
		if (!rawSeconds || !name || !isCheckpointRefName(name)) continue;
		const committedAtSeconds = Number(rawSeconds);
		if (!Number.isInteger(committedAtSeconds)) continue;
		records.push({ name, committedAtSeconds });
	}
	return records;
}
