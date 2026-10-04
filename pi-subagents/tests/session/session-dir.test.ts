import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveSubagentSessionDir } from "../../src/session/session-dir";

describe("deriveSubagentSessionDir", () => {
	it("returns a tasks/ subdirectory nested under the parent session basename", () => {
		const parent = "/home/user/.pi/agent/sessions/--project--/2026-05-20T12-00-00Z_.jsonl";
		const result = deriveSubagentSessionDir(parent, "/home/user/project");
		// 期望值与实现同构：join(dirname(parent), basename(parent, ".jsonl"), "tasks")，Windows 上才会一致
		expect(result).toBe(join(dirname(parent), basename(parent, ".jsonl"), "tasks"));
	});

	it("handles parent session files without a .jsonl extension", () => {
		const parent = "/sessions/abc123";
		const result = deriveSubagentSessionDir(parent, "/tmp");
		// basename is "abc123" (no extension to strip)
		expect(result).toBe(join(dirname(parent), basename(parent, ".jsonl"), "tasks"));
	});

	it("returns a temp directory when parentSessionFile is undefined", () => {
		const result = deriveSubagentSessionDir(undefined, "/home/user/project");
		// Should contain pi-subagents prefix, encoded cwd, and end with tasks
		expect(result).toMatch(/pi-subagents/);
		expect(result).toContain("home-user-project");
		expect(result).toMatch(/tasks$/);
	});
});
