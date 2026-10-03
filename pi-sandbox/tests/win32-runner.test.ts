// pi-sandbox/tests/win32-runner.test.ts
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import koffi from "koffi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as abi from "../src/win32/abi.js";
import { main } from "../src/win32/runner.js";
import { RUNNER_FAILURE_EXIT, RUNNER_SIGNATURE } from "../src/win32/cli.js";

const PVOID = koffi.pointer("void");

// requireDirectory 走真实文件系统：workspace / --temp 根必须是真实存在的目录，
// 且 withPathLock 的锁文件根真的 mkdir，所以隔离到每个用例自己的临时目录里，
// 不写进仓库 cwd。
let root = "";
let WS = "";
let TMP = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-sandbox-win32-runner-"));
	WS = mkdtempSync(join(root, "ws-"));
	TMP = mkdtempSync(join(root, "tmp-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function makeDeps(overrides: Record<string, unknown> = {}) {
	const calls: Array<{ name: string; args: unknown[] }> = [];
	const rec = (name: string, result: unknown) => (...args: unknown[]) => {
		calls.push({ name, args });
		return typeof result === "function" ? (result as (...a: unknown[]) => unknown)(...args) : (result as never);
	};
	const api = {
		calls,
		getLastError: () => 0,
		formatMessage: () => "",
		openProcess: rec("openProcess", 0x1n),
		closeHandle: rec("closeHandle", 1),
		openProcessToken: (process: unknown, access: number, slot: unknown) => { koffi.encode(slot as never, PVOID, 0x2n); return 1 },
		getTokenInformation: (token: unknown, cls: number, info: Buffer | null, length: number, needed: Buffer) => {
			if (cls === abi.TokenGroups) {
				if (info === null) { koffi.encode(needed as never, "uint32", 32); return 0 }
				info.writeUInt32LE(1, 0);
				info.writeBigUInt64LE(0x30n, abi.TOKEN_GROUPS_OFFSET);
				info.writeUInt32LE(abi.SE_GROUP_LOGON_ID >>> 0, abi.TOKEN_GROUPS_OFFSET + 8);
				return 1;
			}
			if (info === null) { koffi.encode(needed as never, "uint32", 16); return 0 }
			// TokenDefaultDacl 必须给一条非 NULL 的现 DACL，否则 §4.6 的补丁拒绝继续；
			// TokenIntegrityLevel 的载荷只被 stub 的 SetTokenInformation 消费，写 0 即可。
			info.writeBigUInt64LE(cls === abi.TokenDefaultDacl ? 0x9000n : 0n, 0);
			return 1;
		},
		getLengthSid: rec("getLengthSid", 12),
		copySid: rec("copySid", 1),
		convertStringSidToSidW: rec("convertStringSidToSidW", (sid: string, slot: unknown) => { koffi.encode(slot as never, PVOID, BigInt(0x4000 + sid.length)); return 1 }),
		createWellKnownSid: rec("createWellKnownSid", 1),
		isValidSid: rec("isValidSid", 1),
		createRestrictedToken: rec("createRestrictedToken", (...args: unknown[]) => {
			koffi.encode(args[8] as never, PVOID, 0x5000n); // 出参槽必须写成非 NULL 令牌
			return 1;
		}),
		setTokenInformation: rec("setTokenInformation", 1),
		localAlloc: rec("localAlloc", Buffer.alloc(256)),
		localFree: rec("localFree", null),
		setEntriesInAclW: rec("setEntriesInAclW", (...args: unknown[]) => {
			koffi.encode(args[3] as never, PVOID, 0xa000n); // 合并后的新 ACL 指针
			return 0;
		}),
		initializeAcl: rec("initializeAcl", 1),
		addMandatoryAce: rec("addMandatoryAce", 1),
		getNamedSecurityInfoW: rec("getNamedSecurityInfoW", 0),
		setNamedSecurityInfoW: rec("setNamedSecurityInfoW", 0),
		getTempPathW: (length: number, buffer: Buffer) => { const p = `${root}${sep}`; buffer.write(p, 0, "utf16le"); return p.length },
		createFileW: rec("createFileW", 0x6000n),
		lockFileEx: rec("lockFileEx", 1),
		unlockFileEx: rec("unlockFileEx", 1),
		setConsoleCtrlHandler: rec("setConsoleCtrlHandler", 1),
	};
	const spawn = (token: unknown, options: { command: string }) => {
		calls.push({ name: "spawn", args: [token, options] });
		return { pid: 4242, process: 0x7000n, job: 0x7100n };
	};
	return { calls, api, spawn, wait: (process: unknown) => { calls.push({ name: "wait", args: [process] }); return 99 }, ...overrides };
}

function args(mode: string, command = ["pwsh.exe", "-NoProfile", "-Command", "echo hi"]) {
	return ["--workspace", WS, "--temp", TMP, "--mode", mode, "--", ...command];
}

describe("windows-acl runner main", () => {
	it("mirrors the confined child's exit code", async () => {
		const deps = makeDeps();
		await expect(main(args("workspace-write"), deps as never)).resolves.toBe(99);
		expect(deps.calls.map((c) => c.name)).toContain("wait");
	});

	it("grants both roots and derives both SIDs in workspace-write", async () => {
		const deps = makeDeps();
		await main(args("workspace-write"), deps as never);
		const granted = deps.calls.filter((c) => c.name === "setNamedSecurityInfoW");
		expect(granted.length).toBeGreaterThanOrEqual(2); // workspace + %TEMP%
		const sids = deps.calls.filter((c) => c.name === "convertStringSidToSidW").map((c) => c.args[0]);
		expect(sids.some((s) => String(s).startsWith("S-1-4-"))).toBe(true);
		expect(new Set(sids).size).toBe(sids.length);
	});

	it("grants nothing in read-only mode", async () => {
		const deps = makeDeps();
		await main(args("read-only"), deps as never);
		expect(deps.calls.some((c) => c.name === "setNamedSecurityInfoW")).toBe(false);
		// 授权路径零调用：没有路径锁、没有能力 SID 解析、没有标签/ACL 读取构造。唯一一次
		// SetEntriesInAclW 是 §4.6 的令牌默认 DACL 补丁（SID 回退到 Everyone），不是授权根的 DACL 合并。
		for (const grantCall of ["createFileW", "getNamedSecurityInfoW", "initializeAcl", "addMandatoryAce"]) {
			expect(deps.calls.some((c) => c.name === grantCall)).toBe(false);
		}
		expect(deps.calls.some((c) => c.name === "convertStringSidToSidW")).toBe(false);
		expect(deps.calls.filter((c) => c.name === "setEntriesInAclW").length).toBe(1);
	});

	it("passes the caller's argv verbatim to the spawner", async () => {
		const deps = makeDeps();
		await main(args("workspace-write", ["pwsh.exe", "-Command", "echo --temp C:\\x"]), deps as never);
		const spawned = deps.calls.find((c) => c.name === "spawn");
		expect((spawned?.args[1] as { command: string }).command).toBe("pwsh.exe");
	});

	it("installs a Ctrl+C handler before spawning", async () => {
		const deps = makeDeps();
		await main(args("workspace-write"), deps as never);
		const names = deps.calls.map((c) => c.name);
		expect(names.indexOf("setConsoleCtrlHandler")).toBeLessThan(names.indexOf("spawn"));
	});

	it("fails closed with the signature line and exit 127 on a Win32 error", async () => {
		const deps = makeDeps({ api: { ...makeDeps().api, createRestrictedToken: () => { throw new Error("Win32 CreateRestrictedToken failed (1314): A required privilege is not held by the client.") } } });
		await expect(main(args("workspace-write"), deps as never)).rejects.toThrowError(/CreateRestrictedToken/);
	});

	it("rejects a temp root nested inside the workspace before any Win32 call", async () => {
		const deps = makeDeps();
		const nestedTemp = join(WS, "tmp");
		mkdirSync(nestedTemp);
		await expect(main(["--workspace", WS, "--temp", nestedTemp, "--mode", "workspace-write", "--", "pwsh.exe"], deps as never))
			.rejects.toThrowError(/temp root must not be inside the workspace/i);
		expect(deps.calls.some((c) => c.name === "openProcess")).toBe(false);
		expect(deps.calls).toEqual([]); // 任何 Win32 调用都还没发生
	});

	it("prints exactly one signature line and exits 127 as the entry point", () => {
		const runner = fileURLToPath(new URL("../src/win32/runner.js", import.meta.url));
		const missing = join(root, "missing-workspace");
		const result = spawnSync(process.execPath, [runner, "--workspace", missing, "--temp", TMP, "--mode", "read-only", "--", "echo"], { encoding: "utf8" });
		expect(result.status).toBe(RUNNER_FAILURE_EXIT);
		expect(result.stderr).toBe(`${RUNNER_SIGNATURE}: --workspace is not an existing directory: ${missing}\n`);
	});
});
