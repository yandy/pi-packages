import { resolveRepositoryContext } from "./checkpoint-store.js";
import { createGitRunner, type GitResult, type RunGit } from "./git.js";
import { CHECKPOINT_REFS_PREFIX } from "./refs.js";

export const RETENTION_DAYS = 30;
export const MAX_REFS_PER_REPO = 200;
export const DEFAULT_SWEEP_TIMEOUT_MS = 10_000;

const SECONDS_PER_DAY = 86_400;
const REF_LISTING_FORMAT = "--format=%(committerdate:unix) %(objectname) %(refname)";

export interface CheckpointRefRecord {
	name: string;
	committedAtSeconds: number;
}

/** A listed ref plus the commit it pointed at while the listing ran. */
interface EnumeratedCheckpointRef extends CheckpointRefRecord {
	objectOid: string;
}

export interface RetentionPolicy {
	nowSeconds: number;
	retentionDays: number;
	maxRefs: number;
}

export interface PruneResult {
	/** Refs deleted by the successful pass. */
	deleted: number;
	/** `enumerated - deleted` for the pass that succeeded. Refs under the prefix with a malformed shape or an unreadable date count as neither deleted nor kept. */
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
 * Deletes stale checkpoint refs for the repository containing `cwd`. Returns `null` when `cwd` is outside
 * a Git worktree; any other Git failure is thrown for the caller to handle.
 *
 * Protocol: one listing, then one conditional `update-ref --stdin` transaction of
 * `delete <ref> <oid>` lines. Git applies the whole batch or nothing, and refuses a line whose ref no
 * longer points at the listed commit, so a ref rewritten between the listing and the delete (a run's
 * baseline ref updated to a fresh result, or another sweeper) is never deleted on stale information.
 * A failed transaction is retried once from a fresh listing with the same `now`. Truncated, killed or
 * non-zero listings are refused outright: an incomplete listing would otherwise select refs that were
 * never enumerated. Concurrent sweeps stay non-fatal: the second conditional delete fails, it
 * re-enumerates, finds nothing stale and reports `{ deleted: 0, kept: n }`.
 */
export async function pruneCheckpointRefs(cwd: string, options: PruneOptions = {}): Promise<PruneResult | null> {
	const runGit = options.runGit ?? createGitRunner();
	const repository = await resolveRepositoryContext(cwd, runGit);
	if (!repository) return null;

	const nowSeconds = Math.floor((options.now?.() ?? new Date()).getTime() / 1000);
	const policy: RetentionPolicy = {
		nowSeconds,
		retentionDays: options.retentionDays ?? RETENTION_DAYS,
		maxRefs: options.maxRefs ?? MAX_REFS_PER_REPO,
	};
	const enumerate = () => enumerateCheckpointRefs(repository.worktreeRoot, runGit, options.signal);

	const records = await enumerate();
	const deleteSet = selectRefsToDelete(records, policy);
	if (deleteSet.length === 0) return { deleted: 0, kept: records.length };

	const applied = await deleteCheckpointRefs(repository.worktreeRoot, runGit, records, deleteSet, options.signal).then(
		() => true,
		() => false,
	);
	if (applied) return { deleted: deleteSet.length, kept: records.length - deleteSet.length };

	// Someone else moved a listed ref. Recompute once against fresh OIDs instead of retrying stale ones;
	// a second failure is the caller's problem to report.
	const retried = await enumerate();
	const retrySet = selectRefsToDelete(retried, policy);
	if (retrySet.length === 0) return { deleted: 0, kept: retried.length };

	await deleteCheckpointRefs(repository.worktreeRoot, runGit, retried, retrySet, options.signal);
	return { deleted: retrySet.length, kept: retried.length - retrySet.length };
}

/**
 * Lists eligible refs with their commit IDs. A listing that did not run to completion is useless for
 * selection: the runner kills the child on output truncation, which can race a clean exit code, so a
 * partial list must never be treated as the repository's ref set.
 */
async function enumerateCheckpointRefs(
	worktreeRoot: string,
	runGit: RunGit,
	signal?: AbortSignal,
): Promise<EnumeratedCheckpointRef[]> {
	const listing = await runGit(["for-each-ref", REF_LISTING_FORMAT, CHECKPOINT_REFS_PREFIX], {
		cwd: worktreeRoot,
		env: { LC_ALL: "C" },
		signal,
	});
	if (listing.code !== 0 || listing.killed || listing.truncated) {
		throw new Error("Checkpoint ref listing did not complete");
	}
	return parseRefListing(listing.stdout);
}

/** Applies one conditional `update-ref --stdin` transaction; any mismatch aborts the whole batch. */
async function deleteCheckpointRefs(
	worktreeRoot: string,
	runGit: RunGit,
	records: readonly EnumeratedCheckpointRef[],
	deleteSet: readonly string[],
	signal?: AbortSignal,
): Promise<void> {
	const objectOids = new Map(records.map((record) => [record.name, record.objectOid]));
	const result = await runGit(["update-ref", "--stdin"], {
		cwd: worktreeRoot,
		signal,
		stdin: deleteSet.map((name) => `delete ${name} ${objectOids.get(name)}\n`).join(""),
	});
	if (result.code !== 0 || result.killed || result.truncated) {
		throw new Error("Checkpoint ref deletion did not complete");
	}
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

function parseRefListing(stdout: string): EnumeratedCheckpointRef[] {
	const records: EnumeratedCheckpointRef[] = [];
	for (const line of stdout.split("\n")) {
		const [rawSeconds, objectOid, name] = line.trim().split(" ", 3);
		if (!rawSeconds || !objectOid || !name || !isCheckpointRefName(name)) continue;
		const committedAtSeconds = Number(rawSeconds);
		if (!Number.isInteger(committedAtSeconds)) continue;
		records.push({ name, committedAtSeconds, objectOid });
	}
	return records;
}
