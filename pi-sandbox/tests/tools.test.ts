import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSandboxTools, resolveCall, resolveCallMode } from "../src/tools";
import { createPermissionState } from "../src/permission";
import { DEFAULT_SANDBOX_CONFIG } from "../src/config";
import { getEscalationBroker, resetEscalationBrokerForTests } from "../src/escalation-broker";

let dir: string;
let ws: string;
/** 真·围栏外落点（既不在 workspace，也不在注入的 tmp 根内）。 */
let outsideDir: string;
/** 注入的 tmp 根，替换 "/tmp" + os.tmpdir()——否则整个 dir 都在 tmpdir() 里，构造不出围栏外。 */
let fakeTmpDir: string;

function fakeChild() {
	const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.kill = vi.fn(() => { process.nextTick(() => child.emit("close", null, "SIGTERM")); return true; });
	return child;
}

function makeDeps(overrides: Partial<Parameters<typeof createSandboxTools>[0]> = {}) {
	const child = fakeChild();
	const spawnFn = vi.fn(() => child) as never;
	return {
		deps: {
			cwd: ws,
			getConfig: () => DEFAULT_SANDBOX_CONFIG,
			permission: createPermissionState(),
			spawnFn,
			selected: { runner: "bwrap" as const, enforcement: "full" as const },
			// 测试注入（testing.md 参数注入）：把 tmp 可写根钉在测试目录内，
			// 于是 dir/outside 成为真·围栏外——判例无需触碰真实 HOME 或 /etc。
			_tmpRoots: [fakeTmpDir],
			...overrides,
		},
		child,
		spawnFn,
	};
}

function toolCtx(hasUI = true, choice: string | undefined = "Allow once") {
	return { hasUI, ui: { select: vi.fn(async () => choice), notify: vi.fn() } } as never;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "tools-"));
	mkdirSync(join(dir, "ws"), { recursive: true });
	mkdirSync(join(dir, "fake-tmp"), { recursive: true });
	mkdirSync(join(dir, "outside"), { recursive: true });
	ws = realpathSync.native(join(dir, "ws"));
	fakeTmpDir = realpathSync.native(join(dir, "fake-tmp"));
	outsideDir = realpathSync.native(join(dir, "outside"));
});
afterEach(() => { resetEscalationBrokerForTests(); rmSync(dir, { recursive: true, force: true }); });

describe("createSandboxTools schemas", () => {
	it("bash keeps command/timeout and gains the escalation pair", () => {
		const { deps } = makeDeps();
		const { bash } = createSandboxTools(deps);
		const props = (bash.parameters as { properties: Record<string, unknown> }).properties;
		expect(props.command).toBeDefined();
		expect(props.sandbox_permissions).toBeDefined();
		expect(props.justification).toBeDefined();
	});
	it("description teaches the escalation contract within the per-tool budget (β′)", () => {
		const { deps } = makeDeps();
		const { bash, write, edit } = createSandboxTools(deps);
		// 跨工具规则只留一句：正常调用两个提权字段都不传（never null），协议细节在按需面。
		for (const tool of [bash, write, edit]) {
			expect(tool.description).toContain("Pass neither escalation field unless you are retrying a denial (never null).");
			expect(tool.description).toContain("workspace-write already allows the workspace and /tmp");
			// 旧版把这套协议写进每个 description（×3 重复）：不许回潮。
			expect(tool.description).not.toContain("Writes outside the permitted roots are denied");
			expect(tool.description).not.toContain("Pass justification:");
		}
		// bash 专属事实（bwrap --tmpfs /tmp 语义）只写进 bash，不摊给 write/edit。
		expect(bash.description).toContain("private tmpfs emptied after every command");
		expect(write.description).not.toContain("private tmpfs");
		expect(edit.description).not.toContain("private tmpfs");
		// 预算回归闸（β′）：三个工具的常驻增量合计 ≤ 700 chars（当前 636，改前 1281）。
		const added = [bash, write, edit].flatMap((t) =>
			t.description.split("\n").filter((l) => l.startsWith("Sandbox:") || l.startsWith("bash's")),
		);
		expect(added.join("").length).toBeLessThanOrEqual(700);
	});
	it("keeps base promptSnippet/promptGuidelines and schema options (Ruling 15)", () => {
		const { deps } = makeDeps();
		const { bash, write, edit } = createSandboxTools(deps);
		expect(bash.promptSnippet).toBe("Execute bash commands (ls, grep, find, etc.)");
		expect(write.promptGuidelines).toContain("Use write only for new files or complete rewrites.");
		expect(write.promptGuidelines?.[write.promptGuidelines.length - 1]).toContain("sandbox_permissions");
		// pi 0.80.2 dist 事实：editSchema 自带 additionalProperties:false，writeSchema 无该字段。
		// spread 版 extendParams 如实保留 base options——edit 钉 false（Type.Object 重建即丢），
		// write 钉 base 原样（undefined）；裁决原文假设 write 也为 false，与 dist 不符，按事实钉住。
		expect((write.parameters as { additionalProperties?: boolean }).additionalProperties).toBeUndefined();
		expect((edit.parameters as { additionalProperties?: boolean }).additionalProperties).toBe(false);
	});
});

describe("resolveCallMode", () => {
	it("no escalation params: permission override > config default", async () => {
		const { deps } = makeDeps();
		deps.permission.override = "read-only";
		expect(await resolveCallMode({}, toolCtx(), deps, "command", () => "x")).toBe("read-only");
		deps.permission.override = null;
		expect(await resolveCallMode({}, toolCtx(), deps, "command", () => "x")).toBe("workspace-write");
	});
	it("malformed pair throws", async () => {
		const { deps } = makeDeps();
		await expect(resolveCallMode({ sandbox_permissions: "danger-full-access" }, toolCtx(), deps, "command", () => "x"))
			.rejects.toThrow(/nothing ran.*omit BOTH fields/s);
	});
	it("resolveCall flags a genuine one-shot escalation only (same-mode request stays escalated:false)", async () => {
		const { deps } = makeDeps();
		expect(await resolveCall({}, toolCtx(), deps, "command", () => "x")).toEqual({ mode: "workspace-write", escalated: false });
		// 请求档位 == effective：免审批执行，不是提权（否则会给模型发假的"特批"信号）。
		expect(await resolveCall({ sandbox_permissions: "workspace-write", justification: "same as effective" }, toolCtx(), deps, "command", () => "x"))
			.toEqual({ mode: "workspace-write", escalated: false });
		expect(await resolveCall({ sandbox_permissions: "danger-full-access", justification: "need /etc write" }, toolCtx(true, "Allow once"), deps, "command", () => "x"))
			.toEqual({ mode: "danger-full-access", escalated: true });
	});
	it("approved escalation is one-shot: override state untouched (Review Focus #5)", async () => {
		const { deps } = makeDeps();
		const mode = await resolveCallMode(
			{ sandbox_permissions: "danger-full-access", justification: "need /etc write" },
			toolCtx(true, "Allow once"), deps, "command", () => "x",
		);
		expect(mode).toBe("danger-full-access");
		expect(deps.permission.override).toBeNull();
	});
	it("headless: escalation fails closed", async () => {
		const { deps } = makeDeps();
		await expect(resolveCallMode(
			{ sandbox_permissions: "danger-full-access", justification: "x" },
			toolCtx(false), deps, "command", () => "x",
		)).rejects.toThrow(/no approval channel is available/);
	});
});

describe("write tool fence + escalation wiring", () => {
	it("write inside workspace delegates to the base tool", async () => {
		const { deps } = makeDeps();
		const { write } = createSandboxTools(deps);
		const result = await write.execute("call-1", { path: join(ws, "ok.txt"), content: "hi" }, undefined, undefined, toolCtx()) as { content: { text: string }[] };
		expect(result.content[0].text).toContain("Successfully wrote");
		const { readFile } = await import("node:fs/promises");
		expect(await readFile(join(ws, "ok.txt"), "utf-8")).toBe("hi");
	});
	it("write outside workspace: throws carrying marker + hint", async () => {
		const { deps } = makeDeps();
		const { write } = createSandboxTools(deps);
		// 注入 _tmpRoots 后 dir/outside 是真·围栏外；assertWriteAllowed 在任何落盘前即抛，
		// 所以这里不会真的产生文件（尾部文件名故意不存在）。
		const outside = join(outsideDir, `denied-${process.pid}.txt`);
		await expect(write.execute("call-2", { path: outside, content: "x" }, undefined, undefined, toolCtx()))
			.rejects.toThrow(/file access denied under workspace-write mode[\s\S]*escalation available/);
	});
	it("escalated retry with Allow once writes outside and carries the one-shot marker", async () => {
		const { deps } = makeDeps();
		const { write } = createSandboxTools(deps);
		const outside = join(outsideDir, `tools-test-${process.pid}-${Date.now()}.txt`);
		// 自证断言对：同一路径不带提权必须被拒——落点若其实在围栏内，本判例会响亮失败而非假绿。
		await expect(write.execute("call-3-pre", { path: outside, content: "no" }, undefined, undefined, toolCtx()))
			.rejects.toThrow(/file access denied under workspace-write mode/);
		// 带提权（Allow once）后真实落盘，并随结果下发"仅此一次"标记。
		const result = await write.execute("call-3", {
			path: outside, content: "ok",
			sandbox_permissions: "danger-full-access", justification: "user-approved external write",
		}, undefined, undefined, toolCtx(true, "Allow once")) as { content: { text: string }[] };
		expect(await (await import("node:fs/promises")).readFile(outside, "utf-8")).toBe("ok");
		expect(result.content.map((c) => c.text).join("\n")).toContain('one-shot escalation to "danger-full-access"');
	});
	it("plain call carries no escalation marker (no false one-shot signal)", async () => {
		const { deps } = makeDeps();
		const { write } = createSandboxTools(deps);
		const result = await write.execute("call-3b", { path: join(ws, "plain.txt"), content: "x" }, undefined, undefined, toolCtx()) as { content: { text: string }[] };
		expect(result.content.map((c) => c.text).join("\n")).not.toContain("one-shot escalation");
	});
	it("Deny: error tells the model to stop and explain", async () => {
		const { deps } = makeDeps();
		const { write } = createSandboxTools(deps);
		const outside = join(outsideDir, "denied.txt");
		await expect(write.execute("call-4", {
			path: outside, content: "x",
			sandbox_permissions: "danger-full-access", justification: "reason",
		}, undefined, undefined, toolCtx(true, "Deny"))).rejects.toThrow(/stop and explain instead of working around it/);
	});
	it("fence sees pi-resolved paths: ~-form path escaping the workspace is denied (Ruling 14)", async () => {
		const { deps } = makeDeps();
		const { write } = createSandboxTools(deps);
		// ~ 必须展开到真实 HOME（判例要的就是 ~ 形态）：注入 _tmpRoots 后 tmpdir() 不再自动可写，
		// 故无论 HOME 落在哪都在围栏外。该写被拒，不会落盘。
		const name = `sbx-tilde-${process.pid}-${Date.now()}.txt`;
		await expect(write.execute("call-6", { path: `~/${name}`, content: "x" }, undefined, undefined, toolCtx()))
			.rejects.toThrow(/file access denied under workspace-write mode/);
		expect(existsSync(join(homedir(), name))).toBe(false);
	});
	it("derives the fence root per call from ctx.cwd (C2)", async () => {
		const { deps } = makeDeps();
		const { write } = createSandboxTools(deps);
		const other = mkdtempSync(join(outsideDir, "c2-")); // 真·围栏外（tmp 根之外）
		try {
			const otherCtx = { ...(toolCtx() as object), cwd: other } as never;
			await write.execute("c-9", { path: join(other, "f.txt"), content: "x" }, undefined, undefined, otherCtx);
			expect(existsSync(join(other, "f.txt"))).toBe(true); // 旧行为（冻结 ws）下此写会被拒
			const escape = join(outsideDir, `c2-escape-${process.pid}-${Date.now()}.txt`);
			await expect(write.execute("c-10", { path: escape, content: "x" }, undefined, undefined, otherCtx))
				.rejects.toThrow(/file access denied under workspace-write mode/);
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});
});

describe("edit tool fence", () => {
	it("edit inside workspace applies the replacement", async () => {
		const { deps } = makeDeps();
		const { edit } = createSandboxTools(deps);
		const target = join(ws, "edit-me.txt");
		writeFileSync(target, "hello world");
		await edit.execute("call-7", { path: target, edits: [{ oldText: "hello", newText: "goodbye" }] }, undefined, undefined, toolCtx());
		const { readFile } = await import("node:fs/promises");
		expect(await readFile(target, "utf-8")).toBe("goodbye world");
	});
	it("edit outside workspace is denied", async () => {
		const { deps } = makeDeps();
		const { edit } = createSandboxTools(deps);
		const outside = join(outsideDir, `edit-test-${process.pid}-${Date.now()}.txt`);
		writeFileSync(outside, "x");
		try {
			await expect(edit.execute("call-8", { path: outside, edits: [{ oldText: "x", newText: "y" }] }, undefined, undefined, toolCtx()))
				.rejects.toThrow(/file access denied under workspace-write mode/);
		} finally {
			rmSync(outside, { force: true });
		}
	});
});

describe("bash tool wiring", () => {
	it("spawns the confined argv through injected spawnFn", async () => {
		const { deps, child, spawnFn } = makeDeps();
		const { bash } = createSandboxTools(deps);
		const p = bash.execute("call-5", { command: "echo hi" }, undefined, undefined, toolCtx());
		// M4：exec 先 await cwd 预检才 spawn/挂监听——等 spawn（其后同步挂监听）再喂数据/关流。
		await vi.waitFor(() => { expect(spawnFn).toHaveBeenCalled(); });
		child.stdout.write("hi");
		child.emit("close", 0, undefined);
		await p;
		expect(spawnFn).toHaveBeenCalledWith("bwrap", expect.arrayContaining(["--"]), expect.objectContaining({ cwd: ws }));
	});
});

describe("resolveCallMode 审批通道路由（spec 2026-09-30）", () => {
	/** 子会话 ctx：hasUI=false，select 一旦被本地调用就响亮失败（审批必须走父通道）。 */
	function subagentCtx(sessionId: string) {
		return {
			hasUI: false,
			sessionManager: { getSessionId: () => sessionId },
			ui: {
				select: vi.fn(async () => {
					throw new Error("child session must not prompt locally");
				}),
			},
		} as never;
	}

	function registerParent(sessionId: string, choice: string | undefined = "Allow once") {
		const select = vi.fn(async () => choice);
		getEscalationBroker().registerParent({ sessionId, hasUI: () => true, select });
		return select;
	}

	it("子会话 + 已注册父通道 → 走父 select，返回批准的 mode 且不动进程档位", async () => {
		const { deps } = makeDeps();
		const parentSelect = registerParent("parent-1");
		getEscalationBroker().linkChild("child-1", "parent-1");
		const mode = await resolveCallMode(
			{ sandbox_permissions: "danger-full-access", justification: "need /etc write" },
			subagentCtx("child-1"),
			deps, "command", () => "cat /etc/shadow",
		);
		expect(mode).toBe("danger-full-access");
		expect(parentSelect).toHaveBeenCalledTimes(1);
		expect(parentSelect.mock.calls[0][1]).toEqual(["Allow once", "Deny"]);
		// D4：标题文案与 direct 路径完全一致（含 justification 与摘要），不含任何子代理标识
		const title = parentSelect.mock.calls[0][0] as string;
		expect(title).toContain("need /etc write");
		expect(title).toContain("cat /etc/shadow");
		expect(title).not.toContain("child-1");
		expect(deps.permission.override).toBeNull();
	});

	it("子会话父侧 Deny → 沿用既有拒绝文案", async () => {
		const { deps } = makeDeps();
		registerParent("parent-2", "Deny");
		getEscalationBroker().linkChild("child-2", "parent-2");
		await expect(resolveCallMode(
			{ sandbox_permissions: "danger-full-access", justification: "j" },
			subagentCtx("child-2"),
			deps, "command", () => "x",
		)).rejects.toThrow(/rejected escalating this command to "danger-full-access".*stop and explain/s);
	});

	it("无 link 的子会话 → fail-closed（Review Focus #4）", async () => {
		const { deps } = makeDeps();
		registerParent("parent-3");
		await expect(resolveCallMode(
			{ sandbox_permissions: "danger-full-access", justification: "j" },
			subagentCtx("orphan"),
			deps, "command", () => "x",
		)).rejects.toThrow(/no approval channel is available/);
	});

	it("ctx 无 sessionManager → fail-closed，不抛 TypeError（Review Focus #1）", async () => {
		const { deps } = makeDeps();
		registerParent("parent-4");
		getEscalationBroker().linkChild("child-4", "parent-4");
		// toolCtx(false) 是既有判例用的窄 ctx：没有 sessionManager
		await expect(resolveCallMode(
			{ sandbox_permissions: "danger-full-access", justification: "j" },
			toolCtx(false),
			deps, "command", () => "x",
		)).rejects.toThrow(/no approval channel is available/);
	});

	it("子会话 signal 已 abort → 不弹窗，按取消抛错（Review Focus #2）", async () => {
		const { deps } = makeDeps();
		const parentSelect = registerParent("parent-5");
		getEscalationBroker().linkChild("child-5", "parent-5");
		const ac = new AbortController();
		ac.abort();
		await expect(resolveCallMode(
			{ sandbox_permissions: "danger-full-access", justification: "j" },
			subagentCtx("child-5"),
			deps, "command", () => "x", ac.signal,
		)).rejects.toThrow(/cancelled/);
		expect(parentSelect).not.toHaveBeenCalled();
	});

	it("direct 路径透传 signal（D6）", async () => {
		const { deps } = makeDeps();
		const ctx = toolCtx(true, "Allow once") as { ui: { select: ReturnType<typeof vi.fn> } };
		const ac = new AbortController();
		await resolveCallMode(
			{ sandbox_permissions: "danger-full-access", justification: "j" },
			ctx as never,
			deps, "command", () => "x", ac.signal,
		);
		expect(ctx.ui.select.mock.calls[0][2]).toEqual({ signal: ac.signal });
	});

	it("direct 路径无 signal → 第三参为 undefined（headless 行为逐字不变，D6）", async () => {
		const { deps } = makeDeps();
		const ctx = toolCtx(true, "Allow once") as { ui: { select: ReturnType<typeof vi.fn> } };
		await resolveCallMode(
			{ sandbox_permissions: "danger-full-access", justification: "j" },
			ctx as never,
			deps, "command", () => "x",
		);
		expect(ctx.ui.select.mock.calls[0][2]).toBeUndefined();
	});

	it("direct 路径也排进 FIFO 车道：本会话已注册通道时经 broker.request（Ruling 17）", async () => {
		const { deps } = makeDeps();
		const ownSelect = vi.fn(async () => "Allow once");
		getEscalationBroker().registerParent({ sessionId: "self", hasUI: () => true, select: ownSelect });
		const ctx = {
			hasUI: true,
			sessionManager: { getSessionId: () => "self" },
			ui: {
				select: vi.fn(async () => {
					throw new Error("must go through the broker lane");
				}),
			},
		} as never;
		const mode = await resolveCallMode(
			{ sandbox_permissions: "danger-full-access", justification: "j" },
			ctx, deps, "command", () => "x",
		);
		expect(mode).toBe("danger-full-access");
		expect(ownSelect).toHaveBeenCalledTimes(1);
	});

	it("hasUI 但本会话未注册通道 → 回落直连 ctx.ui.select（行为与改动前一致）", async () => {
		const { deps } = makeDeps();
		const select = vi.fn(async () => "Allow once");
		const ctx = { hasUI: true, sessionManager: { getSessionId: () => "unregistered" }, ui: { select } } as never;
		const mode = await resolveCallMode(
			{ sandbox_permissions: "danger-full-access", justification: "j" },
			ctx, deps, "command", () => "x",
		);
		expect(mode).toBe("danger-full-access");
		expect(select).toHaveBeenCalledTimes(1);
	});

	it("execute 层透传 signal：已 abort → 不弹窗、按取消抛错（bash，Important #2）", async () => {
		const { deps } = makeDeps();
		const parentSelect = registerParent("parent-e1");
		getEscalationBroker().linkChild("child-e1", "parent-e1");
		const { bash } = createSandboxTools(deps);
		const ac = new AbortController();
		ac.abort();
		await expect(bash.execute("call-e1", {
			command: "touch ./x",
			sandbox_permissions: "danger-full-access",
			justification: "probe",
		}, ac.signal, undefined, subagentCtx("child-e1"))).rejects.toThrow(/cancelled/);
		expect(parentSelect).not.toHaveBeenCalled();
	});

	it("execute 层透传 signal：已 abort → 不弹窗（write，Important #2）", async () => {
		const { deps } = makeDeps();
		const parentSelect = registerParent("parent-e2");
		getEscalationBroker().linkChild("child-e2", "parent-e2");
		const { write } = createSandboxTools(deps);
		const ac = new AbortController();
		ac.abort();
		await expect(write.execute("call-e2", {
			path: join(outsideDir, `e2-${process.pid}-${Date.now()}.txt`),
			content: "x",
			sandbox_permissions: "danger-full-access",
			justification: "probe",
		}, ac.signal, undefined, subagentCtx("child-e2"))).rejects.toThrow(/cancelled/);
		expect(parentSelect).not.toHaveBeenCalled();
	});

	it("execute 层透传 signal：已 abort → 不弹窗（edit，Important #2）", async () => {
		const { deps } = makeDeps();
		const parentSelect = registerParent("parent-e3");
		getEscalationBroker().linkChild("child-e3", "parent-e3");
		const { edit } = createSandboxTools(deps);
		const ac = new AbortController();
		ac.abort();
		await expect(edit.execute("call-e3", {
			path: join(outsideDir, `e3-${process.pid}-${Date.now()}.txt`),
			edits: [{ oldText: "x", newText: "y" }],
			sandbox_permissions: "danger-full-access",
			justification: "probe",
		}, ac.signal, undefined, subagentCtx("child-e3"))).rejects.toThrow(/cancelled/);
		expect(parentSelect).not.toHaveBeenCalled();
	});
});
