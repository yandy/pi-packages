import { describe, expect, it } from "vitest";
import {
	formatIndexLine,
	indexCapacity,
	parseEntryIndex,
	removeIndexLine,
	upsertIndexLine,
} from "../src/entry-index";

const HANDWRITTEN = ["# Memory Index", "", "## Project", "- [A](a.md) — 第一条", "", "<!-- keep me -->", ""].join("\n");

describe("parseEntryIndex", () => {
	it("parses name, file and description", () => {
		const parsed = parseEntryIndex("- [集成测试](集成测试.md) — 必须连真实 PostgreSQL\n- [B](b.md) — 第二条");
		expect(parsed.entries).toHaveLength(2);
		expect(parsed.entries[0]).toMatchObject({ name: "集成测试", file: "集成测试.md", description: "必须连真实 PostgreSQL" });
	});

	it("counts non-entry non-empty lines as unrecognized", () => {
		expect(parseEntryIndex(HANDWRITTEN).unrecognized).toBe(3);
	});

	it("records the line number of each entry", () => {
		expect(parseEntryIndex(HANDWRITTEN).entries[0].lineNo).toBe(3);
	});

	// 这两个用例钉住 LINE_RE 的「非贪婪」选择。文件名由 entryFileName 从 name 派生，而它**不剥离**
	// 括号与方括号，所以 `Fix login (v2)` 会得到 `Fix-login-(v2).md`、`Array [0]` 会得到 `Array-[0].md`。
	// 若把 name 组写成 [^\]]+ 或把 file 组写成 [^)]+，这两种行会 NO MATCH → 被计入 unrecognized，
	// 随后 upsert 会追加一条同 file 的重复行、remove 又删不掉它（MEMORY.md 随写入次数无界增长）。
	it("parses a file name containing parentheses", () => {
		const line = formatIndexLine("Fix login (v2)", "Fix-login-(v2).md", "d");
		expect(parseEntryIndex(line).entries[0]).toMatchObject({ name: "Fix login (v2)", file: "Fix-login-(v2).md", description: "d" });
	});

	it("parses a name containing square brackets", () => {
		const line = formatIndexLine("Array [0]", "Array-[0].md", "d");
		expect(parseEntryIndex(line).entries[0]).toMatchObject({ name: "Array [0]", file: "Array-[0].md", description: "d" });
	});
});

describe("formatIndexLine", () => {
	it("uses an em dash surrounded by single spaces", () => {
		expect(formatIndexLine("A", "a.md", "d")).toBe("- [A](a.md) — d");
	});

	it("round-trips through parseEntryIndex", () => {
		const line = formatIndexLine("集成测试", "集成测试.md", "摘要");
		expect(parseEntryIndex(line).entries[0]).toMatchObject({ name: "集成测试", file: "集成测试.md", description: "摘要" });
	});

	// 回归守卫：file 组必须是非贪婪的。若改成贪婪的 (.+)，description 里的 `) — ` 会把分割点吃到最后一个括号，
	// 使 file 变成 `a.md) — see (x` 而 description 只剩 `y`。
	it("round-trips a description containing parentheses and an em dash", () => {
		const line = formatIndexLine("A", "a.md", "see (x) — y");
		expect(parseEntryIndex(line).entries[0]).toMatchObject({ name: "A", file: "a.md", description: "see (x) — y" });
	});
});

describe("upsertIndexLine", () => {
	it("appends right after the last entry, keeping later handwritten lines", () => {
		const out = upsertIndexLine(HANDWRITTEN, { name: "B", file: "b.md", description: "第二条" });
		expect(out).toBe("# Memory Index\n\n## Project\n- [A](a.md) — 第一条\n- [B](b.md) — 第二条\n\n<!-- keep me -->\n");
	});

	it("updates an existing line in place without moving anything", () => {
		const raw = "# Memory Index\n- [A](a.md) — 旧\n- [B](b.md) — B\n<!-- tail -->\n";
		const out = upsertIndexLine(raw, { name: "A", file: "a.md", description: "新" });
		expect(out).toBe("# Memory Index\n- [A](a.md) — 新\n- [B](b.md) — B\n<!-- tail -->\n");
	});

	it("writes at an explicit line number when asked", () => {
		const raw = "- [A](a.md) — A\n- [B](b.md) — B\n";
		const out = upsertIndexLine(raw, { name: "A2", file: "a2.md", description: "A" }, { atLineNo: 0 });
		expect(out).toBe("- [A2](a2.md) — A\n- [B](b.md) — B\n");
	});

	it("handles an empty index", () => {
		expect(upsertIndexLine("", { name: "A", file: "a.md", description: "A" })).toBe("- [A](a.md) — A\n");
	});

	it("appends when the index has only handwritten content", () => {
		expect(upsertIndexLine("# Memory Index\n", { name: "A", file: "a.md", description: "A" })).toBe(
			"# Memory Index\n- [A](a.md) — A\n",
		);
	});
});

describe("removeIndexLine", () => {
	it("removes only the target line and keeps everything else verbatim", () => {
		const raw = "# Memory Index\n\n## Project\n- [A](a.md) — A\n- [B](b.md) — B\n\n<!-- keep me -->\n";
		expect(removeIndexLine(raw, "a.md")).toBe("# Memory Index\n\n## Project\n- [B](b.md) — B\n\n<!-- keep me -->\n");
	});

	it("returns the input unchanged when the file is absent", () => {
		expect(removeIndexLine(HANDWRITTEN, "zzz.md")).toBe(HANDWRITTEN);
	});
});

describe("indexCapacity", () => {
	it("counts non-empty lines and utf8 bytes", () => {
		const cap = indexCapacity(HANDWRITTEN, 200, 25600);
		expect(cap.lineCount).toBe(4);
		expect(cap.byteLength).toBe(Buffer.byteLength(HANDWRITTEN, "utf8"));
		expect(cap.ok).toBe(true);
	});

	it("treats exactly-at-limit as ok and one-over as not ok", () => {
		const atLimit = "- [A](a.md) — A\n- [B](b.md) — B\n";
		expect(indexCapacity(atLimit, 2, 1024).ok).toBe(true);
		expect(indexCapacity(atLimit, 1, 1024).ok).toBe(false);
		expect(indexCapacity(atLimit, 2, Buffer.byteLength(atLimit, "utf8")).ok).toBe(true);
		expect(indexCapacity(atLimit, 2, Buffer.byteLength(atLimit, "utf8") - 1).ok).toBe(false);
	});
});
