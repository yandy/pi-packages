import { describe, expect, it } from "vitest";
import { AgentTypeRegistry } from "../../src/config/agent-types";
import type { EnvInfo } from "../../src/session/env";
import { buildAgentPrompt, buildAppendSection } from "../../src/session/prompts";
import type { AgentConfig } from "../../src/types";

const testRegistry = new AgentTypeRegistry(() => new Map());

const env: EnvInfo = {
	isGitRepo: true,
	branch: "main",
	platform: "darwin",
};

const envNoGit: EnvInfo = {
	isGitRepo: false,
	branch: "",
	platform: "linux",
};

function getDefaultConfig(name: string): AgentConfig {
	return testRegistry.resolveAgentConfig(name);
}

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "test-agent",
		description: "Test",
		builtinToolNames: [],
		systemPrompt: "You are a test agent.",
		promptMode: "append",
		...overrides,
	};
}

describe("buildAgentPrompt", () => {
	it("replace mode includes parent prompt as base (no bridge/wrapper)", () => {
		const config = agent({ name: "standalone", systemPrompt: "You are a standalone agent.", promptMode: "replace" });
		const prompt = buildAgentPrompt(config, "/workspace", env, "PARENT parent prompt content");
		expect(prompt).toContain("You are a standalone agent.");
		expect(prompt).toContain("PARENT parent prompt content");
		expect(prompt).not.toContain("<sub_agent_context>");
		expect(prompt).not.toContain("<agent_instructions>");
	});

	it("replace mode falls back to genericBase when no parent supplied", () => {
		const config = agent({ promptMode: "replace", systemPrompt: "Custom standalone instructions." });
		const prompt = buildAgentPrompt(config, "/workspace", env);
		expect(prompt).toContain("general-purpose coding agent");
		expect(prompt).not.toContain("You are a pi coding agent sub-agent");
		expect(prompt).toContain("Custom standalone instructions.");
	});

	it("replace mode orders: identity → active_agent → env → config.systemPrompt", () => {
		const config = agent({ name: "ordered", promptMode: "replace", systemPrompt: "Final custom instructions." });
		const prompt = buildAgentPrompt(config, "/workspace", env, "IDENTITY parent content");
		const idxIdentity = prompt.indexOf("IDENTITY parent content");
		const idxTag = prompt.indexOf('<active_agent name="ordered"/>');
		const idxEnv = prompt.indexOf("# Environment");
		const idxCustom = prompt.indexOf("Final custom instructions.");
		expect(idxIdentity).toBeGreaterThan(-1);
		expect(idxTag).toBeGreaterThan(idxIdentity);
		expect(idxEnv).toBeGreaterThan(idxTag);
		expect(idxCustom).toBeGreaterThan(idxEnv);
	});
});

describe("buildAppendSection", () => {
	it("starts with a blank-line separator so it can follow a base prompt", () => {
		expect(buildAppendSection(agent(), env).startsWith("\n\n")).toBe(true);
	});

	it("includes the sub-agent bridge without per-tool reminders", () => {
		const section = buildAppendSection(agent(), env);
		expect(section).toContain("<sub_agent_context>");
		expect(section).toContain("You are operating as a sub-agent invoked to handle a specific task.");
		expect(section).toContain("- Make independent tool calls in parallel");
		expect(section).not.toContain("Use the read tool");
		expect(section).not.toContain("Use the edit tool");
		expect(section).not.toContain("Use the grep tool");
	});

	it("wraps a non-empty body in <agent_instructions>", () => {
		const section = buildAppendSection(agent({ systemPrompt: "Extra instructions." }), env);
		expect(section).toContain("<agent_instructions>\nExtra instructions.\n</agent_instructions>");
	});

	it("omits <agent_instructions> for an empty body", () => {
		const section = buildAppendSection(agent({ systemPrompt: "" }), env);
		expect(section).not.toContain("<agent_instructions>");
	});

	it("renders git branch and platform but never the working directory", () => {
		const section = buildAppendSection(agent(), env);
		expect(section).toContain("Branch: main");
		expect(section).toContain("Platform: darwin");
		expect(section).not.toContain("Working directory:");
		expect(section).not.toContain("/workspace");
	});

	it("renders 'Not a git repository' without a branch line", () => {
		const section = buildAppendSection(agent(), envNoGit);
		expect(section).toContain("Not a git repository");
		expect(section).not.toContain("Branch:");
	});

	it("carries the built-in read-only Explore body", () => {
		const section = buildAppendSection(getDefaultConfig("Explore"), env);
		expect(section).toContain("READ-ONLY");
		expect(section).toContain("file search specialist");
	});
});

// Patch 3 (RepOne #443): inject <active_agent name="..."/> tag so downstream
// extensions can resolve per-agent policy by parsing the child's system prompt.
describe("active_agent tag injection", () => {
	it("append section places the tag after the bridge and before the env block", () => {
		const section = buildAppendSection(agent({ name: "agent-b", systemPrompt: "" }), env);
		const bridgeIdx = section.indexOf("<sub_agent_context>");
		const tagIdx = section.indexOf('<active_agent name="agent-b"/>');
		const envIdx = section.indexOf("# Environment");
		expect(tagIdx).toBeGreaterThan(bridgeIdx);
		expect(envIdx).toBeGreaterThan(tagIdx);
	});

	it("replace prompt places the tag before the env block", () => {
		const prompt = buildAgentPrompt(agent({ name: "agent-a", promptMode: "replace" }), "/workspace", env);
		const tagIdx = prompt.indexOf('<active_agent name="agent-a"/>');
		const envIdx = prompt.indexOf("# Environment");
		expect(tagIdx).toBeGreaterThan(0);
		expect(envIdx).toBeGreaterThan(tagIdx);
	});
});
