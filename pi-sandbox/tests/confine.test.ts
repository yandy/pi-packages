import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	assertShellAllowed,
	classifyDenial,
	classifyRunnerFailure,
	confine,
	DENIAL_SIGNATURES,
	RUNNER_FAILURE_RULES,
	SandboxUnavailableError,
	UnsupportedWindowsShellError,
} from "../src/confine";

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
	it.skipIf(process.platform === "win32")("canonicalizes the workspace root before building the profile", () => {
		// mkdtemp 真实目录 + symlink 根（dir/real 与 dir/link→real）：旧版传 /tmp 在多数系统上
		// 已是 canonical，去掉 canonicalPath 的变异照样绿；symlink 根让断言真正承重。
		// win32 建 symlink 需特权（开发者模式/管理员），与 policy.test.ts 同款 skipIf；
		// Windows 侧链接/junction 解析由 tests/win32/e2e.test.ts 覆盖。
		const dir = mkdtempSync(join(tmpdir(), "confine-"));
		try {
			mkdirSync(join(dir, "real"));
			symlinkSync(join(dir, "real"), join(dir, "link"));
			const realRoot = realpathSync.native(join(dir, "real"));
			const result = confine(["true"], "workspace-write", join(dir, "link"), {
				selected: { runner: "bwrap", enforcement: "full" },
			});
			// bwrap 的 workspace bind 是「源=目标」对（--bind <root> <root>）：两处都必须是
			// realpath，symlink 拼写不得残留在 argv（去掉 canonicalPath 的变异下两断言皆红）。
			const bindIdx = result.argv.indexOf(realRoot);
			expect(bindIdx).toBeGreaterThan(-1);
			expect(result.argv[bindIdx + 1]).toBe(realRoot);
			expect(result.argv).not.toContain(join(dir, "link"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
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

describe("windows-acl dialect", () => {
	it("classifies the four Windows denial dialects case-insensitively", () => {
		const signatures = DENIAL_SIGNATURES["windows-acl"];
		expect(signatures).toEqual(["access is denied", "access to the path", "permission denied", "operation not permitted"]);
		for (const text of [
			"Access is denied.",
			"Access to the path 'C:\\other\\x.txt' is denied.",
			"rm: cannot remove '/c/tmp/x': Permission denied",
			"EPERM: operation not permitted, unlink 'C:\\x'",
		]) {
			expect(classifyDenial(1, text, signatures)).toBe(true);
		}
		expect(classifyDenial(1, "command not found", signatures)).toBe(false);
		expect(classifyDenial(0, "Access is denied.", signatures)).toBe(false);
	});

	it("treats exit 127 plus the runner signature as a runner failure (and nothing else)", () => {
		const rules = RUNNER_FAILURE_RULES["windows-acl"];
		expect(classifyRunnerFailure(127, "windows-acl-run: --temp is not an existing directory: C:\\nope", rules)).toMatch(/--temp is not an existing directory/);
		// 已知取舍：受限命令自身 exit 127 且恰好打印签名也会命中（Review Focus #3）
		expect(classifyRunnerFailure(127, "windows-acl-run: Access is denied.", rules)).toBeDefined();
		// 但 exit 非 127 时绝不判为 runner 失败（命令真的跑过）
		expect(classifyRunnerFailure(1, "windows-acl-run: Access is denied.", rules)).toBeUndefined();
		expect(classifyRunnerFailure(127, "Access is denied.", rules)).toBeUndefined();
	});

	it("wraps the win32 runner argv with the resolved rung", () => {
		const confined = confine(["pwsh.exe", "-Command", "echo hi"], "workspace-write", "C:\\work\\demo", {
			hooks: {
				platform: "win32",
				windowsAclRung: () => ({ node: "C:\\node.exe", runner: "C:\\pkg\\src\\win32\\runner.js" }),
			},
		});
		expect(confined.argv.slice(0, 4)).toEqual(["C:\\node.exe", "C:\\pkg\\src\\win32\\runner.js", "--workspace", "C:\\work\\demo"]);
		expect(confined.argv).toContain("--temp");
		expect(confined.argv).toContain("--mode");
		expect(confined.argv.slice(-4)).toEqual(["--", "pwsh.exe", "-Command", "echo hi"]);
		expect(confined.enforcement).toBe("partial");
		// 显式字面量：锁定方言内容与顺序，以及 127 exit 门控（不能只跟导出表互等，否则缺键时 undefined===undefined 假阳性）
		expect(confined.denialSignatures).toEqual(["access is denied", "access to the path", "permission denied", "operation not permitted"]);
		expect(confined.runnerFailureRules).toEqual([{ allowedExitCodes: [127], fatalSignatures: ["windows-acl-run: "] }]);
		expect(confined.denialSignatures).toEqual(DENIAL_SIGNATURES["windows-acl"]);
		expect(confined.runnerFailureRules).toEqual(RUNNER_FAILURE_RULES["windows-acl"]);
	});

	it("resolves the rung exactly once and never consults it a second time", () => {
		let rungCalls = 0;
		const confined = confine(["true"], "read-only", "C:\\work\\demo", {
			selected: { runner: "windows-acl", enforcement: "partial" },
			hooks: {
				// 第二次解析才失败：确认 confine 解析一次后透传，runnerInvocation 不再自行解析
				windowsAclRung: () => {
					rungCalls += 1;
					return rungCalls === 1 ? { node: "C:\\node.exe", runner: "C:\\runner.js" } : undefined;
				},
			},
		});
		expect(rungCalls).toBe(1);
		expect(confined.argv.slice(0, 2)).toEqual(["C:\\node.exe", "C:\\runner.js"]);
	});

	it("fails closed when the win32 rung cannot be resolved", () => {
		// 全局 runner 缓存此时已选中 windows-acl，因此下面走的是 confine 自己的 fail-closed 守卫
		expect(() => confine(["pwsh.exe", "-Command", "echo hi"], "workspace-write", "C:\\work\\demo", {
			hooks: { platform: "win32", windowsAclRung: () => undefined },
		})).toThrowError(/SANDBOX_UNAVAILABLE/);
		// 显式注入 selected：不依赖缓存与 selectRunner 路径，确定性地锁定错误类型与 detail
		expect(() => confine(["pwsh.exe", "-Command", "echo hi"], "workspace-write", "C:\\work\\demo", {
			selected: { runner: "windows-acl", enforcement: "partial" },
			hooks: { windowsAclRung: () => undefined },
		})).toThrowError(SandboxUnavailableError);
		expect(() => confine(["pwsh.exe", "-Command", "echo hi"], "workspace-write", "C:\\work\\demo", {
			selected: { runner: "windows-acl", enforcement: "partial" },
			hooks: { windowsAclRung: () => undefined },
		})).toThrowError(/win32 runner is not resolvable/);
	});

	it("documents the bash refusal without a defaultTools snippet", () => {
		// win32 工具接线：`defaultTools` 去不掉扩展注册的工具，也不再需要配置——文案只给有效指引：
		// 用 powershell、bash 保持 fail-closed、danger-full-access 是唯一显式逃生门。
		const error = new UnsupportedWindowsShellError("bash");
		expect(error.message).toContain('[sandbox: bash is not supported on Windows]');
		expect(error.message).toContain("the command was NOT executed");
		expect(error.message).toContain("powershell tool only");
		expect(error.message).toContain("fail-closed");
		expect(error.message).toContain("pi >= 1.0.0");
		expect(error.message).toContain("danger-full-access");
		expect(error.message).not.toContain("-bash");
		expect(error.message).not.toContain("defaultTools");
	});

	it("refuses bash on win32 confined modes and nothing else", () => {
		expect(() => assertShellAllowed("bash", "win32", "workspace-write")).toThrowError(UnsupportedWindowsShellError);
		expect(() => assertShellAllowed("bash", "win32", "read-only")).toThrowError(UnsupportedWindowsShellError);
		expect(() => assertShellAllowed("bash", "win32", "danger-full-access")).not.toThrow();
		expect(() => assertShellAllowed("bash", "linux", "workspace-write")).not.toThrow();
		expect(() => assertShellAllowed("powershell", "win32", "read-only")).not.toThrow();
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

/**
 * spec 2026-10-14 §5：`extraRoots` 从 ConfineOptions 进 RunnerPolicy，再由各 profile 构造器消费。
 * confine 只透传（额外根已在 config.resolveConfiguredRoots 里 canonical + 存在性过滤过），
 * 所以这里断言的是「透传到了哪个后端」，而不是解析规则本身。
 */
describe("confine extraRoots", () => {
	const extraRoots = ["/home/u/.cache/uv"];

	it("bwrap binds each extra root before the '--' separator", () => {
		const result = confine(["true"], "workspace-write", "/ws", {
			selected: { runner: "bwrap", enforcement: "full" },
			extraRoots,
		});
		const sep = result.argv.indexOf("--");
		expect(result.argv.slice(0, sep)).toEqual([
			"bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "--die-with-parent",
			"--bind", "/tmp", "/tmp", "--bind", "/ws", "/ws", "--bind", "/home/u/.cache/uv", "/home/u/.cache/uv",
		]);
	});

	it("landlock grants each extra root read-write", () => {
		const result = confine(["true"], "workspace-write", "/ws", {
			selected: { runner: "landlock", enforcement: "full" },
			hooks,
			extraRoots,
		});
		expect(result.argv.slice(0, result.argv.indexOf("--"))).toEqual([
			"/opt/landlock-run", "--ro", "/", "--rw", "/dev/null", "--rw", "/tmp", "--rw", "/ws",
			"--rw", "/home/u/.cache/uv",
		]);
	});

	it("a custom runnerCommand receives the same bwrap-dialect profile, extra roots included (failure mode 9)", () => {
		const result = confine(["true"], "workspace-write", "/ws", {
			runnerCommand: ["myrunner"],
			runnerFailureSignatures: ["myrunner: "],
			extraRoots,
		});
		expect(result.argv).toContain("/home/u/.cache/uv");
		expect(result.argv[result.argv.indexOf("--bind") + 1]).toBe("/tmp");
	});

	it("read-only confines everything: extra roots never reach the profile", () => {
		const result = confine(["true"], "read-only", "/ws", {
			selected: { runner: "bwrap", enforcement: "full" },
			extraRoots,
		});
		expect(result.argv).not.toContain("--bind");
		expect(result.argv).not.toContain("/home/u/.cache/uv");
	});

	// Ruling 5：win32 runner 是写死的两根 argv 契约，confine 透传的额外根在那里被有意丢弃。
	it("windows-acl drops extra roots (Ruling 5)", () => {
		const availability = { node: "C:\\node.exe", runner: "C:\\pkg\\src\\win32\\runner.js" };
		const result = confine(["cmd", "/c", "ver"], "workspace-write", "C:\\ws", {
			selected: { runner: "windows-acl", enforcement: "partial" },
			hooks: { windowsAclRung: () => availability },
			extraRoots: ["C:\\cache\\uv"],
		});
		expect(result.argv.join(" ")).not.toContain("C:\\cache\\uv");
		expect(result.argv).toContain("--workspace");
		expect(result.argv).toContain("--temp");
	});
});

/**
 * spec 2026-10-14-protected-project-config：挖洞根**缺省即安全**——undefined 时 confine 自行
 * 探测，所以直接调 createSandboxBashOps 的调用方也自带保护，不需要记得传。
 */
describe("confine protectedRoots", () => {
	let ws: string;
	beforeEach(() => { ws = realpathSync.native(mkdtempSync(join(tmpdir(), "confine-prot-"))); });
	afterEach(() => { rmSync(ws, { recursive: true, force: true }); });

	const bwrap = { selected: { runner: "bwrap" as const, enforcement: "full" as const } };
	/** confine 会在末尾追加 `"--", ...argv`，断言 profile 时先切掉。 */
	const profileOf = (argv: string[]) => argv.slice(0, argv.indexOf("--"));

	it("auto-detects nothing while the config dir does not exist (bwrap cannot ro-bind a missing source)", () => {
		const argv = confine(["true"], "workspace-write", ws, bwrap).argv;
		expect(argv.filter((a) => a === "--ro-bind")).toHaveLength(1); // 只有全盘那条
	});

	it("auto-detects the config dir once it exists, and puts the carve-out last", () => {
		mkdirSync(join(ws, ".pi", "agents"), { recursive: true });
		const argv = profileOf(confine(["true"], "workspace-write", ws, bwrap).argv);
		const pi = join(ws, ".pi");
		expect(argv.slice(-3)).toEqual(["--ro-bind", pi, pi]);
		// 顺序承重：必须在 workspace 的 rw bind 之后，否则被后者覆盖。
		expect(argv.lastIndexOf(pi)).toBeGreaterThan(argv.indexOf(ws));
	});

	it("an explicit protectedRoots override wins over auto-detection", () => {
		mkdirSync(join(ws, ".pi"), { recursive: true });
		const argv = confine(["true"], "workspace-write", ws, { ...bwrap, protectedRoots: [] }).argv;
		expect(argv.filter((a) => a === "--ro-bind")).toHaveLength(1);
	});

	it("auto-detects nothing under read-only (the carve-out would be a no-op)", () => {
		mkdirSync(join(ws, ".pi"), { recursive: true });
		const argv = confine(["true"], "read-only", ws, bwrap).argv;
		expect(argv.filter((a) => a === "--ro-bind")).toHaveLength(1);
	});

	it("canonicalizes the workspace before detecting, so a symlinked workspace still carves out", () => {
		if (process.platform === "win32") return; // 建 symlink 需特权，与本文件其余用例同口径
		mkdirSync(join(ws, "real", ".pi"), { recursive: true });
		symlinkSync(join(ws, "real"), join(ws, "link"));
		const argv = profileOf(confine(["true"], "workspace-write", join(ws, "link"), bwrap).argv);
		const real = realpathSync.native(join(ws, "real"));
		// 挖洞根必须跟着 canonical 化后的工作区走，symlink 拼写不得残留在 argv 里。
		expect(argv.slice(-3)).toEqual(["--ro-bind", join(real, ".pi"), join(real, ".pi")]);
		expect(argv).not.toContain(join(ws, "link"));
	});
});

/**
 * 后端能力矩阵（spec 2026-10-14-protected-project-config）：挖洞根**按后端**分派，不是一刀切。
 * seatbelt 的 deny 对不存在的路径同样有效（拒的是「创建」这个动作），所以 macOS 上没有
 * 「.pi 不存在就不挡」的缺口；bwrap 必须按存在性门控（--ro-bind 对缺失源硬失败）。
 */
describe("confine protectedRoots per backend", () => {
	let ws: string;
	beforeEach(() => { ws = realpathSync.native(mkdtempSync(join(tmpdir(), "confine-mat-"))); });
	afterEach(() => { rmSync(ws, { recursive: true, force: true }); });
	const pi = () => join(ws, ".pi");
	const profileOf = (argv: string[]) => argv.slice(0, argv.indexOf("--")).join(" ");

	it("seatbelt denies the config dir even when it does not exist", () => {
		expect(existsSync(pi())).toBe(false);
		const argv = confine(["true"], "workspace-write", ws, {
			selected: { runner: "seatbelt", enforcement: "full" },
			hooks: { seatbeltExec: "/usr/bin/sbx" },
		}).argv;
		expect(profileOf(argv)).toContain(`(deny file-write* (subpath "${pi()}"))`);
	});

	it("landlock cannot express a carve-out: no trace of the config dir even when it exists", () => {
		mkdirSync(pi(), { recursive: true });
		const argv = confine(["true"], "workspace-write", ws, {
			selected: { runner: "landlock", enforcement: "full" },
			hooks,
		}).argv;
		expect(profileOf(argv)).not.toContain(".pi");
	});

	it("windows-acl cannot express a carve-out either", () => {
		mkdirSync(pi(), { recursive: true });
		const availability = { node: "C:\\node.exe", runner: "C:\\pkg\\src\\win32\\runner.js" };
		const argv = confine(["cmd", "/c", "ver"], "workspace-write", "C:\\ws", {
			selected: { runner: "windows-acl", enforcement: "partial" },
			hooks: { windowsAclRung: () => availability },
		}).argv;
		expect(argv.join(" ")).not.toContain(".pi");
	});

	it("a custom runnerCommand is treated as bwrap-compatible and gets the existence-gated carve-out", () => {
		mkdirSync(pi(), { recursive: true });
		const argv = confine(["true"], "workspace-write", ws, {
			runnerCommand: ["myrunner"],
			runnerFailureSignatures: ["myrunner: "],
		}).argv;
		expect(profileOf(argv)).toContain(`--ro-bind ${pi()} ${pi()}`);
	});
});
