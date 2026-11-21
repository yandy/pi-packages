import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CheckpointStore } from "./checkpoint-store.js";
import { createCheckpointCommandHandler } from "./command.js";
import { createCheckpointCoordinator } from "./coordinator.js";
import { createDiffPreview } from "./diff.js";
import { createGitRunner } from "./git.js";
import { createCheckpointMaintenance } from "./maintenance.js";
import { createCheckpointRenderer } from "./renderer.js";
import { CHECKPOINT_ENTRY_TYPE } from "./session.js";

export default function registerCheckpoint(pi: ExtensionAPI): void {
	const runGit = createGitRunner();
	const store = new CheckpointStore(runGit);
	const coordinator = createCheckpointCoordinator({
		pi,
		store,
		preview: (input) => createDiffPreview(input, runGit),
	});
	const maintenance = createCheckpointMaintenance({ runGit });
	// Incremented on every session boundary so a settle continuation that outlives its session cannot
	// submit maintenance under the next session's generation and cwd.
	let lifecycleGeneration = 0;

	pi.registerEntryRenderer(CHECKPOINT_ENTRY_TYPE, createCheckpointRenderer());
	pi.registerCommand("checkpoint", {
		description: "Show a checkpoint snapshot or prune expired checkpoint refs",
		handler: createCheckpointCommandHandler({
			runGit,
			prune: (ctx, dryRun) => maintenance.prune(ctx, dryRun),
		}),
	});
	pi.on("session_start", (_event, ctx) => {
		lifecycleGeneration += 1;
		coordinator.reset();
		return maintenance.sessionStart(ctx);
	});
	pi.on("session_shutdown", () => {
		lifecycleGeneration += 1;
		coordinator.reset();
		maintenance.reset();
	});
	pi.on("before_agent_start", (event, ctx) => coordinator.beforeAgentStart(event, ctx));
	pi.on("agent_settled", async (event, ctx) => {
		const generation = lifecycleGeneration;
		await coordinator.agentSettled(event, ctx);
		// Capture may still be in flight when the session is replaced; the new session owns maintenance,
		// so the stale continuation stops here instead of sweeping its cwd under the new policy.
		if (generation !== lifecycleGeneration) return;
		await maintenance.agentSettled(ctx);
	});
}
