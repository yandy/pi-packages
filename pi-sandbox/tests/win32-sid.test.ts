// pi-sandbox/tests/win32-sid.test.ts
import { describe, expect, it } from "vitest";
import { assertGrantRootsDisjoint, canonicalSidInput, tempWriteSid, workspaceWriteSid } from "../src/win32/sid.js";

describe("win32 capability SIDs", () => {
	it("derives the documented workspace SID (golden vectors)", () => {
		// 值由 spec 确认的派生式（sha256 -> 两个 uint32 % (2^30-1) + 1）算出，改公式会让既有 ACE 变成残留
		expect(workspaceWriteSid("C:\\work\\demo")).toBe("S-1-4-105015370-174601073");
		expect(workspaceWriteSid("C:\\Users\\alice\\AppData\\Local\\Temp")).toBe("S-1-4-201402608-266402677");
	});

	it("domain-separates the temp SID from the workspace SID", () => {
		expect(tempWriteSid("C:\\Users\\alice\\AppData\\Local\\Temp")).toBe("S-1-4-465295939-439959006-1");
		// 同一条路径的两种能力必须不同（第三级子授权是域分离标记）
		expect(tempWriteSid("C:\\work\\demo")).not.toBe(workspaceWriteSid("C:\\work\\demo"));
		expect(workspaceWriteSid("C:\\ws")).toMatch(/^S-1-4-\d{1,10}-\d{1,10}$/);
		expect(tempWriteSid("C:\\ws")).toMatch(/^S-1-4-\d{1,10}-\d{1,10}-1$/);
	});

	it("derives one SID per directory spelling", () => {
		const canonical = "C:\\work\\demo";
		expect(workspaceWriteSid(canonicalSidInput("C:\\work\\demo\\"))).toBe(workspaceWriteSid(canonical));
		expect(workspaceWriteSid(canonicalSidInput("C:/work/demo"))).toBe(workspaceWriteSid(canonical));
		// 大小写不同是同一个目录：归一化后必须同 SID，否则会出现两个能力各授一半
		expect(workspaceWriteSid(canonicalSidInput("c:\\WORK\\Demo"))).toBe(workspaceWriteSid(canonical));
	});

	it("rejects a temp root nested inside the workspace", () => {
		expect(() => assertGrantRootsDisjoint("C:\\work\\demo", "C:\\work\\demo\\tmp")).toThrowError(/temp root must not be inside the workspace/i);
		expect(() => assertGrantRootsDisjoint("C:\\work", "C:\\Temp")).not.toThrow();
		// workspace 在 temp 之下是允许的（授权冗余，不是错误）
		expect(() => assertGrantRootsDisjoint("C:\\Temp\\proj", "C:\\Temp")).not.toThrow();
		expect(() => assertGrantRootsDisjoint("C:\\work", "C:\\work")).not.toThrow();
	});
});
