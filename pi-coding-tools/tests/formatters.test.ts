import { describe, expect, it } from "vitest";
import type { SgResult } from "../src/ast-grep/types";
import { formatSearchResult } from "../src/formatters";

const match: SgResult["matches"][number] = {
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
};

describe("formatSearchResult", () => {
	it("formats matches with file:line:col and snippet", () => {
		const out = formatSearchResult({
			matches: [match],
			totalMatches: 1,
			truncated: false,
		});
		expect(out).toContain("1 match");
		expect(out).toContain("src/index.ts:11:3");
		expect(out).toContain('console.log("hi")');
	});

	it("groups by file with count", () => {
		const m2 = {
			...match,
			file: "src/index.ts",
			range: {
				...match.range,
				start: { line: 20, column: 0 },
			},
		};
		const out = formatSearchResult({
			matches: [match, m2],
			totalMatches: 2,
			truncated: false,
		});
		expect(out).toContain("src/index.ts (2 matches)");
	});

	it("no matches", () => {
		expect(
			formatSearchResult({
				matches: [],
				totalMatches: 0,
				truncated: false,
			}),
		).toContain("No matches");
	});

	it("surfaces error", () => {
		expect(
			formatSearchResult({
				matches: [],
				totalMatches: 0,
				truncated: false,
				error: "boom",
			}),
		).toContain("boom");
	});
});
