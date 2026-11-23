import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "../../src/config/agent-types";
import { loadCustomAgents } from "../../src/config/custom-agents";
import { assembleSessionConfig } from "../../src/session/session-config";

describe("loadCustomAgents", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pi-test-"));
		// 全局目录隔离：getAgentDir() 读 PI_CODING_AGENT_DIR（跨平台）；HOME 在 Windows 上不被
		// os.homedir() 采纳（读 USERPROFILE），不能作为隔离手段（testing.md「getAgentDir 隔离」）。
		vi.stubEnv("PI_CODING_AGENT_DIR", join(tmpDir, "agent-dir"));
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeAgent(name: string, content: string) {
		const dir = join(tmpDir, ".pi", "agents");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${name}.md`), content);
	}

	it("returns empty map when .pi/agents/ does not exist", () => {
		const result = loadCustomAgents(tmpDir);
		expect(result.size).toBe(0);
	});

	it("loads a basic agent with all frontmatter fields", () => {
		writeAgent(
			"auditor",
			`---
description: Security Auditor
tools: read, grep, find
model: anthropic/claude-opus-4-6
thinking: high
max_turns: 30
timeout: 300
prompt_mode: replace
inherit_context: true
run_in_background: true
---

You are a security auditor.`,
		);

		const result = loadCustomAgents(tmpDir);
		expect(result.size).toBe(1);

		const agent = result.get("auditor")!;
		expect(agent.name).toBe("auditor");
		expect(agent.description).toBe("Security Auditor");
		expect(agent.toolNames).toEqual(["read", "grep", "find"]);
		expect(agent.model).toBe("anthropic/claude-opus-4-6");
		expect(agent.thinking).toBe("high");
		expect(agent.maxTurns).toBe(30);
		expect(agent.timeout).toBe(300);
		expect(agent.promptMode).toBe("replace");
		expect(agent.inheritContext).toBe(true);
		expect(agent.runInBackground).toBe(true);
		expect(agent.systemPrompt).toBe("You are a security auditor.");
	});

	it("drops a non-numeric timeout", () => {
		writeAgent(
			"badtimeout",
			`---
description: Bad Timeout
timeout: abc
---

Prompt.`,
		);

		const agent = loadCustomAgents(tmpDir).get("badtimeout")!;
		expect(agent.timeout).toBeUndefined();
	});

	it("uses sensible defaults when frontmatter is empty", () => {
		writeAgent(
			"minimal",
			`---
---

Just a prompt.`,
		);

		const result = loadCustomAgents(tmpDir);
		const agent = result.get("minimal")!;

		expect(agent.name).toBe("minimal");
		expect(agent.description).toBe("minimal"); // defaults to filename
		expect(agent.toolNames).toBeUndefined(); // omitted = inherit the parent's tools
		expect(agent.model).toBeUndefined();
		expect(agent.thinking).toBeUndefined();
		expect(agent.maxTurns).toBeUndefined();
		expect(agent.promptMode).toBe("append");
		expect(agent.inheritContext).toBeUndefined();
		expect(agent.runInBackground).toBeUndefined();
		expect(agent.systemPrompt).toBe("Just a prompt.");
	});

	it("uses sensible defaults when no frontmatter at all", () => {
		writeAgent("bare", "Just a system prompt, no frontmatter.");

		const result = loadCustomAgents(tmpDir);
		const agent = result.get("bare")!;

		expect(agent.name).toBe("bare");
		expect(agent.description).toBe("bare");
		expect(agent.toolNames).toBeUndefined(); // omitted = inherit the parent's tools
		expect(agent.promptMode).toBe("append");
		expect(agent.systemPrompt).toBe("Just a system prompt, no frontmatter.");
	});

	it("lets a project agent override a global agent with the same name", () => {
		// global: $PI_CODING_AGENT_DIR/agents/auditor.md（beforeEach 已 stub 指向 tmpDir 内的 agent-dir）
		const globalDir = join(tmpDir, "agent-dir", "agents");
		mkdirSync(globalDir, { recursive: true });
		writeFileSync(
			join(globalDir, "auditor.md"),
			"---\ndescription: Global Auditor\n---\n\nGlobal prompt.",
			"utf8",
		);
		// project: <cwd>/.pi/agents/auditor.md
		writeAgent(
			"auditor",
			"---\ndescription: Project Auditor\n---\n\nProject prompt.",
		);

		const result = loadCustomAgents(tmpDir);
		expect(result.size).toBe(1);
		const agent = result.get("auditor")!;
		expect(agent.description).toBe("Project Auditor");
		expect(agent.systemPrompt).toBe("Project prompt.");
	});

	it("handles tools: none → empty array", () => {
		writeAgent(
			"notool",
			`---
tools: none
---

No tools.`,
		);

		const result = loadCustomAgents(tmpDir);
		expect(result.get("notool")?.toolNames).toEqual([]);
	});

	it("treats a bare `tools:` line as zero tools, not inherit", () => {
		writeAgent(
			"barenotool",
			`---
tools:
---

No tools.`,
		);

		const result = loadCustomAgents(tmpDir);
		expect(result.get("barenotool")?.toolNames).toEqual([]);
	});

	it("keeps a bare `tools:` line as zero tools even with a known parent set", () => {
		writeAgent("barenotool", `---
tools:
---

No tools.`);

		const registry = new AgentTypeRegistry(() => loadCustomAgents(tmpDir));
		const io = { buildReplacePrompt: () => "", buildAppendSection: () => "" };
		const env = { isGitRepo: false, branch: "", platform: "linux" as const };

		// The key is present (YAML null) but valueless: zero tools, even though
		// the parent's active set is known — this is the case that was broken.
		expect(
			assembleSessionConfig(
				"barenotool",
				{ cwd: tmpDir, modelRegistry: { find: () => undefined }, activeToolNames: ["read", "bash", "subagent"] },
				{},
				env,
				registry,
				io,
			).toolNames,
		).toEqual([]);
	});

	it("keeps `tools: none` empty all the way into the session config", () => {
		writeAgent("notool", `---
tools: none
---

No tools.`);
		writeAgent("notools2", `---
description: omitted tools field
---

All tools.`);

		const registry = new AgentTypeRegistry(() => loadCustomAgents(tmpDir));
		const io = { buildReplacePrompt: () => "", buildAppendSection: () => "" };
		const ctx = { cwd: tmpDir, modelRegistry: { find: () => undefined } };
		const env = { isGitRepo: false, branch: "", platform: "linux" as const };

		// none/empty → zero tools; omitted → inherit the parent's tools (undefined).
		expect(assembleSessionConfig("notool", ctx, {}, env, registry, io).toolNames).toEqual([]);
		expect(assembleSessionConfig("notools2", ctx, {}, env, registry, io).toolNames).toBeUndefined();

		// With a known parent active set, the omitted list resolves to that set minus dispatch tools.
		const withParent = { ...ctx, activeToolNames: ["read", "bash", "subagent"] };
		expect(assembleSessionConfig("notools2", withParent, {}, env, registry, io).toolNames).toEqual(["read", "bash"]);
	});

	it("carries a +name/-name list into the session config and rejects a mixed one", () => {
		writeAgent("deltas", `---\ntools: -edit, -write\n---\n\nDeltas.`);
		writeAgent("mixed", `---\ntools: read, -edit\n---\n\nMixed.`);

		const registry = new AgentTypeRegistry(() => loadCustomAgents(tmpDir));
		const io = { buildReplacePrompt: () => "", buildAppendSection: () => "" };
		const ctx = { cwd: tmpDir, modelRegistry: { find: () => undefined } };
		const env = { isGitRepo: false, branch: "", platform: "linux" as const };

		expect(assembleSessionConfig("deltas", ctx, {}, env, registry, io).toolNames).toEqual(["-edit", "-write"]);
		expect(() => assembleSessionConfig("mixed", ctx, {}, env, registry, io)).toThrow(/"mixed".*cannot be mixed/s);
	});

	it("passes +name / -name entries through as an inheriting list", () => {
		writeAgent(
			"deltas",
			`---
tools: -edit, -write, +powershell
---

Deltas.`,
		);

		const result = loadCustomAgents(tmpDir);
		expect(result.get("deltas")?.toolNames).toEqual(["-edit", "-write", "+powershell"]);
	});

	it("passes through unknown tool names (not filtered)", () => {
		writeAgent(
			"custom-tools",
			`---
tools: read, my_custom_tool, grep
---

Custom tools.`,
		);

		const result = loadCustomAgents(tmpDir);
		// Unknown tool names are passed through — filtering happens at tool creation time
		expect(result.get("custom-tools")?.toolNames).toEqual(["read", "my_custom_tool", "grep"]);
	});

	it("passes through thinking level as-is (no validation)", () => {
		writeAgent(
			"anythink",
			`---
thinking: turbo
---

Any thinking.`,
		);

		const result = loadCustomAgents(tmpDir);
		// Pi validates at session creation — we just pass through
		expect(result.get("anythink")?.thinking).toBe("turbo");
	});

	it("accepts max_turns: 0 as unlimited", () => {
		writeAgent(
			"unlimited",
			`---
max_turns: 0
---

Unlimited turns.`,
		);

		const result = loadCustomAgents(tmpDir);
		expect(result.get("unlimited")?.maxTurns).toBe(0);
	});

	it("rejects negative max_turns", () => {
		writeAgent(
			"negturns",
			`---
max_turns: -5
---

Negative turns.`,
		);

		const result = loadCustomAgents(tmpDir);
		expect(result.get("negturns")?.maxTurns).toBeUndefined();
	});

	it("defaults unknown prompt_mode to append", () => {
		writeAgent(
			"badmode",
			`---
prompt_mode: merge
---

Unknown mode.`,
		);

		const result = loadCustomAgents(tmpDir);
		expect(result.get("badmode")?.promptMode).toBe("append");
	});

	it("loads multiple agents", () => {
		writeAgent(
			"agent1",
			`---
description: First
---

First agent.`,
		);
		writeAgent(
			"agent2",
			`---
description: Second
---

Second agent.`,
		);

		const result = loadCustomAgents(tmpDir);
		expect(result.size).toBe(2);
		expect(result.has("agent1")).toBe(true);
		expect(result.has("agent2")).toBe(true);
	});

	it("skips non-.md files", () => {
		const dir = join(tmpDir, ".pi", "agents");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "notes.txt"), "not an agent");
		writeFileSync(
			join(dir, "real.md"),
			`---
description: Real Agent
---

Real.`,
		);

		const result = loadCustomAgents(tmpDir);
		expect(result.size).toBe(1);
		expect(result.has("real")).toBe(true);
	});

	it("allows agents with names matching defaults (overrides them)", () => {
		writeAgent(
			"Explore",
			`---
description: Custom Explore
---

Custom explore agent.`,
		);
		writeAgent(
			"custom",
			`---
description: Custom Agent
---

Should be loaded.`,
		);

		const result = loadCustomAgents(tmpDir);
		expect(result.has("Explore")).toBe(true);
		expect(result.get("Explore")?.description).toBe("Custom Explore");
		expect(result.has("custom")).toBe(true);
	});

	it("handles empty body with frontmatter", () => {
		writeAgent(
			"nobody",
			`---
description: No body
tools: read
---
`,
		);

		const result = loadCustomAgents(tmpDir);
		expect(result.get("nobody")?.systemPrompt).toBe("");
	});

	it("handles enabled: false frontmatter", () => {
		writeAgent(
			"disabled",
			`---
enabled: false
---
`,
		);

		const result = loadCustomAgents(tmpDir);
		const agent = result.get("disabled")!;
		expect(agent.enabled).toBe(false);
	});

	it("parses display_name frontmatter", () => {
		writeAgent(
			"myagent",
			`---
description: My Agent
display_name: MyAgent
---

Agent prompt.`,
		);

		const result = loadCustomAgents(tmpDir);
		expect(result.get("myagent")?.displayName).toBe("MyAgent");
	});

	it("honors PI_CODING_AGENT_DIR for global custom agent discovery", () => {
		const altAgentDir = mkdtempSync(join(tmpdir(), "pi-alt-agent-"));
		const originalEnv = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = altAgentDir;
		try {
			const globalAgentsDir = join(altAgentDir, "agents");
			mkdirSync(globalAgentsDir, { recursive: true });
			writeFileSync(join(globalAgentsDir, "via-env.md"), "---\ndescription: Discovered via env var\n---\n\nTest body.");

			const result = loadCustomAgents(tmpDir);

			// Agent is found at $PI_CODING_AGENT_DIR/agents, not at $HOME/.pi/agent/agents
			expect(result.has("via-env")).toBe(true);
			expect(result.get("via-env")?.description).toBe("Discovered via env var");
		} finally {
			if (originalEnv == null) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = originalEnv;
			rmSync(altAgentDir, { recursive: true, force: true });
		}
	});
});
