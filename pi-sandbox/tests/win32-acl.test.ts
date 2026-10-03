// pi-sandbox/tests/win32-acl.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import koffi from "koffi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as abi from "../src/win32/abi.js";
import { buildExplicitAccess, grantWrite, lockFilePath, withPathLock } from "../src/win32/acl.js";

const PVOID = koffi.pointer("void");

// withPathLock 会真的 mkdir：锁文件根走隔离临时目录，不写进仓库 cwd。
let tempRoot = "";
beforeEach(() => {
	tempRoot = mkdtempSync(join(tmpdir(), "pi-sandbox-win32-acl-"));
});
afterEach(() => {
	rmSync(tempRoot, { recursive: true, force: true });
});

/** 分配一块原生内存并写入给定字节。 */
function allocBytes(bytes: Buffer): bigint {
	const pointer = koffi.alloc("uint8", bytes.length) as unknown as bigint;
	koffi.encode(pointer as never, "uint8", bytes, bytes.length);
	return pointer;
}

/** 造一个只够 sameSidAt/getLengthSid 读取的最小 SID，返回其指针。 */
function fakeSid(subAuthority: number): bigint {
	const sid = Buffer.alloc(12);
	sid.writeUInt8(1, 0); // revision
	sid.writeUInt8(1, 1); // 1 sub-authority
	sid.writeUInt32LE(subAuthority, 8);
	return allocBytes(sid);
}

const WORKSPACE_SID = fakeSid(0x1111);
const LOW_SID = fakeSid(0x2222);
const WORLD_SID = fakeSid(0x3333);

/** 写一个 ACE（头 4 + 掩码 4 + 内联 SID 12），返回下一个偏移。 */
function writeAce(acl: Buffer, offset: number, type: number, flags: number, mask: number, sidPointer: bigint): number {
	acl.writeUInt8(type, offset);
	acl.writeUInt8(flags, offset + 1);
	acl.writeUInt16LE(24, offset + 2);
	acl.writeUInt32LE(mask, offset + 4);
	Buffer.from(koffi.decode(sidPointer as never, "uint8", 12) as number[]).copy(acl, offset + 8);
	return offset + 24;
}

/** 造一个 ACL（按需含精确允许/拒绝/标签 ACE），返回其原生指针。 */
function buildAcl(options: { grant?: boolean; deny?: boolean; label?: boolean; denyInheritance?: number }): bigint {
	const count = (options.grant ? 1 : 0) + (options.deny ? 1 : 0) + (options.label ? 1 : 0);
	const acl = Buffer.alloc(8 + count * 24);
	acl.writeUInt16LE(2, 0); // AclRevision
	acl.writeUInt16LE(acl.length, 2); // AclSize
	acl.writeUInt16LE(count, 4); // AceCount
	let offset = 8;
	if (options.deny) offset = writeAce(acl, offset, abi.ACCESS_DENIED_ACE_TYPE, options.denyInheritance ?? abi.CONTAINER_INHERIT_ACE, abi.FILE_DELETE_CHILD, WORLD_SID);
	if (options.grant) offset = writeAce(acl, offset, abi.ACCESS_ALLOWED_ACE_TYPE, abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT, abi.GRANT_MASK, WORKSPACE_SID);
	if (options.label) writeAce(acl, offset, abi.SYSTEM_MANDATORY_LABEL_ACE_TYPE, abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT, abi.SYSTEM_MANDATORY_LABEL_NO_WRITE_UP, LOW_SID);
	return allocBytes(acl);
}

/** 把指针写进 Win32 出参槽（stub api 的「返回指针」动作）。 */
function writeSlot(slot: unknown, value: bigint): void {
	koffi.encode(slot as never, PVOID, value);
}

/** 记录调用的 fake 绑定表：只实现 acl.js 用到的调用。 */
function makeApi(overrides: Record<string, unknown> = {}) {
	const calls: Array<{ name: string; args: unknown[] }> = [];
	const record = (name: string, result: unknown) => (...args: unknown[]) => {
		calls.push({ name, args });
		return typeof result === "function" ? (result as (...a: unknown[]) => unknown)(...args) : result;
	};
	const api = {
		calls,
		getLastError: () => 0,
		formatMessage: () => "",
		getTempPathW: (length: number, buffer: Buffer) => {
			const path = `${tempRoot}${sep}`;
			buffer.write(path, 0, "utf16le");
			return path.length;
		},
		createFileW: record("createFileW", 7n),
		lockFileEx: record("lockFileEx", 1),
		unlockFileEx: record("unlockFileEx", 1),
		closeHandle: record("closeHandle", 1),
		localAlloc: record("localAlloc", Buffer.alloc(64)),
		localFree: record("localFree", null),
		getLengthSid: record("getLengthSid", 12), // 本测试的 fake SID 均为 12 字节
		initializeAcl: record("initializeAcl", 1),
		addMandatoryAce: record("addMandatoryAce", 1),
		setEntriesInAclW: (count: number, entries: Buffer, old: unknown, slot: unknown) => {
			calls.push({ name: "setEntriesInAclW", args: [count, entries, old, slot] });
			writeSlot(slot, allocBytes(Buffer.alloc(64)));
			return 0;
		},
		setNamedSecurityInfoW: record("setNamedSecurityInfoW", 0),
		getNamedSecurityInfoW: record("getNamedSecurityInfoW", 0),
		...overrides,
	};
	return api;
}

describe("win32 acl layer", () => {
	it("packs EXPLICIT_ACCESS_W at the verified offsets", () => {
		const entry = buildExplicitAccess(0x1234n as never, abi.DENY_ACCESS, abi.FILE_DELETE_CHILD, abi.CONTAINER_INHERIT_ACE);
		expect(entry.length).toBe(48);
		expect(entry.readUInt32LE(0)).toBe(abi.FILE_DELETE_CHILD);
		expect(entry.readUInt32LE(4)).toBe(abi.DENY_ACCESS);
		expect(entry.readUInt32LE(8)).toBe(abi.CONTAINER_INHERIT_ACE);
		expect(entry.readUInt32LE(24)).toBe(0);
		expect(entry.readUInt32LE(28)).toBe(abi.TRUSTEE_IS_SID);
		expect(entry.readBigUInt64LE(40)).toBe(0x1234n);
	});

	it("defaults the capability grant to OI|CI inheritance", () => {
		const entry = buildExplicitAccess(1n as never, abi.GRANT_ACCESS, abi.GRANT_MASK);
		expect(entry.readUInt32LE(8)).toBe(abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT);
		expect(entry.readUInt32LE(0)).toBe(abi.GRANT_MASK);
	});

	it("locks the per-path lock file without sharing delete", () => {
		const api = makeApi({
			createFileW: (...args: unknown[]) => {
				(api.calls as Array<{ name: string; args: unknown[] }>).push({ name: "createFileW", args });
				return 7n;
			},
		});
		withPathLock(api as never, "C:\\work\\demo", () => "done");
		const open = (api.calls as Array<{ name: string; args: unknown[] }>).find((c) => c.name === "createFileW");
		expect(open).toBeDefined();
		const shareMode = open?.args[2];
		expect(shareMode).toBe(abi.FILE_SHARE_READ | abi.FILE_SHARE_WRITE);
		expect((shareMode as number) & 0x4).toBe(0); // FILE_SHARE_DELETE 必须不开
		const order = (api.calls as Array<{ name: string }>).map((c) => c.name);
		expect(order.indexOf("lockFileEx")).toBeLessThan(order.indexOf("unlockFileEx"));
		expect(order.lastIndexOf("closeHandle")).toBe(order.length - 1);
	});

	it("derives a deterministic lock path from the lowercased target", () => {
		const api = makeApi();
		expect(lockFilePath(api as never, "C:\\Work\\Demo")).toBe(lockFilePath(api as never, "c:\\work\\demo"));
		expect(lockFilePath(api as never, "C:\\work\\demo")).toMatch(/dsh-acl-locks[\\/][0-9a-f]{16}\.lock$/);
	});

	it("skips the security-descriptor write when the exact triple already stands", () => {
		// 精确 ACE + 精确拒绝 + 精确标签都在 -> 只读描述符并释放，不调 SetNamedSecurityInfoW
		let descriptor = 0n;
		const api = makeApi({
			getNamedSecurityInfoW: (_path: unknown, _type: unknown, _info: unknown, _owner: unknown, _group: unknown, daclSlot: bigint, saclSlot: bigint, descriptorSlot: bigint) => {
				writeSlot(daclSlot, buildAcl({ grant: true, deny: true }));
				writeSlot(saclSlot, buildAcl({ label: true }));
				descriptor = allocBytes(Buffer.alloc(64)); // descriptor 拥有 ACL 块
				writeSlot(descriptorSlot, descriptor);
				return 0;
			},
		});
		grantWrite(api as never, "C:\\work\\demo", WORKSPACE_SID as never, LOW_SID as never, WORLD_SID as never);
		const calls = api.calls as Array<{ name: string; args: unknown[] }>;
		expect(calls.some((c) => c.name === "setNamedSecurityInfoW")).toBe(false);
		// 跳过路径只拥有 descriptor 这一处分配：必须恰好释放它一次。count 抓 double free，
		// 身份抓「释放了别的指针（例如 ACL 内部指针）」——两者都会踩坏 Win32 堆。
		const frees = calls.filter((c) => c.name === "localFree");
		expect(frees).toHaveLength(1);
		expect(frees[0]?.args[0]).toBe(descriptor);
	});

	it("applies grant + deny + label in ONE SetNamedSecurityInfoW call", () => {
		const api = makeApi({
			getNamedSecurityInfoW: (_path: unknown, _type: unknown, _info: unknown, _owner: unknown, _group: unknown, daclSlot: bigint, saclSlot: bigint, descriptorSlot: bigint) => {
				writeSlot(daclSlot, 0n);
				writeSlot(saclSlot, 0n);
				writeSlot(descriptorSlot, 0n);
				return 0;
			},
		});
		grantWrite(api as never, "C:\\work\\demo", WORKSPACE_SID as never, LOW_SID as never, WORLD_SID as never);
		const applyCalls = (api.calls as Array<{ name: string; args: unknown[] }>).filter((c) => c.name === "setNamedSecurityInfoW");
		expect(applyCalls).toHaveLength(1);
		expect(applyCalls[0]?.args[2]).toBe(abi.DACL_SECURITY_INFORMATION | abi.LABEL_SECURITY_INFORMATION);
		const entries = (api.calls as Array<{ name: string; args: unknown[] }>).find((c) => c.name === "setEntriesInAclW")?.args[1] as Buffer;
		expect(entries.length).toBe(96); // 两条 EXPLICIT_ACCESS_W：拒绝在前、允许在后
		expect(entries.readUInt32LE(4)).toBe(abi.DENY_ACCESS);
		expect(entries.readUInt32LE(48 + 4)).toBe(abi.GRANT_ACCESS);
		// 每条 EXPLICIT_ACCESS_W 48 字节：perms@0、mode@4、inheritance@8、trustee.ptstrName@40。
		// entry 0 = deny：掩码、继承位、被拒绝的 SID 都要钉住。
		expect(entries.readUInt32LE(0)).toBe(abi.FILE_DELETE_CHILD);
		// deny 必须只继承到容器（CONTAINER_INHERIT_ACE）；若退化成默认的 OI|CI，0x40 会蔓延到文件，
		// 拒绝根内所有 GENERIC_ALL 打开。
		expect(entries.readUInt32LE(8)).toBe(abi.CONTAINER_INHERIT_ACE);
		expect(entries.readBigUInt64LE(40)).toBe(WORLD_SID); // deny 命名 world SID，而不是能力 SID
		// entry 1 = grant：掩码、继承位、被授予的 SID 都要钉住。
		expect(entries.readUInt32LE(48)).toBe(abi.GRANT_MASK);
		expect(entries.readUInt32LE(56)).toBe(abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT);
		expect(entries.readBigUInt64LE(88)).toBe(WORKSPACE_SID); // grant 命名能力 SID，而不是 world SID
	});

	it("falls back to the apply path when the current triple is a near miss", () => {
		// 近失 1：deny ACE 存在且掩码/SID 精确，但继承位是 OI|CI 而不是 CONTAINER_INHERIT_ACE。
		// 其余（能力 ACE + 标签）都精确，因此走到 apply 只能由这一处近失触发。
		const wrongDeny = makeApi({
			getNamedSecurityInfoW: (_path: unknown, _type: unknown, _info: unknown, _owner: unknown, _group: unknown, daclSlot: bigint, saclSlot: bigint, descriptorSlot: bigint) => {
				writeSlot(daclSlot, buildAcl({ grant: true, deny: true, denyInheritance: abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT }));
				writeSlot(saclSlot, buildAcl({ label: true }));
				writeSlot(descriptorSlot, allocBytes(Buffer.alloc(64)));
				return 0;
			},
		});
		grantWrite(wrongDeny as never, "C:\\work\\demo", WORKSPACE_SID as never, LOW_SID as never, WORLD_SID as never);
		expect((wrongDeny.calls as Array<{ name: string }>).filter((c) => c.name === "setNamedSecurityInfoW")).toHaveLength(1);

		// 近失 2：DACL 里根本没有 deny ACE（能力 ACE 精确；标签在 SACL 里精确，
		// DACL 里的那条 label ACE 对 hasExactLabel 不可见、不参与判定）-> 同样落到 apply。
		const noDeny = makeApi({
			getNamedSecurityInfoW: (_path: unknown, _type: unknown, _info: unknown, _owner: unknown, _group: unknown, daclSlot: bigint, saclSlot: bigint, descriptorSlot: bigint) => {
				writeSlot(daclSlot, buildAcl({ grant: true, label: true }));
				writeSlot(saclSlot, buildAcl({ label: true }));
				writeSlot(descriptorSlot, allocBytes(Buffer.alloc(64)));
				return 0;
			},
		});
		grantWrite(noDeny as never, "C:\\work\\demo", WORKSPACE_SID as never, LOW_SID as never, WORLD_SID as never);
		expect((noDeny.calls as Array<{ name: string }>).filter((c) => c.name === "setNamedSecurityInfoW")).toHaveLength(1);
	});

	it("fails closed with the API name when the descriptor cannot be read", () => {
		const api = makeApi({ getNamedSecurityInfoW: () => 5 });
		expect(() => grantWrite(api as never, "C:\\work\\demo", WORKSPACE_SID as never, LOW_SID as never, WORLD_SID as never))
			.toThrowError(/GetNamedSecurityInfoW/);
	});
});
