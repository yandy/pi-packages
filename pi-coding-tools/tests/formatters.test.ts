import { describe, expect, it } from "vitest";
import type { SgResult } from "../src/ast-grep/types";
import { formatHover, formatNavigate, formatSearchResult, formatSymbolTree } from "../src/formatters";
import type { DocumentSymbol, Hover, Location } from "../src/lsp/types";

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

const sym: DocumentSymbol = {
	name: "UserService",
	kind: 5,
	detail: "class UserService",
	range: { start: { line: 0, character: 0 }, end: { line: 9, character: 0 } },
	selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 16 } },
	children: [
		{
			name: "findById",
			kind: 6,
			detail: "findById(id: string): User",
			range: { start: { line: 1, character: 2 }, end: { line: 3, character: 2 } },
			selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 10 } },
		},
	],
};

describe("formatSymbolTree", () => {
	it("renders tree with kind + detail", () => {
		const out = formatSymbolTree([sym], "src/user.ts");
		expect(out).toContain("src/user.ts");
		expect(out).toContain("class UserService");
		expect(out).toContain("findById(id: string): User");
		expect(out).toContain("├──");
	});
});

describe("formatHover", () => {
	it("renders markdown contents", () => {
		const h: Hover = {
			contents: { kind: "markdown", value: "`(method) findById(id: string): User`" },
		};
		expect(formatHover(h)).toContain("findById(id: string): User");
	});
	it("null hover → message", () => {
		expect(formatHover(null)).toMatch(/No hover/);
	});
});

describe("formatNavigate", () => {
	const loc: Location = {
		uri: "file:///proj/src/user.ts",
		range: { start: { line: 4, character: 0 }, end: { line: 4, character: 10 } },
	};
	it("definition → single location", () => {
		const out = formatNavigate("definition", loc, "/proj");
		expect(out).toContain("definition");
		expect(out).toContain("src/user.ts:5:1");
	});
	it("references → list", () => {
		const out = formatNavigate("references", [loc, loc], "/proj");
		expect(out).toContain("references (2)");
	});
});
