import { describe, expect, it } from "vitest";
import type { CliRewriteMatch, SgResult, SgRewriteResult } from "../src/ast-grep/types";
import { formatHover, formatNavigate, formatRewriteResult, formatSearchResult, formatSymbolTree } from "../src/formatters";
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
		expect(out).toContain("└──");
	});
});

describe("formatHover", () => {
	it("renders markdown contents", () => {
		const h: Hover = {
			contents: { kind: "markdown", value: "`(method) findById(id: string): User`" },
		};
		expect(formatHover(h)).toContain("findById(id: string): User");
		// inline backticks stripped
		expect(formatHover(h)).not.toContain("`findById");
	});
	it("strips fenced code blocks, keeping inner content", () => {
		const h: Hover = {
			contents: { kind: "markdown", value: "```typescript\nfunction foo(x: number): void\n```" },
		};
		const out = formatHover(h);
		expect(out).toContain("function foo(x: number): void");
		expect(out).not.toContain("```");
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

const rewriteMatch: CliRewriteMatch = {
	text: 'console.log("hi")',
	file: "src/index.ts",
	lines: 'console.log("hi");\n',
	language: "typescript",
	charCount: { leading: 0, trailing: 1 },
	range: { start: { line: 4, column: 0 }, end: { line: 4, column: 19 }, byteOffset: { start: 0, end: 19 } },
	replacement: 'logger.info("hi")',
	replacementOffsets: { start: 0, end: 19 },
};

describe("formatRewriteResult", () => {
	it("dry-run lists before->after with file:line and dry-run marker", () => {
		const out = formatRewriteResult({
			matches: [rewriteMatch],
			totalMatches: 1,
			truncated: false,
			applied: false,
		});
		expect(out).toContain("1 match");
		expect(out).toContain("dry-run");
		expect(out).toContain("src/index.ts:5:1");
		expect(out).toContain('console.log("hi")');
		expect(out).toContain('logger.info("hi")');
	});

	it("groups by file with count in dry-run", () => {
		const m2 = { ...rewriteMatch, range: { ...rewriteMatch.range, start: { line: 10, column: 0 } } };
		const out = formatRewriteResult({
			matches: [rewriteMatch, m2],
			totalMatches: 2,
			truncated: false,
			applied: false,
		});
		expect(out).toContain("src/index.ts (2 matches)");
	});

	it("apply mode shows Applied summary with per-file changes", () => {
		const out = formatRewriteResult({
			matches: [rewriteMatch],
			totalMatches: 1,
			truncated: false,
			applied: true,
		});
		expect(out).toContain("Applied 1 change");
		expect(out).toContain("src/index.ts (1 change)");
		expect(out).not.toContain("dry-run");
	});

	it("no matches", () => {
		expect(
			formatRewriteResult({ matches: [], totalMatches: 0, truncated: false, applied: false }),
		).toContain("No matches");
	});

	it("aligns the + replacement line under the - original line", () => {
		const out = formatRewriteResult({
			matches: [rewriteMatch],
			totalMatches: 1,
			truncated: false,
			applied: false,
		});
		const lines = out.split("\n");
		const dashLine = lines.find((l) => l.includes("- console.log"));
		const plusLine = lines.find((l) => l.includes("+ logger.info"));
		expect(dashLine).toBeDefined();
		expect(plusLine).toBeDefined();
		const dashCol = dashLine!.indexOf("-");
		const plusCol = plusLine!.indexOf("+");
		expect(plusCol).toBe(dashCol);
	});

	it("surfaces error", () => {
		expect(
			formatRewriteResult({ matches: [], totalMatches: 0, truncated: false, error: "boom", applied: false }),
		).toContain("boom");
	});
});
