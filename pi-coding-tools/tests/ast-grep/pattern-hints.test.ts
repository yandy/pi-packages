import { describe, expect, it } from "vitest";
import { getPatternHint } from "../../src/ast-grep/pattern-hints";

describe("getPatternHint", () => {
	it("detects \\w regex escape", () => {
		expect(getPatternHint("foo\\w+", "typescript")).toMatch(/regex/);
	});

	it("detects .* wildcard", () => {
		expect(getPatternHint("foo.*bar", "typescript")).toMatch(/regex|\$\$\$/);
	});

	it("detects alternation |", () => {
		expect(getPatternHint("foo|bar", "typescript")).toMatch(/alternation/);
	});

	it("detects python trailing colon on def", () => {
		expect(getPatternHint("def foo():", "python")).toMatch(/trailing colon/);
	});

	it("detects incomplete ts function pattern", () => {
		expect(getPatternHint("function $NAME", "typescript")).toMatch(/params and body/);
	});

	it("returns null for valid pattern", () => {
		expect(getPatternHint("console.log($MSG)", "typescript")).toBeNull();
	});
});
