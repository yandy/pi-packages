import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSandboxConfigCache } from "../src/config";
import { processPermissionState } from "../src/permission";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "idx-"));
	mkdirSync(join(dir, "agent"), { recursive: true });
	vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent"));
});
afterEach(() => {
	processPermissionState.override = null; // C1：模块单例跨测试复位
	resetSandboxConfigCache();
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

describe("extension activate", () => {
	it("registers sandboxed bash/write/edit tools and the /permission command, no flags/hooks", async () => {
		const tools: string[] = [];
		const commands: string[] = [];
		const fakePi = {
			registerTool: (t: { name: string }) => { tools.push(t.name); },
			registerCommand: (name: string) => { commands.push(name); },
			registerFlag: vi.fn(() => { throw new Error("2.0 must not register flags"); }),
			on: vi.fn(() => { throw new Error("2.0 must not register event hooks"); }),
		};
		const activate = (await import("../index")).default;
		activate(fakePi as never);
		expect(tools.sort()).toEqual(["bash", "edit", "write"]);
		expect(commands).toEqual(["permission"]);
	});

	it("/permission override is shared across activates via the module singleton (C1)", async () => {
		// 背景事实：pi 对每个会话（含 subagent 子会话）重新调用扩展 factory——两次 activate
		// 模拟父/子两个会话；覆盖必须经模块级 processPermissionState 跨会话可见。
		type Handler = (args: string, ctx: { ui: { notify: ReturnType<typeof vi.fn> } }) => Promise<void>;
		const handlers: Handler[] = [];
		const makeFakePi = () => ({
			registerTool: () => {},
			registerCommand: (_name: string, cmd: { handler: Handler }) => { handlers.push(cmd.handler); },
			registerFlag: vi.fn(() => { throw new Error("2.0 must not register flags"); }),
			on: vi.fn(() => { throw new Error("2.0 must not register event hooks"); }),
		});
		const activate = (await import("../index")).default;
		activate(makeFakePi() as never); // 会话 #1（父）
		activate(makeFakePi() as never); // 会话 #2（子；factory 重新调用）
		expect(handlers).toHaveLength(2);

		// 会话 #1 设覆盖（用 danger-full-access：status 走 bypassed 分支，不触发真实 runner 探测）
		const notify1 = vi.fn();
		await handlers[0]("danger-full-access", { ui: { notify: notify1 } });
		expect(notify1).toHaveBeenCalledWith(expect.stringContaining("danger-full-access"), "info");

		// 会话 #2 的 status 必须看到该覆盖（无 cwd → describeStatus("") 回落 activate cwd）
		const notify2 = vi.fn();
		await handlers[1]("", { ui: { notify: notify2 } });
		const status = String(notify2.mock.calls[0]?.[0]);
		expect(status).toContain("danger-full-access");
		expect(status).toContain("/permission");
		expect(processPermissionState.override).toBe("danger-full-access");
	});

	it("corrupt project config: activate does not throw, falls back to defaults, still registers everything (I2)", async () => {
		// 违规配置（runnerCommand 无配对 signatures → validateSandboxConfig throw）写在临时项目里，
		// chdir 过去让 activate 的 process.cwd() 命中它；PI_CODING_AGENT_DIR 已被 beforeEach 隔离。
		const projectDir = join(dir, "project");
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "sandbox.json"), JSON.stringify({ runnerCommand: ["myrunner"] }));
		const tools: string[] = [];
		const commands: string[] = [];
		const fakePi = {
			registerTool: (t: { name: string }) => { tools.push(t.name); },
			registerCommand: (name: string) => { commands.push(name); },
			registerFlag: vi.fn(() => { throw new Error("2.0 must not register flags"); }),
			on: vi.fn(() => { throw new Error("2.0 must not register event hooks"); }),
		};
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const prevCwd = process.cwd();
		process.chdir(projectDir);
		try {
			const activate = (await import("../index")).default;
			expect(() => activate(fakePi as never)).not.toThrow();
			expect(tools.sort()).toEqual(["bash", "edit", "write"]);
			expect(commands).toEqual(["permission"]);
			expect(warn.mock.calls.flat().join(" ")).toMatch(/falling back to defaults/u);
		} finally {
			process.chdir(prevCwd);
			warn.mockRestore();
		}
	});
});
