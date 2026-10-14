import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { TodoItem } from "../src/todo-store.js";
import { renderTodoViewLines, TodoView } from "../src/todo-view.js";

// Minimal stub of the Theme shape used by the view.
const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
	strikethrough: (text: string) => text,
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

const board = (count: number, extra: Record<number, Partial<TodoItem>> = {}): TodoItem[] =>
	Array.from({ length: count }, (_, i) => {
		const id = String(i + 1);
		return { ...todo(id, `task ${i + 1}`), ...extra[Number(id)] };
	});

// Raw terminal sequences, matching how the TUI delivers key presses.
const KEY_UP = "\u001b[A";
const KEY_DOWN = "\u001b[B";
const KEY_ESCAPE = "\u001b";
const KEY_END = "\u001b[F";

describe("renderTodoViewLines", () => {
	it("lists every todo when they fit the row budget", () => {
		const lines = renderTodoViewLines(board(3), theme, { width: 60, rows: 20, selectedIndex: 0 });
		expect(lines.some((line) => line.includes("#1"))).toBe(true);
		expect(lines.some((line) => line.includes("#3"))).toBe(true);
	});

	it("never renders more lines than the row budget", () => {
		for (const rows of [6, 8, 12]) {
			const lines = renderTodoViewLines(board(40), theme, { width: 60, rows, selectedIndex: 20 });
			expect(lines.length).toBeLessThanOrEqual(rows);
		}
	});

	it("reports the position when the list is longer than the window", () => {
		const lines = renderTodoViewLines(board(40), theme, { width: 60, rows: 8, selectedIndex: 20 });
		expect(lines.join("\n")).toContain("(21/40)");
	});

	it("marks the selected row with a pointer", () => {
		const lines = renderTodoViewLines(board(5), theme, { width: 60, rows: 20, selectedIndex: 2 });
		expect(lines.find((line) => line.includes("#3"))).toContain("→");
	});

	it("keeps every line within the given width", () => {
		const lines = renderTodoViewLines(board(5), theme, { width: 24, rows: 20, selectedIndex: 0 });
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
	});

	it("truncates long titles", () => {
		const longTitle = "修复".repeat(30);
		const lines = renderTodoViewLines([todo("1", longTitle)], theme, { width: 30, rows: 20, selectedIndex: 0 });
		expect(lines.some((line) => line.includes("#1"))).toBe(true);
		expect(lines.join("\n")).not.toContain(longTitle);
	});

	it("summarizes progress in the header", () => {
		const items = [todo("1", "Done A", "done"), todo("2", "Running", "in_progress"), todo("3", "Next")];
		const header = renderTodoViewLines(items, theme, { width: 60, rows: 20, selectedIndex: 0 })[1];
		expect(header).toContain("✓ 1/3");
	});
});

describe("TodoView", () => {
	const tui = { terminal: { rows: 24 } } as any;

	it("moves the selection down and up", () => {
		const view = new TodoView(board(5), theme, tui, undefined, () => {});
		view.handleInput(KEY_DOWN);
		expect(view.selectedIndex).toBe(1);
		view.handleInput(KEY_UP);
		expect(view.selectedIndex).toBe(0);
	});

	it("clamps the selection at both ends", () => {
		const view = new TodoView(board(3), theme, tui, undefined, () => {});
		view.handleInput(KEY_UP);
		expect(view.selectedIndex).toBe(0);
		for (let i = 0; i < 10; i++) view.handleInput(KEY_DOWN);
		expect(view.selectedIndex).toBe(2);
	});

	it("jumps to the last todo with the end key", () => {
		const view = new TodoView(board(9), theme, tui, undefined, () => {});
		view.handleInput(KEY_END);
		expect(view.selectedIndex).toBe(8);
	});

	it("closes on escape", () => {
		const onClose = vi.fn();
		const view = new TodoView(board(3), theme, tui, undefined, onClose);
		view.handleInput(KEY_ESCAPE);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("closes on q", () => {
		const onClose = vi.fn();
		const view = new TodoView(board(3), theme, tui, undefined, onClose);
		view.handleInput("q");
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("stays within the terminal height budget", () => {
		const view = new TodoView(board(40), theme, tui, undefined, () => {});
		expect(view.render(60).length).toBeLessThanOrEqual(Math.floor(24 * 0.85));
	});
});
