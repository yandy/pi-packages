import { describe, expect, it } from "vitest";
import { AgentTypeRegistry } from "../../src/config/agent-types";
import type { ModelTierMap } from "../../src/config/model-tiers";
import { resolveModelName, resolveSpawnConfig } from "../../src/tools/spawn-config";
import type { AgentConfig } from "../../src/types";

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "test-agent",
		description: "Test agent",
		toolNames: ["read", "grep"],
		systemPrompt: "You are a test agent.",
		promptMode: "replace",
		inheritContext: false,
		runInBackground: false,
		...overrides,
	};
}

/** Registry with a single disabled Explore override. */
function makeDisabledExploreRegistry(): AgentTypeRegistry {
	return new AgentTypeRegistry(
		() => new Map([["Explore", makeAgentConfig({ name: "Explore", description: "Disabled", enabled: false })]]),
	);
}

/** Minimal registry with default agents only. */
const testRegistry = new AgentTypeRegistry(() => new Map());

/** Shorthand for building ModelInfo. */
function makeModelInfo(overrides: Partial<Parameters<typeof resolveSpawnConfig>[2]> = {}) {
	return {
		parentModel: { id: "claude-sonnet", name: "Claude Sonnet", provider: "anthropic" },
		modelRegistry: { getAll: () => [], getAvailable: () => [] } as unknown,
		...overrides,
	};
}

const defaultSettings = {
	defaultMaxTurns: undefined as number | undefined,
	defaultTimeoutSeconds: undefined as number | undefined,
};

const deepseekFlash = { id: "deepseek-flash", name: "DeepSeek Flash", provider: "ark" };
const haiku = { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" };
const concreteFast = { id: "fast", name: "Concrete Fast", provider: "custom" };
const concreteStandard = { id: "standard", name: "Concrete Standard", provider: "custom" };
const concreteAdvanced = { id: "advanced", name: "Concrete Advanced", provider: "custom" };
const tierModels = [deepseekFlash, haiku, concreteFast, concreteStandard, concreteAdvanced];

function makeTierModelInfo() {
	return makeModelInfo({
		modelRegistry: {
			find(provider: string, modelId: string) {
				return tierModels.find((model) => model.provider === provider && model.id === modelId);
			},
			getAll: () => tierModels,
			getAvailable: () => tierModels,
		},
	});
}

function resolveToolModel(
	model: string,
	modelTiers: ModelTierMap,
	registry: AgentTypeRegistry = testRegistry,
	subagentType = "general-purpose",
) {
	return resolveSpawnConfig(
		{ subagent_type: subagentType, prompt: "test", description: "d", model },
		registry,
		makeTierModelInfo(),
		{ ...defaultSettings, modelTiers },
	);
}

/** Registry whose single agent locks timeout: 300 (frontmatter-style). */
function makeTimeoutRegistry(): AgentTypeRegistry {
	return new AgentTypeRegistry(
		() => new Map([["test-agent", makeAgentConfig({ timeout: 300 })]]),
	);
}

describe("resolveModelName", () => {
	it("returns provider/id when provider and id are present", () => {
		expect(resolveModelName({ provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet" })).toBe(
			"anthropic/claude-sonnet",
		);
	});

	it("returns undefined when model is undefined", () => {
		expect(resolveModelName(undefined)).toBeUndefined();
	});

	it("returns name as fallback when provider is missing", () => {
		expect(resolveModelName({ id: "claude-sonnet", name: "Claude Sonnet" })).toBe("Claude Sonnet");
	});

	it("returns id as fallback when provider and name are both missing", () => {
		expect(resolveModelName({ id: "some-model" })).toBe("some-model");
	});

	it("returns undefined when model has no usable fields", () => {
		expect(resolveModelName({})).toBeUndefined();
	});
});

describe("resolveSpawnConfig — type resolution", () => {
	it("resolves a known agent type", () => {
		const result = resolveSpawnConfig(
			{ subagent_type: "general-purpose", prompt: "test", description: "d" },
			testRegistry,
			makeModelInfo(),
			defaultSettings,
		);
		expect("error" in result && result.error).toBeFalsy();
		if ("error" in result) return;
		expect(result.identity.subagentType).toBe("general-purpose");
		expect(result.identity.fellBack).toBe(false);
	});

	it("falls back to general-purpose for unknown agent type", () => {
		const result = resolveSpawnConfig(
			{ subagent_type: "unknown-type", prompt: "test", description: "d" },
			testRegistry,
			makeModelInfo(),
			defaultSettings,
		);
		expect("error" in result && result.error).toBeFalsy();
		if ("error" in result) return;
		expect(result.identity.subagentType).toBe("general-purpose");
		expect(result.identity.fellBack).toBe(true);
	});

	it("returns an error for a disabled agent type (exact match)", () => {
		const registry = makeDisabledExploreRegistry();
		const result = resolveSpawnConfig(
			{ subagent_type: "Explore", prompt: "test", description: "d" },
			registry,
			makeModelInfo(),
			defaultSettings,
		);
		expect("error" in result).toBe(true);
		if ("error" in result) {
			expect(result.error).toBe('Agent type "Explore" is disabled');
		}
	});

	it("reports the canonical casing in the disabled-agent error (case-insensitive input)", () => {
		const registry = makeDisabledExploreRegistry();
		const result = resolveSpawnConfig(
			{ subagent_type: "explore", prompt: "test", description: "d" },
			registry,
			makeModelInfo(),
			defaultSettings,
		);
		expect("error" in result).toBe(true);
		if ("error" in result) {
			expect(result.error).toBe('Agent type "Explore" is disabled');
		}
	});

	it("uses displayName from agent config when available", () => {
		const result = resolveSpawnConfig(
			{ subagent_type: "general-purpose", prompt: "test", description: "d" },
			testRegistry,
			makeModelInfo(),
			defaultSettings,
		);
		if ("error" in result) return;
		// general-purpose config has displayName: "Agent"
		expect(result.identity.displayName).toBe("Agent");
	});
});

describe("resolveSpawnConfig — model resolution", () => {
	it("inherits parent model when no model specified and shows its name", () => {
		const parentModel = { id: "claude-sonnet", name: "Claude Sonnet", provider: "anthropic" };
		const result = resolveSpawnConfig(
			{ subagent_type: "general-purpose", prompt: "test", description: "d" },
			testRegistry,
			makeModelInfo({ parentModel }),
			defaultSettings,
		);
		if ("error" in result) return;
		expect(result.execution.model).toBe(parentModel);
		// modelName is always shown, even when same as parent
		expect(result.presentation.modelName).toBe("anthropic/claude-sonnet");
	});

	it("returns error when user-specified model cannot be resolved", () => {
		const result = resolveSpawnConfig(
			{ subagent_type: "general-purpose", prompt: "test", description: "d", model: "nonexistent-xyz" },
			testRegistry,
			makeModelInfo({ modelRegistry: { getAll: () => [], getAvailable: () => [] } }),
			defaultSettings,
		);
		expect("error" in result && result.error).toBeTruthy();
	});

	it("resolves a normalized tool tier name through its exact model mapping", () => {
		const result = resolveToolModel(" FAST ", { fast: "ark/deepseek-flash" });
		if ("error" in result) throw new Error(result.error);
		expect(result.execution.model).toBe(deepseekFlash);
	});

	it("resolves a tier mapping value with the existing fuzzy matcher", () => {
		const result = resolveToolModel("fast", { fast: "haiku" });
		if ("error" in result) throw new Error(result.error);
		expect(result.execution.model).toBe(haiku);
	});

	it("rejects an unconfigured reserved tier instead of fuzzy-matching a same-named model", () => {
		const result = resolveToolModel("advanced", { fast: "haiku" });
		expect("error" in result).toBe(true);
		if ("error" in result) expect(result.error).toContain('Model tier "advanced" is not configured');
	});

	it("adds tier context when the configured model reference cannot be resolved", () => {
		const result = resolveToolModel("fast", { fast: "missing-model" });
		expect("error" in result).toBe(true);
		if ("error" in result) {
			expect(result.error).toContain('Model tier "fast" maps to "missing-model"');
			expect(result.error).toContain('Model not found: "missing-model"');
		}
	});

	it("resolves a tier mapping only once when its value names another tier", () => {
		const result = resolveToolModel("fast", { fast: "standard", standard: "haiku" });
		if ("error" in result) throw new Error(result.error);
		expect(result.execution.model).toBe(concreteStandard);
	});

	it("uses a full provider/modelId to disambiguate a real model from a tier", () => {
		const result = resolveToolModel("custom/fast", { fast: "ark/deepseek-flash" });
		if ("error" in result) throw new Error(result.error);
		expect(result.execution.model).toBe(concreteFast);
	});

	it("keeps ordinary fuzzy model selection unchanged", () => {
		const result = resolveToolModel("haiku", { fast: "ark/deepseek-flash" });
		if ("error" in result) throw new Error(result.error);
		expect(result.execution.model).toBe(haiku);
	});

	it("keeps a frontmatter-pinned model ahead of a tool tier alias", () => {
		const registry = new AgentTypeRegistry(
			() =>
				new Map([
					[
						"pinned-agent",
						makeAgentConfig({ name: "pinned-agent", model: "anthropic/claude-haiku-4-5" }),
					],
				]),
		);
		const result = resolveToolModel("fast", { fast: "ark/deepseek-flash" }, registry, "pinned-agent");
		if ("error" in result) throw new Error(result.error);
		expect(result.execution.model).toBe(haiku);
	});
});

describe("resolveSpawnConfig — max turns normalization", () => {
	it("normalizes max_turns from params", () => {
		const result = resolveSpawnConfig(
			{ subagent_type: "general-purpose", prompt: "test", description: "d", max_turns: 10 },
			testRegistry,
			makeModelInfo(),
			defaultSettings,
		);
		if ("error" in result) return;
		expect(result.execution.effectiveMaxTurns).toBe(10);
	});

	it("uses settings defaultMaxTurns when no max_turns in params", () => {
		const result = resolveSpawnConfig(
			{ subagent_type: "general-purpose", prompt: "test", description: "d" },
			testRegistry,
			makeModelInfo(),
			{ defaultMaxTurns: 25 },
		);
		if ("error" in result) return;
		expect(result.execution.effectiveMaxTurns).toBe(25);
	});

	it("returns undefined effectiveMaxTurns when neither params nor settings specify", () => {
		const result = resolveSpawnConfig(
			{ subagent_type: "general-purpose", prompt: "test", description: "d" },
			testRegistry,
			makeModelInfo(),
			defaultSettings,
		);
		if ("error" in result) return;
		expect(result.execution.effectiveMaxTurns).toBeUndefined();
	});

	it("resolves effectiveTimeoutSeconds from params and normalizes", () => {
		const result = resolveSpawnConfig(
			{ subagent_type: "general-purpose", prompt: "p", description: "d", timeout: 0.5 },
			testRegistry,
			makeModelInfo(),
			defaultSettings,
		);
		if ("error" in result) return;
		expect(result.execution.effectiveTimeoutSeconds).toBe(1);
		expect(result.execution.agentInvocation.timeout).toBe(1);
	});

	it("uses settings defaultTimeoutSeconds when no param is given", () => {
		const result = resolveSpawnConfig(
			{ subagent_type: "general-purpose", prompt: "p", description: "d" },
			testRegistry,
			makeModelInfo(),
			{ defaultMaxTurns: undefined, defaultTimeoutSeconds: 600 },
		);
		if ("error" in result) return;
		expect(result.execution.effectiveTimeoutSeconds).toBe(600);
		expect(result.execution.agentInvocation.timeout).toBeUndefined();
	});

	it("frontmatter timeout wins over param; neither → undefined", () => {
		const result = resolveSpawnConfig(
			{ subagent_type: "test-agent", prompt: "p", description: "d", timeout: 60 },
			makeTimeoutRegistry(),
			makeModelInfo(),
			{ defaultMaxTurns: undefined, defaultTimeoutSeconds: 600 },
		);
		if ("error" in result) return;
		expect(result.execution.effectiveTimeoutSeconds).toBe(300);
	});
});

describe("resolveSpawnConfig — invocation fields", () => {
	it("sets runInBackground from params", () => {
		const result = resolveSpawnConfig(
			{ subagent_type: "general-purpose", prompt: "test", description: "d", run_in_background: true },
			testRegistry,
			makeModelInfo(),
			defaultSettings,
		);
		if ("error" in result) return;
		expect(result.execution.runInBackground).toBe(true);
	});

	it("builds agentInvocation snapshot with modelName always present", () => {
		const result = resolveSpawnConfig(
			{ subagent_type: "general-purpose", prompt: "test", description: "d", thinking: "high" },
			testRegistry,
			makeModelInfo(),
			defaultSettings,
		);
		if ("error" in result) return;
		expect(result.execution.agentInvocation).toEqual({
			modelName: "anthropic/claude-sonnet",
			thinking: "high",
			maxTurns: undefined,
			inheritContext: false,
			runInBackground: false,
		});
	});
});

describe("resolveSpawnConfig — detailBase and tags", () => {
	it("builds detailBase with description from params", () => {
		const result = resolveSpawnConfig(
			{ subagent_type: "general-purpose", prompt: "test", description: "my task" },
			testRegistry,
			makeModelInfo(),
			defaultSettings,
		);
		if ("error" in result) return;
		expect(result.presentation.detailBase.description).toBe("my task");
		expect(result.presentation.detailBase.subagentType).toBe("general-purpose");
		expect(result.presentation.detailBase.displayName).toBe("Agent");
	});

	it("includes thinking tag when thinking is set", () => {
		const result = resolveSpawnConfig(
			{ subagent_type: "general-purpose", prompt: "test", description: "d", thinking: "high" },
			testRegistry,
			makeModelInfo(),
			defaultSettings,
		);
		if ("error" in result) return;
		expect(result.presentation.agentTags).toContain("thinking: high");
	});

	it("omits mode label for replace-mode agents", () => {
		const result = resolveSpawnConfig(
			{ subagent_type: "Explore", prompt: "test", description: "d" },
			testRegistry,
			makeModelInfo(),
			defaultSettings,
		);
		if ("error" in result) return;
		// Explore has promptMode: "replace" → no mode label, no invocation overrides
		expect(result.presentation.agentTags).toEqual([]);
		// No invocation overrides → detailBase.tags stays undefined
		expect(result.presentation.detailBase.tags).toBeUndefined();
	});

	it("includes append tag for append-mode agents like general-purpose", () => {
		const result = resolveSpawnConfig(
			{ subagent_type: "general-purpose", prompt: "test", description: "d" },
			testRegistry,
			makeModelInfo(),
			defaultSettings,
		);
		if ("error" in result) return;
		// general-purpose has promptMode: "append" → gets the "append" label
		expect(result.presentation.agentTags).toContain("append");
	});
});

describe("resolveSpawnConfig — prompt and rawType passthrough", () => {
	it("passes through prompt and rawType", () => {
		const result = resolveSpawnConfig(
			{ subagent_type: "Explore", prompt: "search for bugs", description: "bug search" },
			testRegistry,
			makeModelInfo(),
			defaultSettings,
		);
		if ("error" in result) return;
		expect(result.execution.prompt).toBe("search for bugs");
		expect(result.identity.rawType).toBe("Explore");
	});
});
