import { describe, expect, it } from "vitest";
import { escapeWindowsTrailing, isReservedWindowsName, windowsSafeName } from "../src/windows-names";

describe("isReservedWindowsName", () => {
	it("recognises the classic device names, case-insensitively", () => {
		for (const name of ["con", "CON", "Con", "prn", "aux", "nul", "com1", "COM9", "lpt1", "LPT9"]) {
			expect(isReservedWindowsName(name), name).toBe(true);
		}
	});

	it("recognises them with an extension (NUL.txt and NUL.tar.gz are both NUL)", () => {
		for (const name of ["nul.txt", "NUL.tar.gz", "con.md", "com1.log"]) {
			expect(isReservedWindowsName(name), name).toBe(true);
		}
	});

	it("recognises the console aliases", () => {
		expect(isReservedWindowsName("conin$")).toBe(true);
		expect(isReservedWindowsName("CONOUT$")).toBe(true);
	});

	it("leaves lookalikes alone", () => {
		for (const name of ["CONSOLE", "nul2", "com0", "com10", "lpt", "aux_", "_nul", "con_2e", "github.com__con__repo"]) {
			expect(isReservedWindowsName(name), name).toBe(false);
		}
	});
});

describe("escapeWindowsTrailing", () => {
	it("escapes a trailing dot or space with the shared hex vocabulary", () => {
		expect(escapeWindowsTrailing("proj.")).toBe("proj_2e");
		expect(escapeWindowsTrailing("proj ")).toBe("proj_20");
	});

	it("leaves other names untouched", () => {
		expect(escapeWindowsTrailing("proj")).toBe("proj");
		expect(escapeWindowsTrailing("proj.old")).toBe("proj.old");
	});
});

describe("windowsSafeName", () => {
	it("prefixes reserved names", () => {
		expect(windowsSafeName("nul")).toBe("_nul");
		expect(windowsSafeName("CON")).toBe("_CON");
		expect(windowsSafeName("con.md")).toBe("_con.md");
		expect(windowsSafeName("nul.tar.gz")).toBe("_nul.tar.gz");
	});

	it("escapes the trailing character before the reserved check", () => {
		// 顺序固定：先转义结尾，再判保留名 —— 判定看到的是最终形态（nul. → nul_2e，不再命中）
		expect(windowsSafeName("nul.")).toBe("nul_2e");
		expect(windowsSafeName("proj.")).toBe("proj_2e");
	});

	it("is idempotent on already-safe names", () => {
		for (const name of ["_nul", "github.com__yandy__pi-packages", "C_3a__Users__yandy"]) {
			expect(windowsSafeName(name)).toBe(name);
		}
	});
});
