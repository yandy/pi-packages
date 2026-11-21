import { randomUUID } from "node:crypto";
import type { AgentSettledEvent, BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CheckpointStore, Snapshot } from "./checkpoint-store.js";
import type { DiffInput, DiffPreview } from "./diff.js";
import { GitUnavailableError } from "./git.js";
import { checkpointRef } from "./refs.js";
import {
	CHECKPOINT_ENTRY_TYPE,
	type CheckpointEntryData,
	nextRunNumber,
	resolveSourceEntryId,
} from "./session.js";

export interface CheckpointCoordinator {
	beforeAgentStart(event: BeforeAgentStartEvent, ctx: ExtensionContext): Promise<void>;
	agentSettled(event: AgentSettledEvent, ctx: ExtensionContext): Promise<void>;
	reset(): void;
}

interface CoordinatorDependencies {
	pi: Pick<ExtensionAPI, "appendEntry">;
	store: Pick<CheckpointStore, "captureBaseline" | "captureResult">;
	preview: (input: DiffInput) => Promise<DiffPreview>;
	randomUUID?: () => string;
	now?: () => Date;
}

interface ActiveRun {
	runId: string;
	runNumber: number;
	previousLeafId: string | null;
	messageType: "user" | "custom";
	startedAt: string;
	ref: string;
	generation: number;
	controller: AbortController;
	baseline?: Snapshot;
}

export function createCheckpointCoordinator(deps: CoordinatorDependencies): CheckpointCoordinator {
	const makeRunId = deps.randomUUID ?? randomUUID;
	const now = deps.now ?? (() => new Date());
	let generation = 0;
	let active: ActiveRun | undefined;
	let unavailableWarned = false;

	const isCurrent = (run: ActiveRun) => active === run && generation === run.generation;
	const timestamp = () => now().toISOString();
	const notifyUnavailable = (ctx: ExtensionContext) => {
		if (unavailableWarned) return;
		unavailableWarned = true;
		ctx.ui.notify("pi-checkpoint: Git worktree unavailable; checkpoint capture skipped", "warning");
	};
	const append = (data: CheckpointEntryData) => deps.pi.appendEntry(CHECKPOINT_ENTRY_TYPE, data);
	const baseData = (run: ActiveRun) => ({
		version: 1 as const,
		runId: run.runId,
		runNumber: run.runNumber,
		previousLeafId: run.previousLeafId,
		messageType: run.messageType,
		startedAt: run.startedAt,
	});

	return {
		async beforeAgentStart(event, ctx) {
			if (active) return;
			const run: ActiveRun = {
				runId: makeRunId(),
				runNumber: nextRunNumber(ctx.sessionManager.getEntries()),
				previousLeafId: ctx.sessionManager.getLeafId() ?? null,
				messageType: event.messageType,
				startedAt: timestamp(),
				ref: "",
				generation,
				controller: new AbortController(),
			};
			run.ref = checkpointRef(ctx.sessionManager.getSessionId(), run.runId);
			active = run;
			try {
				const baseline = await deps.store.captureBaseline(ctx.cwd, run.ref, run.controller.signal);
				if (!isCurrent(run)) return;
				if (!baseline) {
					active = undefined;
					notifyUnavailable(ctx);
					return;
				}
				run.baseline = baseline;
			} catch (error) {
				if (!isCurrent(run)) return;
				active = undefined;
				if (error instanceof GitUnavailableError) {
					notifyUnavailable(ctx);
					return;
				}
				append({
					...baseData(run),
					status: "error",
					sourceEntryId: null,
					settledAt: null,
					aborted: false,
					stage: "baseline",
					ref: run.ref,
					baselineCommit: null,
					error: errorMessage(error),
				});
				ctx.ui.notify(`pi-checkpoint: baseline capture failed: ${errorMessage(error)}`, "warning");
			}
		},

		async agentSettled(event, ctx) {
			const run = active;
			if (!run?.baseline) return;
			const baseline = run.baseline;
			let result: Snapshot;
			try {
				result = await deps.store.captureResult(baseline, run.controller.signal);
			} catch (error) {
				if (!isCurrent(run)) return;
				active = undefined;
				append({
					...baseData(run),
					status: "error",
					sourceEntryId: resolveSourceEntryId(
						ctx.sessionManager.getBranch(),
						run.previousLeafId,
						run.messageType,
					),
					settledAt: timestamp(),
					aborted: event.aborted,
					stage: "result",
					ref: run.ref,
					baselineCommit: baseline.commit,
					error: errorMessage(error),
				});
				ctx.ui.notify(`pi-checkpoint: result capture failed: ${errorMessage(error)}`, "warning");
				return;
			}
			if (!isCurrent(run)) return;

			let preview: DiffPreview;
			try {
				preview = await deps.preview({
					cwd: result.worktreeRoot,
					baselineCommit: baseline.commit,
					resultCommit: result.commit,
					signal: run.controller.signal,
				});
			} catch (error) {
				preview = {
					shortstat: null,
					patchPreview: null,
					previewTruncated: false,
					previewError: errorMessage(error),
				};
			}
			if (!isCurrent(run)) return;
			active = undefined;
			append({
				...baseData(run),
				...preview,
				status: "ok",
				sourceEntryId: resolveSourceEntryId(
					ctx.sessionManager.getBranch(),
					run.previousLeafId,
					run.messageType,
				),
				settledAt: timestamp(),
				aborted: event.aborted,
				ref: run.ref,
				baselineCommit: baseline.commit,
				resultCommit: result.commit,
				headBefore: baseline.head,
				headAfter: result.head,
				commonDir: result.commonDir,
			});
		},

		reset() {
			const previous = active;
			active = undefined;
			generation += 1;
			unavailableWarned = false;
			previous?.controller.abort();
		},
	};
}

function errorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/\s+/g, " ").trim().slice(0, 500);
}
