import { resolveRepositoryContext } from "./checkpoint-store.js";
import { createGitRunner, type GitResult, type RunGit } from "./git.js";
import { CHECKPOINT_REFS_PREFIX } from "./refs.js";

export const RETENTION_DAYS = 30;
export const MAX_REFS_PER_REPO = 200;
export const DEFAULT_SWEEP_TIMEOUT_MS = 10_000;

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
	/** Refs the listing accepted and kept. Refs under the prefix with a malformed shape or an unreadable date count as neither deleted nor kept. */
	kept: number;
}

export interface PruneOptions {
	runGit?: RunGit;
	now?: () => Date;
	retentionDays?: number;
	maxRefs?: number;
	signal?: AbortSignal;
}

export type SweepOutcome =
	| { status: "pruned"; deleted: number; kept: number }
	| { status: "skipped"; reason: "already-swept" | "not-a-worktree" }
	| { status: "failed"; error: string };

export interface SweeperOptions extends PruneOptions {
	timeoutMs?: number;
}

export interface RetentionSweeper {
	sweep(cwd: string, sweepOptions?: { force?: boolean }): Promise<SweepOutcome>;
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

/**
 * Builds a best-effort retention sweeper. Each instance remembers the common Git directories it has
 * already swept, so one session sweeps a repository once. `sweep` never throws: a missing worktree,
 * a repeated call, a Git failure, a timeout or truncated output all resolve to a {@link SweepOutcome}.
 */
export function createRetentionSweeper(options: SweeperOptions = {}): RetentionSweeper {
	const runGit = options.runGit ?? createGitRunner();
	const timeoutMs = options.timeoutMs ?? DEFAULT_SWEEP_TIMEOUT_MS;
	const sweptCommonDirs = new Set<string>();

	return {
		async sweep(cwd, sweepOptions = {}) {
			try {
				const controller = new AbortController();
				const forwardAbort = () => controller.abort();
				let timedOut = false;
				let interrupted = false;
				if (options.signal?.aborted) controller.abort();
				else options.signal?.addEventListener("abort", forwardAbort, { once: true });
				const timer = setTimeout(() => {
					timedOut = true;
					controller.abort();
				}, timeoutMs);

				// Every git call, including the three inside the repository-context resolve, is bounded:
				// an abort settles a still-pending runner call instead of waiting for it to finish.
				const guardedRunGit: RunGit = async (args, gitOptions) => {
					const result = await abortable(controller.signal, runGit(args, { ...gitOptions, signal: controller.signal }));
					if (result.killed || result.truncated) interrupted = true;
					return result;
				};

				try {
					const repository = await resolveRepositoryContext(cwd, guardedRunGit);
					if (!repository) return { status: "skipped", reason: "not-a-worktree" };
					if (!sweepOptions.force && sweptCommonDirs.has(repository.commonDir)) {
						return { status: "skipped", reason: "already-swept" };
					}
					// Recorded before pruning so a failed sweep is not retried by this instance.
					sweptCommonDirs.add(repository.commonDir);

					const result = await pruneCheckpointRefs(repository.worktreeRoot, {
						retentionDays: options.retentionDays,
						maxRefs: options.maxRefs,
						now: options.now,
						runGit: guardedRunGit,
						signal: controller.signal,
					});
					if (timedOut) return { status: "failed", error: timeoutMessage(timeoutMs) };
					if (interrupted || controller.signal.aborted) {
						return { status: "failed", error: "Retention sweep was interrupted" };
					}
					if (!result) return { status: "skipped", reason: "not-a-worktree" };
					return { status: "pruned", deleted: result.deleted, kept: result.kept };
				} catch (error) {
					if (timedOut) return { status: "failed", error: timeoutMessage(timeoutMs) };
					throw error;
				} finally {
					clearTimeout(timer);
					options.signal?.removeEventListener("abort", forwardAbort);
				}
			} catch (error) {
				return { status: "failed", error: cleanErrorMessage(error) };
			}
		},
	};
}

/**
 * Settles with whatever the runner eventually returned, or with an interrupted result as soon as
 * `signal` aborts. Without this, a runner call that ignores the signal would keep `sweep` pending
 * past its timeout.
 */
function abortable(signal: AbortSignal, pending: Promise<GitResult>): Promise<GitResult> {
	return new Promise<GitResult>((resolveResult, reject) => {
		let settled = false;
		const settle = (apply: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			apply();
		};
		const onAbort = () =>
			settle(() => resolveResult({ stdout: "", stderr: "", code: null, killed: true, truncated: false }));
		signal.addEventListener("abort", onAbort, { once: true });
		pending.then(
			(result) => settle(() => resolveResult(result)),
			(error: unknown) => settle(() => reject(error)),
		);
		// The signal may have aborted between the runner call and the listener registration.
		if (signal.aborted) onAbort();
	});
}

function timeoutMessage(timeoutMs: number): string {
	return `Retention sweep timed out after ${timeoutMs}ms`;
}

function cleanErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/\s+/g, " ").trim().slice(0, 500);
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
