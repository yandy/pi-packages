import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBashToolDefinition, createEditToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { createSandboxTools, ESCALATION_PROPS, resolveCall, resolveCallMode } from "../src/tools";
import { canonicalizeTarget, isWithinRoots } from "../src/fence";
import { writableRoots } from "../src/policy";
import { createPermissionState, processPermissionState } from "../src/permission";
import { DEFAULT_SANDBOX_CONFIG } from "../src/config";
import { PLACEHOLDER_KEYS } from "../src/escalation";
import { getEscalationBroker, resetEscalationBrokerForTests } from "../src/escalation-broker";
import { NON_TUI_APPROVAL_DEADLINE_MS } from "../src/approval-dialog";
import { getDenialLedger, resetDenialLedgerForTests } from "../src/denial-ledger";

// T14 修订（Fix 2）：把受限 pwsh ops 工厂替换成一个可识别的哨兵，使“builder 收到的 operations 是否
// 来自沙箱工厂”成为可断言的身份问题。若实现误接了宿主的本地（未受限）ops 或任何别的对象，断言必红。
const { powershellOpsSentinel, createSandboxPowerShellOpsMock } = vi.hoisted(() => {
	const sentinel = { exec: vi.fn(async () => ({ exitCode: 0 })) };
	return { powershellOpsSentinel: sentinel, createSandboxPowerShellOpsMock: vi.fn(() => sentinel) };
});
vi.mock("../src/powershell-ops", () => ({ createSandboxPowerShellOps: createSandboxPowerShellOpsMock }));

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
			// 平台注入：默认钉 linux，使 bash 受限逻辑用例在 Windows 宿主上也真正执行（win32 上
			// createSandboxBashOps 会在 spawn 前拒绝 bash；win32 覆盖见 tests/win32/* 与下面的
			// "windows tool wiring"，它们通过 overrides 显式传 platform: "win32"）。
			platform: "linux" as const,
			hooks: { discoverGpuDevices: () => [] },
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
		// 宿主 bash 工具（pi 1.5.x 的 dist/core/tools/bash.js resolveSpawnContext）会读
		// sessionManager.getSessionFile()：缺失时 execute 内抛 TypeError，spawnFn 永远不被调用。
		// 桩形状 = { getSessionId(): string; getSessionFile(): string }，后续走真实宿主 bash
		// 链路的用例复用同一个桩。
		sessionManager: {
			getSessionId: () => TEST_SESSION,
			getSessionFile: () => join(dir, "session.jsonl"),
		},
		ui: { select: vi.fn(async () => choice), input: vi.fn(async () => undefined), notify: vi.fn() },
	} as never;
}

/** 需要定制共享 toolCtx 的 mock 时使用的完整结构视图；不另造审批 ctx 桩。 */
type ToolCtxTestDouble = {
	hasUI: boolean;
	/** 弹窗宿主模式：缺省 undefined → 审批按非 TUI 处理（有 deadline）。 */
	mode?: string;
	sessionManager: { getSessionId(): string; getSessionFile(): string };
	ui: {
		select: ReturnType<typeof vi.fn>;
		input: ReturnType<typeof vi.fn>;
		notify: ReturnType<typeof vi.fn>;
	};
};

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
afterEach(() => {
	vi.useRealTimers();
	resetEscalationBrokerForTests();
	resetDenialLedgerForTests();
	rmSync(dir, { recursive: true, force: true });
});

describe("createSandboxTools schemas", () => {
	it("提权参数显式声明 null：strict 模式下模型拿到的是 schema 认可的“不提权”取值（而非猜字符串）", () => {
		const { deps } = makeDeps();
		const { bash, write, edit } = createSandboxTools(deps);
		// 1.5.x 默认启用 strict 转换：strict 提供商（如 deepseek-flash，compat.supportsStrictMode=true）下 pi 会把
		// 所有 property 塞进 required，并对“不允许 null”的字段补 anyOf[X,{type:"null"}]。声明 null 后：
		// ① 模型有显式的合法取值（JSON null）来表达“不提权”，不必与 “never null” 的文案打架去写字符串 "null"；
		// ② pi 的 strict 转换不再补一层包裹；
		// ③ declared schema 允许 null，所以 optional 的 JSON null 会保留并原样送达 execute（归一化分支保持可达）。
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
		// extendParams 不得丢 base 属性：bash 的 command 仍在 schema 中
		//（并入自已删除的 "bash keeps command/timeout and gains the escalation pair"）。
		expect((bash.parameters as { properties: Record<string, unknown> }).properties.command).toBeDefined();
		// 声明仍是 optional：非 strict 提供商下 required 不含这两个字段，模型可以完全不传。
		const required = (bash.parameters as { required?: string[] }).required ?? [];
		expect(required).not.toContain("sandbox_permissions");
		expect(required).not.toContain("justification");
	});
	it("description teaches the escalation contract within the per-tool budget (β′)", () => {
		const { deps } = makeDeps();
		const { bash, write, edit } = createSandboxTools(deps);
		// 跨工具规则只留一句：不提权时省略或传 JSON null，且非拒绝重试的提权会被忽略。
		// （2026-10-02 二次修订：负向子句 `— never the string "null"` 移除，只留正向表述。）
		for (const tool of [bash, write, edit]) {
			expect(tool.description).toContain("omit (or JSON null) unless retrying a denial");
			// tmp 根：win32 只有 os.tmpdir()，没有 /tmp（fence.ts 的 defaultTmpRoots）。
			expect(tool.description).toContain("the OS temp dir");
			expect(tool.description).not.toContain("/tmp");
			// 旧版把这套协议写进每个 description（×3 重复）：不许回潮。
			expect(tool.description).not.toContain("Writes outside the permitted roots are denied");
			expect(tool.description).not.toContain("Pass justification:");
		}
		// /tmp 已 bind 宿主（2026-10-01 决策）→ 常驻面不再需要任何 /tmp 专属措辞。
		for (const tool of [bash, write, edit]) expect(tool.description).not.toContain("tmpfs");
		// 预算回归闸（β′）：三个工具的常驻增量合计 ≤ 560 chars（当前 468，改前 1281 / 首稿 546）。
		const added = [bash, write, edit].flatMap((t) =>
			t.description.split("\n").filter((l) => l.startsWith("Sandbox:")),
		);
		expect(added.join("").length).toBeLessThanOrEqual(560);
	});
	it("keeps base promptSnippet/promptGuidelines and schema options (Ruling 15)", () => {
		const { deps } = makeDeps();
		const { bash, write, edit } = createSandboxTools(deps);
		expect(bash.promptSnippet).toBe("Execute bash commands (ls, grep, find, etc.)");
		// 包内性质（不钉宿主文案）：本包只在 base 之后追加系统规则，故注册清单必须以 base 逐条逐序为前缀。
		// base 的文案随宿主版本漂移，这里一律与 base 定义对照，不写死宿主的字面量。
		for (const [tool, base] of [[bash, createBashToolDefinition(ws)], [write, createWriteToolDefinition(ws)]] as const) {
			const baseGuidelines = base.promptGuidelines ?? [];
			expect(baseGuidelines.length, "base 定义没有 guideline").toBeGreaterThan(0);
			expect(tool.promptGuidelines?.slice(0, baseGuidelines.length), "base guideline 被丢或被改写")
				.toEqual(baseGuidelines);
		}
		expect(write.promptGuidelines?.[write.promptGuidelines.length - 1]).toContain("sandbox_permissions");
		// Ruling 15 的包内性质（不钉宿主的 schema 事实，宿主版本会漂移）：spread 版 extendParams
		// 如实保留 base schema 的自有 options——包装后与 base 同值。
		const baseWrite = createWriteToolDefinition(ws);
		const baseEdit = createEditToolDefinition(ws);
		expect((write.parameters as { additionalProperties?: boolean }).additionalProperties)
			.toBe((baseWrite.parameters as { additionalProperties?: boolean }).additionalProperties);
		expect((edit.parameters as { additionalProperties?: boolean }).additionalProperties)
			.toBe((baseEdit.parameters as { additionalProperties?: boolean }).additionalProperties);
		// 上面两条在「base 本就没有这个 option」的宿主上恒真，故再钉一条关系约束：顶层 schema options
		// 键集合与 base 逐字一致。它只在两种情形下鉴别得出问题：① 手写 `{ type, properties }` 重建会丢
		// `required` 键；② base 自带 `additionalProperties` 一类自有 option 的宿主版本。对 TypeBox 式
		// 重建（`Type.Object({ ...base.properties })`）它无鉴别力——当前宿主上重建出的顶层键、`required`、
		// `additionalProperties` 三项与 base 全同。
		for (const [tool, base] of [[write, baseWrite], [edit, baseEdit]] as const) {
			expect(Object.keys(tool.parameters as object).sort()).toEqual(Object.keys(base.parameters as object).sort());
		}
	});
	it("常驻规则禁止把全局缓存/数据目录搬进 workspace 作为沙箱绕行，且排在提权协议之前（β′）", () => {
		const { deps } = makeDeps();
		const { bash, write, edit } = createSandboxTools(deps);
		for (const tool of [bash, write, edit]) {
			const guidelines = tool.promptGuidelines ?? [];
			const envAt = guidelines.findIndex((g) => g.includes("relocating global cache/data directories into the workspace"));
			const escalationAt = guidelines.findIndex((g) => g.includes("retry the exact same call once with sandbox_permissions"));
			expect(envAt).toBeGreaterThanOrEqual(0);
			// 注入点在提权协议之前：protocol 行保持最后一条（`sandbox_permissions` 是模型最需要的参数名）。
			expect(escalationAt).toBeGreaterThan(envAt);
			const rule = guidelines[envAt];
			// A-only（无检测/拒绝兜底）：三类绕行路线必须在措辞里点名，否则规则管不住 flag 与配置文件路线。
			expect(rule).toContain("XDG_CACHE_HOME");
			expect(rule).toContain("npm_config_cache");
			expect(rule).toContain("--cache-dir");
			expect(rule).toContain("config files");
			// 被拒后"改 env 再重试"是主要失败模式：提权重试同样不得夹带 relocation。
			expect(rule).toContain("including on the escalated retry");
			// 用户显式要求的 relocation 不应被规则逼成抗命。
			expect(rule).toContain("unless the user explicitly asked");
			// 预算回归闸：跨工具去重后 system rules 只多这一条，长度与既有 ESCALATION_GUIDELINE 同量级。
			expect(rule.length).toBeLessThanOrEqual(700);
		}
	});
});

describe("prepareArguments（pi 校验前的占位符剥离；edit 必须串联 base 钩子）", () => {
	it("键名单一来源：ESCALATION_PROPS 的键 == escalation.ts 的 PLACEHOLDER_KEYS（重命名时不得静默漂移）", () => {
		expect(Object.keys(ESCALATION_PROPS)).toEqual([...PLACEHOLDER_KEYS]);
	});

	it('bash：字符串 "null" 被剥掉，command/timeout 原样保留', () => {
		const { deps } = makeDeps();
		const { bash } = createSandboxTools(deps);
		expect(bash.prepareArguments?.({ command: "ls", timeout: null, sandbox_permissions: "null", justification: "null" }))
			.toEqual({ command: "ls", timeout: null });
	});

	it('bash：带空白的 sandbox_permissions " null " 也被剥掉', () => {
		const { deps } = makeDeps();
		const { bash } = createSandboxTools(deps);
		expect(bash.prepareArguments?.({ command: "ls", sandbox_permissions: " null " })).toEqual({ command: "ls" });
	});

	it("write：占位符剥掉，path/content 原样保留", () => {
		const { deps } = makeDeps();
		const { write } = createSandboxTools(deps);
		expect(write.prepareArguments?.({ path: "/ws/a.txt", content: "hi", sandbox_permissions: "NULL", justification: "   " }))
			.toEqual({ path: "/ws/a.txt", content: "hi" });
	});

	it("edit：串联 base 的 prepareEditArguments —— legacy oldText/newText 仍规整成 edits，占位符同时剥掉", () => {
		const { deps } = makeDeps();
		const { edit } = createSandboxTools(deps);
		expect(edit.prepareArguments?.({ path: "a.txt", oldText: "a", newText: "b", sandbox_permissions: "null", justification: "null" }))
			.toEqual({ path: "a.txt", edits: [{ oldText: "a", newText: "b" }] });
	});

	it("edit：新式 edits 数组与真提权参数穿过钩子不变", () => {
		const { deps } = makeDeps();
		const { edit } = createSandboxTools(deps);
		const args = {
			path: "a.txt",
			edits: [{ oldText: "a", newText: "b" }],
			sandbox_permissions: "danger-full-access",
			justification: "need /etc write",
		};
		expect(edit.prepareArguments?.(args)).toEqual(args);
	});

	it("剥后的参数走 resolveCall：普通调用、不弹窗、不报 malformed（噪声源头被掐断）", async () => {
		const { deps } = makeDeps();
		const { bash } = createSandboxTools(deps);
		const ctx = toolCtx(true, "Allow once") as { ui: { select: ReturnType<typeof vi.fn> } };
		const prepared = bash.prepareArguments?.({ command: "ls", sandbox_permissions: "null", justification: "null" }) as never;
		expect(await resolveCall(prepared, ctx as never, deps, "command", () => "ls"))
			.toEqual({ mode: "workspace-write", escalated: false, ignoredEscalation: false });
		expect(ctx.ui.select).not.toHaveBeenCalled();
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

	it("passes discovered GPU devices through to the actual bwrap spawn argv", async () => {
		const { deps, child, spawnFn } = makeDeps({ hooks: { discoverGpuDevices: () => ["/dev/nvidia0"] } });
		const { bash } = createSandboxTools(deps);
		const p = bash.execute("call-gpu", { command: "true" }, undefined, undefined, toolCtx());
		await vi.waitFor(() => { expect(spawnFn).toHaveBeenCalled(); });
		child.emit("close", 0, undefined);
		await p;

		const [program, args] = spawnFn.mock.calls[0] as [string, string[]];
		const devIndex = args.indexOf("--dev");
		expect(program).toBe("bwrap");
		expect(args.slice(devIndex, devIndex + 6)).toEqual([
			"--dev", "/dev", "--dev-bind-try", "/dev/nvidia0", "/dev/nvidia0", "--unshare-pid",
		]);
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
		// mode 为父会话的实际宿主模式（issue #253：deadline 判定按弹窗所在会话，不看子会话）
		getEscalationBroker().registerParent({ sessionId, hasUI: () => true, mode: () => "rpc", select });
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
		expect(parentSelect.mock.calls[0][1]).toEqual(["Deny", "Allow once"]);
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

	it("direct 路径透传 signal：宿主拿到派生 signal（不是调用方对象）与 timeout（D6 + #253）", async () => {
		const { deps } = makeDeps();
		const ctx = toolCtx(true, "Allow once") as ToolCtxTestDouble;
		const ac = new AbortController();
		seedDenial("command");
		await resolveCallMode(
			{ sandbox_permissions: "danger-full-access", justification: "j" },
			ctx as never,
			deps, "command", () => "x", ac.signal,
		);
		const opts = ctx.ui.select.mock.calls[0][2] as { signal: AbortSignal; timeout?: number };
		expect(opts.signal).toBeInstanceOf(AbortSignal);
		expect(opts.signal).not.toBe(ac.signal);
		expect(opts.timeout).toBe(NON_TUI_APPROVAL_DEADLINE_MS);
	});

	it("direct 路径无 signal：仍向宿主传派生 signal 与 timeout（本地 deadline 不依赖调用方给 signal）", async () => {
		const { deps } = makeDeps();
		const ctx = toolCtx(true, "Allow once") as ToolCtxTestDouble;
		seedDenial("command");
		await resolveCallMode(
			{ sandbox_permissions: "danger-full-access", justification: "j" },
			ctx as never,
			deps, "command", () => "x",
		);
		const opts = ctx.ui.select.mock.calls[0][2] as { signal: AbortSignal; timeout?: number };
		expect(opts).toBeDefined();
		expect(opts.signal).toBeInstanceOf(AbortSignal);
		expect(opts.timeout).toBe(NON_TUI_APPROVAL_DEADLINE_MS);
	});

	it("direct 路径 ctx.ui.select 抛错 → 按取消处理，命令不执行，不冒泡宿主内部报错（与 broker.request 口径一致）", async () => {
		const { deps, spawnFn } = makeDeps();
		const { bash } = createSandboxTools(deps);
		const ctx = toolCtx(true) as ToolCtxTestDouble;
		ctx.ui.select.mockRejectedValue(new Error("host UI internals exploded"));
		seedDenial("command");
		// 宿主 select 的内部报错绝不能变成用户/模型看到的工具错误文本：应落进 approveEscalation
		// 既有的"取消"分支，且文案里不得出现宿主原文。经真工具 execute 触发（而非只走到 resolveCallMode），
		// 以独立覆盖 fail-closed 的另一半事实：审批异常即取消 → 命令根本没被执行（resolveCall 在装配 ops
		// 与 spawn 之前）。生产顺序一变，本用例的 spawnFn 负向断言就会红。
		const settled = await bash.execute("call-select-throws", {
			command: "echo must-not-run",
			sandbox_permissions: "danger-full-access", justification: "j",
		}, undefined, undefined, ctx as never).then(() => null, (error: Error) => error);
		expect(settled).toBeInstanceOf(Error);
		expect(settled?.message).toMatch(/cancelled/);
		expect(settled?.message).not.toContain("host UI internals exploded");
		expect(ctx.ui.input).not.toHaveBeenCalled();
		expect(spawnFn).not.toHaveBeenCalled();
	});

	it("hasUI 时直连 ctx.ui.select，即使本会话已注册通道也不经 broker.request", async () => {
		const { deps } = makeDeps();
		const broker = getEscalationBroker();
		const ownSelect = vi.fn(async () => "Allow once");
		broker.registerParent({ sessionId: TEST_SESSION, hasUI: () => true, mode: () => "rpc", select: ownSelect });
		const request = vi.spyOn(broker, "request");
		const ctx = toolCtx(true, "Allow once") as ToolCtxTestDouble;
		seedDenial("command");
		try {
			const mode = await resolveCallMode(
				{ sandbox_permissions: "danger-full-access", justification: "j" },
				ctx, deps, "command", () => "x",
			);
			expect(mode).toBe("danger-full-access");
			expect(ctx.ui.select).toHaveBeenCalledTimes(1);
			expect(ownSelect).not.toHaveBeenCalled();
			expect(request).not.toHaveBeenCalled();
		} finally {
			request.mockRestore();
		}
	});

	it("父会话自己的审批与子会话转发的审批并发时两者都结算", async () => {
		const { deps } = makeDeps();
		const parentCtx = toolCtx(true) as ToolCtxTestDouble;
		let releaseDirect: ((value: string | undefined) => void) | undefined;
		parentCtx.ui.select.mockImplementation(() => new Promise<string | undefined>((resolve) => {
			releaseDirect = resolve;
		}));
		let releaseForwarded: ((value: string | undefined) => void) | undefined;
		const forwardedSelect = vi.fn((_title: string) => new Promise<string | undefined>((resolve) => {
			releaseForwarded = resolve;
		}));
		const broker = getEscalationBroker();
		broker.registerParent({ sessionId: TEST_SESSION, hasUI: () => true, mode: () => "rpc", select: forwardedSelect });
		broker.linkChild("child-concurrent", TEST_SESSION);
		seedDenial("command");
		seedDenial("command", "child-concurrent");
		const direct = resolveCallMode(
			{ sandbox_permissions: "danger-full-access", justification: "parent" },
			parentCtx, deps, "command", () => "parent-command",
		);
		const forwarded = resolveCallMode(
			{ sandbox_permissions: "danger-full-access", justification: "child" },
			subagentCtx("child-concurrent"), deps, "command", () => "child-command",
		);
		// 直连与转发两个 UI 都必须先进入在飞状态，不要求谁的弹窗先出现。
		await vi.waitFor(() => {
			expect(parentCtx.ui.select).toHaveBeenCalledTimes(1);
			expect(forwardedSelect).toHaveBeenCalledTimes(1);
		});
		if (releaseDirect === undefined || releaseForwarded === undefined) throw new Error("both approvals must be pending");
		releaseDirect("Allow once");
		releaseForwarded("Allow once");
		await expect(direct).resolves.toBe("danger-full-access");
		await expect(forwarded).resolves.toBe("danger-full-access");
	});

	it("hasUI 且本会话未注册通道 → 仍直连 ctx.ui.select", async () => {
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
		// JSON null：schema 显式声明 Type.Null()，declared-schema 校验会保留并原样送达 execute → 视作未提供。
		expect(await resolveCall({ sandbox_permissions: null, justification: null }, toolCtx(), deps, "command", () => "x"))
			.toEqual(plain);
		// justification 的字符串臂是 Type.String()（字段本身为 string | null）：字符串 "null"/"" 在未走钩子的
		// resolveCall 直调路径下会到达 execute → 必须是未提供，否则一笔普通调用会被判成 MALFORMED
		// （"justification was sent without sandbox_permissions"）。真实工具链上 prepareArguments 已先剥掉（见 prepareArguments 判例）。
		expect(await resolveCall({ justification: "null" }, toolCtx(), deps, "command", () => "x")).toEqual(plain);
		expect(await resolveCall({ justification: "  NULL  " }, toolCtx(), deps, "command", () => "x")).toEqual(plain);
	});

	it("占位理由不是理由：真提权 + justification 占位符 → MALFORMED，且不弹审批", async () => {
		const { deps } = makeDeps();
		// 播种前置拒绝，让“不弹审批”的断言真正承重：无归一化时这笔请求会通过配对校验、命中门禁、
		// 带着 Reason: null 进审批弹窗（弹窗本身就是故障信号）。
		seedDenial("command");
		const ctx = toolCtx(true, "Allow once") as { ui: { select: ReturnType<typeof vi.fn> } };
		await expect(resolveCall({ sandbox_permissions: "danger-full-access", justification: "null" }, ctx as never, deps, "command", () => "x"))
			.rejects.toThrow(/nothing ran.*sent without justification/s);
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
		// 围栏自检（真机首跑曾见 win32 宿主误放行）：outside 必须真在围栏外。runner 的 TMP 是 8.3
		// 短名（RUNNER~1）而 realpath 是长名，若判定链路把两种形态混入就会漂移——失败时消息
		// 携带全部判定输入（canonical 目标、生效 roots、tmpdir、平台），把放行归因钉死到一层。
		const canonical = canonicalizeTarget(outside);
		const roots = writableRoots("workspace-write", deps.cwd, deps._tmpRoots);
		const verdict = isWithinRoots(canonical, roots, process.platform !== "win32");
		// 失败时的身份证据：roots 与 target 祖先链的 dev:ino —— 若出现相同身份即身份回退命中，
		// 若身份各异则判定来自词法分支。工具调用前先暴露，避免事后无法重现。
		const statId = (p: string): string => {
			try {
				const s = statSync(p);
				return `${s.dev}:${s.ino}`;
			} catch {
				return "ENOENT";
			}
		};
		const ancestorIds: string[] = [];
		for (let a = canonical; ; ) {
			ancestorIds.push(`${a} [${statId(a)}]`);
			const parent = dirname(a);
			if (parent === a) break;
			a = parent;
		}
		expect(
			verdict,
			`fence self-check: target=${canonical} verdict=${verdict} roots=${JSON.stringify(roots.map((r) => `${r} [${statId(r)}]`))} ancestors=${JSON.stringify(ancestorIds)} _tmpRoots=${JSON.stringify(deps._tmpRoots)} tmpdir=${tmpdir()} platform=${process.platform}`,
		).toBe(false);
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

describe("windows tool wiring", () => {
	/** 测试用 pwsh 工具工厂：记录调用（base 元数据一次 + execute 时带 ops 一次），execute 直接回显。 */
	function fakePowerShellBuilder(calls: { cwd: string; opts?: unknown }[] = []) {
		return vi.fn((cwd: string, opts?: unknown) => {
			calls.push({ cwd, opts });
			return {
				name: "powershell",
				label: "PowerShell",
				description: "Run PowerShell commands",
				parameters: { type: "object", properties: { command: { type: "string" } } },
				async execute(_id: string, params: { command?: string }) {
					return { content: [{ type: "text" as const, text: `ran ${String(params.command ?? "")}` }] };
				},
			};
		});
	}

	it("builds the tool set on win32 and exposes a powershell tool", () => {
		const tools = createSandboxTools({ cwd: process.cwd(), permission: processPermissionState, platform: "win32" });
		for (const name of ["bash", "write", "edit"] as const) expect(tools[name]).toBeDefined();
		expect(tools.powershell?.label).toBe("powershell (sandboxed)");
	});

	it("registers bash with exposure:hidden on win32 and leaves the key unset elsewhere", () => {
		// win32 工具接线（D3）：内建默认激活列表按**名字**激活 ["read","bash","edit","write"]，扩展同名工具
		// 覆盖内建定义；`defaultActive: false` 仍允许命名激活，挡不住默认列表。因此改用 `exposure: "hidden"`：
		// _applyToolLoadout 丢弃 hidden、命名激活也不生效（registered but unreachable）。
		// 但绝不能跳过注册（那会露出 pi 内置的未受限 bash，显式启用即 fail-open），所以是“注册 + hidden”。
		const win32 = createSandboxTools({ cwd: process.cwd(), permission: processPermissionState, platform: "win32" });
		expect((win32.bash as { exposure?: string }).exposure).toBe("hidden");
		// 非 win32 不设该键（既有行为不变：bash 必须默认激活）——按自有属性判定，避免真值判断漏掉 undefined。
		const linux = createSandboxTools({ cwd: process.cwd(), permission: processPermissionState, platform: "linux" });
		expect(Object.prototype.hasOwnProperty.call(linux.bash, "exposure")).toBe(false);
		expect((linux.bash as { exposure?: string }).exposure).toBeUndefined();
	});

	it("does not register a powershell tool on POSIX platforms (builder present or not)", () => {
		const build = vi.fn();
		const tools = createSandboxTools({
			cwd: process.cwd(),
			permission: processPermissionState,
			platform: "linux",
			_hostCreatePowerShellToolDefinition: build,
		});
		expect(tools.powershell).toBeUndefined();
		// 平台门控先于 builder 构造：非 win32 上连注入的 spy 都不该被调用。
		expect(build).not.toHaveBeenCalled();
	});

	it("passes the win32 platform through to the bash ops builder", async () => {
		// bash 的拒绝行为本身由 Task 12 的 shell-ops 用例钉住；这里只断言 tools 层不吞掉该注入点。
		// ops 是逐调用构造的（mode 来自当次 resolveCall），故需真跑一次 execute 才能观察到 platform 透传。
		const build = vi.fn(() => ({ exec: vi.fn(async () => ({ exitCode: 0 })) }));
		const { deps } = makeDeps({ platform: "win32", _buildBashOps: build as never });
		const { bash } = createSandboxTools(deps);
		await bash.execute("call-win32", { command: "echo hi" }, undefined, undefined, toolCtx());
		expect(build).toHaveBeenCalledWith(expect.objectContaining({ platform: "win32" }));
	});

	it("win32 + host builder: powershell carries the same escalation surface and builds ops per call", async () => {
		// 注入 builder spy，观察 base 元数据装配与 execute 时的受限 ops 构造。
		const calls: { cwd: string; opts?: unknown }[] = [];
		const builder = fakePowerShellBuilder(calls);
		const { deps } = makeDeps({ platform: "win32", _hostCreatePowerShellToolDefinition: builder });
		const { powershell } = createSandboxTools(deps);
		expect(powershell?.name).toBe("powershell");
		// 与 bash 同一套提权面（extendParams）与同一套 prepareArguments 串联（占位符剥离）。
		const props = (powershell?.parameters as { properties: Record<string, unknown> }).properties;
		expect(props.sandbox_permissions).toBeDefined();
		expect(props.justification).toBeDefined();
		expect(powershell?.prepareArguments?.({ command: "Get-ChildItem", sandbox_permissions: "null", justification: "null" }))
			.toEqual({ command: "Get-ChildItem" });
		// 创建期取一次 base 元数据；execute 时按当次 mode 再构造一次带受限 ops 的定义（与 bash 同构）。
		expect(calls.length).toBe(1);
		const result = await powershell!.execute("pwsh-1", { command: "Get-ChildItem" }, undefined, undefined, toolCtx());
		expect(calls.length).toBe(2);
		expect(calls[0].opts).toBeUndefined();
		// 身份钉住（T14 修订）：build 时传到 builder 的必须是受限工厂的产物**本人**，而非宿主的本地（未受限）ops
		// 或任何拷贝/包装（后者同样“是个 operations”，却会让 pwsh 在沙箱外执行，fail-open）。
		// 必须用 toBe（引用相等）：toEqual/objectContaining 是结构比较，浅拷贝也能蒙混通过。
		const executeOpts = calls[1].opts as { operations?: unknown } | undefined;
		expect(executeOpts?.operations).toBe(powershellOpsSentinel);
		expect(createSandboxPowerShellOpsMock).toHaveBeenCalledWith(expect.objectContaining({
			platform: "win32",
			onDenial: expect.any(Function),
		}));
		expect((result.content[0] as { text: string }).text).toBe("ran Get-ChildItem");
	});

	it("powershell 与 bash/write/edit 共用同一条缓存重定向禁令（同常量、同去重）", () => {
		const { deps } = makeDeps({ platform: "win32", _hostCreatePowerShellToolDefinition: fakePowerShellBuilder() });
		const { powershell } = createSandboxTools(deps);
		const guidelines = powershell?.promptGuidelines ?? [];
		expect(guidelines.some((g) => g.includes("relocating global cache/data directories into the workspace"))).toBe(true);
	});

	it("a throwing host pwsh builder degrades to no powershell tool without breaking bash/write/edit", () => {
		// I2 fail-open 回归闸：经注入缝传入抛错的 builder；构造期抛错若冒泡出 createSandboxTools，pi 会把整个扩展置 null，
		// bash/write/edit 随即无沙箱裸跑。必须降级为“无 pwsh 覆盖”，三个基础工具照常注册。
		const builder = vi.fn(() => {
			throw new Error("host builder exploded");
		});
		const { deps } = makeDeps({ platform: "win32", _hostCreatePowerShellToolDefinition: builder });
		const tools = createSandboxTools(deps);
		expect(builder).toHaveBeenCalledTimes(1);
		for (const name of ["bash", "write", "edit"] as const) expect(tools[name]).toBeDefined();
		expect(tools.powershell).toBeUndefined();
	});

	it("powershell shares bash's command-kind denial gate and one-shot marker", async () => {
		const { deps } = makeDeps({ platform: "win32", _hostCreatePowerShellToolDefinition: fakePowerShellBuilder() });
		const { powershell } = createSandboxTools(deps);
		const ctx = toolCtx(true, "Allow once") as { ui: { select: ReturnType<typeof vi.fn> } };
		// 无前置拒绝：command 类门禁忽略提权（与 bash 同账本），不弹窗、结果带忽略标记。
		const ignored = await powershell!.execute("pwsh-g1", {
			command: "Set-Content C:\\outside.txt x",
			sandbox_permissions: "danger-full-access",
			justification: "preemptive",
		}, undefined, undefined, ctx as never) as { content: { text: string }[] };
		expect(ctx.ui.select).not.toHaveBeenCalled();
		expect(ignored.content.map((c) => c.text).join("\n")).toContain("escalation fields were ignored");
		// 播种 command 类前置拒绝后原样重试：进入审批且 subject 是 command（同 bash 文案），批准后带一次性标记。
		seedDenial("command");
		const escalated = await powershell!.execute("pwsh-g2", {
			command: "Set-Content C:\\outside.txt x",
			sandbox_permissions: "danger-full-access",
			justification: "retry after denial",
		}, undefined, undefined, ctx as never) as { content: { text: string }[] };
		expect(ctx.ui.select).toHaveBeenCalledTimes(1);
		expect(ctx.ui.select.mock.calls[0][0]).toContain("this command");
		expect(escalated.content.map((c) => c.text).join("\n")).toContain('one-shot escalation to "danger-full-access"');
	});

	it("powershell carries the injected extra roots into the sandbox ops factory", async () => {
		const extra = realpathSync.native(mkdtempSync(join(tmpdir(), "tools-extra-")));
		try {
			const { deps } = makeDeps({
				platform: "win32",
				_hostCreatePowerShellToolDefinition: fakePowerShellBuilder(),
				_extraRoots: [extra],
			});
			const { powershell } = createSandboxTools(deps);
			await powershell!.execute("pwsh-extra", { command: "Get-ChildItem" }, undefined, undefined, toolCtx());
			// 与 bash 同一条接线：配置/注入的额外根必须原样到达受限 ops 工厂的 options
			//（platform 注入与既有用例同口径），否则 pwsh 在额外根上是 fail-closed 的哑拒。
			expect(createSandboxPowerShellOpsMock).toHaveBeenLastCalledWith(expect.objectContaining({
				platform: "win32",
				extraRoots: [extra],
			}));
		} finally { rmSync(extra, { recursive: true, force: true }); }
	});
});

describe("extraWritableDirs 接线", () => {
	it("write 工具：配置的额外根可写", async () => {
		const extra = realpathSync.native(mkdtempSync(join(tmpdir(), "tools-extra-")));
		try {
			const { deps } = makeDeps({ getConfig: () => ({ ...DEFAULT_SANDBOX_CONFIG, extraWritableDirs: [extra] }) });
			const { write } = createSandboxTools(deps);
			const target = join(extra, "ok.txt");
			await write.execute("w-extra", { path: target, content: "ok" }, undefined, undefined, toolCtx() as never);
			const { readFile } = await import("node:fs/promises");
			expect(await readFile(target, "utf-8")).toBe("ok");
		} finally { rmSync(extra, { recursive: true, force: true }); }
	});
	it("bash：额外根进入 bwrap argv（含 default tools 路径）", async () => {
		const extra = realpathSync.native(mkdtempSync(join(tmpdir(), "tools-extra-")));
		try {
			const { deps, child, spawnFn } = makeDeps({ _extraRoots: [extra] });
			const { bash } = createSandboxTools(deps);
			// 仿文件内既有 spawn 判例（"spawns the confined argv through injected spawnFn"）：等 spawn 后
			// 手动关流，让 execute 正常结束。
			const p = bash.execute("b-extra", { command: "true" }, undefined, undefined, toolCtx() as never);
			await vi.waitFor(() => { expect(spawnFn).toHaveBeenCalled(); });
			child.emit("close", 0, undefined);
			await p;
			expect(spawnFn).toHaveBeenCalledWith("bwrap", expect.arrayContaining(["--bind", extra, extra]), expect.objectContaining({ cwd: ws }));
		} finally { rmSync(extra, { recursive: true, force: true }); }
	});
	it("edit 工具：配置的额外根可写", async () => {
		const extra = realpathSync.native(mkdtempSync(join(tmpdir(), "tools-extra-")));
		try {
			const { deps } = makeDeps({ getConfig: () => ({ ...DEFAULT_SANDBOX_CONFIG, extraWritableDirs: [extra] }) });
			const { edit } = createSandboxTools(deps);
			const target = join(extra, "edit.txt");
			writeFileSync(target, "hello world");
			await edit.execute("e-extra", { path: target, edits: [{ oldText: "hello", newText: "goodbye" }] }, undefined, undefined, toolCtx() as never);
			const { readFile } = await import("node:fs/promises");
			expect(await readFile(target, "utf-8")).toBe("goodbye world");
		} finally { rmSync(extra, { recursive: true, force: true }); }
	});
});

describe("审批 deadline 与应答白名单（#253 验收）", () => {
	/** 子会话 ctx：hasUI=false，审批必须转发到父通道；mode 可选（用于证明实现不看子会话 mode）。 */
	function childCtx(sessionId: string, mode?: string) {
		return {
			hasUI: false,
			mode,
			sessionManager: { getSessionId: () => sessionId },
			ui: {
				select: vi.fn(async () => {
					throw new Error("child session must not prompt locally");
				}),
			},
		} as never;
	}

	/** 直连 ctx（本会话有 UI）：mode 决定 TUI/RPC 判定。 */
	function directCtx(mode: string | undefined): ToolCtxTestDouble {
		const ctx = toolCtx(true) as ToolCtxTestDouble;
		ctx.mode = mode;
		return ctx;
	}

	/** 记录 promise 的结算状态与值，便于在假时钟下断言「到期前仍 pending」。 */
	function track<T>(promise: Promise<T>) {
		const state: { done: boolean; value: T | undefined; error: Error | undefined } = {
			done: false,
			value: undefined,
			error: undefined,
		};
		const tracked = promise.then(
			(value) => {
				state.done = true;
				state.value = value;
				return value;
			},
			(error: Error) => {
				state.done = true;
				state.error = error;
				throw error;
			},
		);
		tracked.catch(() => {}); // 迟到的 rejection 不得变成 unhandled rejection
		return { state, tracked };
	}

	it("直连 RPC 永不应答：deadline 前 pending，到点抛既有 cancelled 文案，且不 spawn", async () => {
		vi.useFakeTimers();
		const { deps, spawnFn } = makeDeps();
		const { bash } = createSandboxTools(deps);
		const ctx = directCtx("rpc");
		ctx.ui.select.mockImplementation(() => new Promise<string | undefined>(() => {}));
		seedDenial("command");
		const { state } = track(bash.execute("deadline-bash", {
			command: "touch ./must-not-run",
			sandbox_permissions: "danger-full-access", justification: "probe",
		}, undefined, undefined, ctx as never));

		await vi.advanceTimersByTimeAsync(NON_TUI_APPROVAL_DEADLINE_MS - 1);
		expect(state.done).toBe(false);

		await vi.advanceTimersByTimeAsync(1);
		expect(state.done).toBe(true);
		expect(state.error?.message).toMatch(/cancelled — nothing was executed/);
		expect(spawnFn).not.toHaveBeenCalled();
		expect(existsSync(join(ws, "must-not-run"))).toBe(false);
	});

	it("直连 RPC 永不应答（write）：文件未落盘，也不新增 denial 记录", async () => {
		vi.useFakeTimers();
		const { deps } = makeDeps();
		const { write } = createSandboxTools(deps);
		const ctx = directCtx("rpc");
		ctx.ui.select.mockImplementation(() => new Promise<string | undefined>(() => {}));
		seedDenial("operation");
		const target = join(outsideDir, `deadline-write-${process.pid}-${Date.now()}.txt`);
		const { state } = track(write.execute("deadline-write", {
			path: target, content: "x",
			sandbox_permissions: "danger-full-access", justification: "probe",
		}, undefined, undefined, ctx as never));

		await vi.advanceTimersByTimeAsync(NON_TUI_APPROVAL_DEADLINE_MS);
		expect(state.done).toBe(true);
		expect(state.error?.message).toMatch(/cancelled/);
		expect(existsSync(target)).toBe(false);
		// 一次性语义：前置记录已被门禁消费，超时既不恢复也不新增
		expect(getDenialLedger().consume(TEST_SESSION, "operation")).toBe(false);
	});

	it("超时后不恢复前置拒绝：同一会话的下一次提权被门禁忽略", async () => {
		vi.useFakeTimers();
		const { deps } = makeDeps();
		const ctx = directCtx("rpc");
		ctx.ui.select.mockImplementation(() => new Promise<string | undefined>(() => {}));
		seedDenial("command");
		const first = track(resolveCall(
			{ sandbox_permissions: "danger-full-access", justification: "j" },
			ctx as never, deps, "command", () => "x",
		));
		await vi.advanceTimersByTimeAsync(NON_TUI_APPROVAL_DEADLINE_MS);
		expect(first.state.error?.message).toMatch(/cancelled/);
		// 记录没有重建：第二笔提权直接被 denial-first 门禁忽略（不弹窗、不执行）
		vi.useRealTimers();
		const second = await resolveCall(
			{ sandbox_permissions: "danger-full-access", justification: "j" },
			ctx as never, deps, "command", () => "x",
		);
		expect(second).toEqual({ mode: "workspace-write", escalated: false, ignoredEscalation: true });
		expect(ctx.ui.select).toHaveBeenCalledTimes(1);
	});

	// RPC 宿主原样透传客户端 value：这些都是真能到达授权判定的运行时值（表驱动覆盖 execute 层）。
	const invalidChoices: { label: string; value: unknown }[] = [
		{ label: '"Allow"', value: "Allow" },
		{ label: '"not-a-choice"', value: "not-a-choice" },
		{ label: "null", value: null },
		{ label: "对象", value: {} },
	];
	for (const { label, value } of invalidChoices) {
		it(`非法应答 ${label}：不批准、不执行、不新增 denial 记录`, async () => {
			const { deps, spawnFn } = makeDeps();
			const { bash } = createSandboxTools(deps);
			const ctx = directCtx("rpc");
			ctx.ui.select.mockResolvedValue(value);
			seedDenial("command");
			const settled = await bash.execute(`invalid-choice-${label}`, {
				command: "touch ./must-not-run",
				sandbox_permissions: "danger-full-access", justification: "probe",
			}, undefined, undefined, ctx as never).then(() => null, (error: Error) => error);
			expect(settled).toBeInstanceOf(Error);
			expect(settled?.message).toMatch(/not one of the offered options.*nothing was executed/s);
			expect(spawnFn).not.toHaveBeenCalled();
			expect(existsSync(join(ws, "must-not-run"))).toBe(false);
			expect(getDenialLedger().consume(TEST_SESSION, "command")).toBe(false);
		});
	}

	it("到期后迟到的 Allow once 不执行（execute 层，非仅 dialog 层）", async () => {
		vi.useFakeTimers();
		const { deps, spawnFn } = makeDeps();
		const { bash } = createSandboxTools(deps);
		const ctx = directCtx("rpc");
		let answer: ((value: string | undefined) => void) | undefined;
		ctx.ui.select.mockImplementation(() => new Promise<string | undefined>((resolve) => {
			answer = resolve;
		}));
		seedDenial("command");
		const { state } = track(bash.execute("late-allow", {
			command: "touch ./must-not-run",
			sandbox_permissions: "danger-full-access", justification: "probe",
		}, undefined, undefined, ctx as never));
		await vi.advanceTimersByTimeAsync(NON_TUI_APPROVAL_DEADLINE_MS);
		expect(state.error?.message).toMatch(/cancelled — nothing was executed/);

		vi.useRealTimers();
		if (answer === undefined) throw new Error("approval must still be pending for the late answer");
		answer("Allow once");
		await new Promise((resolve) => setTimeout(resolve, 10)); // 真实宏任务窗口：让迟到应答沿 promise 链走完
		expect(spawnFn).not.toHaveBeenCalled();
		expect(existsSync(join(ws, "must-not-run"))).toBe(false);
	});

	it("Deny 与在飞 abort 都不新增 denial 记录（cancelled ≠ Deny，也不恢复前置记录）", async () => {
		const { deps } = makeDeps();
		const denyCtx = directCtx("rpc");
		denyCtx.ui.select.mockResolvedValue("Deny");
		denyCtx.ui.input.mockResolvedValue("nope");
		seedDenial("command");
		await expect(resolveCall(
			{ sandbox_permissions: "danger-full-access", justification: "j" },
			denyCtx as never, deps, "command", () => "x",
		)).rejects.toThrow(/the user rejected/);
		expect(getDenialLedger().consume(TEST_SESSION, "command")).toBe(false);

		const abortCtx = directCtx("rpc");
		abortCtx.ui.select.mockImplementation(() => new Promise<string | undefined>(() => {}));
		seedDenial("command");
		const ac = new AbortController();
		const { state } = track(resolveCall(
			{ sandbox_permissions: "danger-full-access", justification: "j" },
			abortCtx as never, deps, "command", () => "x", ac.signal,
		));
		await vi.waitFor(() => expect(abortCtx.ui.select).toHaveBeenCalledTimes(1));
		ac.abort();
		await vi.waitFor(() => expect(state.done).toBe(true));
		expect(state.error?.message).toMatch(/cancelled/);
		expect(getDenialLedger().consume(TEST_SESSION, "command")).toBe(false);
	});

	it("ctx.ui 的抛错取值器不冒泡宿主报错：input 抛错 → Deny 无理由，select 抛错 → cancelled", async () => {
		const { deps, spawnFn } = makeDeps();
		const { bash } = createSandboxTools(deps);
		const denialCtx = {
			hasUI: true,
			mode: "rpc",
			sessionManager: { getSessionId: () => TEST_SESSION },
			ui: {
				select: async () => "Deny",
				get input(): (title: string, placeholder?: string) => Promise<string | undefined> {
					throw new Error("hostile input getter");
				},
			},
		} as never;
		seedDenial("command");
		const denied = await bash.execute("getter-input", {
			command: "touch ./must-not-run",
			sandbox_permissions: "danger-full-access", justification: "probe",
		}, undefined, undefined, denialCtx).then(() => null, (error: Error) => error);
		expect(denied?.message).toMatch(/the user rejected escalating this command/);
		expect(denied?.message).not.toContain("hostile input getter");

		const selectCtx = {
			hasUI: true,
			mode: "rpc",
			sessionManager: { getSessionId: () => TEST_SESSION },
			ui: {
				get select(): (title: string, options: string[]) => Promise<string | undefined> {
					throw new Error("hostile select getter");
				},
			},
		} as never;
		seedDenial("command");
		const cancelled = await bash.execute("getter-select", {
			command: "touch ./must-not-run",
			sandbox_permissions: "danger-full-access", justification: "probe",
		}, undefined, undefined, selectCtx).then(() => null, (error: Error) => error);
		expect(cancelled?.message).toMatch(/cancelled — nothing was executed/);
		expect(cancelled?.message).not.toContain("hostile select getter");
		expect(spawnFn).not.toHaveBeenCalled();
	});

	it("broker 父通道永不应答：按父会话 mode（rpc）武装 deadline，子会话 mode 不参与判定", async () => {
		vi.useFakeTimers();
		const { deps } = makeDeps();
		const select = vi.fn(() => new Promise<string | undefined>(() => {}));
		getEscalationBroker().registerParent({ sessionId: "parent-rpc", hasUI: () => true, mode: () => "rpc", select });
		getEscalationBroker().linkChild("child-tui", "parent-rpc");
		seedDenial("command", "child-tui");
		const { state } = track(resolveCallMode(
			{ sandbox_permissions: "danger-full-access", justification: "j" },
			// 子会话 mode 是 tui：实现若误用子会话 mode 就不会武装 deadline
			childCtx("child-tui", "tui"), deps, "command", () => "x",
		));
		expect(select).toHaveBeenCalledTimes(1);
		expect(select.mock.calls[0][2]).toMatchObject({ timeout: NON_TUI_APPROVAL_DEADLINE_MS });

		await vi.advanceTimersByTimeAsync(NON_TUI_APPROVAL_DEADLINE_MS - 1);
		expect(state.done).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(state.done).toBe(true);
		expect(state.error?.message).toMatch(/cancelled — nothing was executed/);
	});

	it("TUI 父通道不设默认上限：假时钟推进超过默认值仍 pending，人工回答后正常批准", async () => {
		vi.useFakeTimers();
		const { deps } = makeDeps();
		let release: ((value: string | undefined) => void) | undefined;
		const select = vi.fn((_title: string) => new Promise<string | undefined>((resolve) => {
			release = resolve;
		}));
		getEscalationBroker().registerParent({ sessionId: "parent-tui", hasUI: () => true, mode: () => "tui", select });
		getEscalationBroker().linkChild("child-rpc", "parent-tui");
		seedDenial("command", "child-rpc");
		const { state, tracked } = track(resolveCallMode(
			{ sandbox_permissions: "danger-full-access", justification: "j" },
			// 子会话 mode 是 rpc：父会话是 TUI 时不得武装 deadline
			childCtx("child-rpc", "rpc"), deps, "command", () => "x",
		));
		expect(select.mock.calls[0][2]).toMatchObject({ timeout: undefined });
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(NON_TUI_APPROVAL_DEADLINE_MS * 4);
		expect(state.done).toBe(false);

		vi.useRealTimers();
		if (release === undefined) throw new Error("TUI dialog must be pending");
		release("Allow once");
		await expect(tracked).resolves.toBe("danger-full-access");
	});

	it("Deny 理由步本地 deadline 到期 → 整次审批 cancelled（不退化成 Deny 无理由）", async () => {
		vi.useFakeTimers();
		const { deps, spawnFn } = makeDeps();
		const { bash } = createSandboxTools(deps);
		const ctx = directCtx("rpc");
		ctx.ui.select.mockResolvedValue("Deny");
		ctx.ui.input.mockImplementation(() => new Promise<string | undefined>(() => {}));
		seedDenial("command");
		const { state } = track(bash.execute("reason-deadline", {
			command: "touch ./must-not-run",
			sandbox_permissions: "danger-full-access", justification: "probe",
		}, undefined, undefined, ctx as never));

		await vi.advanceTimersByTimeAsync(NON_TUI_APPROVAL_DEADLINE_MS);
		expect(state.done).toBe(true);
		expect(state.error?.message).toMatch(/cancelled — nothing was executed/);
		expect(state.error?.message).not.toMatch(/the user rejected/);
		expect(spawnFn).not.toHaveBeenCalled();
	});

	it("宿主正常取消理由输入 → 仍是「用户拒绝、无理由」（本地 deadline 不误伤）", async () => {
		vi.useFakeTimers();
		const { deps } = makeDeps();
		const ctx = directCtx("rpc");
		ctx.ui.select.mockResolvedValue("Deny");
		ctx.ui.input.mockResolvedValue(undefined);
		seedDenial("command");
		const { state } = track(resolveCallMode(
			{ sandbox_permissions: "danger-full-access", justification: "j" },
			ctx as never, deps, "command", () => "x",
		));
		await vi.advanceTimersByTimeAsync(NON_TUI_APPROVAL_DEADLINE_MS * 2);
		expect(state.error?.message).toMatch(/the user rejected escalating this command to "danger-full-access"/);
		expect(state.error?.message).not.toMatch(/cancelled/);
	});

	it("在飞 abort（宿主忽略 signal、永不应答）：本地结算为 cancelled，宿主 signal 被中断", async () => {
		const { deps } = makeDeps();
		const ctx = directCtx("rpc");
		let hostSignal: AbortSignal | undefined;
		ctx.ui.select.mockImplementation((_title: string, _options: string[], opts?: { signal?: AbortSignal }) => {
			hostSignal = opts?.signal;
			return new Promise<string | undefined>(() => {});
		});
		seedDenial("command");
		const ac = new AbortController();
		const { state } = track(resolveCallMode(
			{ sandbox_permissions: "danger-full-access", justification: "j" },
			ctx as never, deps, "command", () => "x", ac.signal,
		));
		await vi.waitFor(() => expect(hostSignal).toBeDefined());
		ac.abort();
		await vi.waitFor(() => expect(state.done).toBe(true));
		expect(state.error?.message).toMatch(/cancelled — nothing was executed/);
		expect(hostSignal?.aborted).toBe(true);
	});

	it("TUI 直连不设默认上限：无本地 timer", async () => {
		vi.useFakeTimers();
		const { deps } = makeDeps();
		const ctx = directCtx("tui");
		ctx.ui.select.mockImplementation(() => new Promise<string | undefined>(() => {}));
		seedDenial("command");
		const { state } = track(resolveCallMode(
			{ sandbox_permissions: "danger-full-access", justification: "j" },
			ctx as never, deps, "command", () => "x",
		));
		await vi.advanceTimersByTimeAsync(NON_TUI_APPROVAL_DEADLINE_MS * 4);
		expect(state.done).toBe(false);
		expect(ctx.ui.select.mock.calls[0][2]).toMatchObject({ timeout: undefined });
	});
});

describe("审批桌面通知请求", () => {
	it("直连审批通过注入的事件出口公告", async () => {
		const emitEvent = vi.fn();
		const { deps } = makeDeps({ emitEvent });
		const ctx = toolCtx(true, "Allow once");
		seedDenial("command");
		await resolveCall(
			{ sandbox_permissions: "danger-full-access", justification: "notify me" },
			ctx,
			deps,
			"command",
			() => "echo hi",
		);
		expect(emitEvent).toHaveBeenCalledExactlyOnceWith("notify:request", {
			title: "Approval required",
			body: expect.stringContaining("notify me"),
			urgency: "critical",
		});
	});

	it("转发审批只公告在父通道，不使用子会话事件出口", async () => {
		const childEmit = vi.fn();
		const parentAnnounce = vi.fn();
		const { deps } = makeDeps({ emitEvent: childEmit });
		getEscalationBroker().registerParent({
			sessionId: "parent-notify",
			hasUI: () => true,
			mode: () => "rpc",
			select: vi.fn(async () => "Allow once"),
			announce: parentAnnounce,
		});
		getEscalationBroker().linkChild(TEST_SESSION, "parent-notify");
		seedDenial("command");
		await resolveCall(
			{ sandbox_permissions: "danger-full-access", justification: "parent notification" },
			toolCtx(false),
			deps,
			"command",
			() => "echo hi",
		);
		expect(parentAnnounce).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("parent notification"));
		expect(childEmit).not.toHaveBeenCalled();
	});
});
