// pi-sandbox/tests/win32-abi.test.ts
import { describe, expect, it } from "vitest";
import * as abi from "../src/win32/abi.js";

describe("win32 abi constants", () => {
	it("packs the capability grant mask the ACL layer applies", () => {
		// (FILE_GENERIC_WRITE | DELETE | FILE_DELETE_CHILD) & ~STANDARD_RIGHTS_WRITE
		expect(abi.GRANT_MASK).toBe(0x00110156);
		expect(abi.GRANT_MASK & abi.STANDARD_RIGHTS_WRITE).toBe(0);
		// WRITE_DAC (0x40000) / WRITE_OWNER (0x80000) 必须不在掩码里：受限子进程不能改 DACL 或夺取所有权
		expect(abi.GRANT_MASK & 0x00040000).toBe(0);
		expect(abi.GRANT_MASK & 0x00080000).toBe(0);
		expect(abi.FILE_ALL_ACCESS).toBe(0x1f01ff);
	});

	it("keeps the x64 record layouts the probes verified", () => {
		expect(abi.EXPLICIT_ACCESS_W_SIZE).toBe(48);
		expect(abi.TRUSTEE_W_OFFSET).toBe(16);
		// relative to TRUSTEE_W; absolute inside EXPLICIT_ACCESS_W = 16 + 24 = 40
		expect(abi.TRUSTEE_W_PTSTRNAME_OFFSET).toBe(24);
		expect(abi.SID_AND_ATTRIBUTES_SIZE).toBe(16);
		expect(abi.TOKEN_GROUPS_OFFSET).toBe(8);
		expect(abi.ACL_HEADER_SIZE).toBe(8);
		expect(abi.MANDATORY_ACE_OVERHEAD).toBe(8);
		expect(abi.TOKEN_MANDATORY_LABEL_SIZE).toBe(16);
		expect(abi.SECURITY_MAX_SID_SIZE).toBe(68);
		expect(abi.SID_MAX_SUB_AUTHORITIES).toBe(15);
	});

	it("keeps the process and job constants", () => {
		expect(abi.STARTUPINFOW_SIZE).toBe(104);
		expect(abi.PROCESS_INFORMATION_SIZE).toBe(24);
		expect(abi.JOBOBJECT_EXTENDED_LIMIT_SIZE).toBe(144);
		expect(abi.JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET).toBe(16);
		expect(abi.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE).toBe(0x2000);
		expect(abi.JobObjectExtendedLimitInformation).toBe(9);
		expect(abi.CREATE_SUSPENDED).toBe(0x4);
		expect(abi.INFINITE).toBe(0xffffffff);
		expect(abi.STARTF_USESTDHANDLES).toBe(0x100);
		expect(abi.STARTF_USESHOWWINDOW).toBe(0x1);
		expect(abi.SW_HIDE).toBe(0);
		expect(abi.HANDLE_FLAG_INHERIT).toBe(0x1);
		expect([abi.STD_INPUT_HANDLE, abi.STD_OUTPUT_HANDLE, abi.STD_ERROR_HANDLE]).toEqual([-10, -11, -12]);
	});

	it("keeps the token and label constants", () => {
		expect([abi.WinWorldSid, abi.WinLowLabelSid]).toEqual([1, 66]);
		expect([abi.TokenGroups, abi.TokenDefaultDacl, abi.TokenIntegrityLevel]).toEqual([2, 6, 25]);
		expect(abi.WRITE_RESTRICTED).toBe(0x8);
		expect(abi.DISABLE_MAX_PRIVILEGE).toBe(0x1);
		expect(abi.LUA_TOKEN).toBe(0x4);
		expect(abi.SYSTEM_MANDATORY_LABEL_NO_WRITE_UP).toBe(0x1);
		expect(abi.SYSTEM_MANDATORY_LABEL_ACE_TYPE).toBe(0x11);
		expect(abi.SE_GROUP_INTEGRITY).toBe(0x20);
		expect(abi.SE_GROUP_LOGON_ID).toBe(0xc0000000);
		expect(abi.ACL_REVISION).toBe(2);
	});
});
