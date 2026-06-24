import { describe, expect, it } from "vitest";
import { parseRewriteStdout } from "../../src/ast-grep/rewrite";

const sampleRewriteMatches = [
	{
		text: 'console.log("hi")',
		file: "src/index.ts",
		lines: 'console.log("hi");\n',
		language: "typescript",
		charCount: { leading: 0, trailing: 1 },
		range: {
			start: { line: 4, column: 0 },
			end: { line: 4, column: 19 },
			byteOffset: { start: 0, end: 19 },
		},
		replacement: 'logger.info("hi")',
		replacementOffsets: { start: 0, end: 19 },
	},
];

describe("parseRewriteStdout", () => {
	it("parses valid compact json array with replacement fields", () => {
		const result = parseRewriteStdout(JSON.stringify(sampleRewriteMatches));
		expect(result.matches).toHaveLength(1);
		expect(result.matches[0].file).toBe("src/index.ts");
		expect(result.matches[0].replacement).toBe('logger.info("hi")');
		expect(result.matches[0].replacementOffsets).toEqual({ start: 0, end: 19 });
		expect(result.totalMatches).toBe(1);
		expect(result.truncated).toBe(false);
	});

	it("returns empty on blank stdout", () => {
		const result = parseRewriteStdout("   ");
		expect(result.matches).toEqual([]);
		expect(result.totalMatches).toBe(0);
		expect(result.truncated).toBe(false);
	});

	it("returns empty on invalid json", () => {
		const result = parseRewriteStdout("not json");
		expect(result.matches).toEqual([]);
		expect(result.totalMatches).toBe(0);
	});

	it("returns empty when matches lack replacement field", () => {
		const noReplacement = [
			{
				text: "x",
				file: "a.ts",
				lines: "x",
				language: "typescript",
				charCount: { leading: 0, trailing: 0 },
				range: {
					start: { line: 0, column: 0 },
					end: { line: 0, column: 1 },
					byteOffset: { start: 0, end: 1 },
				},
			},
		];
		const result = parseRewriteStdout(JSON.stringify(noReplacement));
		expect(result.matches).toEqual([]);
	});
});
