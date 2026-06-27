import { describe, expect, it } from "vitest";
import { AgentTypeRegistry } from "../../src/config/agent-types";
import type { EnvInfo } from "../../src/session/env";
import { buildAgentPrompt } from "../../src/session/prompts";
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

describe("buildAgentPrompt", () => {
  it("includes cwd and git info", () => {
    const config = getDefaultConfig("general-purpose");
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("/workspace");
    expect(prompt).toContain("Branch: main");
    expect(prompt).toContain("darwin");
  });

  it("handles non-git repos", () => {
    const config = getDefaultConfig("Explore");
    const prompt = buildAgentPrompt(config, "/workspace", envNoGit);
    expect(prompt).toContain("Not a git repository");
    expect(prompt).not.toContain("Branch:");
  });

  it("Explore prompt is read-only", () => {
    const config = getDefaultConfig("Explore");
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("READ-ONLY");
    expect(prompt).toContain("file search specialist");
  });

  it("Plan prompt is read-only", () => {
    const config = getDefaultConfig("Plan");
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("READ-ONLY");
    expect(prompt).toContain("software architect");
  });

  it("general-purpose uses append mode (parent twin)", () => {
    const config = getDefaultConfig("general-purpose");
    const parentPrompt = "You are a parent coding agent with full powers.";
    const prompt = buildAgentPrompt(config, "/workspace", env, parentPrompt);
    expect(prompt).toContain("parent coding agent with full powers");
    expect(prompt).toContain("<sub_agent_context>");
    expect(prompt).not.toContain("<inherited_system_prompt>");
    expect(prompt).not.toContain("READ-ONLY");
    // Empty systemPrompt means no <agent_instructions> section
    expect(prompt).not.toContain("<agent_instructions>");
  });

  it("general-purpose without parent prompt falls back to generic base", () => {
    const config = getDefaultConfig("general-purpose");
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("general-purpose coding agent");
    expect(prompt).not.toContain("READ-ONLY");
  });

  it("append mode with parent prompt includes parent + custom instructions", () => {
    const config: AgentConfig = {
      name: "appender",
      description: "Appender",
      builtinToolNames: [],
      systemPrompt: "Extra custom instructions here.",
      promptMode: "append",
      inheritContext: false,
      runInBackground: false,
    };
    const parentPrompt = "You are a parent coding agent with special powers.";
    const prompt = buildAgentPrompt(config, "/workspace", env, parentPrompt);
    expect(prompt).toContain("/workspace");
    expect(prompt).toContain("parent coding agent with special powers");
    expect(prompt).toContain("<sub_agent_context>");
    expect(prompt).not.toContain("<inherited_system_prompt>");
    expect(prompt).toContain("<agent_instructions>");
    expect(prompt).toContain("Extra custom instructions here.");
  });

  it("append mode without parent prompt falls back to generic base", () => {
    const config: AgentConfig = {
      name: "appender",
      description: "Appender",
      builtinToolNames: [],
      systemPrompt: "Extra custom instructions here.",
      promptMode: "append",
      inheritContext: false,
      runInBackground: false,
    };
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("/workspace");
    expect(prompt).toContain("general-purpose coding agent");
    expect(prompt).toContain("Extra custom instructions here.");
  });

  it("append mode with empty systemPrompt is a pure parent clone", () => {
    const config: AgentConfig = {
      name: "clone",
      description: "Clone",
      builtinToolNames: [],
      systemPrompt: "",
      promptMode: "append",
      inheritContext: false,
      runInBackground: false,
    };
    const parentPrompt = "You are a parent coding agent.";
    const prompt = buildAgentPrompt(config, "/workspace", env, parentPrompt);
    expect(prompt).toContain("parent coding agent");
    expect(prompt).toContain("<sub_agent_context>");
    expect(prompt).not.toContain("<inherited_system_prompt>");
    expect(prompt).not.toContain("<agent_instructions>");
  });

  it("replace mode includes config systemPrompt last and removes the thin standalone header", () => {
    const config: AgentConfig = {
      name: "custom",
      description: "Custom",
      builtinToolNames: [],
      systemPrompt: "You are a specialized agent.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
    };
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("You are a specialized agent.");
    expect(prompt).toContain("/workspace");
    // The thin two-line standalone header is removed in favour of the parent/genericBase prefix.
    expect(prompt).not.toContain("You are a pi coding agent sub-agent");
  });

  it("replace mode includes parent prompt as base (no bridge/wrapper)", () => {
    const config: AgentConfig = {
      name: "standalone",
      description: "Standalone",
      builtinToolNames: [],
      systemPrompt: "You are a standalone agent.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
    };
    const prompt = buildAgentPrompt(
      config,
      "/workspace",
      env,
      "PARENT parent prompt content",
    );
    expect(prompt).toContain("You are a standalone agent.");
    // Parent is now included as the cacheable base prefix.
    expect(prompt).toContain("PARENT parent prompt content");
    // Replace mode still omits the bridge and agent_instructions wrapper.
    expect(prompt).not.toContain("<sub_agent_context>");
    expect(prompt).not.toContain("<agent_instructions>");
  });

  it("replace mode falls back to genericBase when no parent supplied", () => {
    const config: AgentConfig = {
      name: "standalone",
      description: "Standalone",
      builtinToolNames: [],
      systemPrompt: "Custom standalone instructions.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
    };
    const prompt = buildAgentPrompt(config, "/workspace", env);
    // Should use genericBase as the prefix (same fallback as append mode).
    expect(prompt).toContain("general-purpose coding agent");
    expect(prompt).not.toContain("You are a pi coding agent sub-agent");
    expect(prompt).toContain("Custom standalone instructions.");
  });

  it("replace mode orders: identity → active_agent → env → config.systemPrompt", () => {
    const config: AgentConfig = {
      name: "ordered",
      description: "Ordered",
      builtinToolNames: [],
      systemPrompt: "Final custom instructions.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
    };
    const prompt = buildAgentPrompt(
      config,
      "/workspace",
      env,
      "IDENTITY parent content",
    );
    const idxIdentity = prompt.indexOf("IDENTITY parent content");
    const idxTag = prompt.indexOf('<active_agent name="ordered"/>');
    const idxEnv = prompt.indexOf("# Environment");
    const idxCustom = prompt.indexOf("Final custom instructions.");
    expect(idxIdentity).toBeGreaterThan(-1);
    expect(idxTag).toBeGreaterThan(idxIdentity);
    expect(idxEnv).toBeGreaterThan(idxTag);
    expect(idxCustom).toBeGreaterThan(idxEnv);
  });

  it("append mode bridge contains tool reminders", () => {
    const config = getDefaultConfig("general-purpose");
    const prompt = buildAgentPrompt(
      config,
      "/workspace",
      env,
      "Parent prompt.",
    );
    expect(prompt).toContain("Use the read tool instead of cat");
    expect(prompt).toContain("Use the edit tool instead of sed");
    expect(prompt).toContain("Use the grep tool instead of");
  });

  it("append mode without parent prompt still has bridge", () => {
    const config: AgentConfig = {
      name: "no-parent",
      description: "No parent",
      builtinToolNames: [],
      systemPrompt: "Extra stuff.",
      promptMode: "append",
      inheritContext: false,
      runInBackground: false,
    };
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("<sub_agent_context>");
    expect(prompt).not.toContain("<inherited_system_prompt>");
    expect(prompt).toContain("Use the read tool instead of cat");
    expect(prompt).toContain("general-purpose coding agent");
    expect(prompt).toContain("Extra stuff.");
  });

  // Patch 3 (RepOne #443): inject <active_agent name="..."/> tag so downstream
  // extensions (e.g. @yandy0725/pi-permission-system) can resolve per-agent
  // policy by parsing the child's system prompt.
  describe("active_agent tag injection", () => {
    it("includes <active_agent name=...> tag in replace mode after identity prefix", () => {
      const config: AgentConfig = {
        name: "Explore",
        description: "Explore",
        builtinToolNames: [],
        systemPrompt: "You are an explorer.",
        promptMode: "replace",
        inheritContext: false,
        runInBackground: false,
      };
      // Replace mode now places identity (parent/genericBase) first for KV
      // cache reuse; the tag follows after the cacheable prefix.
      const prompt = buildAgentPrompt(
        config,
        "/workspace",
        env,
        "Parent identity prefix.",
      );
      const idxIdentity = prompt.indexOf("Parent identity prefix.");
      const idxTag = prompt.indexOf('<active_agent name="Explore"/>');
      expect(idxTag).toBeGreaterThan(-1);
      expect(idxTag).toBeGreaterThan(idxIdentity);
    });

    it("includes <active_agent name=...> tag in append mode after sub_agent_context", () => {
      const config: AgentConfig = {
        name: "general-purpose",
        description: "Twin",
        builtinToolNames: [],
        systemPrompt: "",
        promptMode: "append",
        inheritContext: false,
        runInBackground: false,
      };
      const prompt = buildAgentPrompt(
        config,
        "/workspace",
        env,
        "Parent prompt content.",
      );
      const tagIdx = prompt.indexOf('<active_agent name="general-purpose"/>');
      const ctxIdx = prompt.indexOf("<sub_agent_context>");
      expect(tagIdx).toBeGreaterThan(-1);
      expect(ctxIdx).toBeGreaterThan(-1);
      // Sub-agent context comes before the agent-specific active_agent tag
      expect(ctxIdx).toBeLessThan(tagIdx);
    });

    it("uses agent name verbatim in the tag (no escaping or normalization)", () => {
      const config: AgentConfig = {
        name: "my-custom-agent",
        description: "Custom",
        builtinToolNames: [],
        systemPrompt: "You are custom.",
        promptMode: "replace",
        inheritContext: false,
        runInBackground: false,
      };
      const prompt = buildAgentPrompt(config, "/workspace", env);
      expect(prompt).toContain('<active_agent name="my-custom-agent"/>');
    });

    it("active_agent tag appears before envBlock in both modes", () => {
      const replaceConfig: AgentConfig = {
        name: "agent-a",
        description: "Replace",
        builtinToolNames: [],
        systemPrompt: "Replace agent.",
        promptMode: "replace",
        inheritContext: false,
        runInBackground: false,
      };
      const replacePrompt = buildAgentPrompt(replaceConfig, "/workspace", env);
      const tagIdx = replacePrompt.indexOf('<active_agent name="agent-a"/>');
      const envIdx = replacePrompt.indexOf("# Environment");
      // Replace mode: tag follows the identity prefix (not at position 0)
      // but still precedes the env block.
      expect(tagIdx).toBeGreaterThan(0);
      expect(envIdx).toBeGreaterThan(tagIdx);

      const appendConfig: AgentConfig = {
        name: "agent-b",
        description: "Append",
        builtinToolNames: [],
        systemPrompt: "",
        promptMode: "append",
        inheritContext: false,
        runInBackground: false,
      };
      const appendPrompt = buildAgentPrompt(
        appendConfig,
        "/workspace",
        env,
        "Parent.",
      );
      const tagIdxB = appendPrompt.indexOf('<active_agent name="agent-b"/>');
      const envIdxB = appendPrompt.indexOf("# Environment");
      // Append mode: tag follows parent content (not at index 0) but still precedes env block
      expect(tagIdxB).toBeGreaterThan(0);
      expect(envIdxB).toBeGreaterThan(tagIdxB);
    });
  });
});
