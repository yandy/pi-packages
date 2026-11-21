import type { ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import type { SweepOutcome } from "./retention.js";
import { findCheckpoint } from "./session.js";

const USAGE = "Usage: /checkpoint <runNumber>\n       /checkpoint prune";

const PRUNE_SKIP_MESSAGES: Record<"already-swept" | "not-a-worktree", string> = {
	"not-a-worktree": "Checkpoint prune skipped: not inside a Git worktree",
	"already-swept": "Checkpoint prune skipped: this repository was already pruned in this process",
};

export interface CheckpointCommandDeps {
	sweep: (cwd: string) => Promise<SweepOutcome>;
	refExists: (cwd: string, ref: string) => Promise<boolean>;
}

export function createCheckpointCommandHandler(deps: CheckpointCommandDeps): RegisteredCommand["handler"] {
	return async (args, ctx) => {
		const input = args.trim();
		if (input === "prune") {
			reportSweepOutcome(ctx, await deps.sweep(ctx.cwd));
			return;
		}
		if (!/^[1-9]\d*$/.test(input)) {
			ctx.ui.notify(USAGE, "warning");
			return;
		}
		const runNumber = Number(input);
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
		ctx.ui.notify(
			`Checkpoint #${runNumber}${data.aborted ? " (aborted)" : ""}\nref: ${data.ref}\nbaseline: ${data.baselineCommit}\nresult: ${data.resultCommit}\ngit diff ${data.baselineCommit} ${data.resultCommit}`,
			"info",
		);
		if (await refIsGone(deps, ctx.cwd, data.ref)) {
			ctx.ui.notify(
				`Checkpoint #${runNumber}: the checkpoint ref was pruned, so the git diff command may fail once Git reclaims its objects; the stored preview remains`,
				"warning",
			);
		}
	};
}

function reportSweepOutcome(ctx: ExtensionCommandContext, outcome: SweepOutcome): void {
	if (outcome.status === "pruned") {
		ctx.ui.notify(`Pruned ${outcome.deleted} checkpoint ref(s); ${outcome.kept} kept`, "info");
		return;
	}
	if (outcome.status === "failed") {
		ctx.ui.notify(`Checkpoint prune failed: ${outcome.error}`, "warning");
		return;
	}
	ctx.ui.notify(PRUNE_SKIP_MESSAGES[outcome.reason], "info");
}

/** Only a definite "false" reports the ref as gone; a failing check stays silent so it never hides the query output. */
async function refIsGone(deps: CheckpointCommandDeps, cwd: string, ref: string): Promise<boolean> {
	try {
		return !(await deps.refExists(cwd, ref));
	} catch {
		return false;
	}
}
