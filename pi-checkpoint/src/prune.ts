import { createGitRunner, type RunGit } from "./git.js";
import { CHECKPOINT_REFS_PREFIX, isCheckpointResultSubject } from "./refs.js";
import type { RepositoryContext } from "./repository.js";
import type { RetentionPolicy } from "./retention-config.js";

/** A completed checkpoint ref: the commit is the result commit of one run. */
export interface CheckpointRefRecord {
	ref: string;
	commit: string;
	/** Committer time in Unix seconds. */
	timestamp: number;
}

export interface PrunePlan {
	/** Number of completed refs considered. */
	completed: number;
	/** Completed refs older than the TTL cutoff. */
	expired: number;
	/** Completed refs exceeding maxRefs after TTL expiration. */
	overflow: number;
	/** Unique refs to delete: the deduplicated union of expired and overflow. */
	selected: number;
	/** Selected records ordered by timestamp and then by full refname. */
	records: CheckpointRefRecord[];
}

export interface PruneReport {
	commonDir: string;
	completed: number;
	expired: number;
	overflow: number;
	selected: number;
	dryRun: boolean;
	deleted: number;
}

export interface PruneOptions {
	dryRun?: boolean;
}

const SECONDS_PER_DAY = 86_400;
const ENUMERATION_MAX_BYTES = 16 * 1024 * 1024;
const CHECKPOINT_REFS_SCOPE = `${CHECKPOINT_REFS_PREFIX}/`;
const FIELD_SEPARATOR = "\0";
const RECORD_SEPARATOR = "\n";
const ENUMERATION_FIELDS = [
	"%(refname)",
	"%(objectname)",
	"%(objecttype)",
	"%(committerdate:unix)",
	"%(subject)",
] as const;
const ENUMERATION_FORMAT = ENUMERATION_FIELDS.join("%00");
/** Full SHA-1 or SHA-256 object id; abbreviations are rejected. */
const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const UNIX_SECONDS = /^\d+$/;

/**
 * Selects completed checkpoint refs for deletion. Pure: no clock, no Git, no I/O.
 *
 * TTL runs first so expired refs never consume the maxRefs budget, then the oldest survivors
 * beyond maxRefs are selected. The union is deduplicated by refname and ordered deterministically.
 */
export function buildPrunePlan(
	records: readonly CheckpointRefRecord[],
	policy: RetentionPolicy,
	nowSeconds: number,
): PrunePlan {
	const cutoff = policy.retentionDays === null ? null : nowSeconds - policy.retentionDays * SECONDS_PER_DAY;
	const expired = cutoff === null ? [] : records.filter((record) => record.timestamp < cutoff);
	const expiredRefs = new Set(expired.map((record) => record.ref));
	const survivors = records.filter((record) => !expiredRefs.has(record.ref)).sort(compareRecords);
	const overflow =
		policy.maxRefs === null || survivors.length <= policy.maxRefs
			? []
			: survivors.slice(0, survivors.length - policy.maxRefs);
	const selected = uniqueByRef([...expired, ...overflow]);
	return {
		completed: records.length,
		expired: expired.length,
		overflow: overflow.length,
		selected: selected.length,
		records: selected,
	};
}

function compareRecords(a: CheckpointRefRecord, b: CheckpointRefRecord): number {
	if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
	if (a.ref === b.ref) return 0;
	return a.ref < b.ref ? -1 : 1;
}

function uniqueByRef(records: readonly CheckpointRefRecord[]): CheckpointRefRecord[] {
	const byRef = new Map<string, CheckpointRefRecord>();
	for (const record of records) if (!byRef.has(record.ref)) byRef.set(record.ref, record);
	return [...byRef.values()].sort(compareRecords);
}

/**
 * Enumerates checkpoint refs in one repository and deletes the planned ones.
 *
 * Fails closed: truncated or malformed enumeration and any Git failure reject without deleting
 * anything. Deletion is one `update-ref --stdin` transaction whose `delete` commands carry the
 * enumerated full object id, so a ref updated by another process aborts the whole sweep.
 */
export class CheckpointPruner {
	private readonly runGit: RunGit;

	constructor(runGit: RunGit = createGitRunner()) {
		this.runGit = runGit;
	}

	async prune(repository: RepositoryContext, policy: RetentionPolicy, options: PruneOptions = {}): Promise<PruneReport> {
		const records = await this.enumerate(repository);
		const plan = buildPrunePlan(records, policy, Math.floor(Date.now() / 1000));
		const dryRun = options.dryRun === true;
		let deleted = 0;
		if (!dryRun && plan.records.length > 0) {
			await this.runGit(["update-ref", "--stdin"], {
				cwd: repository.worktreeRoot,
				stdin: plan.records.map((record) => `delete ${record.ref} ${record.commit}${RECORD_SEPARATOR}`).join(""),
			});
			deleted = plan.records.length;
		}
		return {
			commonDir: repository.commonDir,
			completed: plan.completed,
			expired: plan.expired,
			overflow: plan.overflow,
			selected: plan.selected,
			dryRun,
			deleted,
		};
	}

	private async enumerate(repository: RepositoryContext): Promise<CheckpointRefRecord[]> {
		const result = await this.runGit(["for-each-ref", `--format=${ENUMERATION_FORMAT}`, CHECKPOINT_REFS_SCOPE], {
			cwd: repository.worktreeRoot,
			maxOutputBytes: ENUMERATION_MAX_BYTES,
		});
		if (result.truncated) throw new Error("checkpoint ref enumeration was truncated");
		return parseEnumeration(result.stdout);
	}
}

/**
 * Parses one newline-terminated record per ref. Framing is strict: empty output is the only
 * accepted non-terminated input, and an interior blank record is malformed rather than skipped.
 */
function parseEnumeration(stdout: string): CheckpointRefRecord[] {
	if (stdout === "") return [];
	if (!stdout.endsWith(RECORD_SEPARATOR)) {
		throw new Error("malformed checkpoint ref enumeration: unterminated record");
	}
	const lines = stdout.split(RECORD_SEPARATOR);
	// The final terminator leaves one empty remainder, which is not a record.
	lines.pop();
	const records: CheckpointRefRecord[] = [];
	const seen = new Set<string>();
	for (const line of lines) {
		if (line === "") {
			throw new Error("malformed checkpoint ref enumeration: blank record");
		}
		const fields = line.split(FIELD_SEPARATOR);
		if (fields.length !== ENUMERATION_FIELDS.length) {
			throw new Error(`malformed checkpoint ref enumeration record: expected ${ENUMERATION_FIELDS.length} fields`);
		}
		const [ref, commit, objectType, committerSeconds, subject] = fields;
		if (!ref.startsWith(CHECKPOINT_REFS_SCOPE)) continue;
		// Tags, trees and blobs are not checkpoint commits, so they are not candidates.
		if (objectType !== "commit") continue;
		if (!FULL_OBJECT_ID.test(commit)) {
			throw new Error(`malformed checkpoint ref enumeration record: bad object id for ${ref}`);
		}
		if (!UNIX_SECONDS.test(committerSeconds)) {
			throw new Error(`malformed checkpoint ref enumeration record: bad committer time for ${ref}`);
		}
		if (seen.has(ref)) {
			throw new Error(`malformed checkpoint ref enumeration record: duplicate ref ${ref}`);
		}
		seen.add(ref);
		if (!isCheckpointResultSubject(ref, subject)) continue;
		records.push({ ref, commit, timestamp: Number(committerSeconds) });
	}
	return records;
}
