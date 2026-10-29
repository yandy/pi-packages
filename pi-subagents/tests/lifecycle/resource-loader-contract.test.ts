import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildResourceLoaderOptions } from "../../src/lifecycle/create-subagent-session";
import type { SessionConfig } from "../../src/session/session-config";

/**
 * Contract tests against the REAL DefaultResourceLoader.
 *
 * The factory tests mock createResourceLoader, so they only prove which options
 * we pass. These prove what the harness does with them — the SDK semantics the
 * whole prompt_mode design rests on:
 *
 *   append  → base prompt comes from SYSTEM.md, APPEND_SYSTEM.md stays in front
 *             of our section, AGENTS.md is loaded
 *   replace → our section is the whole prompt; the three of them are suppressed
 */

const SECTION = "<sub_agent_context>\nSUB-AGENT SECTION\n</sub_agent_context>";

let cwd: string;
let agentDir: string;

function writeProjectFiles(): void {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "SYSTEM.md"), "PROJECT SYSTEM PROMPT");
	writeFileSync(join(cwd, ".pi", "APPEND_SYSTEM.md"), "PROJECT APPEND");
	writeFileSync(join(cwd, "AGENTS.md"), "PROJECT AGENTS RULES");
}

function config(promptMode: "append" | "replace"): SessionConfig {
	return {
		effectiveCwd: cwd,
		promptMode,
		promptSection: SECTION,
		toolNames: ["read"],
		model: undefined,
		thinkingLevel: undefined,
		agentMaxTurns: undefined,
	};
}

async function load(promptMode: "append" | "replace") {
	const loader = new DefaultResourceLoader(buildResourceLoaderOptions(config(promptMode), agentDir));
	await loader.reload();
	return loader;
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "pi-subagents-rl-cwd-"));
	agentDir = mkdtempSync(join(tmpdir(), "pi-subagents-rl-agent-"));
	writeProjectFiles();
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
});

describe("resource loader contract — append", () => {
	it("takes the base prompt from SYSTEM.md instead of us overriding it", async () => {
		const loader = await load("append");
		expect(loader.getSystemPrompt()).toBe("PROJECT SYSTEM PROMPT");
	});

	it("appends our section after APPEND_SYSTEM.md", async () => {
		const loader = await load("append");
		expect(loader.getAppendSystemPrompt()).toEqual(["PROJECT APPEND", SECTION]);
	});

	it("leaves the base prompt to the harness when there is no SYSTEM.md", async () => {
		// The common case: no override means buildSystemPrompt falls back to its own
		// template (tool list + guidelines rendered for the child's own tools).
		rmSync(join(cwd, ".pi", "SYSTEM.md"));
		const loader = await load("append");
		expect(loader.getSystemPrompt() || "").toBe("");
	});

	it("loads the project AGENTS.md", async () => {
		const loader = await load("append");
		const files = loader.getAgentsFiles().agentsFiles.map((f) => basename(f.path));
		expect(files).toContain("AGENTS.md");
	});
});

describe("resource loader contract — replace", () => {
	it("uses our section as the whole system prompt, ignoring SYSTEM.md", async () => {
		const loader = await load("replace");
		expect(loader.getSystemPrompt()).toBe(SECTION);
	});

	it("suppresses APPEND_SYSTEM.md entirely", async () => {
		const loader = await load("replace");
		expect(loader.getAppendSystemPrompt()).toEqual([]);
	});

	it("suppresses the project AGENTS.md", async () => {
		const loader = await load("replace");
		expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
	});
});
