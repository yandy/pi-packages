import { describe, expect, it } from "vitest";
import type { TodoItem } from "../src/todo-store.js";
import { renderWidget } from "../src/widget.js";

// Minimal stub of the Theme shape used by renderWidget.
const theme = {
	fg: (_name: string, text: string) => text,
	strikethrough: (text: string) => text,
} as any;

describe("renderWidget", () => {
	it("returns null when there are no todos", () => {
		expect(renderWidget([], theme)).toBeNull();
	});

	it("returns null when all todos are done", () => {
		const items: TodoItem[] = [{ id: "a", title: "Done", status: "done" }];
		expect(renderWidget(items, theme)).toBeNull();
	});

	it("returns a single line summarising each non-done todo", () => {
		const items: TodoItem[] = [
			{ id: "a", title: "Plan", status: "pending" },
			{ id: "b", title: "Build", status: "in_progress" },
			{ id: "c", title: "Shipped", status: "done" },
		];
		const lines = renderWidget(items, theme);
		expect(lines).not.toBeNull();
		expect(lines?.length).toBe(1);
		expect(lines?.[0]).toContain("○ Plan");
		expect(lines?.[0]).toContain("◉ Build");
		// Done items are omitted from the widget.
		expect(lines?.[0]).not.toContain("Shipped");
	});

	it("shows the blocked marker for blocked todos", () => {
		const items: TodoItem[] = [
			{ id: "a", title: "First", status: "pending" },
			{ id: "b", title: "Second", status: "pending", blockedBy: ["a"] },
		];
		const lines = renderWidget(items, theme);
		expect(lines?.[0]).toContain("🔒 Second");
	});
});
