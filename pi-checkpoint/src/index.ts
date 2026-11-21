import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CheckpointStore } from "./checkpoint-store.js";
import { createCheckpointCommandHandler } from "./command.js";
import { createCheckpointCoordinator } from "./coordinator.js";
import { createDiffPreview } from "./diff.js";
import { createGitRunner, type RunGit } from "./git.js";
import { createCheckpointRenderer } from "./renderer.js";
import { createRetentionSweeper } from "./retention.js";
import { CHECKPOINT_ENTRY_TYPE } from "./session.js";

export interface CheckpointExtensionDeps {
	runGit?: RunGit;
	now?: () => Date;
}

export default function registerCheckpoint(pi: ExtensionAPI, deps: CheckpointExtensionDeps = {}): void {
	const runGit = deps.runGit ?? createGitRunner();
	const store = new CheckpointStore(runGit);
	const sweeper = createRetentionSweeper({ runGit, now: deps.now });
	const coordinator = createCheckpointCoordinator({
		pi,
		store,
		preview: (input) => createDiffPreview(input, runGit),
	});

	pi.registerEntryRenderer(CHECKPOINT_ENTRY_TYPE, createCheckpointRenderer());
	pi.registerCommand("checkpoint", {
		description: "Inspect a checkpoint run's ref and diff command, or prune stale checkpoint refs",
		handler: createCheckpointCommandHandler({
			sweep: (cwd) => sweeper.sweep(cwd, { force: true }),
			refExists: async (cwd, ref) => {
				const result = await runGit(["rev-parse", "--verify", "--quiet", ref], { cwd, allowNonZeroExit: true });
				return result.code === 0;
			},
		}),
	});
	pi.on("session_start", (_event, ctx) => {
		coordinator.reset();
		void sweeper.sweep(ctx.cwd);
	});
	pi.on("session_shutdown", () => coordinator.reset());
	pi.on("before_agent_start", (event, ctx) => coordinator.beforeAgentStart(event, ctx));
	pi.on("agent_settled", (event, ctx) => coordinator.agentSettled(event, ctx));
}
