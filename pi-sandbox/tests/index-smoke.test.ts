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
	return { hasUI, sessionManager: { getSessionId: () => sessionId }, ui: { select: async () => "Allow once", input: async () => "because" } };
}

describe("extension activate", () => {
	it("registers sandboxed bash/write/edit tools, the /permission command and the lifecycle hooks, no flags", async () => {
		const { fakePi, tools, commands, hooks, channels } = makeFakePi();
		const activate = (await import("../index")).default;
		activate(fakePi as never);
		expect(tools.sort()).toEqual(["bash", "edit", "write"]);
		expect(commands).toEqual(["permission"]);
		// T15 起多一个 resources_discover（技能平台门控）；其余注册面不变。
		expect(Object.keys(hooks).sort()).toEqual(["resources_discover", "session_shutdown", "session_start"]);
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
		// 数字载荷被 typeof 守卫拦下：既没建立 link，也没污染后续合法 link（正对照）
		channels["subagents:child:session-created"]?.({ sessionId: "c2", parentSessionId: "p" });
		expect(broker.resolveChannel("c2")).not.toBeNull();
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

	it("注册的父通道把 opts 透传给 ctx.ui.input（Deny 理由两步式的第二步）", async () => {
		const { fakePi, hooks } = makeFakePi();
		const activate = (await import("../index")).default;
		activate(fakePi as never);
		const input = vi.fn(async () => "because");
		const ctx = { hasUI: true, sessionManager: { getSessionId: () => "p" }, ui: { select: async () => "Allow once", input } };
		hooks.session_start?.({ type: "session_start" }, ctx);
		getEscalationBroker().linkChild("c", "p");
		const resolved = getEscalationBroker().resolveChannel("c");
		expect(resolved).not.toBeNull();
		const ac = new AbortController();
		await resolved?.input?.("Why deny?", "optional", { signal: ac.signal });
		expect(input).toHaveBeenCalledWith("Why deny?", "optional", { signal: ac.signal });
	});

	it("旧宿主 ctx.ui 无 input → 通道 input 为 undefined（broker 跳过理由追问）", async () => {
		const { fakePi, hooks } = makeFakePi();
		const activate = (await import("../index")).default;
		activate(fakePi as never);
		const ctx = { hasUI: true, sessionManager: { getSessionId: () => "p" }, ui: { select: async () => "Allow once" } };
		hooks.session_start?.({ type: "session_start" }, ctx);
		getEscalationBroker().linkChild("c", "p");
		const resolved = getEscalationBroker().resolveChannel("c");
		expect(resolved).not.toBeNull();
		expect(resolved?.input).toBeUndefined();
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

/**
 * T15：技能平台门控（Ruling 9）与 pwsh 未激活提示（Ruling 8）。
 * 提示是**每进程一次**的模块级标志，所以每个需要“首次提示”的用例先 `vi.resetModules()`
 * 再 import index；fires-once 用例用两次 activate 钉住跨会话不重复。
 */
describe("T15: 平台门控与 pwsh 未激活提示（Ruling 8/9）", () => {
	/** Node 上 process.platform 是 configurable 的数据属性：临时改写后按原描述符还原。 */
	async function withPlatform<T>(platform: string, run: () => Promise<T> | T): Promise<T> {
		const original = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: platform });
		try {
			return await run();
		} finally {
			if (original) Object.defineProperty(process, "platform", original);
		}
	}

	/** 带 getActiveTools 的假 pi（Ruling 8 的探测面）；传函数可模拟取值抛错（陈旧宿主）。 */
	function makeFakePiWithActiveTools(active: string[] | (() => string[])) {
		const made = makeFakePi();
		(made.fakePi as unknown as { getActiveTools: () => string[] }).getActiveTools =
			typeof active === "function" ? active : () => active;
		return made;
	}

	function uiCtx(sessionId: string, notify: ReturnType<typeof vi.fn>) {
		return {
			hasUI: true,
			sessionManager: { getSessionId: () => sessionId },
			ui: { select: async () => "Allow once", input: async () => "because", notify },
		};
	}

	it("contributes the ACL skill path only on win32", async () => {
		const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
		const fakePi = { on: (name: string, handler: never) => { (handlers[name] ??= []).push(handler); return () => {}; }, registerTool: () => {}, registerCommand: () => {}, events: { on: () => () => {} } };
		(await import("../index")).default(fakePi as never);
		const discovery = handlers.resources_discover?.[0];
		expect(discovery).toBeDefined();
		await withPlatform("win32", async () => {
			await expect(Promise.resolve(discovery?.({ type: "resources_discover", cwd: process.cwd(), reason: "startup" }, {}))).resolves.toEqual({
				skillPaths: ["./skills/diagnose-windows-sandbox-acl"],
			});
		});
		await withPlatform("linux", async () => {
			await expect(Promise.resolve(discovery?.({ type: "resources_discover", cwd: process.cwd(), reason: "reload" }, {}))).resolves.toEqual({ skillPaths: [] });
		});
	});

	it("registers the powershell tool only when createSandboxTools provides one", async () => {
		// 宿主 0.80.2 没有 createPowerShellToolDefinition，win32 的正例分支单测里无法自然到达；
		// 这里 mock 掉 ../src/tools 的返回值，只钉 index.ts 的 `!== undefined` 门控本身。
		// （缺省分支由本文件首个用例的 tools 精确集合覆盖：undefined 必须跳过注册而不是注册 undefined。）
		vi.doMock("../src/tools", () => ({
			createSandboxTools: () => ({
				bash: { name: "bash" },
				write: { name: "write" },
				edit: { name: "edit" },
				powershell: { name: "powershell" },
			}),
		}));
		vi.resetModules();
		try {
			const { fakePi, tools } = makeFakePi();
			const activate = (await import("../index")).default;
			activate(fakePi as never);
			expect(tools.sort()).toEqual(["bash", "edit", "powershell", "write"]);
		} finally {
			vi.doUnmock("../src/tools");
			vi.resetModules();
		}
	});

	it("/permission 状态行在 win32 且 pwsh 未激活时标注 not activated（Ruling 8）", async () => {
		const { fakePi, commandHandlers } = makeFakePiWithActiveTools(["bash"]);
		const activate = (await import("../index")).default;
		activate(fakePi as never);
		processPermissionState.override = "danger-full-access"; // bypassed 分支：不触发真实 runner 探测
		const notify = vi.fn();
		await withPlatform("win32", async () => {
			await commandHandlers.permission.handler("", { ui: { notify } });
		});
		expect(notify).toHaveBeenCalledTimes(1);
		expect(String(notify.mock.calls[0]?.[0])).toContain("shell: powershell only (not activated)");
	});

	it("/permission 状态行在 win32 且 pwsh 已激活时只注明 shell 方言", async () => {
		const { fakePi, commandHandlers } = makeFakePiWithActiveTools(["bash", "powershell"]);
		const activate = (await import("../index")).default;
		activate(fakePi as never);
		processPermissionState.override = "danger-full-access";
		const notify = vi.fn();
		await withPlatform("win32", async () => {
			await commandHandlers.permission.handler("", { ui: { notify } });
		});
		expect(notify).toHaveBeenCalledTimes(1);
		const text = String(notify.mock.calls[0]?.[0]);
		expect(text).toContain("shell: powershell only");
		expect(text).not.toContain("not activated");
	});

	it("/permission 状态行在非 win32 上不含 PowerShell 行", async () => {
		const { fakePi, commandHandlers } = makeFakePiWithActiveTools(["bash"]);
		const activate = (await import("../index")).default;
		activate(fakePi as never);
		processPermissionState.override = "danger-full-access";
		const notify = vi.fn();
		await commandHandlers.permission.handler("", { ui: { notify } });
		expect(notify).toHaveBeenCalledTimes(1);
		expect(String(notify.mock.calls[0]?.[0])).not.toContain("shell: powershell");
	});

	it("Ruling 8: win32 + bash 活动而 pwsh 缺失 → 有 UI 提示一次，消息点名修法", async () => {
		vi.resetModules();
		const activate = (await import("../index")).default;
		const first = makeFakePiWithActiveTools(["bash"]);
		activate(first.fakePi as never);
		const notify = vi.fn();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await withPlatform("win32", async () => {
				first.hooks.session_start?.({ type: "session_start" }, uiCtx("p", notify));
				first.hooks.session_start?.({ type: "session_start" }, uiCtx("p", notify)); // 同一 activate 内重复 session_start
			});
			expect(notify).toHaveBeenCalledTimes(1);
			expect(notify.mock.calls[0]?.[1]).toBe("warning");
			const message = String(notify.mock.calls[0]?.[0]);
			expect(message).toContain("~/.pi/agent/settings.json");
			expect(message).toContain('"defaultTools"');
			expect(message).toContain("-bash");
			expect(message).toContain("+powershell");
			expect(message).toContain("refused");
			expect(warn).not.toHaveBeenCalled();

			// 每进程一次：宿主对每个会话重调 factory，第二次 activate / session_start 不得再刷屏
			const second = makeFakePiWithActiveTools(["bash"]);
			activate(second.fakePi as never);
			const notify2 = vi.fn();
			await withPlatform("win32", async () => {
				second.hooks.session_start?.({ type: "session_start" }, uiCtx("p2", notify2));
			});
			expect(notify2).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("Ruling 8: win32 + 无 UI（hasUI=false）→ 提示写 stderr", async () => {
		vi.resetModules();
		const activate = (await import("../index")).default;
		const { fakePi, hooks } = makeFakePiWithActiveTools(["bash"]);
		activate(fakePi as never);
		const notify = vi.fn();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await withPlatform("win32", async () => {
				hooks.session_start?.({ type: "session_start" }, { hasUI: false, ui: { notify } });
			});
			expect(notify).not.toHaveBeenCalled();
			expect(warn).toHaveBeenCalledTimes(1);
			const text = String(warn.mock.calls[0]?.[0]);
			expect(text).toContain("sandbox:");
			expect(text).toContain("+powershell");
		} finally {
			warn.mockRestore();
		}
	});

	it("Ruling 8: ctx 已失效（hasUI 取值器抛错）→ 回落 console.warn，不冒泡（I2）", async () => {
		vi.resetModules();
		const activate = (await import("../index")).default;
		const { fakePi, hooks } = makeFakePiWithActiveTools(["bash"]);
		activate(fakePi as never);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const staleCtx = {
				get hasUI(): boolean {
					throw new Error("This extension ctx is stale after session replacement or reload.");
				},
				ui: { notify: vi.fn() },
			};
			await withPlatform("win32", async () => {
				expect(() => hooks.session_start?.({ type: "session_start" }, staleCtx)).not.toThrow();
			});
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0]?.[0])).toContain("+powershell");
		} finally {
			warn.mockRestore();
		}
	});

	it("Ruling 8: win32 + 老宿主无 getActiveTools → 无法判断，静默且不抛（I2）", async () => {
		vi.resetModules();
		const activate = (await import("../index")).default;
		const { fakePi, hooks } = makeFakePi(); // 无 getActiveTools
		activate(fakePi as never);
		const notify = vi.fn();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await withPlatform("win32", async () => {
				expect(() => hooks.session_start?.({ type: "session_start" }, uiCtx("p", notify))).not.toThrow();
			});
			expect(notify).not.toHaveBeenCalled();
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("Ruling 8: win32 + getActiveTools 抛错（陈旧宿主 ctx）→ 静默且不抛（I2）", async () => {
		vi.resetModules();
		const activate = (await import("../index")).default;
		const { fakePi, hooks } = makeFakePiWithActiveTools(() => {
			throw new Error("host ctx is stale");
		});
		activate(fakePi as never);
		const notify = vi.fn();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await withPlatform("win32", async () => {
				expect(() => hooks.session_start?.({ type: "session_start" }, uiCtx("p", notify))).not.toThrow();
			});
			expect(notify).not.toHaveBeenCalled();
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("Ruling 8: win32 + pwsh 已在活动列表 → 静默", async () => {
		vi.resetModules();
		const activate = (await import("../index")).default;
		const { fakePi, hooks } = makeFakePiWithActiveTools(["bash", "powershell"]);
		activate(fakePi as never);
		const notify = vi.fn();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await withPlatform("win32", async () => {
				hooks.session_start?.({ type: "session_start" }, uiCtx("p", notify));
			});
			expect(notify).not.toHaveBeenCalled();
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("Ruling 8: win32 + bash 本就不活动 → 静默（不该催装 pwsh）", async () => {
		vi.resetModules();
		const activate = (await import("../index")).default;
		const { fakePi, hooks } = makeFakePiWithActiveTools(["read"]);
		activate(fakePi as never);
		const notify = vi.fn();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await withPlatform("win32", async () => {
				hooks.session_start?.({ type: "session_start" }, uiCtx("p", notify));
			});
			expect(notify).not.toHaveBeenCalled();
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("Ruling 8: 非 win32 → 即使 bash 活动、pwsh 缺失也不提示", async () => {
		vi.resetModules();
		const activate = (await import("../index")).default;
		const { fakePi, hooks } = makeFakePiWithActiveTools(["bash"]);
		activate(fakePi as never);
		const notify = vi.fn();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			hooks.session_start?.({ type: "session_start" }, uiCtx("p", notify));
			expect(notify).not.toHaveBeenCalled();
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});
});
