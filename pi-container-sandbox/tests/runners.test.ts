import { describe, expect, it, vi } from "vitest";
import {
	bwrapProfileArgs,
	landlockProfileArgs,
	resetRunnerCache,
	runnerInvocation,
	seatbeltProfileArgs,
	selectRunner,
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
	it("workspace-write adds tmpfs /tmp and rw bind of the workspace, verbatim", () => {
		expect(bwrapProfileArgs(wsWrite)).toEqual([
			"--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "--die-with-parent",
			"--tmpfs", "/tmp", "--bind", WS, WS,
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
	it("win32/unknown: unavailable", () => {
		resetRunnerCache();
		expect(selectRunner(100, { platform: "win32" })).toEqual({ runner: "unavailable" });
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
