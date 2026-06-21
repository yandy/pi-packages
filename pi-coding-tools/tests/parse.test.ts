import { describe, expect, it } from "vitest";
import {
	APPLY_PATCH_LARK_GRAMMAR,
	extractPatchedPaths,
	normalizeSeekLine,
	PatchParseError,
	parseNonEmptyPatch,
	parsePatch,
} from "../src/parse";

describe("parsePatch", () => {
	it("parses a simple add file hunk", () => {
		const patch = `*** Begin Patch
*** Add File: hello.txt
+Hello, World!
+Second line
*** End Patch`;
		const result = parsePatch(patch);
		expect(result).toEqual([
			{
				type: "add",
				filePath: "hello.txt",
				content: "Hello, World!\nSecond line\n",
			},
		]);
	});

	it("parses multiple hunks", () => {
		const patch = `*** Begin Patch
*** Add File: a.txt
+content a
*** Delete File: b.txt
*** End Patch`;
		const result = parsePatch(patch);
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({ type: "add", filePath: "a.txt", content: "content a\n" });
		expect(result[1]).toEqual({ type: "delete", filePath: "b.txt" });
	});

	it("parses add file with empty content", () => {
		const patch = `*** Begin Patch
*** Add File: empty.txt
*** End Patch`;
		const result = parsePatch(patch);
		expect(result).toEqual([{ type: "add", filePath: "empty.txt", content: "" }]);
	});

	it("parses delete file hunk", () => {
		const patch = `*** Begin Patch
*** Delete File: old.txt
*** End Patch`;
		const result = parsePatch(patch);
		expect(result).toEqual([{ type: "delete", filePath: "old.txt" }]);
	});

	it("parses update file with @@ context", () => {
		const patch = `*** Begin Patch
*** Update File: foo.ts
@@ function bar() {
 context line
-old line
+new line
 context line 2
*** End Patch`;
		const result = parsePatch(patch);
		expect(result).toHaveLength(1);
		expect(result[0].type).toBe("update");
		if (result[0].type === "update") {
			expect(result[0].filePath).toBe("foo.ts");
			expect(result[0].chunks).toHaveLength(1);
			expect(result[0].chunks[0].changeContexts).toEqual(["function bar() {"]);
			expect(result[0].chunks[0].oldLines).toEqual(["context line", "old line", "context line 2"]);
			expect(result[0].chunks[0].newLines).toEqual(["context line", "new line", "context line 2"]);
			expect(result[0].chunks[0].isEndOfFile).toBe(false);
		}
	});

	it("parses update file with *** Move to", () => {
		const patch = `*** Begin Patch
*** Update File: old.ts
*** Move to: new.ts
@@ ctx
-old
+new
*** End Patch`;
		const result = parsePatch(patch);
		expect(result[0].type).toBe("update");
		if (result[0].type === "update") {
			expect(result[0].movePath).toBe("new.ts");
		}
	});

	it("parses update file with *** End of File", () => {
		const patch = `*** Begin Patch
*** Update File: foo.ts
@@ 
 context
+appended
*** End of File
*** End Patch`;
		const result = parsePatch(patch);
		expect(result[0].type).toBe("update");
		if (result[0].type === "update") {
			expect(result[0].chunks[0].isEndOfFile).toBe(true);
		}
	});

	it("parses update with no @@ context (first chunk allowed)", () => {
		const patch = `*** Begin Patch
*** Update File: foo.ts
-old
+new
*** End Patch`;
		const result = parsePatch(patch);
		expect(result[0].type).toBe("update");
		if (result[0].type === "update") {
			expect(result[0].chunks[0].changeContexts).toEqual([]);
		}
	});

	it("throws PatchParseError when missing *** Begin Patch", () => {
		expect(() => parsePatch("*** End Patch")).toThrow(PatchParseError);
	});

	it("throws PatchParseError when missing *** End Patch", () => {
		expect(() => parsePatch("*** Begin Patch\n*** Add File: a.txt\n+content")).toThrow(PatchParseError);
	});

	it("throws PatchParseError on empty patch", () => {
		expect(() => parseNonEmptyPatch("*** Begin Patch\n*** End Patch")).toThrow(PatchParseError);
	});

	it("throws PatchParseError on invalid hunk header", () => {
		expect(() => parsePatch("*** Begin Patch\n*** Unknown: foo\n*** End Patch")).toThrow(PatchParseError);
	});

	it("normalizes CRLF to LF", () => {
		const patch = "*** Begin Patch\r\n*** Add File: a.txt\r\n+content\r\n*** End Patch\r\n";
		const result = parsePatch(patch);
		expect(result[0]).toEqual({ type: "add", filePath: "a.txt", content: "content\n" });
	});

	it("unwraps heredoc wrapper", () => {
		const inner = "*** Begin Patch\n*** Add File: a.txt\n+content\n*** End Patch";
		const wrapped = `<<EOF\n${inner}\nEOF`;
		const result = parsePatch(wrapped);
		expect(result).toHaveLength(1);
	});
});

describe("extractPatchedPaths", () => {
	it("extracts add/delete/update paths", () => {
		const patch = `*** Begin Patch
*** Add File: a.txt
+content
*** Update File: b.ts
@@ ctx
-old
+new
*** Delete File: c.md
*** End Patch`;
		expect(extractPatchedPaths(patch)).toEqual(["a.txt", "b.ts", "c.md"]);
	});

	it("returns empty array for text without patch markers", () => {
		expect(extractPatchedPaths("no patch here")).toEqual([]);
	});
});

describe("normalizeSeekLine", () => {
	it("replaces smart quotes with ASCII", () => {
		expect(normalizeSeekLine("hello \u201Cworld\u201D")).toBe('hello "world"');
	});

	it("replaces em-dash with hyphen", () => {
		expect(normalizeSeekLine("a\u2014b")).toBe("a-b");
	});

	it("replaces non-breaking spaces with regular spaces", () => {
		expect(normalizeSeekLine("a\u00A0b")).toBe("a b");
	});

	it("trims whitespace", () => {
		expect(normalizeSeekLine("  hello  ")).toBe("hello");
	});
});

describe("APPLY_PATCH_LARK_GRAMMAR", () => {
	it("contains the lark grammar definition", () => {
		expect(APPLY_PATCH_LARK_GRAMMAR).toContain('"*** Begin Patch"');
		expect(APPLY_PATCH_LARK_GRAMMAR).toContain('"*** End Patch"');
		expect(APPLY_PATCH_LARK_GRAMMAR).toContain("add_hunk");
		expect(APPLY_PATCH_LARK_GRAMMAR).toContain("update_hunk");
		expect(APPLY_PATCH_LARK_GRAMMAR).toContain("delete_hunk");
	});
});
