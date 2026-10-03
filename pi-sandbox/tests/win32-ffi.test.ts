// pi-sandbox/tests/win32-ffi.test.ts
import { afterEach, describe, expect, it } from "vitest";
import * as ffi from "../src/win32/ffi.js";

// 内存与指针操作走真实 koffi（跨平台可用）；只有 Win32 绑定表是 win32 专属。
import koffi from "koffi";
const PVOID = koffi.pointer("void");

describe("win32 ffi helpers", () => {
	it("round-trips a pointer slot", () => {
		const slot = ffi.allocPtrSlot();
		const target = ffi.allocBytes(16); // 真实原生内存
		koffi.encode(slot, PVOID, target);
		expect(ffi.decodePtr(slot)).toBe(target);
		// 槽为 0 时必须解出 null（grantWrite 的 NULL-DACL 分支依赖它）
		koffi.encode(slot, PVOID, 0);
		expect(ffi.decodePtr(slot)).toBeNull();
	});

	it("round-trips a uint32 slot through the injected types", () => {
		const slot = ffi.allocUint32();
		ffi.encodeUint32(slot, 127);
		expect(ffi.decodeUint32At(slot, 0)).toBe(127);
	});

	it("treats a zero pointer as null and the all-ones handle as invalid", () => {
		expect(ffi.isNullPtr(null)).toBe(true);
		expect(ffi.isNullPtr(0n)).toBe(true);
		expect(ffi.isNullPtr(8n)).toBe(false);
		expect(ffi.isInvalidHandle(null)).toBe(true);
		expect(ffi.isInvalidHandle(0xffffffffffffffffn)).toBe(true);
		expect(ffi.isInvalidHandle(8n)).toBe(false);
	});

	it("compares SIDs field-by-field and rejects length mismatch", () => {
		const makeSid = (subAuthority: number, subAuthorityCount = 2) => {
			const bytes = Buffer.alloc(16);
			bytes.writeUInt8(1, 0); // revision
			bytes.writeUInt8(subAuthorityCount, 1);
			bytes.writeUInt32LE(subAuthority, 8);
			const pointer = ffi.allocBytes(bytes.length);
			koffi.encode(pointer, "uint8", bytes, bytes.length);
			return pointer;
		};
		expect(ffi.sameSidAt(makeSid(7), 0, makeSid(7), 0)).toBe(true);
		expect(ffi.sameSidAt(makeSid(7), 0, makeSid(8), 0)).toBe(false); // 子授权不同
		expect(ffi.sameSidAt(makeSid(7), 0, makeSid(7, 1), 0)).toBe(false); // 长度不同
	});

	it("formats Win32 errors with API name, code, and detail", () => {
		const api = { getLastError: () => 5, formatMessage: () => "Access is denied." };
		expect(() => ffi.throwWin32(api as never, "SetNamedSecurityInfoW", 5, "authorize(C:\\ws)")).toThrowError(
			/Win32 SetNamedSecurityInfoW failed \(5\): Access is denied\. \[authorize\(C:\\ws\)\]/,
		);
	});

	it("reads the temp path from a UTF-16 buffer", () => {
		const api = {
			getLastError: () => 0,
			formatMessage: () => "",
			getTempPathW: (length: number, buffer: Buffer) => {
				const path = "C:\\Users\\alice\\AppData\\Local\\Temp\\";
				buffer.write(path, 0, "utf16le");
				return path.length;
			},
		};
		expect(ffi.getTempPath(api as never)).toBe("C:\\Users\\alice\\AppData\\Local\\Temp\\");
	});

	it("refuses to load the Win32 binding table outside Windows", () => {
		// koffi 本身可以加载（上面的用例就在用它）；只有 koffi.load("kernel32.dll") 是 win32 专属
		if (process.platform !== "win32") {
			expect(() => ffi.win32Sync()).toThrowError(/only available on win32 hosts/);
		} else {
			expect(() => ffi.win32Sync()).not.toThrow();
		}
	});
});
