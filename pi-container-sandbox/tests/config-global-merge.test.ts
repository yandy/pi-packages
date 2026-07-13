import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_CONFIG_DIR = ".test-cfg";

// Mock getAgentDir to a writable /tmp path for global + project merge testing
vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => "/tmp/pi-test-global-agent",
	CONFIG_DIR_NAME: ".test-cfg",
}));

import { loadSbxConfig } from "../src/config";

const globalAgentDir = "/tmp/pi-test-global-agent";
const testWorkDir = "/tmp/pi-test-global-work";

describe("global + project config: array fields should merge, not overwrite", () => {
	beforeEach(() => {
		if (existsSync(globalAgentDir)) rmSync(globalAgentDir, { recursive: true });
		if (existsSync(testWorkDir)) rmSync(testWorkDir, { recursive: true });
		mkdirSync(globalAgentDir, { recursive: true });
		mkdirSync(testWorkDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(globalAgentDir)) rmSync(globalAgentDir, { recursive: true });
		if (existsSync(testWorkDir)) rmSync(testWorkDir, { recursive: true });
	});

	it("concatenates mounts from global and project configs instead of overwriting", () => {
		// Global config with mounts
		writeFileSync(resolvePath(globalAgentDir, "sandbox.json"), JSON.stringify({
			runtime: {
				mounts: [{ source: "/global/a", target: "/workspace/global-a" }],
				env: ["GLOBAL_ENV=true"],
			},
			host: { commands: ["git"] },
		}));

		// Project config with mounts
		const projectDir = resolvePath(testWorkDir, "project");
		mkdirSync(projectDir, { recursive: true });
		const configDir = resolvePath(projectDir, TEST_CONFIG_DIR);
		mkdirSync(configDir, { recursive: true });
		writeFileSync(resolvePath(configDir, "sandbox.json"), JSON.stringify({
			runtime: {
				mounts: [{ source: "/proj/b", target: "/workspace/proj-b" }],
				env: ["PROJ_ENV=also"],
			},
			host: { commands: ["docker"] },
		}));

		const cfg = loadSbxConfig(projectDir);

		// mounts: both global and project entries preserved, in order
		expect(cfg.runtime.mounts).toEqual([
			{ source: "/global/a", target: "/workspace/global-a" },
			{ source: "/proj/b", target: "/workspace/proj-b" },
		]);

		// env: both preserved
		expect(cfg.runtime.env).toEqual(["GLOBAL_ENV=true", "PROJ_ENV=also"]);

		// host commands: concatenated
		expect(cfg.host.commands).toEqual(["git", "docker"]);

		// Scalar fields still work as before (project overrides global)
		expect(cfg.runtime.tier).toBe("medium");
	});

	it("project-only works when global has no runtime section", () => {
		writeFileSync(resolvePath(globalAgentDir, "sandbox.json"), JSON.stringify({
			image: { name: "global-img", tag: "v3" },
		}));

		const projectDir = resolvePath(testWorkDir, "project");
		mkdirSync(projectDir, { recursive: true });
		const configDir = resolvePath(projectDir, TEST_CONFIG_DIR);
		mkdirSync(configDir, { recursive: true });
		writeFileSync(resolvePath(configDir, "sandbox.json"), JSON.stringify({
			runtime: {
				mounts: [{ source: "/proj/x", target: "/workspace/x" }],
				env: ["X=1"],
			},
		}));

		const cfg = loadSbxConfig(projectDir);

		expect(cfg.runtime.mounts).toEqual([{ source: "/proj/x", target: "/workspace/x" }]);
		expect(cfg.runtime.env).toEqual(["X=1"]);
	});

	it("global-only works when project has no runtime section", () => {
		writeFileSync(resolvePath(globalAgentDir, "sandbox.json"), JSON.stringify({
			runtime: {
				mounts: [{ source: "/global/z", target: "/workspace/z" }],
				env: ["Z=1"],
			},
			host: { commands: ["npm"] },
		}));

		const projectDir = resolvePath(testWorkDir, "project");
		mkdirSync(projectDir, { recursive: true });
		const configDir = resolvePath(projectDir, TEST_CONFIG_DIR);
		mkdirSync(configDir, { recursive: true });
		writeFileSync(resolvePath(configDir, "sandbox.json"), JSON.stringify({
			image: { name: "proj-img" },
		}));

		const cfg = loadSbxConfig(projectDir);

		expect(cfg.runtime.mounts).toEqual([{ source: "/global/z", target: "/workspace/z" }]);
		expect(cfg.runtime.env).toEqual(["Z=1"]);
		expect(cfg.host.commands).toEqual(["npm"]);
	});
});
