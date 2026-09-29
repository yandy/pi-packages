import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSandboxBashOps } from "../src/bash-ops";

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

function settle(child: ReturnType<typeof fakeChild>, code: number | null) {
	process.nextTick(() => child.emit("close", code, code === null ? "SIGKILL" : undefined));
}

const bwrapSelected = { selected: { runner: "bwrap" as const, enforcement: "full" as const } };

afterEach(() => { vi.unstubAllEnvs(); });

describe("createSandboxBashOps", () => {
	it("danger-full-access spawns the raw bash argv", async () => {
		const child = fakeChild();
		const spawnFn = vi.fn(() => child) as never;
		const ops = createSandboxBashOps({ mode: "danger-full-access", workspaceRoot: "/ws", spawnFn });
		const p = ops.exec("echo hi", "/ws", { onData: () => {} });
		settle(child, 0);
		await p;
		expect(spawnFn).toHaveBeenCalledWith("bash", ["-c", "echo hi"], expect.objectContaining({ cwd: "/ws" }));
	});
	it("workspace-write spawns the confined argv (bwrap profile + -- + bash)", async () => {
		const child = fakeChild();
		const spawnFn = vi.fn(() => child) as never;
		const ops = createSandboxBashOps({ mode: "workspace-write", workspaceRoot: "/ws", spawnFn, ...bwrapSelected });
		const p = ops.exec("true", "/ws", { onData: () => {} });
		settle(child, 0);
		await p;
		const [program, args] = spawnFn.mock.calls[0] as [string, string[]];
		expect(program).toBe("bwrap");
		expect(args).toContain("--");
		expect(args.slice(-3)).toEqual(["bash", "-c", "true"]);
	});
	it("unavailable runner rejects with SANDBOX_UNAVAILABLE and never spawns", async () => {
		const spawnFn = vi.fn(() => fakeChild()) as never;
		const ops = createSandboxBashOps({
			mode: "read-only", workspaceRoot: "/ws", spawnFn, selected: { runner: "unavailable" },
		});
		await expect(ops.exec("true", "/ws", { onData: () => {} })).rejects.toThrow(/SANDBOX_UNAVAILABLE/);
		expect(spawnFn).not.toHaveBeenCalled();
	});
	it("env pins LC_MESSAGES=C, preserves LANG, removes LC_ALL (Review Focus #3 + Ruling 10)", async () => {
		vi.stubEnv("LANG", "zh_CN.UTF-8");
		vi.stubEnv("LC_ALL", "zh_CN.UTF-8");
		const child = fakeChild();
		const spawnFn = vi.fn(() => child) as never;
		const ops = createSandboxBashOps({ mode: "workspace-write", workspaceRoot: "/ws", spawnFn, ...bwrapSelected });
		const p = ops.exec("true", "/ws", { onData: () => {} });
		settle(child, 0);
		await p;
		const options = (spawnFn.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }])[2];
		expect(options.env.LC_MESSAGES).toBe("C");
		expect(options.env.LANG).toBe("zh_CN.UTF-8");
		expect(options.env.LC_ALL).toBeUndefined(); // LC_ALL 覆盖 LC_MESSAGES，必须被移除
	});
	it("streams stdout and stderr to onData", async () => {
		const child = fakeChild();
		const spawnFn = vi.fn(() => child) as never;
		const ops = createSandboxBashOps({ mode: "danger-full-access", workspaceRoot: "/ws", spawnFn });
		const chunks: Buffer[] = [];
		const p = ops.exec("cmd", "/ws", { onData: (b) => chunks.push(b) });
		child.stdout.write("out");
		child.stderr.write("err");
		settle(child, 0);
		await p;
		expect(chunks.map((c) => c.toString()).join("")).toBe("outerr");
	});
	it("denial on nonzero exit appends marker + hint through onData", async () => {
		const child = fakeChild();
		const spawnFn = vi.fn(() => child) as never;
		const ops = createSandboxBashOps({ mode: "workspace-write", workspaceRoot: "/ws", spawnFn, ...bwrapSelected });
		const chunks: Buffer[] = [];
		const p = ops.exec("touch /etc/x", "/ws", { onData: (b) => chunks.push(b) });
		child.stderr.write("touch: cannot touch '/etc/x': Read-only file system");
		settle(child, 1);
		const result = await p;
		expect(result.exitCode).toBe(1);
		const text = chunks.map((c) => c.toString()).join("");
		expect(text).toContain("[sandbox: file access denied under workspace-write mode]");
		expect(text).toContain("[sandbox: escalation available — retry this exact command once");
	});
	it("runner failure rejects with SandboxUnavailableError (exit-gated)", async () => {
		const child = fakeChild();
		const spawnFn = vi.fn(() => child) as never;
		const ops = createSandboxBashOps({
			mode: "workspace-write", workspaceRoot: "/ws", spawnFn,
			selected: { runner: "landlock", enforcement: "full" },
			hooks: { launcherPath: () => "/opt/landlock-run" },
		});
		const p = ops.exec("true", "/ws", { onData: () => {} });
		child.stderr.write("landlock-run: ruleset creation failed");
		settle(child, 125);
		await expect(p).rejects.toThrow(/SANDBOX_UNAVAILABLE/);
	});
	it("timeout (seconds) kills the child with SIGKILL → exitCode null", async () => {
		const child = fakeChild();
		const spawnFn = vi.fn(() => child) as never;
		const ops = createSandboxBashOps({ mode: "danger-full-access", workspaceRoot: "/ws", spawnFn });
		const result = await ops.exec("sleep 100", "/ws", { onData: () => {}, timeout: 0.01 });
		expect(result.exitCode).toBeNull();
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
	});
	it("abort signal kills the child with SIGTERM → exitCode null", async () => {
		const child = fakeChild();
		const spawnFn = vi.fn(() => child) as never;
		const ops = createSandboxBashOps({ mode: "danger-full-access", workspaceRoot: "/ws", spawnFn });
		const ac = new AbortController();
		const p = ops.exec("sleep 100", "/ws", { onData: () => {}, signal: ac.signal });
		ac.abort();
		const result = await p;
		expect(result.exitCode).toBeNull();
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
	});
	it("already-aborted signal resolves {exitCode: null} without spawning (Ruling 9)", async () => {
		const spawnFn = vi.fn(() => fakeChild()) as never;
		const ops = createSandboxBashOps({ mode: "danger-full-access", workspaceRoot: "/ws", spawnFn });
		const ac = new AbortController();
		ac.abort();
		const result = await ops.exec("true", "/ws", { onData: () => {}, signal: ac.signal });
		expect(result.exitCode).toBeNull();
		expect(spawnFn).not.toHaveBeenCalled();
	});
});
