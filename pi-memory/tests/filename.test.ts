import { describe, expect, it } from "vitest";
import { entryFileName, resolveUniqueFileName } from "../src/filename";

describe("entryFileName", () => {
	it("keeps ASCII words and collapses whitespace to dashes", () => {
		expect(entryFileName("  Use real DB in tests  ")).toBe("Use-real-DB-in-tests.md");
	});

	it("preserves non-ASCII characters", () => {
		expect(entryFileName("集成测试必须连真实 PostgreSQL")).toBe("集成测试必须连真实-PostgreSQL.md");
	});

	it("preserves combining-emoji code points", () => {
		expect(entryFileName("部署 🔥 检查")).toBe("部署-🔥-检查.md");
	});

	it("replaces filesystem-unsafe characters", () => {
		expect(entryFileName('a/b\\c:d*e?f"g<h>i|j')).toBe("a_b_c_d_e_f_g_h_i_j.md");
	});

	it("strips control characters", () => {
		expect(entryFileName("a\u0000b\u001fc\u007f")).toBe("a_b_c_.md");
	});

	it("falls back to a hash when nothing usable remains", () => {
		expect(entryFileName("")).toMatch(/^entry-[0-9a-f]{8}\.md$/);
		expect(entryFileName("...")).toMatch(/^entry-[0-9a-f]{8}\.md$/);
		expect(entryFileName("..")).toMatch(/^entry-[0-9a-f]{8}\.md$/);
	});

	it("truncates to 100 bytes on a code-point boundary", () => {
		const stem = entryFileName("汉".repeat(80)).slice(0, -3);
		expect(Buffer.byteLength(stem, "utf8")).toBe(99);
		expect([...stem].every((ch) => ch === "汉")).toBe(true);
	});

	it("is deterministic", () => {
		expect(entryFileName("同一个 标题")).toBe(entryFileName("同一个 标题"));
	});

	it("prefixes reserved Windows device names", () => {
		expect(entryFileName("CON")).toBe("_CON.md");
		expect(entryFileName("con")).toBe("_con.md");
		expect(entryFileName("nul")).toBe("_nul.md");
		expect(entryFileName("com1")).toBe("_com1.md");
		expect(entryFileName("lpt9")).toBe("_lpt9.md");
		expect(entryFileName("nul.tar.gz")).toBe("_nul.tar.gz.md");
	});

	it("leaves lookalike names alone", () => {
		expect(entryFileName("CONSOLE")).toBe("CONSOLE.md");
		expect(entryFileName("nul2")).toBe("nul2.md");
		expect(entryFileName("com10")).toBe("com10.md");
	});
});

describe("resolveUniqueFileName", () => {
	it("returns the base name when free", () => {
		expect(resolveUniqueFileName(["other.md"], "a.md")).toBe("a.md");
	});

	it("appends -2 when the base is taken", () => {
		expect(resolveUniqueFileName(["a.md"], "a.md")).toBe("a-2.md");
	});

	it("skips taken suffixes", () => {
		expect(resolveUniqueFileName(["a.md", "a-2.md", "a-3.md"], "a.md")).toBe("a-4.md");
	});
});
