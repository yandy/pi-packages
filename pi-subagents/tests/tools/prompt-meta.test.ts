import { describe, it } from "vitest";
import { assertPromptHygiene } from "../../../scripts/prompt-hygiene";
import { createToolDeps } from "../helpers/make-deps";
import { AgentTool } from "../../src/tools/agent-tool";
import { GetResultTool } from "../../src/tools/get-result-tool";
import { SteerTool } from "../../src/tools/steer-tool";

function tools(tiers?: Record<string, string>) {
	const deps = createToolDeps(
		tiers
			? {
					settings: {
						defaultMaxTurns: undefined,
						defaultTimeoutSeconds: undefined,
						maxConcurrent: 4,
						modelTiers: tiers as never,
					},
				}
			: {},
	);
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

	it("配置三档 tier 后仍在加宽预算内，且档位指引不重复", () => {
		// 储备：无配置 3563；三档映射约 +361；档位选择指引预留约 900 字符上限。
		// 没有这条闸门，guideline 会随档位文案无上限增长而无人发觉（3600 预算只覆盖无配置场景）。
		assertPromptHygiene({
			pkg: "pi-subagents (all tiers configured)",
			budget: 4900,
			tools: tools({ fast: "deepseek-flash", standard: "deepseek-flash", advanced: "qwen3.8-max" }),
			authored: ["subagent", "get_subagent_result", "steer_subagent"],
		});
	});
});
