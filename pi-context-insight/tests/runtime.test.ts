import { describe, expect, it } from "vitest";
import { CLIENT_RUNTIME } from "../src/client/runtime";

interface Runtime {
	visibleRows: (rows: Array<{ key: string; text: string }>, query: string) => string[];
	nextIndex: (current: number, delta: number, max: number) => number;
	resolveLang: (stored: string | null, initial: "en" | "zh") => "en" | "zh";
}

function load(): Runtime {
	return new Function("window", "document", `${CLIENT_RUNTIME}; return window.__insight;`)({}, undefined) as Runtime;
}

describe("client runtime", () => {
	it("boots without a document and exposes pure helpers", () => {
		expect(typeof load().visibleRows).toBe("function");
	});
	it("filters rows case-insensitively", () => {
		const rows = [
			{ key: "a", text: "Bash session" },
			{ key: "b", text: "read file" },
		];
		expect(load().visibleRows(rows, "ba")).toEqual(["a"]);
		expect(load().visibleRows(rows, "")).toEqual(["a", "b"]);
	});
	it("clamps navigation", () => {
		const { nextIndex } = load();
		expect(nextIndex(0, -1, 3)).toBe(0);
		expect(nextIndex(2, 1, 3)).toBe(2);
		expect(nextIndex(1, 1, 3)).toBe(2);
	});
	it("prefers a stored language and rejects unknown values", () => {
		expect(load().resolveLang("zh", "en")).toBe("zh");
		expect(load().resolveLang(null, "zh")).toBe("zh");
		expect(load().resolveLang("de", "en")).toBe("en");
	});
	it("contains no forbidden APIs", () => {
		for (const banned of ["innerHTML", "eval(", "new Function", "fetch(", "document.write"]) {
			expect(CLIENT_RUNTIME).not.toContain(banned);
		}
	});
});
