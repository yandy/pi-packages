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
});

describe("formatIndexLine", () => {
	it("uses an em dash surrounded by single spaces", () => {
		expect(formatIndexLine("A", "a.md", "d")).toBe("- [A](a.md) — d");
	});

	it("round-trips through parseEntryIndex", () => {
		const line = formatIndexLine("集成测试", "集成测试.md", "摘要");
		expect(parseEntryIndex(line).entries[0]).toMatchObject({ name: "集成测试", file: "集成测试.md", description: "摘要" });
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
