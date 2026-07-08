import { describe, expect, it } from "vitest";
import { AgentTypeRegistry } from "../../src/config/agent-types";
import { resolveModelName, resolveSpawnConfig } from "../../src/tools/spawn-config";
import type { AgentConfig } from "../../src/types";

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "test-agent",
		description: "Test agent",
		builtinToolNames: ["read", "grep"],
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

const defaultSettings = { defaultMaxTurns: undefined as number | undefined };

describe("resolveModelName", () => {
	it("returns provider/id when provider and id are present", () => {
		expect(resolveModelName({ provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet" })).toBe(
			"anthropic/claude-sonnet",
		);
	});

	it("returns provider/id for other providers", () => {
		expect(resolveModelName({ provider: "openai", id: "gpt-4o", name: "GPT-4o" })).toBe("openai/gpt-4o");
		expect(resolveModelName({ provider: "deepseek", id: "deepseek-v4-flash" })).toBe("deepseek/deepseek-v4-flash");
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

	it("sets displayName from registry", () => {
		const result = resolveSpawnConfig(
			{ subagent_type: "Explore", prompt: "test", description: "d" },
			testRegistry,
			makeModelInfo(),
			defaultSettings,
		);
		if ("error" in result) return;
		expect(result.identity.displayName).toBe("Explore");
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
	});

	it("includes twin tag for append-mode agents like general-purpose", () => {
		const result = resolveSpawnConfig(
			{ subagent_type: "general-purpose", prompt: "test", description: "d" },
			testRegistry,
			makeModelInfo(),
			defaultSettings,
		);
		if ("error" in result) return;
		// general-purpose has promptMode: "append" → gets "twin" label
		expect(result.presentation.agentTags).toContain("twin");
	});

	it("sets tags to undefined on detailBase for replace-mode agents with no invocation overrides", () => {
		const result = resolveSpawnConfig(
			{ subagent_type: "Explore", prompt: "test", description: "d" },
			testRegistry,
			makeModelInfo(),
			defaultSettings,
		);
		if ("error" in result) return;
		// Explore has promptMode: "replace" and no invocation overrides → no tags
		expect(result.presentation.detailBase.tags).toBeUndefined();
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
