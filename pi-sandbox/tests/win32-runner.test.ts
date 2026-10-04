// pi-sandbox/tests/win32-runner.test.ts
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
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
	// 每个 SID 字符串一个可区分的哨兵指针：stub 里其他哨兵是 0x1/0x2/0x5000/0x9000/0xa000，
	// 这里从 0x10000 起，保证能断言 DACL 合并里“写的是哪条 SID”而不是只能数调用。
	const sidPointers = new Map<string, bigint>();
	// makeWellKnownSid 返回的是它自己 allocBytes 的缓冲区；stub 收到的第 3 个实参就是该指针。
	const wellKnownPointers = new Map<number, bigint>();
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
		convertStringSidToSidW: rec("convertStringSidToSidW", (sid: string, slot: unknown) => {
			const existing = sidPointers.get(sid);
			const pointer = existing === undefined ? 0x10000n + BigInt(sidPointers.size) : existing;
			sidPointers.set(sid, pointer);
			koffi.encode(slot as never, PVOID, pointer);
			return 1;
		}),
		createWellKnownSid: rec("createWellKnownSid", (type: number, _reserved: unknown, sid: unknown) => {
			wellKnownPointers.set(type, sid as bigint);
			return 1;
		}),
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
	return { calls, api, sidPointers, spawn, wait: (process: unknown) => { calls.push({ name: "wait", args: [process] }); return 99 }, wellKnownPointers, ...overrides };
}

/** EXPLICIT_ACCESS_W 里 Trustee.ptstrName（SID 指针）的字节偏移。 */
const TRUSTEE_NAME_OFFSET = abi.TRUSTEE_W_OFFSET + abi.TRUSTEE_W_PTSTRNAME_OFFSET;

/** 读出一条合并条目里 trustee 命名的 SID 指针。 */
function mergedTrusteePointer(entries: Buffer) {
	return entries.readBigUInt64LE(TRUSTEE_NAME_OFFSET);
}

/**
 * 令牌默认 DACL 补丁是唯一一次单条目（count=1）的 SetEntriesInAclW 合并；
 * 授权路径的两次合并都带 2 条 ACE（环境删除 Deny + 能力 Grant）。
 */
function defaultDaclTrustee(calls: Array<{ name: string; args: unknown[] }>) {
	const patches = calls.filter((call) => call.name === "setEntriesInAclW" && call.args[0] === 1);
	if (patches.length !== 1) throw new Error(`expected exactly one token default-DACL patch, got ${patches.length}`);
	return mergedTrusteePointer(patches[0].args[1] as Buffer);
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
		const sids = deps.calls.filter((c) => c.name === "convertStringSidToSidW").map((c) => String(c.args[0]));
		// Step 3 要求 #6：两条 SID 都必须派生。toHaveLength(2) 正是「只派生一条、
		// 两条根共用同一身份」的检出点：旧断言对单条 SID 真空成立。
		expect(sids).toHaveLength(2);
		for (const sid of sids) expect(sid.startsWith("S-1-4-")).toBe(true);
		const [workspaceSid, tempSid] = sids;
		// workspace = 2 个 sub-authority；temp = 3 个：固定第三段 `-1` 与所有 workspace SID 域分离。
		expect(workspaceSid.split("-")).toHaveLength(5);
		expect(tempSid.split("-")).toHaveLength(6);
		expect(tempSid.endsWith("-1")).toBe(true);
		expect(new Set(sids).size).toBe(sids.length);
	});

	it("names the temp SID in the token's default DACL under workspace-write", async () => {
		const deps = makeDeps();
		await main(args("workspace-write"), deps as never);
		const sids = deps.calls.filter((c) => c.name === "convertStringSidToSidW").map((c) => String(c.args[0]));
		const tempSid = sids.find((sid) => sid.split("-").length === 6);
		const workspaceSid = sids.find((sid) => sid.split("-").length === 5);
		if (tempSid === undefined || workspaceSid === undefined) {
			throw new Error(`expected both capability SIDs, got ${sids.join(", ")}`);
		}
		// §4.6：默认 DACL 补丁必须命名 temp（writeSids[1]）；把 writeSids[1]/[0]
		// 的两个操作数对调会被这里检出（旧断言只在真机探针里看过指针）。
		const trustee = defaultDaclTrustee(deps.calls);
		expect(trustee).toBe(deps.sidPointers.get(tempSid));
		expect(trustee).not.toBe(deps.sidPointers.get(workspaceSid));
	});

	it("names the well-known Everyone SID in the token's default DACL under read-only", async () => {
		const deps = makeDeps();
		await main(args("read-only"), deps as never);
		// read-only 不派生能力 SID，默认 DACL 补丁回退 Everyone（writeSids 为空）。
		const trustee = defaultDaclTrustee(deps.calls);
		expect(trustee).toBe(deps.wellKnownPointers.get(abi.WinWorldSid));
		expect(trustee).not.toBe(deps.wellKnownPointers.get(abi.WinLowLabelSid));
	});

	it("fails closed without spawning when a root grant cannot be applied", async () => {
		const deps = makeDeps();
		deps.api.setNamedSecurityInfoW = () => 5; // ERROR_ACCESS_DENIED：授权失败必须冒泡
		await expect(main(args("workspace-write"), deps as never)).rejects.toThrowError(/SetNamedSecurityInfoW/);
		// 授权失败绝不降级成「零授权照样跑」：spawn/wait 一次都不能发生。
		expect(deps.calls.filter((c) => c.name === "spawn" || c.name === "wait")).toEqual([]);
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
		const options = spawned?.args[1] as { command: string; args: string[] };
		expect(options.command).toBe("pwsh.exe");
		// `--` 之后的 argv 必须逐字透传：哪怕长得像 runner flag（"--temp C:\\x"）
		// 也不能被二次解析或改写。
		expect(options.args).toEqual(["-Command", "echo --temp C:\\x"]);
	});

	it("starts the child in the runner's own cwd, not the workspace root", async () => {
		const deps = makeDeps();
		// 前置条件：「继承 process.cwd()」与「改写成 workspace」只有在两者不同时才能区分。
		expect(WS).not.toBe(process.cwd());
		await main(args("workspace-write"), deps as never);
		const spawned = deps.calls.find((c) => c.name === "spawn");
		expect((spawned?.args[1] as { cwd: string }).cwd).toBe(process.cwd());
	});

	it("installs a Ctrl+C handler before spawning", async () => {
		const deps = makeDeps();
		await main(args("workspace-write"), deps as never);
		const names = deps.calls.map((c) => c.name);
		// 先钉存在性：setConsoleCtrlHandler 缺失时 indexOf 为 -1，顺序比较会恒真。
		expect(names).toContain("setConsoleCtrlHandler");
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

	it.skipIf(process.platform === "win32")("runs main through a symlinked entry point (realpath guard)", () => {
		const runner = fileURLToPath(new URL("../src/win32/runner.js", import.meta.url));
		const symlink = join(root, "runner-symlink.js");
		symlinkSync(runner, symlink);
		const result = spawnSync(
			process.execPath,
			[symlink, "--workspace", WS, "--temp", TMP, "--mode", "read-only", "--", "pwsh"],
			{ encoding: "utf8" },
		);
		// 符号链接入口下 main 也必须跑起来：Linux/macOS 上 win32() 抛错 → 签名行 + 127。
		// 旧的 URL 字面比较在这里判 false，进程会静默 exit 0（TS 分类器视为成功）。
		expect(result.status).toBe(RUNNER_FAILURE_EXIT);
		expect(result.stderr).toContain(`${RUNNER_SIGNATURE}: `);
	});
});
