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

/**
 * spec 2026-10-14 §5.2：额外根一律**追加在末尾**，`extraRoots` 为空时 argv 与引入它之前逐字节相同
 * （上面三个旧用例不改即证明）。去重防止用户把 `/tmp` 也写进配置时 bwrap 收到重复的 `--bind /tmp /tmp`。
 */
describe("extraRoots across the runners", () => {
	const extra = { mode: "workspace-write" as const, workspaceRoot: WS, extraRoots: ["/home/u/.cache/uv", "/opt/scratch"] };

	it("bwrap appends one --bind per extra root, after /tmp and the workspace", () => {
		expect(bwrapProfileArgs(extra)).toEqual([
			"--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "--die-with-parent",
			"--bind", "/tmp", "/tmp", "--bind", WS, WS,
			"--bind", "/home/u/.cache/uv", "/home/u/.cache/uv",
			"--bind", "/opt/scratch", "/opt/scratch",
		]);
	});

	it("bwrap dedupes an extra root that is already bound (/tmp, the workspace)", () => {
		const dup = { mode: "workspace-write" as const, workspaceRoot: WS, extraRoots: ["/tmp", WS, "/opt/scratch"] };
		const args = bwrapProfileArgs(dup);
		// 三个不同的根 → 三次 --bind（重复的 /tmp 与 workspace 不再绑第二遍；否则 bwrap 会收到重复挂载）。
		expect(args.filter((a) => a === "--bind")).toHaveLength(3);
		expect(args).toEqual(bwrapProfileArgs({ mode: "workspace-write", workspaceRoot: WS, extraRoots: ["/opt/scratch"] }));
	});

	it("landlock appends one --rw per extra root", () => {
		expect(landlockProfileArgs(extra)).toEqual([
			"--ro", "/", "--rw", "/dev/null", "--rw", "/tmp", "--rw", WS,
			"--rw", "/home/u/.cache/uv", "--rw", "/opt/scratch",
		]);
	});

	it("seatbelt grants a subpath per extra root via the shared writableRoots derivation", () => {
		const profile = seatbeltProfileArgs(extra)[1];
		expect(profile).toContain('(subpath "/home/u/.cache/uv")');
		expect(profile).toContain('(subpath "/opt/scratch")');
	});

	it("read-only grants nothing, extra roots included", () => {
		const roExtra = { mode: "read-only" as const, workspaceRoot: WS, extraRoots: ["/opt/scratch"] };
		expect(bwrapProfileArgs(roExtra)).not.toContain("--bind");
		expect(landlockProfileArgs(roExtra)).toEqual(["--ro", "/", "--rw", "/dev/null"]);
		expect(seatbeltProfileArgs(roExtra)[1]).not.toContain("(subpath");
	});

	it("an empty extraRoots list is byte-identical to omitting the field", () => {
		const empty = { mode: "workspace-write" as const, workspaceRoot: WS, extraRoots: [] };
		expect(bwrapProfileArgs(empty)).toEqual(bwrapProfileArgs(wsWrite));
		expect(landlockProfileArgs(empty)).toEqual(landlockProfileArgs(wsWrite));
		expect(seatbeltProfileArgs(empty)).toEqual(seatbeltProfileArgs(wsWrite));
	});

	// Ruling 5：win32 runner 是写死的两根 argv 契约，本期忽略额外根（不对称由 config 层 warn + README 公告）。
	it("windows-acl ignores extra roots entirely", () => {
		const availability = { node: "C:\\node.exe", runner: "C:\\pkg\\src\\win32\\runner.js" };
		const winExtra = { mode: "workspace-write" as const, workspaceRoot: "C:\\ws", extraRoots: ["C:\\cache\\uv"] };
		expect(windowsAclRunnerArgv(winExtra, availability)).toEqual(windowsAclRunnerArgv(
			{ mode: "workspace-write", workspaceRoot: "C:\\ws" },
			availability,
		));
		expect(windowsAclRunnerArgv(winExtra, availability).join(" ")).not.toContain("C:\\cache\\uv");
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

/**
 * spec 2026-10-14-protected-project-config：runner 侧的挖洞能力矩阵。
 * bwrap 与 seatbelt 能表达「可写根里挖只读洞」；landlock 不能（规则是并集，无 deny）；
 * windows-acl 本期不能（需 deny ACE / 断继承，是 argv 契约改动）。后两者靠围栏侧兜底。
 */
describe("protectedRoots across the runners", () => {
	const PI = "/home/u/project/.pi";
	const prot = { mode: "workspace-write" as const, workspaceRoot: WS, protectedRoots: [PI] };

	it("bwrap appends --ro-bind AFTER the rw binds, so the later mount shadows the earlier one", () => {
		const args = bwrapProfileArgs(prot);
		const rwIdx = args.indexOf(WS);
		const roIdx = args.indexOf("--ro-bind", args.lastIndexOf("--bind"));
		expect(rwIdx).toBeGreaterThan(-1);
		expect(roIdx).toBeGreaterThan(-1);
		expect(args.slice(-3)).toEqual(["--ro-bind", PI, PI]);
		// 顺序是承重的：bwrap 按序挂载，ro-bind 排在 --bind 之前会被后者覆盖掉。
		expect(roIdx).toBeGreaterThan(rwIdx);
	});

	it("bwrap carves out extra roots too, and keeps them after the rw binds", () => {
		const args = bwrapProfileArgs({ ...prot, extraRoots: ["/home/u/.cache/uv"] });
		expect(args.slice(-6)).toEqual([
			"--bind", "/home/u/.cache/uv", "/home/u/.cache/uv",
			"--ro-bind", PI, PI,
		]);
	});

	it("bwrap adds no carve-out under read-only (nothing is writable there anyway)", () => {
		const args = bwrapProfileArgs({ mode: "read-only", workspaceRoot: WS, protectedRoots: [PI] });
		expect(args).not.toContain("--bind");
		expect(args.filter((a) => a === "--ro-bind")).toHaveLength(1); // 只有全盘那条
	});

	it("seatbelt appends a deny after the allow forms", () => {
		const profile = seatbeltProfileArgs(prot)[1];
		const allowIdx = profile.indexOf("(allow file-write* (subpath");
		const denyIdx = profile.indexOf(`(deny file-write* (subpath "${PI}"))`);
		expect(allowIdx).toBeGreaterThan(-1);
		expect(denyIdx).toBeGreaterThan(allowIdx);
	});

	it("seatbelt SBPL-escapes the protected root", () => {
		const weird = { mode: "workspace-write" as const, workspaceRoot: WS, protectedRoots: [`/a"b\\c/.pi`] };
		expect(seatbeltProfileArgs(weird)[1]).toContain(`(deny file-write* (subpath "/a\\"b\\\\c/.pi"))`);
	});

	it("landlock cannot express a carve-out: argv is unchanged by protectedRoots", () => {
		expect(landlockProfileArgs(prot)).toEqual(landlockProfileArgs(wsWrite));
		expect(landlockProfileArgs(prot).join(" ")).not.toContain(PI);
	});

	it("windows-acl cannot express a carve-out either: argv is unchanged", () => {
		const availability = { node: "C:\\node.exe", runner: "C:\\pkg\\src\\win32\\runner.js" };
		const winProt = { mode: "workspace-write" as const, workspaceRoot: "C:\\ws", protectedRoots: ["C:\\ws\\.pi"] };
		expect(windowsAclRunnerArgv(winProt, availability))
			.toEqual(windowsAclRunnerArgv({ mode: "workspace-write", workspaceRoot: "C:\\ws" }, availability));
	});

	it("an empty protectedRoots list is byte-identical to omitting the field", () => {
		const empty = { mode: "workspace-write" as const, workspaceRoot: WS, protectedRoots: [] };
		expect(bwrapProfileArgs(empty)).toEqual(bwrapProfileArgs(wsWrite));
		expect(seatbeltProfileArgs(empty)).toEqual(seatbeltProfileArgs(wsWrite));
	});
});
