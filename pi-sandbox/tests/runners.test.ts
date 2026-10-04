import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalPath } from "../src/policy";
import {
	bwrapProfileArgs,
	landlockProfileArgs,
	resetRunnerCache,
	runnerInvocation,
	seatbeltProfileArgs,
	selectRunner,
	windowsAclAvailability,
	windowsAclRunnerArgv,
} from "../src/runners";

const WS = "/home/u/project";
const wsWrite = { mode: "workspace-write" as const, workspaceRoot: WS };
const ro = { mode: "read-only" as const, workspaceRoot: WS };

describe("bwrapProfileArgs", () => {
	it("read-only: ro-bind root, dev, pid namespace, die-with-parent", () => {
		expect(bwrapProfileArgs(ro)).toEqual([
			"--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "--die-with-parent",
		]);
	});
	it("workspace-write binds the host /tmp rw plus the workspace, verbatim", () => {
		expect(bwrapProfileArgs(wsWrite)).toEqual([
			"--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "--die-with-parent",
			"--bind", "/tmp", "/tmp", "--bind", WS, WS,
		]);
	});
	it("paths with spaces/quotes/backslashes pass through as single argv entries (no shell quoting)", () => {
		const weird = { mode: "workspace-write" as const, workspaceRoot: `/a b/"c"\\d` };
		const args = bwrapProfileArgs(weird);
		expect(args.slice(-2)).toEqual([`/a b/"c"\\d`, `/a b/"c"\\d`]);
	});
});

describe("landlockProfileArgs", () => {
	it("read-only: ro / plus rw /dev/null", () => {
		expect(landlockProfileArgs(ro)).toEqual(["--ro", "/", "--rw", "/dev/null"]);
	});
	it("workspace-write adds /tmp and workspace to rw", () => {
		expect(landlockProfileArgs(wsWrite)).toEqual(["--ro", "/", "--rw", "/dev/null", "--rw", "/tmp", "--rw", WS]);
	});
});

describe("seatbeltProfileArgs", () => {
	it("read-only: deny file-write* with only the /dev/null sink", () => {
		const args = seatbeltProfileArgs(ro);
		expect(args[0]).toBe("-p");
		expect(args[1]).toContain("(version 1)");
		expect(args[1]).toContain("(allow default)");
		expect(args[1]).toContain("(deny file-write*)");
		expect(args[1]).toContain('(allow file-write* (literal "/dev/null"))');
		expect(args[1]).not.toContain("(subpath");
	});
	it("workspace-write: subpath grants from writableRoots, SBPL-escaped", () => {
		const policy = { mode: "workspace-write" as const, workspaceRoot: `/tmp/q"uo\\te` };
		const profile = seatbeltProfileArgs(policy)[1];
		// SBPL 字面量转义：\ → \\ ，" → \"
		expect(profile).toContain(`(subpath "/tmp/q\\"uo\\\\te")`);
	});
});

describe("selectRunner", () => {
	it("linux: prefers bwrap when its probe passes", () => {
		resetRunnerCache();
		const probeBwrap = vi.fn(() => true);
		const probeLandlock = vi.fn(() => "full" as const);
		expect(selectRunner(100, { platform: "linux", probeBwrap, probeLandlock })).toEqual({ runner: "bwrap", enforcement: "full" });
		expect(probeLandlock).not.toHaveBeenCalled();
	});
	it("linux: falls back to landlock, carrying its probe verdict", () => {
		resetRunnerCache();
		expect(selectRunner(100, { platform: "linux", probeBwrap: () => false, probeLandlock: () => "partial" }))
			.toEqual({ runner: "landlock", enforcement: "partial" });
	});
	it("linux: both unusable → unavailable (fail-closed)", () => {
		resetRunnerCache();
		expect(selectRunner(100, { platform: "linux", probeBwrap: () => false, probeLandlock: () => "unusable" }))
			.toEqual({ runner: "unavailable" });
	});
	it("darwin: seatbelt selected without probing", () => {
		resetRunnerCache();
		const probeBwrap = vi.fn(() => true);
		expect(selectRunner(100, { platform: "darwin", probeBwrap })).toEqual({ runner: "seatbelt", enforcement: "full" });
		expect(probeBwrap).not.toHaveBeenCalled();
	});
	it("unknown platform: unavailable", () => {
		resetRunnerCache();
		// win32 不再是“未知平台”：真实前置检查依赖宿主上的 koffi / src/win32/runner.js，无法用缺省值跨平台断言；
		// win32 的可解析与不可解析两条路径见下方 "windows-acl rung"（注入 hook）。
		expect(selectRunner(100, { platform: "freebsd" })).toEqual({ runner: "unavailable" });
	});
	it("caches the verdict: a second call does not re-probe", () => {
		resetRunnerCache();
		const probeBwrap = vi.fn(() => true);
		selectRunner(100, { platform: "linux", probeBwrap });
		selectRunner(100, { platform: "linux", probeBwrap });
		expect(probeBwrap).toHaveBeenCalledTimes(1);
	});
});

describe("runnerInvocation", () => {
	it("landlock uses the injected launcher path", () => {
		const inv = runnerInvocation(
			{ runner: "landlock", enforcement: "full" },
			ro,
			{ launcherPath: () => "/opt/landlock-run" },
		);
		expect(inv).toEqual(["/opt/landlock-run", "--ro", "/", "--rw", "/dev/null"]);
	});
	it("seatbelt uses the injected sandbox-exec", () => {
		const inv = runnerInvocation({ runner: "seatbelt", enforcement: "full" }, ro, { seatbeltExec: "/usr/bin/sbx" });
		expect(inv[0]).toBe("/usr/bin/sbx");
		expect(inv[1]).toBe("-p");
	});
});

describe("windows-acl rung", () => {
	it("selects the windows rung as a sole candidate with partial enforcement", () => {
		resetRunnerCache();
		const runner = {
			node: "C:\\node.exe",
			runner: "C:\\pkg\\src\\win32\\runner.js",
		};
		expect(selectRunner(5000, { platform: "win32", windowsAclRung: () => runner })).toEqual({
			runner: "windows-acl",
			enforcement: "partial",
		});
	});

	it("reports unavailable when the rung cannot be resolved", () => {
		resetRunnerCache();
		expect(selectRunner(5000, { platform: "win32", windowsAclRung: () => undefined })).toEqual({ runner: "unavailable" });
	});

	it("sole candidate: never consults the functional probes (no spawn at selection time)", () => {
		resetRunnerCache();
		const probeBwrap = vi.fn(() => true);
		const probeLandlock = vi.fn(() => "full" as const);
		const hooks = {
			platform: "win32",
			windowsAclRung: () => ({ node: "C:\\node.exe", runner: "C:\\pkg\\src\\win32\\runner.js" }),
			probeBwrap,
			probeLandlock,
		};
		expect(selectRunner(5000, hooks)).toEqual({ runner: "windows-acl", enforcement: "partial" });
		expect(probeBwrap).not.toHaveBeenCalled();
		expect(probeLandlock).not.toHaveBeenCalled();
	});

	it("requires a runner file, a resolvable koffi, and a node executable", () => {
		const dir = mkdtempSync(join(tmpdir(), "sbx-rung-"));
		const runner = join(dir, "runner.js");
		writeFileSync(runner, "// runner\n");
		expect(windowsAclAvailability({ nodeExecutable: "C:\\node.exe", windowsRunnerPath: runner, koffiResolvable: () => true }))
			.toEqual({ node: "C:\\node.exe", runner });
		expect(windowsAclAvailability({ nodeExecutable: "C:\\node.exe", windowsRunnerPath: runner, koffiResolvable: () => false })).toBeUndefined();
		expect(windowsAclAvailability({ nodeExecutable: undefined, windowsRunnerPath: runner, koffiResolvable: () => true })).toBeUndefined();
		expect(windowsAclAvailability({ nodeExecutable: "C:\\node.exe", windowsRunnerPath: join(dir, "missing.js"), koffiResolvable: () => true })).toBeUndefined();
		rmSync(dir, { recursive: true, force: true });
	});

	it("prefixes node/runner and pins workspace, canonical temp root and mode", () => {
		const availability = { node: "C:\\node.exe", runner: "C:\\pkg\\src\\win32\\runner.js" };
		expect(windowsAclRunnerArgv(wsWrite, availability)).toEqual([
			"C:\\node.exe",
			"C:\\pkg\\src\\win32\\runner.js",
			"--workspace",
			WS,
			"--temp",
			canonicalPath(tmpdir()),
			"--mode",
			"workspace-write",
		]);
		expect(windowsAclRunnerArgv(ro, availability).slice(-2)).toEqual(["--mode", "read-only"]);
	});

	it("runnerInvocation takes the resolved availability, falls back to the hook, and fails closed otherwise", () => {
		const availability = { node: "C:\\node.exe", runner: "C:\\pkg\\src\\win32\\runner.js" };
		const selected = { runner: "windows-acl" as const, enforcement: "partial" as const };
		expect(runnerInvocation(selected, ro, {}, availability)).toEqual(windowsAclRunnerArgv(ro, availability));
		expect(runnerInvocation(selected, ro, { windowsAclRung: () => availability })).toEqual(windowsAclRunnerArgv(ro, availability));
		expect(() => runnerInvocation(selected, ro, { windowsAclRung: () => undefined })).toThrowError(/windows-acl is unavailable/);
	});
});
