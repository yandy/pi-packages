import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { TodoItem } from "../src/todo-store.js";
import { renderWidgetLines, selectWindow, TodoWidget, WIDGET_MAX_ROWS } from "../src/widget.js";

// Minimal stub of the Theme shape used by the widget.
const theme = {
	fg: (_name: string, text: string) => text,
	strikethrough: vi.fn((text: string) => text),
} as any;

const todo = (
	id: string,
	title: string,
	status: TodoItem["status"] = "pending",
	blockedBy?: string[],
): TodoItem => ({
	id,
	title,
	status,
	...(blockedBy ? { blockedBy } : {}),
});

/** 一张 n 项的板子，可给指定 id 覆盖状态/依赖。 */
const board = (count: number, extra: Record<number, Partial<TodoItem>> = {}): TodoItem[] =>
	Array.from({ length: count }, (_, i) => {
		const id = String(i + 1);
		return { ...todo(id, `task ${i + 1}`), ...extra[Number(id)] };
	});

describe("selectWindow", () => {
	it("shows every item when the budget covers the list", () => {
		const items = ["a", "b", "c"];
		expect(selectWindow(items, 0, 5)).toEqual({ visible: items, hiddenAbove: 0, hiddenBelow: 0 });
	});

	it("anchors on the given index and fills forward first", () => {
		const result = selectWindow(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"], 2, 4);
		expect(result.visible).toEqual(["c", "d", "e", "f"]);
		expect(result.hiddenAbove).toBe(2);
		expect(result.hiddenBelow).toBe(4);
	});

	it("spends leftover budget above the anchor when the tail is short", () => {
		const result = selectWindow(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"], 8, 4);
		expect(result.visible).toEqual(["g", "h", "i", "j"]);
		expect(result.hiddenAbove).toBe(6);
		expect(result.hiddenBelow).toBe(0);
	});

	it("keeps the anchor when the budget is a single row", () => {
		const result = selectWindow(["a", "b", "c"], 1, 1);
		expect(result.visible).toEqual(["b"]);
		expect(result.hiddenAbove).toBe(1);
		expect(result.hiddenBelow).toBe(1);
	});

	it("clamps an anchor past the end of the list", () => {
		const result = selectWindow(["a", "b", "c"], 99, 2);
		expect(result.visible).toEqual(["b", "c"]);
		expect(result.hiddenAbove).toBe(1);
		expect(result.hiddenBelow).toBe(0);
	});

	it("returns an empty window for an empty list", () => {
		expect(selectWindow([], 0, 4)).toEqual({ visible: [], hiddenAbove: 0, hiddenBelow: 0 });
	});

	it("centers the window on the anchor when align is center", () => {
		const result = selectWindow(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"], 5, 4, { align: "center" });
		expect(result.visible).toEqual(["e", "f", "g", "h"]);
		expect(result.hiddenAbove).toBe(4);
		expect(result.hiddenBelow).toBe(2);
	});

	it("keeps the centered window inside the list near the end", () => {
		const result = selectWindow(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"], 9, 4, { align: "center" });
		expect(result.visible).toEqual(["g", "h", "i", "j"]);
		expect(result.hiddenAbove).toBe(6);
		expect(result.hiddenBelow).toBe(0);
	});
});

describe("renderWidgetLines", () => {
	it("returns null when there are no todos", () => {
		expect(renderWidgetLines([], theme, { width: 80 })).toBeNull();
	});

	it("returns null when all todos are done", () => {
		expect(renderWidgetLines([todo("1", "Done", "done")], theme, { width: 80 })).toBeNull();
	});

	it("renders one line per todo plus a trailing progress summary", () => {
		const items = [todo("1", "Plan"), todo("2", "Build", "in_progress"), todo("3", "Shipped", "done")];
		const lines = renderWidgetLines(items, theme, { width: 80 });
		expect(lines).toHaveLength(4);
		expect(lines?.[0]).toContain("○ #1 Plan");
		expect(lines?.[1]).toContain("◉ #2 Build");
		expect(lines?.[2]).toContain("✓ #3 Shipped");
		expect(lines?.[3]).toContain("✓ 1/3");
	});

	it("keeps the in-progress todo visible on a board longer than the budget", () => {
		const items = board(12, { 7: { status: "in_progress" } });
		const lines = renderWidgetLines(items, theme, { width: 80 });
		expect(lines?.some((line) => line.includes("#7"))).toBe(true);
		expect(lines?.length).toBeLessThanOrEqual(WIDGET_MAX_ROWS);
	});

	it("never exceeds the row budget", () => {
		for (const count of [1, 3, 8, 9, 12, 25]) {
			for (const maxRows of [4, 6, 8]) {
				const lines = renderWidgetLines(board(count), theme, { width: 80, maxRows });
				expect(lines?.length).toBeLessThanOrEqual(maxRows);
			}
		}
	});

	it("reports how many todos are hidden above and below", () => {
		const lines = renderWidgetLines(board(20, { 11: { status: "in_progress" } }), theme, {
			width: 80,
			maxRows: 8,
		});
		expect(lines?.join("\n")).toMatch(/↑ \d+/);
		expect(lines?.join("\n")).toMatch(/↓ \d+/);
	});

	it("reports only the upper marker when every hidden todo is behind the anchor", () => {
		const items = board(12, { 12: { status: "in_progress" } });
		for (let i = 0; i < 11; i++) items[i].status = "done";

		const rendered = renderWidgetLines(items, theme, { width: 80 })?.join("\n");
		expect(rendered).toMatch(/↑ 6/);
		expect(rendered).not.toMatch(/↓ \d+/);
	});

	it("keeps the budget below the host's 10-line cap", () => {
		// 宿主对字符串数组 widget 硬裁 10 行；预算必须留在这条线以下。
		expect(WIDGET_MAX_ROWS).toBeLessThan(10);
	});

	it("falls back to a usable window when maxRows is smaller than the overhead", () => {
		const lines = renderWidgetLines(board(20, { 10: { status: "in_progress" } }), theme, { width: 80, maxRows: 1 });
		expect(lines?.length).toBeLessThanOrEqual(4);
	});

	it("truncates long titles to the available width", () => {
		const longTitle = "修复".repeat(30);
		const lines = renderWidgetLines([todo("1", longTitle, "in_progress")], theme, { width: 20 });
		expect(lines).not.toBeNull();
		for (const line of lines ?? []) expect(visibleWidth(line)).toBeLessThanOrEqual(20);
		expect(lines?.[0]).not.toContain(longTitle);
	});

	it("summarizes pending and blocked counts in the progress line", () => {
		const items = [
			todo("1", "Blocked", "pending", ["2"]),
			todo("2", "Pending"),
			todo("3", "Running", "in_progress"),
			todo("4", "Done A", "done"),
			todo("5", "Done B", "done"),
			todo("6", "Done C", "done"),
		];
		const summary = renderWidgetLines(items, theme, { width: 80 })?.at(-1);
		expect(summary).toContain("✓ 3/6");
		expect(summary).toContain("○ 2");
		expect(summary).toContain("🔒 1");
	});

	it("shows the blocked marker for blocked todos", () => {
		const items = [todo("1", "First"), todo("2", "Second", "pending", ["1"])];
		const lines = renderWidgetLines(items, theme, { width: 80 });
		expect(lines?.[1]).toContain("🔒 #2 Second");
	});

	it("strikes through done titles", () => {
		theme.strikethrough.mockClear();
		renderWidgetLines([todo("1", "Shipped", "done"), todo("2", "Next")], theme, { width: 80 });
		expect(theme.strikethrough).toHaveBeenCalledWith("Shipped");
	});
});

describe("TodoWidget", () => {
	it("renders nothing when the list is hidden", () => {
		expect(new TodoWidget([todo("1", "Done", "done")], theme).render(80)).toEqual([]);
	});

	it("keeps every rendered line within the given width", () => {
		const items = [todo("1", "修复".repeat(40), "in_progress")];
		const lines = new TodoWidget(items, theme).render(24);
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
	});
});
