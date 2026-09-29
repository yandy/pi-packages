import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSandboxTools, resolveCallMode } from "../src/tools";
import { createPermissionState } from "../src/permission";
import { DEFAULT_SANDBOX_CONFIG } from "../src/config-v2";

let dir: string;
let ws: string;

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
			workspaceRoot: ws,
			getConfig: () => DEFAULT_SANDBOX_CONFIG,
			permission: createPermissionState(),
			spawnFn,
			selected: { runner: "bwrap" as const, enforcement: "full" as const },
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
	ws = realpathSync.native(dir);
	mkdirSync(join(dir, "out"), { recursive: true });
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
		// 与 tests/fence.test.ts 同判例：os.tmpdir() 下（含 dir/out）是 workspace-write 的
		// 合法可写根，无法触发拒绝；围栏外目标须用 /etc，尾部故意不存在——
		// assertWriteAllowed 在任何落盘前即抛，绝不触碰 /etc。
		const outside = join(realpathSync.native("/etc"), `sbx-tools-denied-${process.pid}.txt`);
		await expect(write.execute("call-2", { path: outside, content: "x" }, undefined, undefined, toolCtx()))
			.rejects.toThrow(/file access denied under workspace-write mode[\s\S]*escalation available/);
	});
	it("escalated retry with Allow once writes outside", async () => {
		const { deps } = makeDeps();
		const { write } = createSandboxTools(deps);
		// 同上：dir/out 不是真·围栏外；用 homedir（围栏外且本进程可写）验证提权后真实落盘。
		const outside = join(homedir(), `.sbx-tools-test-${process.pid}.txt`);
		try {
			await write.execute("call-3", {
				path: outside, content: "ok",
				sandbox_permissions: "danger-full-access", justification: "user-approved external write",
			}, undefined, undefined, toolCtx(true, "Allow once"));
			expect(await (await import("node:fs/promises")).readFile(outside, "utf-8")).toBe("ok");
		} finally {
			rmSync(outside, { force: true });
		}
	});
	it("Deny: error tells the model to stop and explain", async () => {
		const { deps } = makeDeps();
		const { write } = createSandboxTools(deps);
		const outside = join(dir, "out", "denied.txt");
		await expect(write.execute("call-4", {
			path: outside, content: "x",
			sandbox_permissions: "danger-full-access", justification: "reason",
		}, undefined, undefined, toolCtx(true, "Deny"))).rejects.toThrow(/stop and explain instead of working around it/);
	});
});

describe("bash tool wiring", () => {
	it("spawns the confined argv through injected spawnFn", async () => {
		const { deps, child, spawnFn } = makeDeps();
		const { bash } = createSandboxTools(deps);
		const p = bash.execute("call-5", { command: "echo hi" }, undefined, undefined, toolCtx());
		process.nextTick(() => { child.stdout.write("hi"); child.emit("close", 0, undefined); });
		await p;
		expect(spawnFn).toHaveBeenCalledWith("bwrap", expect.arrayContaining(["--"]), expect.objectContaining({ cwd: ws }));
	});
});
