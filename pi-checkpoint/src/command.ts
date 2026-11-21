import type { ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import type { RunGit } from "./git.js";
import { type CheckpointOkData, findCheckpoint } from "./session.js";

const USAGE = "Usage: /checkpoint <runNumber> | /checkpoint prune [--dry-run]";
/** Display cap for retained previews; legacy entries may hold larger previews. */
const MAX_PREVIEW_BYTES = 16 * 1024;

export interface CheckpointCommandDependencies {
	/** Shared Git runner used to verify that a snapshot ref still exists. */
	runGit: RunGit;
	/** Task 5 maintenance sweep; owns config loading, serialization, and notifications. */
	prune: (ctx: ExtensionCommandContext, dryRun: boolean) => Promise<void>;
}

interface RetainedSummary {
	shortstat: string | null;
	patchPreview: string | null;
	previewTruncated: boolean;
}

export function createCheckpointCommandHandler({
	runGit,
	prune,
}: CheckpointCommandDependencies): RegisteredCommand["handler"] {
	return async (args, ctx) => {
		const input = args.trim();
		const tokens = input === "" ? [] : input.split(/\s+/);
		if (tokens[0] === "prune") {
			const dryRun = tokens.length === 2 && tokens[1] === "--dry-run";
			if (tokens.length !== 1 && !dryRun) {
				ctx.ui.notify(USAGE, "warning");
				return;
			}
			await runPrune(ctx, dryRun, prune);
			return;
		}
		if (tokens.length !== 1 || !/^[1-9]\d*$/.test(tokens[0])) {
			ctx.ui.notify(USAGE, "warning");
			return;
		}
		const runNumber = Number(tokens[0]);
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
		await reportSnapshot(data, ctx, runGit);
	};
}

async function runPrune(
	ctx: ExtensionCommandContext,
	dryRun: boolean,
	prune: CheckpointCommandDependencies["prune"],
): Promise<void> {
	try {
		await prune(ctx, dryRun);
	} catch (error) {
		// Maintenance reports its own failures; this only guards an unexpected rejection from
		// escaping into the command dispatcher.
		ctx.ui.notify(`pi-checkpoint: prune failed: ${cleanError(error)}`, "warning");
	}
}

/**
 * Prints the ready-to-run diff command only when the recorded ref resolves to the recorded result
 * commit. Every other outcome keeps the retained summary and never claims the snapshot is intact.
 */
async function reportSnapshot(data: CheckpointOkData, ctx: ExtensionCommandContext, runGit: RunGit): Promise<void> {
	const cwd = data.commonDir ?? ctx.cwd;
	const retained: RetainedSummary = {
		shortstat: data.shortstat,
		patchPreview: data.patchPreview,
		previewTruncated: data.previewTruncated,
	};
	let stdout: string | null = null;
	let failure: string | null = null;
	try {
		const result = await runGit(["rev-parse", "--verify", "--quiet", `${data.ref}^{commit}`], {
			cwd,
			allowNonZeroExit: true,
		});
		if (result.killed || result.truncated || (result.code !== 0 && result.code !== 1)) {
			failure = cleanError(result.stderr || `git rev-parse exited with ${result.code ?? "unknown"}`);
		} else if (result.code === 0) {
			stdout = result.stdout.trim();
		}
	} catch (error) {
		failure = cleanError(error);
	}

	if (failure !== null) {
		ctx.ui.notify(
			unavailableMessage(data, `snapshot unconfirmed: cannot verify the checkpoint ref in ${cwd}: ${failure}`, retained),
			"warning",
		);
		return;
	}
	if (stdout === null) {
		const scope = data.commonDir === undefined ? "legacy" : "recorded";
		ctx.ui.notify(unavailableMessage(data, missingReason(scope), retained), "warning");
		return;
	}
	if (stdout !== data.resultCommit) {
		const scope = data.commonDir === undefined ? "legacy" : "recorded";
		ctx.ui.notify(unavailableMessage(data, movedReason(scope, stdout), retained), "warning");
		return;
	}
	ctx.ui.notify(
		`Checkpoint #${data.runNumber}${data.aborted ? " (aborted)" : ""}\nref: ${data.ref}\nbaseline: ${data.baselineCommit}\nresult: ${data.resultCommit}\ngit diff ${data.baselineCommit} ${data.resultCommit}`,
		"info",
	);
}

function missingReason(scope: "recorded" | "legacy"): string {
	if (scope === "recorded") {
		return "snapshot unavailable: the checkpoint ref no longer exists or does not point to a commit";
	}
	return "snapshot unavailable: ref not found in the current repository; it may have been pruned or the snapshot may belong to a different repository";
}

function movedReason(scope: "recorded" | "legacy", current: string): string {
	const target = /^[0-9a-f]{4,64}$/i.test(current) ? current.slice(0, 7) : "a different commit";
	if (scope === "recorded") return `snapshot unavailable: the checkpoint ref now points to ${target}`;
	return `snapshot unavailable: ref in the current repository points to ${target}; it may have been pruned or the snapshot may belong to a different repository`;
}

function unavailableMessage(data: CheckpointOkData, reason: string, retained: RetainedSummary): string {
	const lines = [
		`Checkpoint #${data.runNumber}${data.aborted ? " (aborted)" : ""}`,
		reason,
		`ref: ${data.ref}`,
		`baseline: ${data.baselineCommit}`,
		`result: ${data.resultCommit}`,
		`summary: ${retained.shortstat ?? "unavailable"}`,
	];
	if (retained.patchPreview) {
		const preview = cappedPreview(retained.patchPreview);
		lines.push("preview:", preview.text);
		if (preview.truncated || retained.previewTruncated) lines.push("[preview truncated]");
	}
	return lines.join("\n");
}

function cappedPreview(value: string): { text: string; truncated: boolean } {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= MAX_PREVIEW_BYTES) return { text: value, truncated: false };
	let slice = bytes.subarray(0, MAX_PREVIEW_BYTES);
	const decoder = new TextDecoder("utf-8", { fatal: true });
	while (slice.length > 0) {
		try {
			return { text: decoder.decode(slice), truncated: true };
		} catch {
			slice = slice.subarray(0, slice.length - 1);
		}
	}
	return { text: "", truncated: true };
}

function cleanError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/\s+/g, " ").trim().slice(0, 300);
}
