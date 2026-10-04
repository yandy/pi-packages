import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createSandboxBashOps } from "../src/bash-ops";
import { escalationHintMarker, sandboxDenialMarker } from "../src/escalation";

function fakeChild() {
	const child = new EventEmitter() as EventEmitter & {
		stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn>;
	};
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.kill = vi.fn((signal?: string) => {
		process.nextTick(() => child.emit("close", null, signal ?? "SIGTERM"));
		return true;
	});
	return child;
}

/** M4 后 exec 先 await cwd 预检才 spawn/挂监听——等到 close 监听就位再关，避免抢跑。 */
async function settle(child: ReturnType<typeof fakeChild>, code: number | null) {
	for (let i = 0; i < 1000 && child.listenerCount("close") === 0; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	child.emit("close", code, code === null ? "SIGKILL" : undefined);
}

const bwrapSelected = { selected: { runner: "bwrap" as const, enforcement: "full" as const } };

/**
 * 平台注入（testing.md「参数注入」）：本文件除末尾的 win32 用例外，验证的都是 **POSIX 受限逻辑**
 * （confined argv / profile / env 清洗 / denial 分类 / 超时与 abort）。win32 上 `createSandboxBashOps`
 * 会按 Ruling 2 在任何 spawn 前拒绝 bash，若不注入平台，这些用例在 Windows 上就退化成「测拒绝守卫」。
 * 注入 `platform: "linux"` 让它们在任何宿主上都执行；win32 的 bash 拒绝由本文件末尾的 win32 用例、
 * `tests/confine.test.ts` 与 `tests/win32/*`（`e2e.test.ts`）覆盖。
 */
const posix = { platform: "linux" as const };

// M4：exec 会预检 cwd 存在性——测试用的 exec cwd 必须是真实目录（workspaceRoot 仍可用虚构路径）。
const cwd = mkdtempSync(join(tmpdir(), "bash-ops-cwd-"));

afterAll(() => { rmSync(cwd, { recursive: true, force: true }); });

afterEach(() => { vi.unstubAllEnvs(); });

describe("createSandboxBashOps", () => {
	it("danger-full-access spawns the raw bash argv", async () => {
		const child = fakeChild();
		const spawnFn = vi.fn(() => child) as never;
		const ops = createSandboxBashOps({ ...posix, mode: "danger-full-access", workspaceRoot: "/ws", spawnFn });
		const p = ops.exec("echo hi", cwd, { onData: () => {} });
		await settle(child, 0);
		await p;
		expect(spawnFn).toHaveBeenCalledWith("bash", ["-c", "echo hi"], expect.objectContaining({ cwd }));
	});
	it("workspace-write spawns the confined argv (bwrap profile + -- + bash)", async () => {
		const child = fakeChild();
		const spawnFn = vi.fn(() => child) as never;
		const ops = createSandboxBashOps({ ...posix, mode: "workspace-write", workspaceRoot: "/ws", spawnFn, ...bwrapSelected });
		const p = ops.exec("true", cwd, { onData: () => {} });
		await settle(child, 0);
		await p;
		const [program, args] = spawnFn.mock.calls[0] as [string, string[]];
		expect(program).toBe("bwrap");
		expect(args).toContain("--");
		expect(args.slice(-3)).toEqual(["bash", "-c", "true"]);
	});
	it("unavailable runner rejects with SANDBOX_UNAVAILABLE and never spawns", async () => {
		const spawnFn = vi.fn(() => fakeChild()) as never;
		const ops = createSandboxBashOps({
			...posix, mode: "read-only", workspaceRoot: "/ws", spawnFn, selected: { runner: "unavailable" },
		});
		await expect(ops.exec("true", cwd, { onData: () => {} })).rejects.toThrow(/SANDBOX_UNAVAILABLE/);
		expect(spawnFn).not.toHaveBeenCalled();
	});
	it("env pins LC_MESSAGES=C, preserves LANG, removes LC_ALL (Review Focus #3 + Ruling 10)", async () => {
		vi.stubEnv("LANG", "zh_CN.UTF-8");
		vi.stubEnv("LC_ALL", "zh_CN.UTF-8");
		const child = fakeChild();
		const spawnFn = vi.fn(() => child) as never;
		const ops = createSandboxBashOps({ ...posix, mode: "workspace-write", workspaceRoot: "/ws", spawnFn, ...bwrapSelected });
		const p = ops.exec("true", cwd, { onData: () => {} });
		await settle(child, 0);
		await p;
		const options = (spawnFn.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }])[2];
		expect(options.env.LC_MESSAGES).toBe("C");
		expect(options.env.LANG).toBe("zh_CN.UTF-8");
		expect(options.env.LC_ALL).toBeUndefined(); // LC_ALL 覆盖 LC_MESSAGES，必须被移除
	});
	it("streams stdout and stderr to onData", async () => {
		const child = fakeChild();
		const spawnFn = vi.fn(() => child) as never;
		const ops = createSandboxBashOps({ ...posix, mode: "danger-full-access", workspaceRoot: "/ws", spawnFn });
		const chunks: Buffer[] = [];
		const p = ops.exec("cmd", cwd, { onData: (b) => chunks.push(b) });
		child.stdout.write("out");
		child.stderr.write("err");
		await settle(child, 0);
		await p;
		expect(chunks.map((c) => c.toString()).join("")).toBe("outerr");
	});
	it("denial on nonzero exit appends marker + hint through onData", async () => {
		const child = fakeChild();
		const spawnFn = vi.fn(() => child) as never;
		const ops = createSandboxBashOps({ ...posix, mode: "workspace-write", workspaceRoot: "/ws", spawnFn, ...bwrapSelected });
		const chunks: Buffer[] = [];
		const p = ops.exec("touch /etc/x", cwd, { onData: (b) => chunks.push(b) });
		child.stderr.write("touch: cannot touch '/etc/x': Read-only file system");
		await settle(child, 1);
		const result = await p;
		expect(result.exitCode).toBe(1);
		const text = chunks.map((c) => c.toString()).join("");
		expect(text).toContain(sandboxDenialMarker("workspace-write"));
		expect(text).toContain(escalationHintMarker("command"));
	});
	it("onDenial fires exactly once on classified denial (denial-first 记账)", async () => {
		const child = fakeChild();
		const spawnFn = vi.fn(() => child) as never;
		const onDenial = vi.fn();
		const ops = createSandboxBashOps({ ...posix, mode: "workspace-write", workspaceRoot: "/ws", spawnFn, ...bwrapSelected, onDenial });
		const p = ops.exec("touch /etc/x", cwd, { onData: () => {} });
		child.stderr.write("touch: cannot touch '/etc/x': Read-only file system");
		await settle(child, 1);
		await p;
		expect(onDenial).toHaveBeenCalledTimes(1);
	});
	it("onDenial 不因 runner failure 触发（那是沙箱不可用，不是拒绝）", async () => {
		const child = fakeChild();
		const spawnFn = vi.fn(() => child) as never;
		const onDenial = vi.fn();
		const ops = createSandboxBashOps({
			...posix, mode: "workspace-write", workspaceRoot: "/ws", spawnFn, onDenial,
			selected: { runner: "landlock", enforcement: "full" },
			hooks: { launcherPath: () => "/opt/landlock-run" },
		});
		const p = ops.exec("true", cwd, { onData: () => {} });
		child.stderr.write("landlock-run: ruleset creation failed");
		await settle(child, 125);
		await expect(p).rejects.toThrow(/SANDBOX_UNAVAILABLE/);
		expect(onDenial).not.toHaveBeenCalled();
	});
	it("runner failure rejects with SandboxUnavailableError (exit-gated)", async () => {
		const child = fakeChild();
		const spawnFn = vi.fn(() => child) as never;
		const ops = createSandboxBashOps({
			...posix, mode: "workspace-write", workspaceRoot: "/ws", spawnFn,
			selected: { runner: "landlock", enforcement: "full" },
			hooks: { launcherPath: () => "/opt/landlock-run" },
		});
		const p = ops.exec("true", cwd, { onData: () => {} });
		child.stderr.write("landlock-run: ruleset creation failed");
		await settle(child, 125);
		await expect(p).rejects.toThrow(/SANDBOX_UNAVAILABLE/);
	});
	it("timeout (seconds) kills the tree with SIGKILL and rejects timeout:N (I1: pi ops contract)", async () => {
		const child = fakeChild();
		const spawnFn = vi.fn(() => child) as never;
		const ops = createSandboxBashOps({ ...posix, mode: "danger-full-access", workspaceRoot: "/ws", spawnFn });
		// fake child 无 pid → killTree 回退 child.kill，SIGKILL 断言不破
		await expect(ops.exec("sleep 100", cwd, { onData: () => {}, timeout: 0.01 })).rejects.toThrow(/timeout:/);
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
	});
	it("timeout <= 0 arms no timer (pi-local parity, Ruling 20)", async () => {
		const child = fakeChild();
		const spawnFn = vi.fn(() => child) as never;
		const ops = createSandboxBashOps({ ...posix, mode: "danger-full-access", workspaceRoot: "/ws", spawnFn });
		const p = ops.exec("sleep 100", cwd, { onData: () => {}, timeout: 0 });
		await vi.waitFor(() => { expect(spawnFn).toHaveBeenCalled(); });
		// 守卫缺失时 0ms 定时器会在此窗口内 kill（close 走 null）→ reject timeout:0；
		// 仅靠 settle 抢跑会先于已武装的定时器关流并被 cleanup 清掉，无法稳定检出回归。
		await new Promise((resolve) => setTimeout(resolve, 20));
		await settle(child, 0);
		const result = await p;
		expect(result.exitCode).toBe(0);
		expect(child.kill).not.toHaveBeenCalled();
	});
	it("abort signal kills the tree with SIGTERM and rejects \"aborted\" (I1: pi ops contract)", async () => {
		const child = fakeChild();
		const spawnFn = vi.fn(() => child) as never;
		const ops = createSandboxBashOps({ ...posix, mode: "danger-full-access", workspaceRoot: "/ws", spawnFn });
		const ac = new AbortController();
		const p = ops.exec("sleep 100", cwd, { onData: () => {}, signal: ac.signal });
		// M4 预检是 await——等 spawn（同步紧跟的 abort 监听已挂）再 abort，避免抢在监听前
		await vi.waitFor(() => { expect(spawnFn).toHaveBeenCalled(); });
		ac.abort();
		await expect(p).rejects.toThrow(/aborted/);
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
	});
	it("already-aborted signal rejects \"aborted\" without spawning (Ruling 9 + I1)", async () => {
		const spawnFn = vi.fn(() => fakeChild()) as never;
		const ops = createSandboxBashOps({ ...posix, mode: "danger-full-access", workspaceRoot: "/ws", spawnFn });
		const ac = new AbortController();
		ac.abort();
		await expect(ops.exec("true", cwd, { onData: () => {}, signal: ac.signal })).rejects.toThrow(/aborted/);
		expect(spawnFn).not.toHaveBeenCalled();
	});
	it("external kill (no timer, no abort) still resolves {exitCode: null}", async () => {
		const child = fakeChild();
		const spawnFn = vi.fn(() => child) as never;
		const ops = createSandboxBashOps({ ...posix, mode: "danger-full-access", workspaceRoot: "/ws", spawnFn });
		const p = ops.exec("sleep 100", cwd, { onData: () => {} });
		await settle(child, null); // 直接触发 close(null)：既非超时也非 abort
		const result = await p;
		expect(result.exitCode).toBeNull();
	});
	it("spawns detached so the process group is killable (I3)", async () => {
		const child = fakeChild();
		const spawnFn = vi.fn(() => child) as never;
		const ops = createSandboxBashOps({ ...posix, mode: "danger-full-access", workspaceRoot: "/ws", spawnFn });
		const p = ops.exec("true", cwd, { onData: () => {} });
		await settle(child, 0);
		await p;
		const options = (spawnFn.mock.calls[0] as [string, string[], { detached?: boolean }])[2];
		expect(options.detached).toBe(true);
	});
	it("rejects with a friendly error when cwd does not exist (M4)", async () => {
		const spawnFn = vi.fn(() => fakeChild()) as never;
		const ops = createSandboxBashOps({ ...posix, mode: "danger-full-access", workspaceRoot: "/ws", spawnFn });
		await expect(ops.exec("true", "/nonexistent-sbx-dir-xyz", { onData: () => {} })).rejects.toThrow(/Working directory does not exist/);
		expect(spawnFn).not.toHaveBeenCalled();
	});
	it("refuses bash on win32 confined modes before spawning, but danger-full-access still spawns", async () => {
		const confinedSpawn = vi.fn(() => fakeChild()) as never;
		const confined = createSandboxBashOps({
			mode: "workspace-write", workspaceRoot: process.cwd(), platform: "win32", spawnFn: confinedSpawn,
		});
		await expect(confined.exec("echo hi", cwd, { onData: () => {} })).rejects.toThrowError(/bash is not supported on Windows/);
		expect(confinedSpawn).not.toHaveBeenCalled(); // guard 在 confine/spawn 之前 fail-closed

		const child = fakeChild();
		const dfaSpawn = vi.fn(() => child) as never;
		const dfa = createSandboxBashOps({
			mode: "danger-full-access", workspaceRoot: process.cwd(), platform: "win32", spawnFn: dfaSpawn,
		});
		const p = dfa.exec("echo hi", cwd, { onData: () => {} });
		await settle(child, 0);
		await p;
		expect(dfaSpawn).toHaveBeenCalledTimes(1); // guard 不得在 danger-full-access 早退后触发
		const [, args, options] = dfaSpawn.mock.calls[0] as unknown as [string, string[], { detached: boolean; windowsHide: boolean }];
		expect(args).toEqual(["-c", "echo hi"]);
		expect(options.detached).toBe(false); // win32 无进程组
		expect(options.windowsHide).toBe(true);
	});
});
