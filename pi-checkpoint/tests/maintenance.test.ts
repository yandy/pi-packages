import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitRunner } from "../src/git.js";
import { createCheckpointMaintenance } from "../src/maintenance.js";
import { CheckpointPruner, type PruneReport } from "../src/prune.js";
import { DEFAULT_RETENTION_POLICY, type RetentionPolicy, retentionConfigPath } from "../src/retention-config.js";
import type { RepositoryContext } from "../src/repository.js";
import { commitAll, createTestRepo, git, gitWithEnv, type TestRepo, writeRepoFile } from "./helpers/git-repo.js";

const REPO: RepositoryContext = { worktreeRoot: "/repo", commonDir: "/repo/.git", head: "head" };
const OTHER_REPO: RepositoryContext = { worktreeRoot: "/other", commonDir: "/other/.git", head: "head" };
const POLICY: RetentionPolicy = { retentionDays: 30, maxRefs: 1000 };
const MANUAL_POLICY: RetentionPolicy = { retentionDays: 7, maxRefs: 50 };
const DISABLED_POLICY: RetentionPolicy = { retentionDays: null, maxRefs: null };
const REPORT: PruneReport = {
	commonDir: REPO.commonDir,
	completed: 4,
	expired: 1,
	overflow: 1,
	selected: 2,
	dryRun: false,
	deleted: 2,
};

function makeReport(overrides: Partial<PruneReport> = {}): PruneReport {
	return { ...REPORT, ...overrides };
}

function makeHarness() {
	const prune = vi.fn(async () => makeReport());
	const loadPolicy = vi.fn(async () => POLICY);
	const resolveRepository = vi.fn(async () => REPO as RepositoryContext | null);
	const notify = vi.fn();
	const ctx = { cwd: "/repo", ui: { notify } } as unknown as ExtensionContext;
	const maintenance = createCheckpointMaintenance({
		loadPolicy,
		resolveRepository,
		pruner: { prune },
	});
	return { maintenance, prune, loadPolicy, resolveRepository, notify, ctx };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

/**
 * Flushes mock continuations. Every dependency here is a mock, so a single macrotask drains the
 * whole microtask chain and no real I/O is racing the assertion.
 */
async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(condition: () => boolean, description: string, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${description} after ${timeoutMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("CheckpointMaintenance", () => {
	it("loads the global policy and sweeps at session start", async () => {
		const h = makeHarness();

		await h.maintenance.sessionStart(h.ctx);

		expect(h.loadPolicy).toHaveBeenCalledTimes(1);
		expect(h.resolveRepository).toHaveBeenCalledWith("/repo");
		expect(h.prune).toHaveBeenCalledWith(REPO, POLICY, { dryRun: false });
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("pruned 2 checkpoint refs"), "info");
	});

	it("reloads the policy at every session start", async () => {
		const h = makeHarness();
		await h.maintenance.sessionStart(h.ctx);
		h.prune.mockClear();
		h.loadPolicy.mockResolvedValue(MANUAL_POLICY);

		await h.maintenance.sessionStart(h.ctx);

		expect(h.loadPolicy).toHaveBeenCalledTimes(2);
		expect(h.prune).toHaveBeenCalledWith(REPO, MANUAL_POLICY, { dryRun: false });
	});

	it("skips the sweep when both retention dimensions are disabled", async () => {
		const h = makeHarness();
		h.loadPolicy.mockResolvedValue(DISABLED_POLICY);

		await h.maintenance.sessionStart(h.ctx);
		await h.maintenance.agentSettled(h.ctx);

		expect(h.resolveRepository).not.toHaveBeenCalled();
		expect(h.prune).not.toHaveBeenCalled();
		expect(h.notify).not.toHaveBeenCalled();
	});

	it("fails closed with a warning when the config is invalid", async () => {
		const h = makeHarness();
		h.loadPolicy.mockRejectedValue(new Error("Invalid checkpoint config at /agent/checkpoint.json: not valid JSON"));

		await expect(h.maintenance.sessionStart(h.ctx)).resolves.toBeUndefined();
		await expect(h.maintenance.agentSettled(h.ctx)).resolves.toBeUndefined();

		expect(h.loadPolicy).toHaveBeenCalledTimes(1);
		expect(h.resolveRepository).not.toHaveBeenCalled();
		expect(h.prune).not.toHaveBeenCalled();
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("retention"), "warning");
	});

	it("reuses the session policy when the agent settles", async () => {
		const h = makeHarness();
		await h.maintenance.sessionStart(h.ctx);
		h.prune.mockClear();
		h.notify.mockClear();
		h.loadPolicy.mockResolvedValue(MANUAL_POLICY);

		await h.maintenance.agentSettled(h.ctx);

		expect(h.loadPolicy).toHaveBeenCalledTimes(1);
		expect(h.prune).toHaveBeenCalledWith(REPO, POLICY, { dryRun: false });
	});

	it("does not sweep before a session policy is loaded", async () => {
		const h = makeHarness();

		await h.maintenance.agentSettled(h.ctx);

		expect(h.loadPolicy).not.toHaveBeenCalled();
		expect(h.prune).not.toHaveBeenCalled();
	});

	it("is silent for an automatic sweep with no deletions", async () => {
		const h = makeHarness();
		h.prune.mockResolvedValue(makeReport({ selected: 0, deleted: 0 }));

		await h.maintenance.sessionStart(h.ctx);

		expect(h.prune).toHaveBeenCalledTimes(1);
		expect(h.notify).not.toHaveBeenCalled();
	});

	it("skips non-Git working directories without notifying", async () => {
		const h = makeHarness();
		h.resolveRepository.mockResolvedValue(null);

		await h.maintenance.sessionStart(h.ctx);

		expect(h.resolveRepository).toHaveBeenCalledTimes(1);
		expect(h.prune).not.toHaveBeenCalled();
		expect(h.notify).not.toHaveBeenCalled();
	});

	it("serializes same-common-dir sweeps and coalesces automatic follow-ups", async () => {
		const h = makeHarness();
		const first = deferred<PruneReport>();
		h.prune.mockImplementationOnce(() => first.promise);

		const started = h.maintenance.sessionStart(h.ctx);
		await waitFor(() => h.prune.mock.calls.length === 1, "first sweep");
		const queuedA = h.maintenance.agentSettled(h.ctx);
		const queuedB = h.maintenance.agentSettled(h.ctx);
		await flush();
		expect(h.prune).toHaveBeenCalledTimes(1);

		first.resolve(makeReport());
		await Promise.all([started, queuedA, queuedB]);

		expect(h.prune).toHaveBeenCalledTimes(2);
		expect(h.prune.mock.calls[1][0]).toBe(REPO);
	});

	it("runs sweeps for different common dirs independently", async () => {
		const h = makeHarness();
		const first = deferred<PruneReport>();
		const second = deferred<PruneReport>();
		h.prune.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
		h.resolveRepository.mockImplementation(async (cwd: string) => (cwd === "/other" ? OTHER_REPO : REPO));
		const notifyOther = vi.fn();
		const ctxOther = { cwd: "/other", ui: { notify: notifyOther } } as unknown as ExtensionContext;

		const started = h.maintenance.sessionStart(h.ctx);
		await waitFor(() => h.prune.mock.calls.length === 1, "first sweep");
		const settled = h.maintenance.agentSettled(ctxOther);
		await waitFor(() => h.prune.mock.calls.length === 2, "independent second sweep");

		first.resolve(makeReport());
		second.resolve(makeReport({ commonDir: OTHER_REPO.commonDir, deleted: 0 }));
		await Promise.all([started, settled]);

		expect(h.prune.mock.calls[1][0]).toBe(OTHER_REPO);
		expect(notifyOther).not.toHaveBeenCalled();
	});

	it("drops queued work and stale notifications on reset", async () => {
		const h = makeHarness();
		const first = deferred<PruneReport>();
		h.prune.mockImplementationOnce(() => first.promise);

		const started = h.maintenance.sessionStart(h.ctx);
		await waitFor(() => h.prune.mock.calls.length === 1, "first sweep");
		const queued = h.maintenance.agentSettled(h.ctx);
		await waitFor(() => h.resolveRepository.mock.calls.length === 2, "queued sweep resolution");
		await flush();

		h.maintenance.reset();
		first.resolve(makeReport());
		await Promise.all([started, queued]);

		expect(h.prune).toHaveBeenCalledTimes(1);
		expect(h.notify).not.toHaveBeenCalled();
	});

	it("suppresses a stale manual report after reset", async () => {
		const h = makeHarness();
		const first = deferred<PruneReport>();
		h.prune.mockImplementationOnce(() => first.promise);

		const manual = h.maintenance.prune(h.ctx, false);
		await waitFor(() => h.prune.mock.calls.length === 1, "manual sweep");
		h.maintenance.reset();
		first.resolve(makeReport());
		await manual;

		expect(h.notify).not.toHaveBeenCalled();
	});

	it("reloads the policy and waits for prior work on manual prune", async () => {
		const h = makeHarness();
		const first = deferred<PruneReport>();
		const second = deferred<PruneReport>();
		h.prune.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);

		const started = h.maintenance.sessionStart(h.ctx);
		await waitFor(() => h.prune.mock.calls.length === 1, "session sweep");
		h.loadPolicy.mockResolvedValue(MANUAL_POLICY);
		const manual = h.maintenance.prune(h.ctx, true);
		await waitFor(() => h.loadPolicy.mock.calls.length === 2, "manual policy reload");
		await flush();
		expect(h.prune).toHaveBeenCalledTimes(1);

		first.resolve(makeReport());
		second.resolve(makeReport({ dryRun: true, deleted: 0 }));
		await Promise.all([started, manual]);

		expect(h.prune).toHaveBeenCalledTimes(2);
		expect(h.prune).toHaveBeenLastCalledWith(REPO, MANUAL_POLICY, { dryRun: true });
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("prune --dry-run"), "info");
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("to delete: 2"), "info");
	});

	it("reports an applied manual prune", async () => {
		const h = makeHarness();

		await h.maintenance.prune(h.ctx, false);

		expect(h.prune).toHaveBeenCalledWith(REPO, POLICY, { dryRun: false });
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("pruned 2 of 4"), "info");
	});

	it("does not sweep manually without an enabled policy", async () => {
		const h = makeHarness();
		h.loadPolicy.mockResolvedValue(DISABLED_POLICY);

		await h.maintenance.prune(h.ctx, false);

		expect(h.resolveRepository).not.toHaveBeenCalled();
		expect(h.prune).not.toHaveBeenCalled();
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("disabled"), "warning");
	});

	it("reports invalid config on manual prune without rejecting", async () => {
		const h = makeHarness();
		h.loadPolicy.mockRejectedValue(new Error("Invalid checkpoint config at /agent/checkpoint.json: not valid JSON"));

		await expect(h.maintenance.prune(h.ctx, false)).resolves.toBeUndefined();

		expect(h.prune).not.toHaveBeenCalled();
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("Invalid checkpoint config"), "warning");
	});

	it("reports a non-Git working directory on manual prune", async () => {
		const h = makeHarness();
		h.resolveRepository.mockResolvedValue(null);

		await expect(h.maintenance.prune(h.ctx, false)).resolves.toBeUndefined();

		expect(h.prune).not.toHaveBeenCalled();
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("Git worktree"), "warning");
	});

	it("never rejects into the agent lifecycle when resolution or pruning fails", async () => {
		const h = makeHarness();
		h.resolveRepository.mockRejectedValue(new Error("git rev-parse failed"));
		await expect(h.maintenance.sessionStart(h.ctx)).resolves.toBeUndefined();
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("retention"), "warning");

		h.notify.mockClear();
		h.resolveRepository.mockResolvedValue(REPO);
		h.prune.mockRejectedValue(new Error("git update-ref failed"));
		await expect(h.maintenance.agentSettled(h.ctx)).resolves.toBeUndefined();
		await expect(h.maintenance.prune(h.ctx, false)).resolves.toBeUndefined();
		expect(h.prune).toHaveBeenCalledTimes(2);
		expect(h.notify.mock.calls.every((call) => call[1] === "warning")).toBe(true);
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("git update-ref failed"), "warning");
	});
});

describe("CheckpointMaintenance global-only configuration", () => {
	let agentDir: string;
	let repo: TestRepo;

	beforeEach(async () => {
		agentDir = await mkdtemp(join(tmpdir(), "pi-checkpoint-agent-"));
		repo = await createTestRepo();
	});

	afterEach(async () => {
		await rm(agentDir, { recursive: true, force: true });
		await repo.cleanup();
	});

	it("ignores project-level configuration and uses the global default", async () => {
		await writeRepoFile(repo.dir, ".pi/checkpoint.json", JSON.stringify(DISABLED_POLICY));
		const prune = vi.fn(async () => makeReport({ selected: 0, deleted: 0 }));
		const maintenance = createCheckpointMaintenance({
			agentDir,
			resolveRepository: async () => ({ worktreeRoot: repo.dir, commonDir: join(repo.dir, ".git"), head: null }),
			pruner: { prune },
		});
		const ctx = { cwd: repo.dir, ui: { notify: vi.fn() } } as unknown as ExtensionContext;

		await maintenance.sessionStart(ctx);

		expect(prune).toHaveBeenCalledWith(expect.anything(), DEFAULT_RETENTION_POLICY, { dryRun: false });
	});

	it("rejects misspelled keys with zero prune calls and zero deletes", async () => {
		await writeFile(
			retentionConfigPath(agentDir),
			JSON.stringify({ retentionDay: "SENTINEL-CONTENT", maxrefs: 10_000 }),
			"utf8",
		);
		await writeRepoFile(repo.dir, "file.txt", "base\n");
		await commitAll(repo.dir, "base");
		const ref = "refs/pi/checkpoint/dHlwby10ZXN0/run-1";
		const date = "946684800 +0000";
		const result = await gitWithEnv(
			repo.dir,
			{ GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
			"commit-tree",
			"HEAD^{tree}",
			"-m",
			`pi-checkpoint result ref=${ref}`,
		);
		await git(repo.dir, "update-ref", ref, result);
		const pruner = new CheckpointPruner(createGitRunner());
		const prune = vi.spyOn(pruner, "prune");
		const maintenance = createCheckpointMaintenance({ agentDir, pruner });
		const notify = vi.fn();
		const ctx = { cwd: repo.dir, ui: { notify } } as unknown as ExtensionContext;

		await maintenance.sessionStart(ctx);
		await maintenance.prune(ctx, false);

		expect(prune).not.toHaveBeenCalled();
		expect(await git(repo.dir, "rev-parse", ref)).toBe(result);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("unknown top-level keys"), "warning");
		for (const call of notify.mock.calls) {
			expect(String(call[0])).not.toContain("retentionDay");
			expect(String(call[0])).not.toContain("maxrefs");
			expect(String(call[0])).not.toContain("SENTINEL-CONTENT");
		}
	});

	it("does not fall back to project config when the global config is invalid", async () => {
		await writeFile(retentionConfigPath(agentDir), "{ not json", "utf8");
		await writeRepoFile(repo.dir, ".pi/checkpoint.json", JSON.stringify({ retentionDays: 1, maxRefs: 1 }));
		const prune = vi.fn(async () => makeReport());
		const maintenance = createCheckpointMaintenance({
			agentDir,
			resolveRepository: async () => ({ worktreeRoot: repo.dir, commonDir: join(repo.dir, ".git"), head: null }),
			pruner: { prune },
		});
		const notify = vi.fn();
		const ctx = { cwd: repo.dir, ui: { notify } } as unknown as ExtensionContext;

		await maintenance.sessionStart(ctx);

		expect(prune).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("retention"), "warning");
	});
});
