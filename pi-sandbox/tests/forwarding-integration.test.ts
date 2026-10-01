import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SANDBOX_CONFIG, resetSandboxConfigCache } from "../src/config";
import { getEscalationBroker, resetEscalationBrokerForTests } from "../src/escalation-broker";
import { createPermissionState, processPermissionState } from "../src/permission";
import { createSandboxTools } from "../src/tools";

/**
 * 包内组合级判例（Ruling 18）：假宿主驱动 index.ts 的 activate + 真 createSandboxTools + 假子会话 ctx，
 * 走通「session_start 注册 → session-created 事件 link → 子会话 execute → 父 select → 返回 mode →
 * 真实落盘 → disposed 解除 link → 回到 fail-closed」，钉住单元判例（broker / tools / index-smoke
 * 各自为政）之间的接缝。真机 TUI 验证仍由用户执行（计划 Task 5 Step 8）。
 */

let dir: string;
let ws: string;
let outsideDir: string;
let fakeTmpDir: string;

function makeFakePi() {
	const hooks: Record<string, (event: unknown, ctx: unknown) => void> = {};
	const channels: Record<string, (data: unknown) => void> = {};
	const fakePi = {
		registerTool: () => {},
		registerCommand: () => {},
		on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
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
	return { fakePi, hooks, channels };
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fwd-"));
	mkdirSync(join(dir, "agent"), { recursive: true });
	mkdirSync(join(dir, "ws"), { recursive: true });
	mkdirSync(join(dir, "fake-tmp"), { recursive: true });
	mkdirSync(join(dir, "outside"), { recursive: true });
	ws = realpathSync.native(join(dir, "ws"));
	fakeTmpDir = realpathSync.native(join(dir, "fake-tmp"));
	outsideDir = realpathSync.native(join(dir, "outside"));
	vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent"));
});

afterEach(() => {
	processPermissionState.override = null;
	resetEscalationBrokerForTests();
	resetSandboxConfigCache();
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

describe("端到端（包内）：子会话提权 → 父会话弹窗 → 一次放行", () => {
	it("走通 事件→link→子 execute→父 select→落盘，批准一次性，disposed 后回到 fail-closed", async () => {
		const { fakePi, hooks, channels } = makeFakePi();
		const activate = (await import("../index")).default;
		activate(fakePi as never);

		// 父会话上线：注册审批通道（用户在父 TUI 上点 "Allow once"）
		const parentSelect = vi.fn(async () => "Allow once");
		hooks.session_start?.({ type: "session_start" }, {
			hasUI: true,
			sessionManager: { getSessionId: () => "parent-1" },
			ui: { select: parentSelect },
		});

		// pi-subagents 派发子会话：父实例收到 session-created（在子 bindExtensions 之前同步 emit）
		channels["subagents:child:session-created"]?.({ sessionId: "child-1", parentSessionId: "parent-1" });

		const deps = {
			cwd: ws,
			getConfig: () => DEFAULT_SANDBOX_CONFIG,
			permission: createPermissionState(),
			spawnFn: vi.fn(() => {
				throw new Error("本判例不应 spawn 任何进程");
			}) as never,
			selected: { runner: "bwrap" as const, enforcement: "full" as const },
			// testing.md 参数注入：把 tmp 可写根钉在测试目录内，于是 dir/outside 成为真·围栏外
			_tmpRoots: [fakeTmpDir],
		};
		const { write } = createSandboxTools(deps);

		const childCtx = {
			hasUI: false,
			cwd: ws,
			sessionManager: { getSessionId: () => "child-1" },
			ui: {
				select: vi.fn(async () => {
					throw new Error("child session must not prompt locally");
				}),
			},
		} as never;

		// 1) 不提权：围栏拒绝（自证落点确实在围栏外，判例不会假绿）
		const target = join(outsideDir, `fwd-${process.pid}-${Date.now()}.txt`);
		await expect(write.execute("c-1", { path: target, content: "no" }, undefined, undefined, childCtx))
			.rejects.toThrow(/file access denied under workspace-write mode/);

		// 2) 带提权参数原样重试：父会话弹窗放行 → 真实落盘
		await write.execute("c-2", {
			path: target,
			content: "ok",
			sandbox_permissions: "danger-full-access",
			justification: "user-approved external write",
		}, undefined, undefined, childCtx);

		expect(await readFile(target, "utf-8")).toBe("ok");
		expect(parentSelect).toHaveBeenCalledTimes(1);
		expect(parentSelect.mock.calls[0][0] as string).toContain("user-approved external write");
		// D4：标题不含任何子代理来源标识
		expect(parentSelect.mock.calls[0][0] as string).not.toContain("child-1");
		expect(parentSelect.mock.calls[0][1]).toEqual(["Allow once", "Deny"]);
		// 批准只对那一次调用生效：进程档位与本次 deps 的覆盖都没被改写
		expect(processPermissionState.override).toBeNull();
		expect(deps.permission.override).toBeNull();
		expect(getEscalationBroker().resolveChannel("child-1")).not.toBeNull();

		// 3) 子会话结束：disposed 解除 link → 再提权回到 fail-closed
		channels["subagents:child:disposed"]?.({ sessionId: "child-1" });
		await expect(write.execute("c-3", {
			path: join(outsideDir, `fwd-after-${process.pid}-${Date.now()}.txt`),
			content: "x",
			sandbox_permissions: "danger-full-access",
			justification: "after dispose",
		}, undefined, undefined, childCtx)).rejects.toThrow(/no approval channel is available/);
	});
});
