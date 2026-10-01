import { describe, expect, it } from "vitest";
import { deriveDescription, parseEntryFile, serializeEntryFile, type EntryMeta } from "../src/entry-file";

const META: EntryMeta = {
	name: "Use real DB in tests",
	description: "集成测试必须连真实 PostgreSQL，不要 mock",
	type: "feedback",
	created: "2026-10-01",
	modified: "2026-10-01T09:12:33.123Z",
};

describe("serializeEntryFile / parseEntryFile", () => {
	it("round-trips meta and multi-line body with headings", () => {
		const body = "第一段。\n\n## 细节\n\n- 要点一\n- 要点二";
		const parsed = parseEntryFile(serializeEntryFile(META, body));
		expect(parsed?.meta).toEqual(META);
		expect(parsed?.body).toBe(body);
	});

	it("round-trips an empty body", () => {
		const parsed = parseEntryFile(serializeEntryFile(META, ""));
		expect(parsed?.meta).toEqual(META);
		expect(parsed?.body).toBe("");
	});

	it("keeps a body containing a horizontal rule", () => {
		const body = "上文\n\n---\n\n下文";
		expect(parseEntryFile(serializeEntryFile(META, body))?.body).toBe(body);
	});

	// CRLF 文件（Windows 编辑器、git autocrlf、记事本手改 —— D11 明确鼓励手工编辑）不得解析为 null：
	// 那会让该 entry 从清单、搜索、remove/replace 定位与 rebuildIndex 里一起消失 —— 静默丢记忆。
	it("round-trips a CRLF file back to the original meta and body", () => {
		const body = "第一段。\n\n## 细节\n\n- 要点一\n\n---\n\n下文";
		const crlf = serializeEntryFile(META, body).replace(/\n/g, "\r\n");
		const parsed = parseEntryFile(crlf);
		expect(parsed?.meta).toEqual(META);
		expect(parsed?.body).toBe(body);
	});

	it("returns null without frontmatter", () => {
		expect(parseEntryFile("just text")).toBeNull();
	});

	it("returns null when a required field is missing", () => {
		const raw = "---\nname: A\ndescription: D\ntype: user\ncreated: 2026-10-01\n---\nbody\n";
		expect(parseEntryFile(raw)).toBeNull();
	});

	it("returns null for an unknown type", () => {
		const raw = sign("bogus");
		expect(parseEntryFile(raw)).toBeNull();
	});

	it("accepts every declared type", () => {
		for (const type of ["user", "feedback", "project", "reference"] as const) {
			expect(parseEntryFile(serializeEntryFile({ ...META, type }, "b"))?.meta.type).toBe(type);
		}
	});

	it("round-trips an empty description", () => {
		const parsed = parseEntryFile(serializeEntryFile({ ...META, description: "" }, "body"));
		expect(parsed?.meta.description).toBe("");
		expect(parsed?.body).toBe("body");
	});

	it("returns null when the description line is absent entirely", () => {
		const raw = "---\nname: A\ntype: user\ncreated: 2026-10-01\nmodified: 2026-10-01T00:00:00.000Z\n---\nbody\n";
		expect(parseEntryFile(raw)).toBeNull();
	});
});

function sign(type: string): string {
	return `---\nname: A\ndescription: D\ntype: ${type}\ncreated: 2026-10-01\nmodified: 2026-10-01T00:00:00.000Z\n---\nbody\n`;
}

describe("deriveDescription", () => {
	it("takes the first sentence", () => {
		expect(deriveDescription("第一句。第二句。")).toBe("第一句。");
		expect(deriveDescription("First sentence. Second one.")).toBe("First sentence.");
	});

	it("strips markdown markers from the first line", () => {
		expect(deriveDescription("## 标题在这里\n后续")).toBe("标题在这里");
		expect(deriveDescription("- 要点一条\n后续")).toBe("要点一条");
		expect(deriveDescription("1. 编号要点\n后续")).toBe("编号要点");
	});

	it("skips leading blank lines", () => {
		expect(deriveDescription("\n\n实际内容")).toBe("实际内容");
	});

	it("truncates at the limit with an ellipsis", () => {
		const out = deriveDescription("x".repeat(300), 200);
		expect(out.length).toBe(200);
		expect(out.endsWith("…")).toBe(true);
	});

	it("returns an empty string for an empty body", () => {
		expect(deriveDescription("\n \n")).toBe("");
	});
});
