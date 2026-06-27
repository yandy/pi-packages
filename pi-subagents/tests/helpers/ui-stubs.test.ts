import { describe, expect, it } from "vitest";
import { makeMenuUI } from "./ui-stubs";

describe("makeMenuUI", () => {
	it("has all required UI methods", () => {
		const ui = makeMenuUI();
		expect(typeof ui.select).toBe("function");
		expect(typeof ui.input).toBe("function");
		expect(typeof ui.confirm).toBe("function");
		expect(typeof ui.editor).toBe("function");
		expect(typeof ui.notify).toBe("function");
		expect(typeof ui.custom).toBe("function");
	});

	it("select returns undefined when no results provided", () => {
		const ui = makeMenuUI();
		expect(ui.select([])).toBeUndefined();
	});

	it("select returns results in sequence", () => {
		const ui = makeMenuUI(["first", "second", undefined]);
		expect(ui.select([])).toBe("first");
		expect(ui.select([])).toBe("second");
		expect(ui.select([])).toBeUndefined();
	});

	it("stubs are vi.fn() instances", () => {
		const ui = makeMenuUI();
		expect(ui.select.mock).toBeDefined();
		expect(ui.input.mock).toBeDefined();
	});
});
