import { describe, it } from "vitest";
import { assertPromptHygiene } from "../../../scripts/prompt-hygiene";
import { createToolDeps } from "../helpers/make-deps";
import { AgentTool } from "../../src/tools/agent-tool";
import { GetResultTool } from "../../src/tools/get-result-tool";
import { SteerTool } from "../../src/tools/steer-tool";

function tools() {
	const deps = createToolDeps();
	return [
		new AgentTool(deps.manager, deps.runtime, deps.settings, deps.registry, deps.agentDir).toToolDefinition(),
		new GetResultTool(deps.manager, { cancelNudge: () => {} } as never, deps.registry).toToolDefinition(),
		new SteerTool(deps.manager, { emit: () => {} } as never).toToolDefinition(),
	];
}

describe("prompt hygiene", () => {
	it("subagent / get_subagent_result / steer_subagent 的三通道文案符合约定且不超预算", () => {
		assertPromptHygiene({
			pkg: "pi-subagents",
			budget: 3600,
			tools: tools(),
			authored: ["subagent", "get_subagent_result", "steer_subagent"],
		});
	});
});
