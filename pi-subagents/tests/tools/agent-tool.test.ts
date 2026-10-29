import { describe, expect, it, vi } from "vitest";
import { AgentTool } from "../../src/tools/agent-tool";
import { createToolDeps } from "../helpers/make-deps";
import { createTestSubagent } from "../helpers/make-subagent";
import { createMockSession, createSubagentSessionStub, toSubagentSession } from "../helpers/mock-session";

function makeCtx(overrides: Record<string, unknown> = {}) {
	return {
		ui: { fake: true },
		...overrides,
	};
}

function makeTool(deps: ReturnType<typeof createToolDeps>) {
	return new AgentTool(deps.manager, deps.runtime, deps.settings, deps.registry, deps.agentDir);
}

async function execute(
	deps: ReturnType<typeof createToolDeps>,
	params: Record<string, unknown>,
	ctx?: ReturnType<typeof makeCtx>,
) {
	return makeTool(deps).execute("tc-1", params, new AbortController().signal, vi.fn(), ctx ?? makeCtx());
}

describe("AgentTool", () => {
	it("returns tool definition with correct name and label", () => {
		const def = makeTool(createToolDeps()).toToolDefinition();
		expect(def.name).toBe("subagent");
		expect(def.label).toBe("Subagent");
	});

	it("derives type list from registry — includes default agents in description", () => {
		const def = makeTool(createToolDeps()).toToolDefinition();
		// testRegistry loads default agents: general-purpose, Explore, Plan
		expect(def.description).toContain("- general-purpose: General-purpose agent");
		expect(def.description).toContain("- Explore: Fast codebase exploration agent");
	});

	it("calls registry.reload() on each execute", async () => {
		const deps = createToolDeps();
		const reloadSpy = vi.spyOn(deps.registry, "reload");
		await execute(deps, {
			prompt: "test",
			description: "test",
			subagent_type: "general-purpose",
		});
		expect(reloadSpy).toHaveBeenCalledOnce();
		reloadSpy.mockRestore();
	});
});

describe("AgentTool — model tier guidance", () => {
	it("does not expose a model_tier parameter", () => {
		const def = makeTool(createToolDeps()).toToolDefinition();
		const props = (def.parameters as { properties: Record<string, unknown> }).properties;
		expect(props.model_tier).toBeUndefined();
		expect(def.description).not.toContain("model_tier");
	});

	it("renders configured tier → model mappings in promptGuidelines", () => {
		const deps = createToolDeps({
			settings: {
				defaultMaxTurns: undefined,
				defaultTimeoutSeconds: undefined,
				maxConcurrent: 4,
				modelTiers: { fast: "deepseek-flash", advanced: "qwen3.8-max" },
			},
		});
		const def = makeTool(deps).toToolDefinition();
		const guidelines = (def.promptGuidelines ?? []).join("\n");
		expect(guidelines).toContain("fast → deepseek-flash");
		expect(guidelines).toContain("advanced → qwen3.8-max");
		expect(guidelines).toContain("model parameter");
		expect(guidelines).not.toContain("standard →");
	});

	it("omits the tier guideline when no tiers are configured", () => {
		const def = makeTool(createToolDeps()).toToolDefinition();
		// 行为纪律现在恒在 promptGuidelines 里（spec 2026-10-30 D1），只要求不出现 tier 映射。
		const guidelines = (def.promptGuidelines ?? []).join("\n");
		expect(guidelines).not.toContain("subagent model tiers");
		expect(guidelines).toContain("Use subagent for work that needs its own context");
	});
});

describe("AgentTool — 行为纪律的位置（spec 2026-10-30 D1）", () => {
	it("把纪律放 promptGuidelines，不内联在 description 里", () => {
		const def = makeTool(createToolDeps()).toToolDefinition();
		expect(def.description).not.toContain("Guidelines:");
		const guidelines = def.promptGuidelines ?? [];
		expect(guidelines.length).toBeGreaterThanOrEqual(5);
		// 并行的真相：同一 message 里的前台兄弟调用并发，且绕过并发上限（旧文案说“串行”）。
		const parallel = guidelines.find((g) => g.includes("run_in_background"));
		expect(parallel).toContain("run concurrently");
		expect(parallel).not.toContain("Foreground calls run sequentially");
	});

	it("不再复述参数描述（6 条重复已删）", () => {
		const def = makeTool(createToolDeps()).toToolDefinition();
		const guidelines = (def.promptGuidelines ?? []).join("\n");
		for (const repeated of [
			"Use resume with an agent ID",
			"Use thinking to control extended thinking level",
			"Use inherit_context if the agent needs",
			"Use model to specify a different model",
		]) {
			expect(guidelines).not.toContain(repeated);
		}
	});
});

describe("AgentTool — timeout parameter", () => {
	it("exposes an optional timeout parameter described as a hard safety net", () => {
		const def = makeTool(createToolDeps()).toToolDefinition();
		const props = (def.parameters as { properties: Record<string, { description?: string }> }).properties;
		expect(props.timeout).toBeDefined();
		// 该说明只留在参数描述里（D1：description 不再内联纪律）。
		expect(props.timeout?.description).toContain("safety net");
	});

	it("thinking 参数是枚举，非法值不被静默放行", () => {
		const def = makeTool(createToolDeps()).toToolDefinition();
		const props = (def.parameters as { properties: Record<string, { enum?: string[] }> }).properties;
		expect(props.thinking?.enum).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
	});
});

describe("AgentTool — resume path", () => {
	it("returns not-found when resume ID does not exist", async () => {
		const deps = createToolDeps();
		deps.manager.getRecord = vi.fn().mockReturnValue(undefined);
		const result = await execute(deps, {
			prompt: "continue",
			description: "resume",
			subagent_type: "general-purpose",
			resume: "nonexistent",
		});
		expect(result.content[0].text).toContain("Agent not found");
	});

	it("returns no-session when agent has no active session", async () => {
		const deps = createToolDeps();
		// No execution state set — session not yet created
		deps.manager.getRecord = vi.fn().mockReturnValue(createTestSubagent());
		const result = await execute(deps, {
			prompt: "continue",
			description: "resume",
			subagent_type: "general-purpose",
			resume: "agent-1",
		});
		expect(result.content[0].text).toContain("no active session");
	});

	it("returns result text on successful resume", async () => {
		const deps = createToolDeps();
		const resumeRecord = createTestSubagent();
		resumeRecord.subagentSession = toSubagentSession(createSubagentSessionStub(createMockSession()));
		deps.manager.getRecord = vi.fn().mockReturnValue(resumeRecord);
		deps.manager.resume = vi.fn().mockResolvedValue(createTestSubagent({ result: "Resumed output." }));
		const result = await execute(deps, {
			prompt: "continue",
			description: "resume",
			subagent_type: "general-purpose",
			resume: "agent-1",
		});
		expect(result.content[0].text).toContain("Resumed output.");
	});
});

describe("AgentTool — model resolution error", () => {
	it("returns error when model resolution fails", async () => {
		const deps = createToolDeps();
		const result = await execute(deps, {
			prompt: "test",
			description: "test",
			subagent_type: "general-purpose",
			model: "nonexistent-model-xyz",
		});
		// User-specified model that doesn't resolve → error message
		expect(result.content[0].text).toContain("nonexistent-model-xyz");
	});
});

describe("AgentTool — background execution", () => {
	it("returns background launch message with agent ID", async () => {
		const deps = createToolDeps();
		const record = createTestSubagent({ status: "running" });
		deps.manager.getRecord = vi.fn().mockReturnValue(record);
		const result = await execute(deps, {
			prompt: "do something",
			description: "bg task",
			subagent_type: "general-purpose",
			run_in_background: true,
		});
		const text = result.content[0].text;
		expect(text).toContain("background");
		expect(text).toContain("agent-1");
		expect(text).toContain("bg task");
	});

	it("passes parentSession.toolCallId to manager.spawn so the manager wires NotificationState", async () => {
		const deps = createToolDeps();
		deps.manager.getRecord = vi.fn().mockReturnValue(createTestSubagent({ status: "running" }));
		await execute(deps, {
			prompt: "do something",
			description: "bg task",
			subagent_type: "general-purpose",
			run_in_background: true,
		});
		const spawnOpts = (deps.manager.spawn as ReturnType<typeof vi.fn>).mock.calls[0][3];
		expect(spawnOpts.parentSession?.toolCallId).toBe("tc-1");
	});
});

describe("AgentTool — foreground execution", () => {
	it("returns completion message with stats", async () => {
		const deps = createToolDeps();
		deps.manager.spawnAndWait = vi.fn().mockResolvedValue(createTestSubagent({ result: "Task complete.", toolUses: 5 }));
		const result = await execute(deps, {
			prompt: "do task",
			description: "fg task",
			subagent_type: "general-purpose",
		});
		const text = result.content[0].text;
		expect(text).toContain("Agent completed");
		expect(text).toContain("Task complete.");
		// Stats suffix on the completion line (factory-default lifetime usage: 1.0k token)
		expect(text).toContain("(5 tool uses, 1.0k token)");
		// details payload carries the same stats for custom rendering
		expect(result.details).toMatchObject({
			toolUses: 5,
			tokens: "1.0k token",
			turnCount: 1,
			status: "completed",
			agentId: "agent-1",
		});
	});

	it("returns error message when agent fails", async () => {
		const deps = createToolDeps();
		deps.manager.spawnAndWait = vi
			.fn()
			.mockResolvedValue(createTestSubagent({ status: "error", error: "Out of context" }));
		const result = await execute(deps, {
			prompt: "do task",
			description: "fg task",
			subagent_type: "general-purpose",
		});
		expect(result.content[0].text).toContain("Agent failed");
		expect(result.content[0].text).toContain("Out of context");
	});

	it("returns error when spawnAndWait throws", async () => {
		const deps = createToolDeps();
		deps.manager.spawnAndWait = vi.fn().mockRejectedValue(new Error("spawn failure"));
		const result = await execute(deps, {
			prompt: "do task",
			description: "fg task",
			subagent_type: "general-purpose",
		});
		expect(result.content[0].text).toContain("spawn failure");
	});
});
