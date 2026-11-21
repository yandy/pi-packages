import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGitRunner, type RunGit } from "./git.js";
import { CheckpointPruner, type PruneReport } from "./prune.js";
import { resolveRepository, type RepositoryContext } from "./repository.js";
import { loadRetentionPolicy, type RetentionPolicy } from "./retention-config.js";

export interface CheckpointMaintenance {
	/** Resets stale state, reloads the global policy, and requests one sweep for `ctx.cwd`. */
	sessionStart(ctx: ExtensionContext): Promise<void>;
	/** Requests a sweep with the policy captured at session start. */
	agentSettled(ctx: ExtensionContext): Promise<void>;
	/** Reloads the global policy, waits for prior work, and reports one manual sweep. */
	prune(ctx: ExtensionContext, dryRun: boolean): Promise<void>;
	/** Drops queued work and suppresses notifications from the previous session. */
	reset(): void;
}

export interface MaintenanceDependencies {
	/** Global retention policy loader; defaults to the package loader under `agentDir`. */
	loadPolicy?: () => Promise<RetentionPolicy>;
	/** Overrides the global agent dir used by the default loader; tests inject a temp dir. */
	agentDir?: string;
	/** Shared Git runner for the default resolver and pruner. */
	runGit?: RunGit;
	/** Repository resolver; defaults to the shared resolver over `runGit`. */
	resolveRepository?: (cwd: string, signal?: AbortSignal) => Promise<RepositoryContext | null>;
	/** Ref pruner; defaults to a `CheckpointPruner` over `runGit`. */
	pruner?: Pick<CheckpointPruner, "prune">;
}

type SweepKind = "automatic" | "manual";

interface SweepJob {
	kind: SweepKind;
	generation: number;
	ctx: ExtensionContext;
	repository: RepositoryContext;
	policy: RetentionPolicy;
	dryRun: boolean;
	settle: () => void;
	done: Promise<void>;
}

interface Lane {
	running: boolean;
	/** At most one queued automatic job: later automatic requests coalesce into it. */
	queue: SweepJob[];
}

export function createCheckpointMaintenance(deps: MaintenanceDependencies = {}): CheckpointMaintenance {
	const runGit = deps.runGit ?? createGitRunner();
	const loadPolicy = deps.loadPolicy ?? (() => loadRetentionPolicy(deps.agentDir));
	const resolveRepo =
		deps.resolveRepository ?? ((cwd: string, signal?: AbortSignal) => resolveRepository(runGit, cwd, signal));
	const pruner = deps.pruner ?? new CheckpointPruner(runGit);
	const lanes = new Map<string, Lane>();
	let generation = 0;
	let policyLoaded = false;
	let sessionPolicy: RetentionPolicy | null = null;

	const isCurrent = (jobGeneration: number) => jobGeneration === generation;

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning") => {
		// Notifications are best effort and must never fail a sweep or the agent lifecycle.
		try {
			ctx.ui.notify(message, level);
		} catch {}
	};

	const submit = (job: Omit<SweepJob, "settle" | "done">): Promise<void> => {
		let lane = lanes.get(job.repository.commonDir);
		if (!lane) {
			lane = { running: false, queue: [] };
			lanes.set(job.repository.commonDir, lane);
		}
		if (job.kind === "automatic") {
			const queued = lane.queue.find((candidate) => candidate.kind === "automatic");
			if (queued) return queued.done;
		}
		let settle!: () => void;
		const done = new Promise<void>((resolve) => {
			settle = resolve;
		});
		const entry: SweepJob = { ...job, settle, done };
		lane.queue.push(entry);
		void drain(job.repository.commonDir, lane);
		return done;
	};

	const drain = async (key: string, lane: Lane): Promise<void> => {
		if (lane.running) return;
		lane.running = true;
		try {
			while (lane.queue.length > 0) {
				const job = lane.queue.shift();
				if (!job) break;
				try {
					await runSweep(job);
				} catch {
					// A sweep must never reject into the agent lifecycle, even if a dependency throws
					// outside the guarded prune call.
				} finally {
					job.settle();
				}
			}
		} finally {
			lane.running = false;
			if (lane.queue.length === 0) lanes.delete(key);
		}
	};

	const runSweep = async (job: SweepJob): Promise<void> => {
		if (!isCurrent(job.generation)) return;
		let report: PruneReport;
		try {
			report = await pruner.prune(job.repository, job.policy, { dryRun: job.dryRun });
		} catch (error) {
			if (!isCurrent(job.generation)) return;
			const prefix = job.kind === "manual" ? "pi-checkpoint: prune failed" : "pi-checkpoint: retention sweep failed";
			notify(job.ctx, `${prefix}: ${errorMessage(error)}`, "warning");
			return;
		}
		if (!isCurrent(job.generation)) return;
		if (job.kind === "manual") {
			notify(job.ctx, manualReport(report, job.dryRun), "info");
			return;
		}
		if (report.deleted > 0) {
			notify(
				job.ctx,
				`pi-checkpoint: pruned ${report.deleted} checkpoint refs (expired ${report.expired}, overflow ${report.overflow})`,
				"info",
			);
		}
	};

	const reset = () => {
		generation += 1;
		policyLoaded = false;
		sessionPolicy = null;
		for (const [key, lane] of lanes) {
			const dropped = lane.queue.splice(0);
			for (const job of dropped) job.settle();
			if (!lane.running) lanes.delete(key);
		}
	};

	const requestAutomatic = async (ctx: ExtensionContext, policy: RetentionPolicy, jobGeneration: number) => {
		let repository: RepositoryContext | null;
		try {
			repository = await resolveRepo(ctx.cwd);
		} catch (error) {
			if (jobGeneration === generation) {
				notify(ctx, `pi-checkpoint: retention sweep failed: ${errorMessage(error)}`, "warning");
			}
			return;
		}
		if (jobGeneration !== generation || !repository) return;
		await submit({ kind: "automatic", generation: jobGeneration, ctx, repository, policy, dryRun: false });
	};

	return {
		async sessionStart(ctx) {
			reset();
			const jobGeneration = generation;
			let policy: RetentionPolicy;
			try {
				policy = await loadPolicy();
			} catch (error) {
				if (jobGeneration !== generation) return;
				policyLoaded = true;
				sessionPolicy = null;
				notify(ctx, `pi-checkpoint: retention sweep disabled: ${errorMessage(error)}`, "warning");
				return;
			}
			if (jobGeneration !== generation) return;
			policyLoaded = true;
			sessionPolicy = policy;
			if (isDisabled(policy)) return;
			await requestAutomatic(ctx, policy, jobGeneration);
		},

		async agentSettled(ctx) {
			// Settled work reuses the session policy instead of re-reading the config file.
			if (!policyLoaded || sessionPolicy === null || isDisabled(sessionPolicy)) return;
			await requestAutomatic(ctx, sessionPolicy, generation);
		},

		async prune(ctx, dryRun) {
			const jobGeneration = generation;
			let policy: RetentionPolicy;
			try {
				policy = await loadPolicy();
			} catch (error) {
				if (jobGeneration !== generation) return;
				notify(ctx, `pi-checkpoint: prune failed: ${errorMessage(error)}`, "warning");
				return;
			}
			if (jobGeneration !== generation) return;
			if (isDisabled(policy)) {
				notify(ctx, "pi-checkpoint: retention policy disabled (retentionDays and maxRefs are null)", "warning");
				return;
			}
			let repository: RepositoryContext | null;
			try {
				repository = await resolveRepo(ctx.cwd);
			} catch (error) {
				if (jobGeneration !== generation) return;
				notify(ctx, `pi-checkpoint: prune failed: ${errorMessage(error)}`, "warning");
				return;
			}
			if (jobGeneration !== generation) return;
			if (!repository) {
				notify(ctx, "pi-checkpoint: not inside a Git worktree; nothing to prune", "warning");
				return;
			}
			await submit({ kind: "manual", generation: jobGeneration, ctx, repository, policy, dryRun });
		},

		reset,
	};
}

function isDisabled(policy: RetentionPolicy): boolean {
	return policy.retentionDays === null && policy.maxRefs === null;
}

function manualReport(report: PruneReport, dryRun: boolean): string {
	const counts = `expired: ${report.expired}\noverflow: ${report.overflow}`;
	if (dryRun) {
		return `pi-checkpoint: prune --dry-run\ncompleted: ${report.completed}\n${counts}\nto delete: ${report.selected}`;
	}
	return `pi-checkpoint: pruned ${report.deleted} of ${report.completed} completed checkpoint refs\n${counts}`;
}

function errorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/\s+/g, " ").trim().slice(0, 300);
}
