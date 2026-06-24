import { describe, expect, it } from "vitest";
import { parseSgStdout } from "../../src/ast-grep/search";

const sampleMatches = [
	{
		text: 'console.log("hi")',
		file: "src/index.ts",
		lines: 'console.log("hi");\n',
		language: "typescript",
		charCount: { leading: 0, trailing: 0 },
		range: {
			start: { line: 10, column: 2 },
			end: { line: 10, column: 20 },
			byteOffset: { start: 0, end: 20 },
		},
	},
];

describe("parseSgStdout", () => {
	it("parses valid compact json array", () => {
		const result = parseSgStdout(JSON.stringify(sampleMatches));
		expect(result.matches).toHaveLength(1);
		expect(result.matches[0].file).toBe("src/index.ts");
		expect(result.matches[0].range.start.line).toBe(10);
		expect(result.totalMatches).toBe(1);
		expect(result.truncated).toBe(false);
	});

	it("returns empty on blank stdout", () => {
		const result = parseSgStdout("   ");
		expect(result.matches).toEqual([]);
		expect(result.totalMatches).toBe(0);
	});

	it("returns empty on invalid json", () => {
		const result = parseSgStdout("not json");
		expect(result.matches).toEqual([]);
		expect(result.totalMatches).toBe(0);
	});
});
