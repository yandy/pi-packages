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

	pi.registerEntryRenderer(CHECKPOINT_ENTRY_TYPE, createCheckpointRenderer());
	pi.registerCommand("checkpoint", {
		description: "Show the hidden ref and full Git diff command for a checkpoint run",
		handler: createCheckpointCommandHandler(),
	});
	pi.on("session_start", (_event, ctx) => {
		coordinator.reset();
		return maintenance.sessionStart(ctx);
	});
	pi.on("session_shutdown", () => {
		coordinator.reset();
		maintenance.reset();
	});
	pi.on("before_agent_start", (event, ctx) => coordinator.beforeAgentStart(event, ctx));
	pi.on("agent_settled", async (event, ctx) => {
		await coordinator.agentSettled(event, ctx);
		await maintenance.agentSettled(ctx);
	});
}
