import type { RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { findCheckpoint } from "./session.js";

const USAGE = "Usage: /checkpoint <runNumber>";

export function createCheckpointCommandHandler(): RegisteredCommand["handler"] {
	return async (args, ctx) => {
		const input = args.trim();
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
	};
}
