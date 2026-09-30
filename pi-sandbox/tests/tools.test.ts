import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSandboxTools, resolveCallMode } from "../src/tools";
import { createPermissionState } from "../src/permission";
import { DEFAULT_SANDBOX_CONFIG } from "../src/config";

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
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("createSandboxTools schemas", () => {
	it("bash keeps command/timeout and gains the escalation pair", () => {
		const { deps } = makeDeps();
		const { bash } = createSandboxTools(deps);
		const props = (bash.parameters as { properties: Record<string, unknown> }).properties;
		expect(props.command).toBeDefined();
		expect(props.sandbox_permissions).toBeDefined();
		expect(props.justification).toBeDefined();
	});
	it("description teaches the escalation contract", () => {
		const { deps } = makeDeps();
		const { write } = createSandboxTools(deps);
		expect(write.description).toContain("sandbox_permissions");
		expect((write.promptGuidelines ?? []).join(" ")).toContain("sandbox_permissions");
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
			.rejects.toThrow(/requires a justification/);
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
	it("escalated retry with Allow once writes outside", async () => {
		const { deps } = makeDeps();
		const { write } = createSandboxTools(deps);
		const outside = join(outsideDir, `tools-test-${process.pid}-${Date.now()}.txt`);
		// 自证断言对：同一路径不带提权必须被拒——落点若其实在围栏内，本判例会响亮失败而非假绿。
		await expect(write.execute("call-3-pre", { path: outside, content: "no" }, undefined, undefined, toolCtx()))
			.rejects.toThrow(/file access denied under workspace-write mode/);
		// 带提权（Allow once）后真实落盘。
		await write.execute("call-3", {
			path: outside, content: "ok",
			sandbox_permissions: "danger-full-access", justification: "user-approved external write",
		}, undefined, undefined, toolCtx(true, "Allow once"));
		expect(await (await import("node:fs/promises")).readFile(outside, "utf-8")).toBe("ok");
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
