import type { ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import type { RunGit } from "./git.js";
import type { RecordedCheckpointCommit } from "./refs.js";
import { type CheckpointOkData, findCheckpoint, recordedSnapshots } from "./session.js";
import type { PruneResult } from "./retention.js";

const USAGE = "Usage: /checkpoint <runNumber>\n       /checkpoint prune [--dry-run]";

export type SnapshotResolution =
	| { state: "resolved"; oid: string }
	| { state: "absent" }
	| { state: "unverifiable"; error: string };

export interface PruneCommandOptions {
	dryRun: boolean;
	recorded: ReadonlyMap<string, RecordedCheckpointCommit>;
}

export interface CheckpointCommandDeps {
	/** Plans or applies one prune pass; resolves `null` outside a Git worktree. */
	prune: (cwd: string, options: PruneCommandOptions) => Promise<PruneResult | null>;
	/** Resolves the ref to an object id, or reports a definite absence / a failed verification. */
	probeSnapshot: (cwd: string, ref: string) => Promise<SnapshotResolution>;
}

export function createCheckpointCommandHandler(deps: CheckpointCommandDeps): RegisteredCommand["handler"] {
	return async (args, ctx) => {
		const tokens = args.trim() === "" ? [] : args.trim().split(/\s+/);
		const command = tokens[0];
		if (command === "prune") {
			const dryRun = tokens.length === 2 && tokens[1] === "--dry-run";
			if (tokens.length !== 1 && !dryRun) {
				ctx.ui.notify(USAGE, "warning");
				return;
			}
			await runPrune(ctx, dryRun, deps);
			return;
		}
		if (tokens.length !== 1 || command === undefined || !/^[1-9]\d*$/.test(command)) {
			ctx.ui.notify(USAGE, "warning");
			return;
		}
		const runNumber = Number(command);
		if (!Number.isSafeInteger(runNumber)) {
			ctx.ui.notify(USAGE, "warning");
			return;
		}
		const data = findCheckpoint(ctx.sessionManager.getBranch(), runNumber);
		if (!data) {
			ctx.ui.notify(`Checkpoint #${runNumber} not found in the current conversation branch`, "warning");
			return;
		}
		if (data.status === "error") {
			ctx.ui.notify(
				`Checkpoint #${runNumber}: ${data.stage} capture failed\nref: ${data.ref}\nbaseline: ${data.baselineCommit ?? "unavailable"}\n${data.error}`,
				"warning",
			);
			return;
		}
		await reportSnapshot(data, ctx, deps);
	};
}

async function runPrune(ctx: ExtensionCommandContext, dryRun: boolean, deps: CheckpointCommandDeps): Promise<void> {
	try {
		const result = await deps.prune(ctx.cwd, {
			dryRun,
			recorded: recordedSnapshots(ctx.sessionManager.getEntries()),
		});
		if (!result) {
			ctx.ui.notify("Checkpoint prune skipped: not inside a Git worktree", "info");
			return;
		}
		ctx.ui.notify(describePrune(result), "info");
	} catch (error) {
		// A failed prune must not escape into the command dispatcher; the user only needs the reason.
		ctx.ui.notify(`Checkpoint prune failed: ${cleanError(error)}`, "warning");
	}
}

function describePrune(result: PruneResult): string {
	const reasons = `(${result.expired} older than ${result.retentionDays} days, ${result.overflow} beyond the newest ${result.maxRefs})`;
	const baselineOnly = result.baselineOnly > 0 ? `; ${result.baselineOnly} baseline-only ref(s) left untouched` : "";
	if (result.dryRun) {
		return `Checkpoint prune (dry run): would delete ${result.selected} of ${result.completed} completed checkpoint ref(s) ${reasons}; ${result.kept} would be kept${baselineOnly}`;
	}
	return `Pruned ${result.deleted} checkpoint ref(s) ${reasons}; ${result.kept} kept${baselineOnly}`;
}

/**
 * Reports a successful entry in one of three states: the recorded ref still resolves to the recorded
 * result commit (full output and a runnable diff command), it definitely does not (retained summary
 * only, no command that cannot run), or the check itself failed (say that availability is unconfirmed
 * instead of implying the snapshot was pruned).
 */
async function reportSnapshot(
	data: CheckpointOkData,
	ctx: ExtensionCommandContext,
	deps: CheckpointCommandDeps,
): Promise<void> {
	// The snapshot lives in the repository that wrote it, which is not necessarily the current one.
	let resolution: SnapshotResolution;
	try {
		resolution = await deps.probeSnapshot(data.commonDir, data.ref);
	} catch (error) {
		resolution = { state: "unverifiable", error: cleanError(error) };
	}

	if (resolution.state === "unverifiable") {
		ctx.ui.notify(
			retainedMessage(data, `snapshot unconfirmed: cannot confirm ${data.ref} in ${data.commonDir}: ${resolution.error}`),
			"warning",
		);
		return;
	}
	if (resolution.state === "resolved" && resolution.oid === data.resultCommit) {
		ctx.ui.notify(availableMessage(data), "info");
		return;
	}

	const reason = resolution.state === "absent" ? missingReason() : movedReason(resolution.oid);
	ctx.ui.notify(retainedMessage(data, reason), "warning");
}

function availableMessage(data: CheckpointOkData): string {
	return [
		`Checkpoint #${data.runNumber}${data.aborted ? " (aborted)" : ""}`,
		`ref: ${data.ref}`,
		`baseline: ${data.baselineCommit}`,
		`result: ${data.resultCommit}`,
		diffCommand(data),
	].join("\n");
}

function diffCommand(data: CheckpointOkData): string {
	// The recorded common dir may belong to another checkout, so the command carries its own context.
	return `git --git-dir=${quoteShellArgument(data.commonDir)} diff ${data.baselineCommit} ${data.resultCommit}`;
}

function missingReason(): string {
	return "snapshot unavailable: the checkpoint ref no longer exists; it was pruned, or the snapshot belongs to a different repository";
}

function movedReason(oid: string): string {
	const target = /^[0-9a-f]{4,64}$/i.test(oid) ? oid.slice(0, 7) : "another object";
	return `snapshot unavailable: the checkpoint ref now points to ${target}, not the recorded result commit`;
}

/** The retained summary and preview stay readable after the ref is gone; no runnable command is offered. */
function retainedMessage(data: CheckpointOkData, reason: string): string {
	const lines = [
		`Checkpoint #${data.runNumber}${data.aborted ? " (aborted)" : ""}`,
		reason,
		`ref: ${data.ref}`,
		`baseline: ${data.baselineCommit}`,
		`result: ${data.resultCommit}`,
		`summary: ${data.shortstat ?? "unavailable"}`,
	];
	if (data.patchPreview) lines.push("preview:", data.patchPreview);
	if (data.previewTruncated) lines.push("[preview truncated]");
	if (data.previewError) lines.push(`preview error: ${data.previewError}`);
	return lines.join("\n");
}

function quoteShellArgument(value: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
	if (process.platform === "win32") return `"${value.replaceAll('"', '""')}"`;
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Maps `git rev-parse --verify --quiet` onto the three states: exit 0 resolves the ref, exit 1 is a
 * definite absence, and everything else (missing git, not a repository, interrupted child) is a
 * failed verification that must never be reported as a pruned snapshot.
 */
export async function probeSnapshotRef(runGit: RunGit, cwd: string, ref: string): Promise<SnapshotResolution> {
	let result: Awaited<ReturnType<RunGit>>;
	try {
		result = await runGit(["rev-parse", "--verify", "--quiet", ref], { cwd, allowNonZeroExit: true });
	} catch (error) {
		return { state: "unverifiable", error: cleanError(error) };
	}
	if (result.killed || result.truncated) return { state: "unverifiable", error: "the reference check was interrupted" };
	if (result.code === 0) {
		const oid = result.stdout.trim();
		return oid === ""
			? { state: "unverifiable", error: "git rev-parse returned no object id" }
			: { state: "resolved", oid };
	}
	if (result.code === 1) return { state: "absent" };
	return {
		state: "unverifiable",
		error: cleanError(result.stderr) || `git rev-parse exited with ${result.code ?? "unknown"}`,
	};
}

function cleanError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/\s+/g, " ").trim().slice(0, 300);
}
