import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CodingToolsConfig, loadConfig } from "../src/config";

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-coding-tools-test-"));
}

describe("loadConfig", () => {
	let tempCwd: string;
	let savedHome: string | undefined;
	let savedAgentDir: string | undefined;

	beforeEach(() => {
		tempCwd = makeTempDir();
		// loadConfig caches by cwd; reset cache between tests by using a unique cwd each time
		savedHome = process.env.HOME;
		// Unset PI_CODING_AGENT_DIR so getAgentDir() uses HOME instead
		savedAgentDir = process.env.PI_CODING_AGENT_DIR;
		delete process.env.PI_CODING_AGENT_DIR;
	});

	afterEach(() => {
		if (savedHome !== undefined) process.env.HOME = savedHome;
		if (savedAgentDir !== undefined) process.env.PI_CODING_AGENT_DIR = savedAgentDir;
		rmSync(tempCwd, { recursive: true, force: true });
	});

	it("returns all-true defaults when no config files exist", () => {
		const config = loadConfig(tempCwd);
		const expected: CodingToolsConfig = {
			ls: true,
			find: true,
			grep: true,
		};
		expect(config).toEqual(expected);
	});

	it("reads global config from agent dir", () => {
		// Point HOME to temp dir so getAgentDir() resolves inside it
		process.env.HOME = tempCwd;
		const agentDir = join(tempCwd, ".pi", "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "coding-tools.json"), JSON.stringify({ grep: false }));

		const config = loadConfig(tempCwd);
		expect(config).toEqual({
			ls: true,
			find: true,
			grep: false,
		});
	});

	it("project config overrides global config", () => {
		process.env.HOME = tempCwd;
		const agentDir = join(tempCwd, ".pi", "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "coding-tools.json"), JSON.stringify({ ls: false }));

		// Project config at <cwd>/.pi/coding-tools.json
		mkdirSync(join(tempCwd, ".pi"), { recursive: true });
		// Use a subdirectory as cwd so HOME != cwd
		const projectCwd = join(tempCwd, "project");
		mkdirSync(projectCwd);
		mkdirSync(join(projectCwd, ".pi"), { recursive: true });
		writeFileSync(join(projectCwd, ".pi", "coding-tools.json"), JSON.stringify({ ls: true }));

		const config = loadConfig(projectCwd);
		expect(config).toEqual({
			ls: true, // overridden by project
			find: true, // default
			grep: true, // default
		});
	});

	it("falls back to defaults when config JSON is invalid", () => {
		process.env.HOME = tempCwd;
		const agentDir = join(tempCwd, ".pi", "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "coding-tools.json"), "{ invalid json");

		const config = loadConfig(tempCwd);
		expect(config).toEqual({
			ls: true,
			find: true,
			grep: true,
		});
	});

	it("partial config: unspecified fields keep defaults", () => {
		process.env.HOME = tempCwd;
		const agentDir = join(tempCwd, ".pi", "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "coding-tools.json"), JSON.stringify({ find: false }));

		const config = loadConfig(tempCwd);
		expect(config).toEqual({
			ls: true,
			find: false,
			grep: true,
		});
	});
});
