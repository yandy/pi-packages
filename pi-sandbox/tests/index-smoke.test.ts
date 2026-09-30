import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSandboxConfigCache } from "../src/config";
import { getEscalationBroker, resetEscalationBrokerForTests } from "../src/escalation-broker";
import { processPermissionState } from "../src/permission";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "idx-"));
	mkdirSync(join(dir, "agent"), { recursive: true });
	vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent"));
});
afterEach(() => {
	processPermissionState.override = null; // C1：模块单例跨测试复位
	resetEscalationBrokerForTests(); // 审批通道注册表同为进程级单例，必须复位
	resetSandboxConfigCache();
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

type CommandHandler = (args: string, ctx: { ui: { notify: ReturnType<typeof vi.fn> }; cwd?: string }) => Promise<void>;
type HookHandler = (event: unknown, ctx: unknown) => void;

/**
 * 造假 pi：记录注册的工具/命令/hook 与事件订阅。
 * 2026-09-30 起 index.ts 会注册生命周期 hook 与两个子会话事件订阅，
 * 所以旧版的「pi.on 一被调用就抛错」断言已作废（registerFlag 的禁令保留）。
 */
function makeFakePi() {
	const tools: string[] = [];
	const commands: string[] = [];
	const commandHandlers: Record<string, { handler: CommandHandler }> = {};
	const hooks: Record<string, HookHandler> = {};
	const channels: Record<string, (data: unknown) => void> = {};
	const fakePi = {
		registerTool: (t: { name: string }) => {
			tools.push(t.name);
		},
		registerCommand: (name: string, cmd: { handler: CommandHandler }) => {
			commands.push(name);
			commandHandlers[name] = cmd;
		},
		registerFlag: vi.fn(() => {
			throw new Error("2.0 must not register flags");
		}),
		on: (event: string, handler: HookHandler) => {
			hooks[event] = handler;
		},
		events: {
			on: (channel: string, handler: (data: unknown) => void) => {
				channels[channel] = handler;
				return () => {
					delete channels[channel];
				};
			},
			emit: vi.fn(),
		},
	};
	return { fakePi, tools, commands, commandHandlers, hooks, channels };
}

function parentCtx(sessionId: string, hasUI = true) {
	return { hasUI, sessionManager: { getSessionId: () => sessionId }, ui: { select: async () => "Allow once" } };
}

describe("extension activate", () => {
	it("registers sandboxed bash/write/edit tools, the /permission command and the lifecycle hooks, no flags", async () => {
		const { fakePi, tools, commands, hooks, channels } = makeFakePi();
		const activate = (await import("../index")).default;
		activate(fakePi as never);
		expect(tools.sort()).toEqual(["bash", "edit", "write"]);
		expect(commands).toEqual(["permission"]);
		expect(Object.keys(hooks).sort()).toEqual(["session_shutdown", "session_start"]);
		expect(Object.keys(channels).sort()).toEqual(["subagents:child:disposed", "subagents:child:session-created"]);
	});

	it("/permission override is shared across activates via the module singleton (C1)", async () => {
		// 背景事实：pi 对每个会话（含 subagent 子会话）重新调用扩展 factory——两次 activate
		// 模拟父/子两个会话；覆盖必须经模块级 processPermissionState 跨会话可见。
		const first = makeFakePi();
		const second = makeFakePi();
		const activate = (await import("../index")).default;
		activate(first.fakePi as never); // 会话 #1（父）
		activate(second.fakePi as never); // 会话 #2（子；factory 重新调用）

		// 会话 #1 设覆盖（用 danger-full-access：status 走 bypassed 分支，不触发真实 runner 探测）
		const notify1 = vi.fn();
		await first.commandHandlers.permission.handler("danger-full-access", { ui: { notify: notify1 } });
		expect(notify1).toHaveBeenCalledWith(expect.stringContaining("danger-full-access"), "info");

		// 会话 #2 的 status 必须看到该覆盖（无 cwd → describeStatus("") 回落 activate cwd）
		const notify2 = vi.fn();
		await second.commandHandlers.permission.handler("", { ui: { notify: notify2 } });
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
		const { fakePi, tools, commands } = makeFakePi();
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

	it("status shows bypassed before custom runner when mode is danger-full-access (Ruling 19)", async () => {
		const proj = mkdtempSync(join(tmpdir(), "proj-"));
		mkdirSync(join(proj, ".pi"), { recursive: true });
		writeFileSync(join(proj, ".pi", "sandbox.json"), JSON.stringify({
			mode: "danger-full-access",
			runnerCommand: ["myrunner"],
			runnerFailureSignatures: ["myrunner: "],
		}));
		try {
			const { fakePi, commandHandlers } = makeFakePi();
			const activate = (await import("../index")).default;
			activate(fakePi as never);
			const notify = vi.fn();
			await commandHandlers.permission.handler("", { ui: { notify }, cwd: proj });
			const text = notify.mock.calls[0][0] as string;
			expect(text).toContain("bypassed");
			expect(text).not.toContain("custom command");
		} finally {
			rmSync(proj, { recursive: true, force: true });
		}
	});
});

describe("escalation approval forwarding wiring (spec 2026-09-30 §4.5)", () => {
	it("session_start 注册父审批通道，session_shutdown 注销（Review Focus #4）", async () => {
		const { fakePi, hooks } = makeFakePi();
		const activate = (await import("../index")).default;
		activate(fakePi as never);
		const broker = getEscalationBroker();
		broker.linkChild("child-1", "parent-1");
		expect(broker.resolveChannel("child-1")).toBeNull(); // 还没 session_start
		hooks.session_start?.({ type: "session_start" }, parentCtx("parent-1"));
		expect(broker.resolveChannel("child-1")).not.toBeNull();
		hooks.session_shutdown?.({ type: "session_shutdown" }, parentCtx("parent-1"));
		expect(broker.resolveChannel("child-1")).toBeNull(); // 父通道已注销，子会话回到 fail-closed
	});

	it("hasUI=false 的会话不注册为审批终点（正对照：守卫被删则本判例变红）", async () => {
		const { fakePi, hooks } = makeFakePi();
		const activate = (await import("../index")).default;
		activate(fakePi as never);
		const broker = getEscalationBroker();
		broker.linkChild("child-1", "headless-parent");
		const ctx = {
			hasUI: false,
			sessionManager: { getSessionId: () => "headless-parent" },
			ui: { select: async () => "Allow once" },
		};
		hooks.session_start?.({ type: "session_start" }, ctx);
		expect(broker.resolveChannel("child-1")).toBeNull();
		// 正对照：若注册时无视 hasUI，现查会让通道在它翻真后浮现 → 本断言变红
		ctx.hasUI = true;
		expect(broker.resolveChannel("child-1")).toBeNull();
	});

	it("注册后父会话失去 UI → 通道立即失效（hasUI 现查而非快照）", async () => {
		const { fakePi, hooks } = makeFakePi();
		const activate = (await import("../index")).default;
		activate(fakePi as never);
		const ctx = { hasUI: true, sessionManager: { getSessionId: () => "p" }, ui: { select: async () => "Allow once" } };
		hooks.session_start?.({ type: "session_start" }, ctx);
		getEscalationBroker().linkChild("c", "p");
		expect(getEscalationBroker().resolveChannel("c")).not.toBeNull();
		ctx.hasUI = false; // 例如 reload / 会话替换后失去对话框能力
		expect(getEscalationBroker().resolveChannel("c")).toBeNull();
	});

	it("子会话生命周期事件建立/解除 link；载荷缺字段不得抛错", async () => {
		const { fakePi, hooks, channels } = makeFakePi();
		const activate = (await import("../index")).default;
		activate(fakePi as never);
		hooks.session_start?.({ type: "session_start" }, parentCtx("p"));
		const broker = getEscalationBroker();
		channels["subagents:child:session-created"]?.({ sessionId: "c1", parentSessionId: "p" });
		expect(broker.resolveChannel("c1")).not.toBeNull();
		channels["subagents:child:disposed"]?.({ sessionId: "c1" });
		expect(broker.resolveChannel("c1")).toBeNull();
		// 上游契约漂移（缺字段 / 类型错）→ 不 link、不抛错，子会话保持 fail-closed
		expect(() => channels["subagents:child:session-created"]?.({})).not.toThrow();
		expect(() => channels["subagents:child:session-created"]?.({ sessionId: 42, parentSessionId: "p" })).not.toThrow();
		expect(broker.resolveChannel("42")).toBeNull();
	});

	it("注册的父通道把 opts 透传给 ctx.ui.select", async () => {
		const { fakePi, hooks } = makeFakePi();
		const activate = (await import("../index")).default;
		activate(fakePi as never);
		const select = vi.fn(async () => "Allow once");
		const ctx = { hasUI: true, sessionManager: { getSessionId: () => "p" }, ui: { select } };
		hooks.session_start?.({ type: "session_start" }, ctx);
		const channel = getEscalationBroker().resolveChannel("c");
		expect(channel).toBeNull(); // 还没 link
		getEscalationBroker().linkChild("c", "p");
		const resolved = getEscalationBroker().resolveChannel("c");
		expect(resolved).not.toBeNull();
		const ac = new AbortController();
		await resolved?.select("T", ["Allow once", "Deny"], { signal: ac.signal });
		expect(select).toHaveBeenCalledWith("T", ["Allow once", "Deny"], { signal: ac.signal });
	});

	it("ctx 失效（hasUI 取值器抛错）→ 通道失效并 fail-closed，不冒泡宿主报错", async () => {
		const { fakePi, hooks } = makeFakePi();
		const activate = (await import("../index")).default;
		activate(fakePi as never);
		let stale = false;
		const ctx = {
			get hasUI() {
				if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
				return true;
			},
			sessionManager: { getSessionId: () => "p" },
			ui: { select: async () => "Allow once" },
		};
		hooks.session_start?.({ type: "session_start" }, ctx);
		getEscalationBroker().linkChild("c", "p");
		expect(getEscalationBroker().resolveChannel("c")).not.toBeNull();
		stale = true; // 模拟会话替换 / reload 后宿主 assertActive() 抛错
		expect(getEscalationBroker().resolveChannel("c")).toBeNull();
	});

	it("session_shutdown 退订两个事件通道（宿主 reload 复用同一 bus，不退订会累积监听器）", async () => {
		const { fakePi, hooks, channels } = makeFakePi();
		const activate = (await import("../index")).default;
		activate(fakePi as never);
		expect(Object.keys(channels)).toHaveLength(2);
		hooks.session_shutdown?.({ type: "session_shutdown" }, parentCtx("p"));
		expect(Object.keys(channels)).toEqual([]);
	});
});
