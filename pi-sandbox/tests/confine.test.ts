import { describe, expect, it } from "vitest";
import { classifyDenial, classifyRunnerFailure, confine, RUNNER_FAILURE_RULES, SandboxUnavailableError } from "../src/confine";

const hooks = { launcherPath: () => "/opt/landlock-run" };

describe("confine", () => {
	it("bwrap: runner + profile + '--' + original argv", () => {
		const result = confine(["bash", "-c", "true"], "workspace-write", "/ws", {
			selected: { runner: "bwrap", enforcement: "full" },
		});
		expect(result.argv).toEqual([
			"bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "--die-with-parent",
			"--bind", "/tmp", "/tmp", "--bind", "/ws", "/ws", "--", "bash", "-c", "true",
		]);
		expect(result.denialSignatures).toEqual(["read-only file system"]);
		expect(result.runnerFailureRules).toEqual(RUNNER_FAILURE_RULES.bwrap);
	});
	it("landlock: injected launcher path, per-backend dialect (no cross-backend union)", () => {
		const result = confine(["true"], "read-only", "/ws", {
			selected: { runner: "landlock", enforcement: "partial" },
			hooks,
		});
		expect(result.argv[0]).toBe("/opt/landlock-run");
		expect(result.enforcement).toBe("partial");
		expect(result.denialSignatures).toEqual(["permission denied"]);
	});
	it("unavailable runner throws SandboxUnavailableError (fail-closed, argv never spawned)", () => {
		expect(() => confine(["true"], "read-only", "/ws", { selected: { runner: "unavailable" } }))
			.toThrow(SandboxUnavailableError);
		expect(() => confine(["true"], "read-only", "/ws", { selected: { runner: "unavailable" } }))
			.toThrow(/SANDBOX_UNAVAILABLE/);
	});
	it("runnerCommand override: bwrap-dialect profile appended, custom failure signatures", () => {
		const result = confine(["true"], "workspace-write", "/ws", {
			runnerCommand: ["myrunner", "--flag"],
			runnerFailureSignatures: ["myrunner: "],
		});
		expect(result.argv).toEqual([
			"myrunner", "--flag",
			"--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "--die-with-parent",
			"--bind", "/tmp", "/tmp", "--bind", "/ws", "/ws", "--", "true",
		]);
		expect(result.enforcement).toBe("full");
		expect(result.denialSignatures).toEqual(["read-only file system", "permission denied"]);
		expect(result.runnerFailureRules).toEqual([{ fatalSignatures: ["myrunner: "] }]);
	});
	it("canonicalizes the workspace root before building the profile", () => {
		const result = confine(["true"], "workspace-write", "/tmp", {
			selected: { runner: "bwrap", enforcement: "full" },
		});
		// /tmp 在多数系统上已是 canonical；macOS 上 /tmp → /private/tmp
		const bindIdx = result.argv.indexOf("--bind");
		expect(result.argv[bindIdx + 1]).toBe(result.argv[bindIdx + 2]);
		expect(result.argv[bindIdx + 1]).not.toMatch(/\/$/);
	});
});

describe("classifyRunnerFailure", () => {
	const rules = RUNNER_FAILURE_RULES.landlock;
	it("exit 125 + fatal landlock-run line → matched line", () => {
		expect(classifyRunnerFailure(125, "landlock-run: ruleset creation failed: EOPNOTSUPP", rules))
			.toBe("landlock-run: ruleset creation failed: EOPNOTSUPP");
	});
	it("wrong exit code → no match even with the fatal signature", () => {
		expect(classifyRunnerFailure(1, "landlock-run: something", rules)).toBeUndefined();
	});
	it("the informational partial-enforcement line alone is NOT a failure (整行相等剔除先于 fatal 匹配)", () => {
		expect(classifyRunnerFailure(125, "landlock-run: partial enforcement (older Landlock ABI)", rules)).toBeUndefined();
	});
	it("informational line removed, fatal line on another row still matches", () => {
		const stderr = "landlock-run: partial enforcement (older Landlock ABI)\nlandlock-run: fatal boom";
		expect(classifyRunnerFailure(125, stderr, rules)).toBe("landlock-run: fatal boom");
	});
	it("exit 0 or null → never a runner failure", () => {
		expect(classifyRunnerFailure(0, "landlock-run: x", rules)).toBeUndefined();
		expect(classifyRunnerFailure(null, "landlock-run: x", rules)).toBeUndefined();
	});
	it("bwrap rule has no exit gate: any nonzero exit with 'bwrap: ' matches", () => {
		expect(classifyRunnerFailure(1, "bwrap: Can't mount proc", RUNNER_FAILURE_RULES.bwrap)).toContain("bwrap: ");
	});
});

describe("classifyDenial", () => {
	it("case-insensitive substring match on nonzero exit", () => {
		expect(classifyDenial(1, "touch: cannot touch '/etc/x': Read-only file system", ["read-only file system"])).toBe(true);
	});
	it("exit 0 or null → false", () => {
		expect(classifyDenial(0, "Read-only file system", ["read-only file system"])).toBe(false);
		expect(classifyDenial(null, "Read-only file system", ["read-only file system"])).toBe(false);
	});
	it("no signature present → false", () => {
		expect(classifyDenial(1, "command not found", ["read-only file system"])).toBe(false);
	});
});
