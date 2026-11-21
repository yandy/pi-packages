import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitRunner, GitCommandError, type GitResult, type GitRunOptions, type RunGit } from "../src/git.js";
import { buildPrunePlan, type CheckpointRefRecord, CheckpointPruner } from "../src/prune.js";
import { checkpointCommitSubject, checkpointRef } from "../src/refs.js";
import { resolveRepository, type RepositoryContext } from "../src/repository.js";
import { commitAll, createTestRepo, git, gitWithEnv, type TestRepo, writeRepoFile } from "./helpers/git-repo.js";

const DAY_SECONDS = 86_400;
const PLANNER_NOW = 1_700_000_000;
const ENUMERATION_MAX_BYTES = 16 * 1024 * 1024;
const ENUMERATION_FORMAT =
	"%(refname)%00%(objectname)%00%(objecttype)%00%(committerdate:unix)%00%(subject)";

const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);
const OID_C = "c".repeat(40);
const OID_D = "d".repeat(40);
const OID_E = "e".repeat(40);
const OID_F = "f".repeat(40);

const refA = checkpointRef("session-a", "run-a");
const refB = checkpointRef("session-a", "run-b");
const refC = checkpointRef("session-b", "run-c");
const refD = checkpointRef("session-b", "run-d");
const refE = checkpointRef("session-c", "run-e");
const refF = checkpointRef("session-c", "run-f");

function record(ref: string, timestamp: number, commit = OID_A): CheckpointRefRecord {
	return { ref, commit, timestamp };
}

function required<T>(value: T | null): T {
	if (value === null) throw new Error("expected a resolved value");
	return value;
}

// ---------------------------------------------------------------------------
// Pure planner
// ---------------------------------------------------------------------------

describe("buildPrunePlan", () => {
	const ttlDay = { retentionDays: 1, maxRefs: null };

	it("counts completed refs and expires only timestamps strictly before the cutoff", () => {
		const cutoff = PLANNER_NOW - DAY_SECONDS;
		const plan = buildPrunePlan(
			[record(refA, cutoff - 1), record(refB, cutoff), record(refC, PLANNER_NOW)],
			ttlDay,
			PLANNER_NOW,
		);

		expect(plan.completed).toBe(3);
		expect(plan.expired).toBe(1);
		expect(plan.overflow).toBe(0);
		expect(plan.selected).toBe(1);
		expect(plan.records).toEqual([record(refA, cutoff - 1)]);
	});

	it("orders selected records by timestamp and then by full refname", () => {
		const plan = buildPrunePlan(
			[
				record("refs/pi/checkpoint/b/b-run", PLANNER_NOW - 2 * DAY_SECONDS - 10),
				record("refs/pi/checkpoint/a/a-run", PLANNER_NOW - 2 * DAY_SECONDS - 10),
				record("refs/pi/checkpoint/c/c-run", PLANNER_NOW - 2 * DAY_SECONDS - 20),
			],
			ttlDay,
			PLANNER_NOW,
		);

		expect(plan.records.map((entry) => entry.ref)).toEqual([
			"refs/pi/checkpoint/c/c-run",
			"refs/pi/checkpoint/a/a-run",
			"refs/pi/checkpoint/b/b-run",
		]);
	});

	it("applies TTL before LRU and budgets only the surviving records", () => {
		const policy = { retentionDays: 1, maxRefs: 3 };
		const plan = buildPrunePlan(
			[
				record(refA, PLANNER_NOW - 2 * DAY_SECONDS),
				record(refB, PLANNER_NOW - 5 * 3_600),
				record(refC, PLANNER_NOW - 4 * 3_600),
				record(refD, PLANNER_NOW - 3 * 3_600),
				record(refE, PLANNER_NOW - 2 * 3_600),
				record(refF, PLANNER_NOW - 3_600),
			],
			policy,
			PLANNER_NOW,
		);

		expect(plan.completed).toBe(6);
		expect(plan.expired).toBe(1);
		// Five survivors exceed maxRefs = 3 by two; the expired ref must not be counted twice
		// as both a TTL and an LRU candidate.
		expect(plan.overflow).toBe(2);
		expect(plan.selected).toBe(3);
		expect(plan.records.map((entry) => entry.ref)).toEqual([refA, refB, refC]);
		expect(new Set(plan.records.map((entry) => entry.ref)).size).toBe(plan.selected);
	});

	it("keeps the newest completed refs when only maxRefs applies", () => {
		const plan = buildPrunePlan(
			[record(refA, 100), record(refB, 200), record(refC, 300)],
			{ retentionDays: null, maxRefs: 2 },
			PLANNER_NOW,
		);

		expect(plan).toMatchObject({ completed: 3, expired: 0, overflow: 1, selected: 1 });
		expect(plan.records).toEqual([record(refA, 100)]);
	});

	it("disables each dimension independently with null", () => {
		const records = [record(refA, 100), record(refB, PLANNER_NOW), record(refC, PLANNER_NOW + 1)];

		expect(buildPrunePlan(records, { retentionDays: null, maxRefs: null }, PLANNER_NOW)).toMatchObject({
			completed: 3,
			expired: 0,
			overflow: 0,
			selected: 0,
			records: [],
		});
		expect(buildPrunePlan(records, { retentionDays: null, maxRefs: 1 }, PLANNER_NOW)).toMatchObject({
			completed: 3,
			expired: 0,
			overflow: 2,
			selected: 2,
		});
		expect(buildPrunePlan(records, { retentionDays: 1, maxRefs: null }, PLANNER_NOW)).toMatchObject({
			completed: 3,
			expired: 1,
			overflow: 0,
			selected: 1,
		});
	});

	it("counts and orders completed refs globally across sessions", () => {
		const plan = buildPrunePlan(
			[
				record(refF, 600, OID_F),
				record(refA, 100, OID_A),
				record(refD, 500, OID_D),
				record(refC, 200, OID_C),
				record(refB, 400, OID_B),
				record(refE, 300, OID_E),
			],
			{ retentionDays: null, maxRefs: 3 },
			PLANNER_NOW,
		);

		expect(plan.completed).toBe(6);
		expect(plan.selected).toBe(3);
		expect(plan.records).toEqual([record(refA, 100, OID_A), record(refC, 200, OID_C), record(refE, 300, OID_E)]);
	});

	it("selects nothing when there are no completed refs", () => {
		expect(buildPrunePlan([], { retentionDays: 1, maxRefs: 1 }, PLANNER_NOW)).toMatchObject({
			completed: 0,
			expired: 0,
			overflow: 0,
			selected: 0,
			records: [],
		});
	});

	it("breaks maxRefs ties by full refname regardless of input order", () => {
		const plan = buildPrunePlan(
			[record(refF, PLANNER_NOW), record(refA, PLANNER_NOW), record(refD, PLANNER_NOW), record(refB, PLANNER_NOW)],
			{ retentionDays: null, maxRefs: 2 },
			PLANNER_NOW,
		);

		expect(plan.records.map((entry) => entry.ref)).toEqual([refA, refB].sort());
	});
});

// ---------------------------------------------------------------------------
// Executor against a mocked Git
// ---------------------------------------------------------------------------

interface GitCall {
	args: string[];
	options: GitRunOptions;
}

interface EnumerationEntry {
	ref: string;
	commit?: string;
	type?: string;
	timestamp?: number | string;
	subject?: string;
}

function enumeration(...entries: EnumerationEntry[]): string {
	const lines = entries.map((entry) =>
		[
			entry.ref,
			entry.commit ?? OID_A,
			entry.type ?? "commit",
			entry.timestamp ?? PLANNER_NOW,
			entry.subject ?? checkpointCommitSubject("result", entry.ref),
		].join("\0"),
	);
	return `${lines.join("\n")}\n`;
}

function baselineEntry(ref: string, timestamp: number, commit: string): EnumerationEntry {
	return { ref, commit, timestamp, subject: checkpointCommitSubject("baseline", ref) };
}

interface MockGitOptions {
	truncateEnumeration?: boolean;
	updateRefError?: Error;
}

function createMockGit(stdout: string, options: MockGitOptions = {}): { run: RunGit; calls: GitCall[] } {
	const calls: GitCall[] = [];
	const ok = (payload = ""): GitResult => ({ stdout: payload, stderr: "", code: 0, killed: false, truncated: false });
	const run: RunGit = async (args, runOptions) => {
		calls.push({ args, options: runOptions });
		if (args[0] === "for-each-ref") {
			if (options.truncateEnumeration) return { ...ok(stdout.slice(0, stdout.length - 1)), killed: true, truncated: true };
			return ok(stdout);
		}
		if (args[0] === "update-ref") {
			if (options.updateRefError) throw options.updateRefError;
			return ok();
		}
		throw new Error(`unexpected Git command: ${args.join(" ")}`);
	};
	return { run, calls };
}

function callsFor(calls: GitCall[], command: string): GitCall[] {
	return calls.filter((call) => call.args[0] === command);
}

const mockRepository: RepositoryContext = {
	worktreeRoot: "/virtual/repository/worktree",
	commonDir: "/virtual/repository/worktree/.git",
	head: null,
};

describe("CheckpointPruner with mocked Git", () => {
	it("parses NUL-separated fields and deletes only result commits with full old OIDs", async () => {
		const now = Math.floor(Date.now() / 1000);
		const stdout = enumeration(
			{ ref: refA, commit: OID_A, timestamp: now - 90 * DAY_SECONDS },
			{ ref: refB, commit: OID_B, timestamp: now - 80 * DAY_SECONDS },
			baselineEntry(refC, now - 100 * DAY_SECONDS, OID_C),
			{ ref: refD, commit: OID_D, timestamp: now - 110 * DAY_SECONDS, subject: "unrelated commit" },
			{ ref: refE, commit: OID_E, type: "tree", timestamp: "", subject: "" },
		);
		const { run, calls } = createMockGit(stdout);

		const report = await new CheckpointPruner(run).prune(mockRepository, { retentionDays: 1, maxRefs: null });

		expect(report).toEqual({
			commonDir: mockRepository.commonDir,
			completed: 2,
			expired: 2,
			overflow: 0,
			selected: 2,
			dryRun: false,
			deleted: 2,
		});

		const enumerations = callsFor(calls, "for-each-ref");
		expect(enumerations).toHaveLength(1);
		expect(enumerations[0].args[1]).toBe(`--format=${ENUMERATION_FORMAT}`);
		expect(enumerations[0].args[2]).toBe("refs/pi/checkpoint/");
		expect(enumerations[0].options.cwd).toBe(mockRepository.worktreeRoot);
		expect(enumerations[0].options.maxOutputBytes).toBe(ENUMERATION_MAX_BYTES);

		const updates = callsFor(calls, "update-ref");
		expect(updates).toHaveLength(1);
		expect(updates[0].args).toEqual(["update-ref", "--stdin"]);
		expect(updates[0].options.cwd).toBe(mockRepository.worktreeRoot);
		expect(updates[0].options.stdin).toBe(`delete ${refA} ${OID_A}\ndelete ${refB} ${OID_B}\n`);
	});

	it("returns the identical plan for a dry run without touching refs", async () => {
		const stdout = enumeration(
			{ ref: refA, commit: OID_A, timestamp: 100 },
			{ ref: refB, commit: OID_B, timestamp: 200 },
			{ ref: refC, commit: OID_C, timestamp: 300 },
		);
		const policy = { retentionDays: null, maxRefs: 2 };
		const dry = createMockGit(stdout);
		const wet = createMockGit(stdout);

		const dryReport = await new CheckpointPruner(dry.run).prune(mockRepository, policy, { dryRun: true });
		const wetReport = await new CheckpointPruner(wet.run).prune(mockRepository, policy);

		expect(dryReport).toEqual({ ...wetReport, dryRun: true, deleted: 0 });
		expect(wetReport.deleted).toBe(1);
		expect(callsFor(dry.calls, "update-ref")).toHaveLength(0);
		expect(callsFor(wet.calls, "update-ref")).toHaveLength(1);
	});

	it("never runs Git object maintenance", async () => {
		const { run, calls } = createMockGit(
			enumeration(
				{ ref: refA, commit: OID_A, timestamp: 100 },
				{ ref: refB, commit: OID_B, timestamp: 200 },
			),
		);

		await new CheckpointPruner(run).prune(mockRepository, { retentionDays: null, maxRefs: 1 });

		const forbidden = new Set(["gc", "prune", "repack", "pack-refs"]);
		for (const call of calls) {
			for (const arg of call.args) expect(forbidden.has(arg)).toBe(false);
			expect(call.args[0]).toMatch(/^(for-each-ref|update-ref)$/);
		}
	});

	it("fails closed on truncated enumeration output", async () => {
		const { run, calls } = createMockGit(enumeration({ ref: refA, commit: OID_A, timestamp: 100 }), {
			truncateEnumeration: true,
		});

		await expect(new CheckpointPruner(run).prune(mockRepository, { retentionDays: null, maxRefs: 1 })).rejects.toThrow(
			/truncated/,
		);
		expect(callsFor(calls, "update-ref")).toHaveLength(0);
	});

	it.each([
		[
			"an unterminated final record",
			enumeration(
				{ ref: refA, commit: OID_A, timestamp: 100 },
				{ ref: refB, commit: OID_B, timestamp: 200 },
			).slice(0, -1),
		],
		[
			"an interior blank record",
			`${enumeration({ ref: refA, commit: OID_A, timestamp: 100 })}\n` +
				enumeration({ ref: refB, commit: OID_B, timestamp: 200 }),
		],
	])("rejects %s", async (_label, stdout) => {
		const { run, calls } = createMockGit(stdout);

		await expect(
			new CheckpointPruner(run).prune(mockRepository, { retentionDays: null, maxRefs: 1 }),
		).rejects.toThrow(/malformed/);
		expect(callsFor(calls, "update-ref")).toHaveLength(0);
	});

	it("accepts an empty enumeration without touching refs", async () => {
		const { run, calls } = createMockGit("");

		const report = await new CheckpointPruner(run).prune(mockRepository, { retentionDays: 1, maxRefs: 1 });

		expect(report).toMatchObject({ completed: 0, selected: 0, deleted: 0 });
		expect(callsFor(calls, "update-ref")).toHaveLength(0);
	});

	it.each([
		["a missing field", `${refA}\0${OID_A}\0commit\0${PLANNER_NOW}\n`],
		["a non-numeric timestamp", enumeration({ ref: refA, commit: OID_A, timestamp: "not-a-number" })],
		["an empty timestamp", enumeration({ ref: refA, commit: OID_A, timestamp: "" })],
		["an abbreviated object id", enumeration({ ref: refA, commit: "abc1234", timestamp: PLANNER_NOW })],
		[
			"a duplicated ref",
			enumeration(
				{ ref: refA, commit: OID_A, timestamp: 100 },
				{ ref: refA, commit: OID_B, timestamp: 200 },
			),
		],
	])("fails closed on %s", async (_label, stdout) => {
		const { run, calls } = createMockGit(stdout);

		await expect(
			new CheckpointPruner(run).prune(mockRepository, { retentionDays: null, maxRefs: 1 }),
		).rejects.toThrow(/malformed/);
		expect(callsFor(calls, "update-ref")).toHaveLength(0);
	});

	it("propagates transaction failures without retrying an unsafe deletion", async () => {
		const failure = new GitCommandError(["update-ref", "--stdin"], {
			stdout: "",
			stderr: "fatal: cannot lock ref",
			code: 128,
			killed: false,
			truncated: false,
		});
		const { run, calls } = createMockGit(
			enumeration(
				{ ref: refA, commit: OID_A, timestamp: 100 },
				{ ref: refB, commit: OID_B, timestamp: 200 },
			),
			{ updateRefError: failure },
		);

		await expect(
			new CheckpointPruner(run).prune(mockRepository, { retentionDays: null, maxRefs: 1 }),
		).rejects.toBe(failure);

		const updates = callsFor(calls, "update-ref");
		expect(updates).toHaveLength(1);
		const lines = (updates[0].options.stdin ?? "").split("\n").filter((line) => line !== "");
		expect(lines).toEqual([`delete ${refA} ${OID_A}`]);
	});

	it("never charges baseline-only or unknown refs to the maxRefs budget", async () => {
		const { run, calls } = createMockGit(
			enumeration(
				baselineEntry(refA, 100, OID_A),
				baselineEntry(refB, 200, OID_B),
				{ ref: refC, commit: OID_C, timestamp: 300, subject: "pi-checkpoint baseline ref=other" },
				{ ref: refD, commit: OID_D, timestamp: 400 },
				{ ref: refE, commit: OID_E, timestamp: 500 },
				{ ref: refF, commit: OID_F, timestamp: 600 },
			),
		);

		const report = await new CheckpointPruner(run).prune(mockRepository, { retentionDays: null, maxRefs: 2 });

		expect(report).toMatchObject({ completed: 3, expired: 0, overflow: 1, selected: 1, deleted: 1 });
		expect(callsFor(calls, "update-ref")[0].options.stdin).toBe(`delete ${refD} ${OID_D}\n`);
	});

	it("performs no update when enumeration has no completed refs", async () => {
		const { run, calls } = createMockGit(enumeration(baselineEntry(refA, 100, OID_A)));

		const report = await new CheckpointPruner(run).prune(mockRepository, { retentionDays: 1, maxRefs: 1 });

		expect(report).toMatchObject({ completed: 0, selected: 0, deleted: 0 });
		expect(callsFor(calls, "update-ref")).toHaveLength(0);
	});

	it("ignores refs outside the checkpoint namespace", async () => {
		const { run, calls } = createMockGit(
			enumeration(
				{ ref: "refs/pi/elsewhere/run", commit: OID_A, timestamp: 100 },
				{ ref: refA, commit: OID_B, timestamp: 200 },
			),
		);

		const report = await new CheckpointPruner(run).prune(mockRepository, { retentionDays: null, maxRefs: 1 });

		expect(report).toMatchObject({ completed: 1, selected: 0, deleted: 0 });
		expect(callsFor(calls, "update-ref")).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Executor against real temporary repositories
// ---------------------------------------------------------------------------

describe("CheckpointPruner with real repositories", () => {
	let repos: TestRepo[];
	let tempDirs: string[];

	beforeEach(() => {
		repos = [];
		tempDirs = [];
	});

	afterEach(async () => {
		await Promise.all([...repos].reverse().map((repo) => repo.cleanup()));
		await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
	});

	async function makeRepo(): Promise<TestRepo> {
		const repo = await createTestRepo();
		repos.push(repo);
		await writeRepoFile(repo.dir, "file.txt", "base\n");
		await commitAll(repo.dir, "base");
		return repo;
	}

	async function createCheckpointCommit(
		dir: string,
		ref: string,
		kind: "baseline" | "result",
		timestampSeconds: number,
	): Promise<string> {
		const date = `${timestampSeconds} +0000`;
		const commit = await gitWithEnv(
			dir,
			{ GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
			"commit-tree",
			"HEAD^{tree}",
			"-m",
			checkpointCommitSubject(kind, ref),
		);
		await git(dir, "update-ref", ref, commit);
		return commit;
	}

	async function resolve(dir: string): Promise<RepositoryContext> {
		return required(await resolveRepository(createGitRunner(), dir));
	}

	it("never deletes a ref that moved after enumeration and rolls back the transaction", async () => {
		const repo = await makeRepo();
		await createCheckpointCommit(repo.dir, refA, "result", PLANNER_NOW - 300);
		const second = await createCheckpointCommit(repo.dir, refB, "result", PLANNER_NOW - 200);
		const third = await createCheckpointCommit(repo.dir, refC, "result", PLANNER_NOW - 100);
		const repository = await resolve(repo.dir);

		const moved = await git(repo.dir, "commit-tree", "HEAD^{tree}", "-m", checkpointCommitSubject("result", refA));
		const base = createGitRunner();
		let raced = false;
		const racingRunner: RunGit = async (args, options) => {
			const result = await base(args, options);
			if (!raced && args[0] === "for-each-ref") {
				raced = true;
				await git(repo.dir, "update-ref", refA, moved);
			}
			return result;
		};

		await expect(
			new CheckpointPruner(racingRunner).prune(repository, { retentionDays: null, maxRefs: 1 }),
		).rejects.toBeInstanceOf(GitCommandError);

		expect(raced).toBe(true);
		expect(await git(repo.dir, "rev-parse", refA)).toBe(moved);
		expect(await git(repo.dir, "rev-parse", refB)).toBe(second);
		expect(await git(repo.dir, "rev-parse", refC)).toBe(third);
	});

	it("enforces one global maxRefs budget across linked worktrees without touching baseline refs", async () => {
		const repo = await makeRepo();
		const baselineRef = checkpointRef("session-e", "run-5");
		const baseline = await createCheckpointCommit(repo.dir, baselineRef, "baseline", PLANNER_NOW - 500);
		const prunedRefs = [checkpointRef("session-a", "run-1"), checkpointRef("session-b", "run-2")];
		await createCheckpointCommit(repo.dir, prunedRefs[0], "result", PLANNER_NOW - 400);
		await createCheckpointCommit(repo.dir, prunedRefs[1], "result", PLANNER_NOW - 300);
		const kept = [
			await createCheckpointCommit(repo.dir, checkpointRef("session-c", "run-3"), "result", PLANNER_NOW - 200),
			await createCheckpointCommit(repo.dir, checkpointRef("session-d", "run-4"), "result", PLANNER_NOW - 100),
		];

		const parent = await mkdtemp(join(tmpdir(), "pi-checkpoint-prune-linked-"));
		tempDirs.push(parent);
		const linkedDir = join(parent, "worktree");
		await git(repo.dir, "worktree", "add", "-b", "linked", linkedDir);
		try {
			const repository = await resolve(linkedDir);
			expect(repository.commonDir).toBe(await realpath(join(repo.dir, ".git")));

			const report = await new CheckpointPruner().prune(repository, { retentionDays: null, maxRefs: 2 });

			expect(report).toEqual({
				commonDir: repository.commonDir,
				completed: 4,
				expired: 0,
				overflow: 2,
				selected: 2,
				dryRun: false,
				deleted: 2,
			});
			expect(await git(repo.dir, "rev-parse", checkpointRef("session-c", "run-3"))).toBe(kept[0]);
			expect(await git(repo.dir, "rev-parse", checkpointRef("session-d", "run-4"))).toBe(kept[1]);
			for (const ref of prunedRefs) {
				await expect(git(repo.dir, "rev-parse", "--verify", ref)).rejects.toThrow();
			}
			expect(await git(repo.dir, "rev-parse", baselineRef)).toBe(baseline);
			expect(await git(repo.dir, "for-each-ref", "--format=%(refname)", "refs/pi/checkpoint/")).toBe(
				[
					checkpointRef("session-c", "run-3"),
					checkpointRef("session-d", "run-4"),
					baselineRef,
				]
					.sort()
					.join("\n"),
			);
		} finally {
			await git(repo.dir, "worktree", "remove", "--force", linkedDir);
		}
	});

	it("leaves every ref in place for a dry run", async () => {
		const repo = await makeRepo();
		const oid = await createCheckpointCommit(repo.dir, refA, "result", PLANNER_NOW - 100);
		const repository = await resolve(repo.dir);

		const report = await new CheckpointPruner().prune(repository, { retentionDays: 1, maxRefs: null }, { dryRun: true });

		// PLANNER_NOW is far enough in the past that the TTL dimension expires the ref on any host clock.
		expect(report).toMatchObject({ completed: 1, expired: 1, selected: 1, dryRun: true, deleted: 0 });
		expect(await git(repo.dir, "rev-parse", refA)).toBe(oid);
	});
});
