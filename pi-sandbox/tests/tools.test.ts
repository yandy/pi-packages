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
import { getDenialLedger, resetDenialLedgerForTests } from "../src/denial-ledger";

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

/** 测试会话 id：denial-first 门禁按会话记账/消费，默认 ctx 共用它。 */
const TEST_SESSION = "test-session";

function toolCtx(hasUI = true, choice: string | undefined = "Allow once") {
	return {
		hasUI,
		sessionManager: { getSessionId: () => TEST_SESSION },
		ui: { select: vi.fn(async () => choice), input: vi.fn(async () => undefined), notify: vi.fn() },
	} as never;
}

/** 播种一笔前置拒绝（denial-first 门禁的放行条件）。 */
function seedDenial(kind: "command" | "operation" = "command", sessionId = TEST_SESSION) {
	getDenialLedger().record(sessionId, kind);
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
afterEach(() => { resetEscalationBrokerForTests(); resetDenialLedgerForTests(); rmSync(dir, { recursive: true, force: true }); });

describe("createSandboxTools schemas", () => {
	it("bash keeps command/timeout and gains the escalation pair", () => {
		const { deps } = makeDeps();
		const { bash } = createSandboxTools(deps);
		const props = (bash.parameters as { properties: Record<string, unknown> }).properties;
		expect(props.command).toBeDefined();
		expect(props.sandbox_permissions).toBeDefined();
		expect(props.justification).toBeDefined();
	});
	it("提权参数显式声明 null：strict 模式下模型拿到的是 schema 认可的“不提权”取值（而非猜字符串）", () => {
		const { deps } = makeDeps();
		const { bash, write, edit } = createSandboxTools(deps);
		// 背景（pi 1.0.0 实测）：strict 提供商（如 deepseek-flash，compat.supportsStrictMode=true）下 pi 会把
		// 所有 property 塞进 required，并对“不允许 null”的字段补 anyOf[X,{type:"null"}]。声明 null 后：
		// ① 模型有显式的合法取值（JSON null）来表达“不提权”，不必与 “never null” 的文案打架去写字符串 "null"；
		// ② pi 的 strict 转换不再补一层包裹（schemaAllowsNull 递归识别）；
		// ③ JSON null 不会被 pi 的 normalizeOptionalNulls 剥掉，而是原样送达 execute（归一化分支保持可达）。
		for (const tool of [bash, write, edit]) {
			const props = (tool.parameters as { properties: Record<string, unknown> }).properties;
			expect(JSON.parse(JSON.stringify(props.sandbox_permissions))).toEqual({
				anyOf: [
					{ type: "string", const: "workspace-write" },
					{ type: "string", const: "danger-full-access" },
					{ type: "null" },
				],
			});
			expect(JSON.parse(JSON.stringify(props.justification))).toEqual({
				anyOf: [{ type: "string" }, { type: "null" }],
			});
		}
		// 声明仍是 optional：非 strict 提供商下 required 不含这两个字段，模型可以完全不传。
		const required = (bash.parameters as { required?: string[] }).required ?? [];
		expect(required).not.toContain("sandbox_permissions");
		expect(required).not.toContain("justification");
	});
	it("description teaches the escalation contract within the per-tool budget (β′)", () => {
		const { deps } = makeDeps();
		const { bash, write, edit } = createSandboxTools(deps);
		// 跨工具规则只留一句：不提权时省略或传 JSON null（字符串 "null" 不是合法取值），且非拒绝重试的提权会被忽略。
		for (const tool of [bash, write, edit]) {
			expect(tool.description).toContain('Unless retrying a denial, omit these fields or send JSON null — never the string "null".');
			expect(tool.description).toContain("workspace-write already allows the workspace and /tmp");
			// 旧版把这套协议写进每个 description（×3 重复）：不许回潮。
			expect(tool.description).not.toContain("Writes outside the permitted roots are denied");
			expect(tool.description).not.toContain("Pass justification:");
		}
		// /tmp 已 bind 宿主（2026-10-01 决策）→ 常驻面不再需要任何 /tmp 专属措辞。
		for (const tool of [bash, write, edit]) expect(tool.description).not.toContain("tmpfs");
		// 预算回归闸（β′）：三个工具的常驻增量合计 ≤ 560 chars（当前 510，改前 1281）。
		const added = [bash, write, edit].flatMap((t) =>
			t.description.split("\n").filter((l) => l.startsWith("Sandbox:")),
		);
		expect(added.join("").length).toBeLessThanOrEqual(560);
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
		expect(await resolveCall({}, toolCtx(), deps, "command", () => "x")).toEqual({ mode: "workspace-write", escalated: false, ignoredEscalation: false });
		// 请求档位 == effective：免审批执行，不是提权（否则会给模型发假的"特批"信号）。
		expect(await resolveCall({ sandbox_permissions: "workspace-write", justification: "same as effective" }, toolCtx(), deps, "command", () => "x"))
			.toEqual({ mode: "workspace-write", escalated: false, ignoredEscalation: false });
		// 严格更宽 + 有前置拒绝记录（denial-first 硬门禁的放行条件）→ 真提权
		seedDenial("command");
		expect(await resolveCall({ sandbox_permissions: "danger-full-access", justification: "need /etc write" }, toolCtx(true, "Allow once"), deps, "command", () => "x"))
			.toEqual({ mode: "danger-full-access", escalated: true, ignoredEscalation: false });
	});
	it("approved escalation is one-shot: override state untouched (Review Focus #5)", async () => {
		const { deps } = makeDeps();
		seedDenial("command");
		const mode = await resolveCallMode(
			{ sandbox_permissions: "danger-full-access", justification: "need /etc write" },
			toolCtx(true, "Allow once"), deps, "command", () => "x",
		);
		expect(mode).toBe("danger-full-access");
		expect(deps.permission.override).toBeNull();
	});
	it("headless: escalation fails closed", async () => {
		const { deps } = makeDeps();
		seedDenial("command");
		// 有会话身份（能走到门禁的下一环）但无审批通道：仍按既有 fail-closed 报错。
		const headless = { hasUI: false, sessionManager: { getSessionId: () => TEST_SESSION }, ui: { select: vi.fn() } } as never;
		await expect(resolveCallMode(
			{ sandbox_permissions: "danger-full-access", justification: "x" },
			headless, deps, "command", () => "x",
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
		// denial-first：先有一次真实拒绝（记账），提权才会进入审批对话
		await expect(write.execute("call-4-pre", { path: outside, content: "x" }, undefined, undefined, toolCtx()))
			.rejects.toThrow(/file access denied under workspace-write mode/);
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
		seedDenial("command", "child-1");
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
		seedDenial("command", "child-2");
		await expect(resolveCallMode(
			{ sandbox_permissions: "danger-full-access", justification: "j" },
			subagentCtx("child-2"),
			deps, "command", () => "x",
		)).rejects.toThrow(/rejected escalating this command to "danger-full-access".*stop and explain/s);
	});

	it("无 link 的子会话 → fail-closed（Review Focus #4）", async () => {
		const { deps } = makeDeps();
		registerParent("parent-3");
		seedDenial("command", "orphan");
		await expect(resolveCallMode(
			{ sandbox_permissions: "danger-full-access", justification: "j" },
			subagentCtx("orphan"),
			deps, "command", () => "x",
		)).rejects.toThrow(/no approval channel is available/);
	});

	it("ctx 无 sessionManager → 门禁忽略提权（无会话身份无从证明前置拒绝），不抛 TypeError（Review Focus #1）", async () => {
		const { deps } = makeDeps();
		registerParent("parent-4");
		getEscalationBroker().linkChild("child-4", "parent-4");
		// 窄 ctx：没有 sessionManager——门禁先于通道解析，按"无前置拒绝"忽略（不弹窗、不抛 TypeError）
		const narrowCtx = { hasUI: false, ui: { select: vi.fn(async () => "Allow once") } } as never;
		const result = await resolveCall(
			{ sandbox_permissions: "danger-full-access", justification: "j" },
			narrowCtx, deps, "command", () => "x",
		);
		expect(result).toEqual({ mode: "workspace-write", escalated: false, ignoredEscalation: true });
	});

	it("子会话 signal 已 abort → 不弹窗，按取消抛错（Review Focus #2）", async () => {
		const { deps } = makeDeps();
		const parentSelect = registerParent("parent-5");
		getEscalationBroker().linkChild("child-5", "parent-5");
		seedDenial("command", "child-5");
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
		seedDenial("command");
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
		seedDenial("command");
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
		seedDenial("command", "self");
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
		seedDenial("command", "unregistered");
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
		seedDenial("command", "child-e1");
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
		seedDenial("operation", "child-e2");
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
		seedDenial("operation", "child-e3");
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

describe("denial-first 硬门禁（未经真实拒绝不提权）", () => {
	it("无前置拒绝 → 忽略提权参数：不弹窗、按当前档位执行、ignoredEscalation:true", async () => {
		const { deps } = makeDeps();
		const ctx = toolCtx(true, "Allow once") as { ui: { select: ReturnType<typeof vi.fn> } };
		const result = await resolveCall(
			{ sandbox_permissions: "danger-full-access", justification: "preemptive" },
			ctx as never, deps, "command", () => "ls",
		);
		expect(result).toEqual({ mode: "workspace-write", escalated: false, ignoredEscalation: true });
		expect(ctx.ui.select).not.toHaveBeenCalled();
	});

	it("消费一次性：一次拒绝只放行一笔提权，第二笔又被忽略", async () => {
		const { deps } = makeDeps();
		seedDenial("command");
		expect(await resolveCall({ sandbox_permissions: "danger-full-access", justification: "j" }, toolCtx(true, "Allow once"), deps, "command", () => "x"))
			.toEqual({ mode: "danger-full-access", escalated: true, ignoredEscalation: false });
		expect(await resolveCall({ sandbox_permissions: "danger-full-access", justification: "j" }, toolCtx(true, "Allow once"), deps, "command", () => "x"))
			.toEqual({ mode: "workspace-write", escalated: false, ignoredEscalation: true });
	});

	it("kind 隔离：operation 拒绝不放行 command 提权（反之亦然）", async () => {
		const { deps } = makeDeps();
		seedDenial("operation");
		expect(await resolveCall({ sandbox_permissions: "danger-full-access", justification: "j" }, toolCtx(), deps, "command", () => "x"))
			.toEqual({ mode: "workspace-write", escalated: false, ignoredEscalation: true });
		// operation 的记录仍在：write/edit 提权可用
		expect(await resolveCall({ sandbox_permissions: "danger-full-access", justification: "j" }, toolCtx(true, "Allow once"), deps, "operation", () => "x"))
			.toEqual({ mode: "danger-full-access", escalated: true, ignoredEscalation: false });
	});

	it("同档请求不受门禁影响：/permission danger-full-access 下请求同档直接放行", async () => {
		const { deps } = makeDeps();
		deps.permission.override = "danger-full-access";
		const ctx = toolCtx(true, "Deny") as { ui: { select: ReturnType<typeof vi.fn> } };
		expect(await resolveCall({ sandbox_permissions: "danger-full-access", justification: "same" }, ctx as never, deps, "command", () => "x"))
			.toEqual({ mode: "danger-full-access", escalated: false, ignoredEscalation: false });
		expect(ctx.ui.select).not.toHaveBeenCalled();
	});

	it("非法请求不受门禁影响：更窄目标仍报 not strictly wider（不静默降级执行）", async () => {
		const { deps } = makeDeps();
		deps.permission.override = "danger-full-access";
		await expect(resolveCall(
			{ sandbox_permissions: "workspace-write", justification: "narrower" },
			toolCtx(), deps, "command", () => "x",
		)).rejects.toThrow(/not strictly wider/);
	});

	it("占位符归一化按字段可达性：JSON null 与 justification 的字符串形态是真实输入", async () => {
		const { deps } = makeDeps();
		const plain = { mode: "workspace-write" as const, escalated: false, ignoredEscalation: false };
		// JSON null：strict 提供商在声明 Type.Null() 后会原样送达 execute（不再被 pi 剥掉）→ 视作未提供。
		expect(await resolveCall({ sandbox_permissions: null, justification: null }, toolCtx(), deps, "command", () => "x"))
			.toEqual(plain);
		// justification 是 Type.String()：字符串 "null"/"" 能过 pi 的参数校验、真的会到达 execute → 必须是未提供，
		// 否则一笔普通调用会被判成 MALFORMED（"justification was sent without sandbox_permissions"）。
		expect(await resolveCall({ justification: "null" }, toolCtx(), deps, "command", () => "x")).toEqual(plain);
		expect(await resolveCall({ justification: "  NULL  " }, toolCtx(), deps, "command", () => "x")).toEqual(plain);
	});

	it("占位理由不是理由：真提权 + justification 占位符 → MALFORMED，且不弹审批", async () => {
		const { deps } = makeDeps();
		const ctx = toolCtx(true, "Allow once") as { ui: { select: ReturnType<typeof vi.fn> } };
		await expect(resolveCall({ sandbox_permissions: "danger-full-access", justification: "null" }, ctx as never, deps, "command", () => "x"))
			.rejects.toThrow(/nothing ran.*sent without justification/s);
		// 无归一化时这笔请求会带着 Reason: null 进审批弹窗——弹窗本身就是故障信号。
		expect(ctx.ui.select).not.toHaveBeenCalled();
	});

	it("write 工具：围栏内 + 无前置拒绝 → 照常写入，结果追加 ignored 标记且不弹窗", async () => {
		const { deps } = makeDeps();
		const { write } = createSandboxTools(deps);
		const ctx = toolCtx(true, "Allow once") as { ui: { select: ReturnType<typeof vi.fn> } };
		const target = join(ws, "ignored-write.txt");
		const result = (await write.execute("c-ignored", {
			path: target, content: "ok",
			sandbox_permissions: "danger-full-access", justification: "preemptive",
		}, undefined, undefined, ctx as never)) as { content: { text: string }[] };
		const { readFile } = await import("node:fs/promises");
		expect(await readFile(target, "utf-8")).toBe("ok");
		expect(result.content.map((c) => c.text).join("\n")).toContain("escalation fields were ignored");
		expect(ctx.ui.select).not.toHaveBeenCalled();
	});

	it("忽略后真实被拒 → 记账，下一次同类提权恢复标准审批（denial → retry 全链路）", async () => {
		const { deps } = makeDeps();
		const { write } = createSandboxTools(deps);
		const outside = join(outsideDir, `gate-${process.pid}-${Date.now()}.txt`);
		const ctx = toolCtx(true, "Allow once") as { ui: { select: ReturnType<typeof vi.fn> } };
		// 1) 无前置拒绝 + 提权参数 → 忽略，按 workspace-write 执行 → fence 拒绝（同时记账）
		await expect(write.execute("g-1", {
			path: outside, content: "x",
			sandbox_permissions: "danger-full-access", justification: "preemptive",
		}, undefined, undefined, ctx as never)).rejects.toThrow(/file access denied under workspace-write mode/);
		expect(ctx.ui.select).not.toHaveBeenCalled();
		// 2) 原样重试：这次有拒绝记录 → 弹窗 → 真实落盘
		await write.execute("g-2", {
			path: outside, content: "ok",
			sandbox_permissions: "danger-full-access", justification: "retry after denial",
		}, undefined, undefined, ctx as never);
		expect(ctx.ui.select).toHaveBeenCalledTimes(1);
		const { readFile } = await import("node:fs/promises");
		expect(await readFile(outside, "utf-8")).toBe("ok");
	});
});
