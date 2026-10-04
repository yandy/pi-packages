// pi-sandbox/tests/win32-token.test.ts
import koffi from "koffi";
import { describe, expect, it } from "vitest";
import * as abi from "../src/win32/abi.js";
import { createRestrictedToken, restrictTokenIntegrity, setTokenDefaultDaclGrant } from "../src/win32/token.js";

const PVOID = koffi.pointer("void");

function makeApi(overrides: Record<string, unknown> = {}) {
	const calls: Array<{ name: string; args: unknown[] }> = [];
	const rec = (name: string, result: unknown) => (...args: unknown[]) => {
		calls.push({ name, args });
		return typeof result === "function" ? (result as (...a: unknown[]) => unknown)(...args) : result;
	};
	return {
		calls,
		getLastError: () => 0,
		formatMessage: () => "",
		localAlloc: rec("localAlloc", Buffer.alloc(256)),
		localFree: rec("localFree", null),
		getTokenInformation: rec("getTokenInformation", 1),
		setTokenInformation: rec("setTokenInformation", 1),
		// 真实 koffi 的 PVOID 出参槽是 BigInt 指针，必须用 koffi.encode 写入句柄。
		createRestrictedToken: rec("createRestrictedToken", (...args: unknown[]) => {
			koffi.encode(args[8] as never, PVOID, 0x1234n);
			return 1;
		}),
		convertStringSidToSidW: rec("convertStringSidToSidW", 1),
		getLengthSid: rec("getLengthSid", 12),
		setEntriesInAclW: rec("setEntriesInAclW", 0),
		closeHandle: rec("closeHandle", 1),
		...overrides,
	};
}

/** 读 CreateRestrictedToken 收到的 restricting 列表（buffer 里只有 SID 指针）。 */
function restrictingSlot(calls: Array<{ name: string; args: unknown[] }>) {
	const call = calls.find((c) => c.name === "createRestrictedToken");
	return { count: call?.args[6] as number, buffer: call?.args[7] as Buffer };
}

describe("win32 restricted token", () => {
	// 说明：`createRestrictedToken` 的 restricting 列表是「SID_AND_ATTRIBUTES 数组」的原生 buffer，
	// 单测只断言元素个数（每个 16 字节）与 flags，不去解指针内容——指针内容由真机验收覆盖。

	it("selects the read-only restricting list without capability SIDs", () => {
		const api = makeApi();
		createRestrictedToken(api as never, 1n as never, 2n as never, [], { world: 3n as never }, "read-only");
		const { count } = restrictingSlot(api.calls);
		expect(count).toBe(2); // logon SID + Everyone
		const flags = api.calls.find((c) => c.name === "createRestrictedToken")?.args[1] as number;
		expect(flags).toBe(abi.WRITE_RESTRICTED | abi.DISABLE_MAX_PRIVILEGE | abi.LUA_TOKEN);
	});

	it("adds every capability SID in workspace-write mode", () => {
		const api = makeApi();
		createRestrictedToken(api as never, 1n as never, 2n as never, [4n as never, 5n as never], { world: 3n as never }, "workspace-write");
		const { count } = restrictingSlot(api.calls);
		expect(count).toBe(4); // logon SID + Everyone + workspace SID + temp SID
	});

	it("refuses a workspace-write list with no capability SID", () => {
		const api = makeApi();
		expect(() => createRestrictedToken(api as never, 1n as never, 2n as never, [], { world: 3n as never }, "workspace-write"))
			.toThrowError(/workspace-write restricting list requires at least one write SID/);
	});

	it("lowers the token to Low integrity with the verified payload", () => {
		const api = makeApi();
		restrictTokenIntegrity(api as never, 1n as never, 2n as never);
		const call = api.calls.find((c) => c.name === "setTokenInformation");
		expect(call?.args[1]).toBe(abi.TokenIntegrityLevel);
		const info = call?.args[2] as Buffer;
		expect(info.length).toBe(abi.TOKEN_MANDATORY_LABEL_SIZE + 12);
		expect(info.readBigUInt64LE(0)).toBe(2n); // Label.Sid
		expect(info.readUInt32LE(8)).toBe(abi.SE_GROUP_INTEGRITY);
	});

	it("merges a full-access ACE for the given SID into the token default DACL", () => {
		const dacl = Buffer.alloc(16);
		dacl.writeBigUInt64LE(0n, 0);
		const api = makeApi({
			getTokenInformation: (token: unknown, cls: number, info: Buffer | null, length: number, needed: Buffer) => {
				if (cls !== abi.TokenDefaultDacl) return 1;
				if (info === null) { koffi.encode(needed as never, "uint32", 16); return 0 }
				info.writeBigUInt64LE(0x9000n, 0);
				return 1;
			},
			setEntriesInAclW: (count: number, entries: Buffer, old: unknown, slot: Buffer) => {
				expect(count).toBe(1);
				expect(entries.readUInt32LE(0)).toBe(abi.FILE_ALL_ACCESS);
				koffi.encode(slot as never, PVOID, 0xa000n);
				return 0;
			},
		});
		setTokenDefaultDaclGrant(api as never, 1n as never, 4n as never);
		const set = api.calls.find((c) => c.name === "setTokenInformation" && c.args[1] === abi.TokenDefaultDacl);
		expect(set).toBeDefined();
	});

	it("fails closed when the token carries no default DACL", () => {
		const api = makeApi({
			getTokenInformation: (token: unknown, cls: number, info: Buffer | null, length: number, needed: Buffer) => {
				if (info === null) { koffi.encode(needed as never, "uint32", 16); return 0 }
				info.writeBigUInt64LE(0n, 0); // NULL DACL
				return 1;
			},
		});
		expect(() => setTokenDefaultDaclGrant(api as never, 1n as never, 4n as never))
			.toThrowError(/the token carries no default DACL to extend/);
	});
});
