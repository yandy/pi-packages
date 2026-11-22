import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { resolveRepositoryContext } from "./checkpoint-store.js";
import { createGitRunner, type GitResult, type RunGit } from "./git.js";
import { CHECKPOINT_REFS_PREFIX, checkpointCommitSubject, type RecordedCheckpointCommit } from "./refs.js";

export const RETENTION_DAYS = 30;
export const MAX_REFS_PER_REPO = 200;
export const DEFAULT_SWEEP_TIMEOUT_MS = 10_000;

const SECONDS_PER_DAY = 86_400;
const FIELD_SEPARATOR = "\x1f";
const FIELD_COUNT = 7;
/**
 * One record per ref. `%(parent)` exposes the commit graph, which is what separates a result
 * snapshot written by this package from a hand-written commit that merely copied the subject.
 */
const REF_LISTING_FORMAT =
	"--format=%(objecttype)%1f%(objectname)%1f%(committerdate:unix)%1f%(parent)%1f%(subject)%1f%(refname)%1f%(symref)";
/** Full SHA-1 or SHA-256 object id; abbreviated ids are not trustworthy for a conditional delete. */
const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const UNIX_SECONDS = /^\d+$/;

/** A ref whose latest commit is a result snapshot of that same ref, so it is a prune candidate. */
export interface CheckpointRefRecord {
	name: string;
	committedAtSeconds: number;
	objectOid: string;
}

export interface RetentionPolicy {
	nowSeconds: number;
	retentionDays: number;
	maxRefs: number;
}

export interface PrunePlan {
	/** Completed refs older than the retention window, oldest first. */
	expired: CheckpointRefRecord[];
	/** Completed refs outside the newest `maxRefs` after the TTL pass, oldest first. */
	overflow: CheckpointRefRecord[];
	/** Deduplicated union of both reasons, oldest first, ties broken by ref name. */
	selected: CheckpointRefRecord[];
}

export interface PruneResult {
	dryRun: boolean;
	/** Refs whose latest commit is a result snapshot of that ref. */
	completed: number;
	/** Refs whose latest commit is a baseline snapshot: never auto-deleted and never counted against `maxRefs`. */
	baselineOnly: number;
	/** Refs under the prefix that are not recognized checkpoint snapshots. */
	unknown: number;
	/** Completed refs selected because they are older than `retentionDays`. */
	expired: number;
	/** Completed refs selected because they fall outside the newest `maxRefs`. */
	overflow: number;
	/** Unique refs selected for deletion; `expired + overflow` minus the refs selected for both reasons. */
	selected: number;
	/** Refs actually deleted; always 0 for a dry run. */
	deleted: number;
	/** Completed refs that remain after the planned or applied deletion. */
	kept: number;
	retentionDays: number;
	maxRefs: number;
}

export interface PruneOptions {
	runGit?: RunGit;
	now?: () => Date;
	retentionDays?: number;
	maxRefs?: number;
	/** Plans the same selection without calling `update-ref`. */
	dryRun?: boolean;
	/** Snapshot commits this session's entries assert, used to cross-check completed refs. */
	recorded?: ReadonlyMap<string, RecordedCheckpointCommit>;
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
	sweep(
		cwd: string,
		sweepOptions?: { force?: boolean; recorded?: ReadonlyMap<string, RecordedCheckpointCommit> },
	): Promise<SweepOutcome>;
}

export function isCheckpointRefName(name: string): boolean {
	const prefix = `${CHECKPOINT_REFS_PREFIX}/`;
	if (!name.startsWith(prefix)) return false;
	const segments = name.slice(prefix.length).split("/");
	return segments.length === 2 && segments.every((segment) => segment.length > 0);
}

/**
 * Selects completed checkpoint refs for deletion. Pure: no clock, no Git, no I/O.
 *
 * TTL runs first so expired refs never consume the `maxRefs` budget, then the oldest survivors
 * beyond `maxRefs` are selected. The union is deduplicated by refname and ordered deterministically,
 * so a dry run and the following real run produce the same plan.
 */
export function buildPrunePlan(records: readonly CheckpointRefRecord[], policy: RetentionPolicy): PrunePlan {
	const cutoff = policy.nowSeconds - policy.retentionDays * SECONDS_PER_DAY;
	const expired = records.filter((record) => record.committedAtSeconds < cutoff).sort(compareOldestFirst);
	const expiredNames = new Set(expired.map((record) => record.name));
	const survivors = records.filter((record) => !expiredNames.has(record.name)).sort(compareOldestFirst);
	const maxRefs = Math.max(0, policy.maxRefs);
	const overflow = survivors.length <= maxRefs ? [] : survivors.slice(0, survivors.length - maxRefs);
	return { expired, overflow, selected: uniqueByName([...expired, ...overflow]) };
}

function compareOldestFirst(left: CheckpointRefRecord, right: CheckpointRefRecord): number {
	if (left.committedAtSeconds !== right.committedAtSeconds) return left.committedAtSeconds - right.committedAtSeconds;
	if (left.name === right.name) return 0;
	return left.name < right.name ? -1 : 1;
}

function uniqueByName(records: readonly CheckpointRefRecord[]): CheckpointRefRecord[] {
	const byName = new Map<string, CheckpointRefRecord>();
	for (const record of records) if (!byName.has(record.name)) byName.set(record.name, record);
	return [...byName.values()].sort(compareOldestFirst);
}

/**
 * Deletes stale completed checkpoint refs for the repository containing `cwd`. Returns `null` when
 * `cwd` is outside a Git worktree; any other Git failure is thrown for the caller to handle.
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
	const retentionDays = options.retentionDays ?? RETENTION_DAYS;
	const maxRefs = options.maxRefs ?? MAX_REFS_PER_REPO;
	const policy: RetentionPolicy = { nowSeconds, retentionDays, maxRefs };
	const dryRun = options.dryRun === true;
	const enumerate = () => classifyCheckpointRefs(repository.worktreeRoot, runGit, options);

	const listed = await enumerate();
	const plan = buildPrunePlan(listed.completed, policy);
	if (dryRun) return summarize(listed, plan, policy, true, 0, listed.completed.length - plan.selected.length);
	if (plan.selected.length === 0) return summarize(listed, plan, policy, false, 0, listed.completed.length);

	const applied = await deleteCheckpointRefs(
		repository.worktreeRoot,
		repository.commonDir,
		runGit,
		plan.selected,
		options.signal,
	).then(
		() => true,
		() => false,
	);
	if (applied) {
		return summarize(listed, plan, policy, false, plan.selected.length, listed.completed.length - plan.selected.length);
	}

	// Someone else moved a listed ref. Recompute once against fresh OIDs instead of retrying stale ones;
	// a second failure is the caller's problem to report.
	const retried = await enumerate();
	const retryPlan = buildPrunePlan(retried.completed, policy);
	if (retryPlan.selected.length === 0) {
		return summarize(retried, retryPlan, policy, false, 0, retried.completed.length);
	}

	await deleteCheckpointRefs(repository.worktreeRoot, repository.commonDir, runGit, retryPlan.selected, options.signal);
	return summarize(
		retried,
		retryPlan,
		policy,
		false,
		retryPlan.selected.length,
		retried.completed.length - retryPlan.selected.length,
	);
}

function summarize(
	listed: ClassifiedRefs,
	plan: PrunePlan,
	policy: RetentionPolicy,
	dryRun: boolean,
	deleted: number,
	kept: number,
): PruneResult {
	return {
		dryRun,
		completed: listed.completed.length,
		baselineOnly: listed.baselineOnly,
		unknown: listed.unknown,
		expired: plan.expired.length,
		overflow: plan.overflow.length,
		selected: plan.selected.length,
		deleted,
		kept,
		retentionDays: policy.retentionDays,
		maxRefs: policy.maxRefs,
	};
}

interface ClassifiedRefs {
	completed: CheckpointRefRecord[];
	baselineOnly: number;
	unknown: number;
}

interface EnumeratedRef {
	name: string;
	objectOid: string;
	committedAtSeconds: number | null;
	objectType: string;
	parents: string[];
	subject: string;
}

/**
 * Lists every ref under the checkpoint prefix and classifies it by its latest commit.
 *
 * Only `completed` refs may be deleted: the ref must point at a commit whose subject names that exact
 * ref as a result snapshot and whose single parent is the baseline snapshot for the same ref. The
 * subject alone is not evidence, because any local writer can copy it; the parent link ties the result
 * to a baseline this package wrote for the same ref. When the current session recorded the run, its
 * exact baseline/result commit ids are required as well. Baseline-only refs (an in-flight run or crash
 * residue) are never candidates and never consume the `maxRefs` budget, so a sweep cannot break a run
 * that has not produced its result yet.
 *
 * A listing that did not run to completion is useless for classification: the runner kills the child
 * on output truncation, which can race a clean exit code, so a partial list must never be treated as
 * the repository's ref set.
 */
async function classifyCheckpointRefs(
	worktreeRoot: string,
	runGit: RunGit,
	options: PruneOptions,
): Promise<ClassifiedRefs> {
	const listing = await runGit(["for-each-ref", REF_LISTING_FORMAT, CHECKPOINT_REFS_PREFIX], {
		cwd: worktreeRoot,
		env: { LC_ALL: "C" },
		signal: options.signal,
	});
	if (listing.code !== 0 || listing.killed || listing.truncated) {
		throw new Error("Checkpoint ref listing did not complete");
	}
	const enumerated = parseRefListing(listing.stdout);

	const candidates: { record: CheckpointRefRecord; parent: string }[] = [];
	let baselineOnly = 0;
	let unknown = 0;
	for (const ref of enumerated) {
		if (!isCheckpointRefName(ref.name)) {
			unknown += 1;
			continue;
		}
		if (ref.objectType !== "commit" || !FULL_OBJECT_ID.test(ref.objectOid) || ref.committedAtSeconds === null) {
			unknown += 1;
			continue;
		}
		if (ref.subject === checkpointCommitSubject("baseline", ref.name)) {
			baselineOnly += 1;
			continue;
		}
		if (ref.subject !== checkpointCommitSubject("result", ref.name) || ref.parents.length !== 1) {
			unknown += 1;
			continue;
		}
		candidates.push({
			record: { name: ref.name, objectOid: ref.objectOid, committedAtSeconds: ref.committedAtSeconds },
			parent: ref.parents[0] as string,
		});
	}

	const parentSubjects = await lookupCommitSubjects(
		worktreeRoot,
		runGit,
		[...new Set(candidates.map((candidate) => candidate.parent))],
		options.signal,
	);
	const completed: CheckpointRefRecord[] = [];
	for (const candidate of candidates) {
		if (parentSubjects.get(candidate.parent) !== checkpointCommitSubject("baseline", candidate.record.name)) {
			unknown += 1;
			continue;
		}
		const recorded = options.recorded?.get(candidate.record.name);
		if (
			recorded &&
			(recorded.resultCommit !== candidate.record.objectOid || recorded.baselineCommit !== candidate.parent)
		) {
			unknown += 1;
			continue;
		}
		completed.push(candidate.record);
	}
	return { completed, baselineOnly, unknown };
}

/**
 * Reads the subjects of the baseline commits referenced by candidate result commits. One call for all
 * of them; a lookup that did not complete makes the whole pass fail closed.
 */
async function lookupCommitSubjects(
	worktreeRoot: string,
	runGit: RunGit,
	oids: readonly string[],
	signal?: AbortSignal,
): Promise<Map<string, string>> {
	const subjects = new Map<string, string>();
	if (oids.length === 0) return subjects;
	const result = await runGit(["log", "--no-walk=unsorted", "--format=%H%x1f%s", "--stdin"], {
		cwd: worktreeRoot,
		env: { LC_ALL: "C" },
		signal,
		stdin: oids.map((oid) => `${oid}\n`).join(""),
	});
	if (result.code !== 0 || result.killed || result.truncated) {
		throw new Error("Checkpoint baseline lookup did not complete");
	}
	for (const line of result.stdout.split("\n")) {
		if (line === "") continue;
		const fields = line.split(FIELD_SEPARATOR);
		// A subject can legally contain the separator; treat such a record as unreadable instead of
		// silently accepting a truncated subject as proof.
		if (fields.length !== 2) throw new Error("Checkpoint baseline lookup did not complete");
		const [oid, subject] = fields as [string, string];
		if (oid === "") throw new Error("Checkpoint baseline lookup did not complete");
		subjects.set(oid, subject);
	}
	return subjects;
}

/**
 * Applies one conditional `update-ref --stdin` transaction; any mismatch aborts the whole batch.
 *
 * `--no-deref` is mandatory: without it a symbolic checkpoint ref makes git delete the ref it points
 * at (typically a user's branch) and leave the symbolic ref behind. The transaction also runs with an
 * empty hooks directory, because `update-ref` fires the repository's `reference-transaction` hook, and
 * a background sweep must not execute or block on arbitrary repository code.
 */
async function deleteCheckpointRefs(
	worktreeRoot: string,
	commonDir: string,
	runGit: RunGit,
	deleteSet: readonly CheckpointRefRecord[],
	signal?: AbortSignal,
): Promise<void> {
	const temporaryDirectory = await mkdtemp(join(commonDir, "pi-checkpoint-prune-"));
	try {
		const result = await runGit(
			["-c", `core.hooksPath=${join(temporaryDirectory, "hooks")}`, "update-ref", "--no-deref", "--stdin"],
			{
				cwd: worktreeRoot,
				signal,
				stdin: deleteSet.map((record) => `delete ${record.name} ${record.objectOid}\n`).join(""),
			},
		);
		if (result.code !== 0 || result.killed || result.truncated) {
			throw new Error("Checkpoint ref deletion did not complete");
		}
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
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
						recorded: sweepOptions.recorded,
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

/**
 * Parses one newline-terminated record per ref. A symbolic ref is skipped entirely: `for-each-ref`
 * reports its target's object and date, so deleting it would speak about a ref that was never
 * enumerated, and any non-deref mistake would remove whatever it points at.
 */
function parseRefListing(stdout: string): EnumeratedRef[] {
	const refs: EnumeratedRef[] = [];
	for (const line of stdout.split("\n")) {
		if (line === "") continue;
		const fields = line.split(FIELD_SEPARATOR);
		if (fields.length !== FIELD_COUNT) continue;
		const [objectType, objectOid, rawSeconds, parentField, subject, name, symref] = fields as [
			string,
			string,
			string,
			string,
			string,
			string,
			string,
		];
		if (symref) continue;
		refs.push({
			name,
			objectOid,
			committedAtSeconds: UNIX_SECONDS.test(rawSeconds) ? Number(rawSeconds) : null,
			objectType,
			parents: parentField === "" ? [] : parentField.split(" "),
			subject,
		});
	}
	return refs;
}
