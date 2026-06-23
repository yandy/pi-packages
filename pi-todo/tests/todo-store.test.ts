import { describe, expect, it } from "vitest";
import { listTodos, reconstructTodos, setTodos, type TodoItem, updateTodo } from "../src/todo-store.js";

describe("setTodos", () => {
	it("accepts a valid list of todos", () => {
		const items: TodoItem[] = [
			{ id: "a", title: "Task A", status: "pending" },
			{ id: "b", title: "Task B", status: "pending", blockedBy: ["a"] },
		];
		const result = setTodos(items);
		expect(result.error).toBeUndefined();
		expect(result.todos).toEqual(items);
	});

	it("rejects a todo that blocks on a non-existent id", () => {
		const result = setTodos([{ id: "a", title: "Task A", status: "pending", blockedBy: ["zzz"] }]);
		expect(result.error).toMatch(/blockedBy/);
		expect(result.todos).toEqual([]);
	});

	it("rejects a todo that blocks on itself", () => {
		const result = setTodos([{ id: "a", title: "Task A", status: "pending", blockedBy: ["a"] }]);
		expect(result.error).toMatch(/self/i);
		expect(result.todos).toEqual([]);
	});

	it("rejects a circular dependency", () => {
		const result = setTodos([
			{ id: "a", title: "A", status: "pending", blockedBy: ["b"] },
			{ id: "b", title: "B", status: "pending", blockedBy: ["a"] },
		]);
		expect(result.error).toMatch(/cycle/i);
		expect(result.todos).toEqual([]);
	});

	it("accepts an empty list", () => {
		const result = setTodos([]);
		expect(result.error).toBeUndefined();
		expect(result.todos).toEqual([]);
	});
});

describe("listTodos", () => {
	it("returns a placeholder for an empty list", () => {
		expect(listTodos([])).toBe("No todos");
	});

	it("lists each todo with a status marker and blocked indicator", () => {
		const items: TodoItem[] = [
			{ id: "a", title: "Task A", status: "pending" },
			{ id: "b", title: "Task B", status: "in_progress" },
			{ id: "c", title: "Task C", status: "done" },
			{ id: "d", title: "Task D", status: "pending", blockedBy: ["a"] },
		];
		const text = listTodos(items);
		expect(text).toContain("○ [a] Task A");
		expect(text).toContain("◉ [b] Task B");
		expect(text).toContain("✓ [c] Task C");
		expect(text).toContain("🔒 [d] Task D");
	});
});

describe("updateTodo", () => {
	const base: TodoItem[] = [
		{ id: "a", title: "Task A", status: "pending" },
		{ id: "b", title: "Task B", status: "pending", blockedBy: ["a"] },
	];

	it("updates the status of an existing todo", () => {
		const result = updateTodo(base, "a", { status: "in_progress" });
		expect(result.error).toBeUndefined();
		expect(result.todos[0].status).toBe("in_progress");
		expect(result.todos[1].status).toBe("pending");
	});

	it("updates the title of an existing todo", () => {
		const result = updateTodo(base, "a", { title: "Renamed" });
		expect(result.error).toBeUndefined();
		expect(result.todos[0].title).toBe("Renamed");
	});

	it("updates blockedBy and re-validates dependencies", () => {
		const result = updateTodo(base, "a", { blockedBy: ["b"] });
		expect(result.error).toMatch(/cycle/i);
		expect(result.todos).toEqual(base);
	});

	it("returns an error when the id is not found", () => {
		const result = updateTodo(base, "zzz", { status: "done" });
		expect(result.error).toMatch(/not found/i);
		expect(result.todos).toEqual(base);
	});

	it("leaves other fields untouched when patch is partial", () => {
		const result = updateTodo(base, "b", { status: "done" });
		expect(result.error).toBeUndefined();
		expect(result.todos[1].title).toBe("Task B");
		expect(result.todos[1].blockedBy).toEqual(["a"]);
	});
});

describe("reconstructTodos", () => {
	const todoEntry = (todos: TodoItem[]) => ({
		type: "message",
		message: {
			role: "toolResult",
			toolName: "todo",
			details: { todos },
		},
	});

	it("returns an empty array for empty entries", () => {
		expect(reconstructTodos([])).toEqual([]);
	});

	it("returns an empty array when no entries match", () => {
		const entries = [
			{ type: "other" },
			{ type: "message", message: { role: "toolResult", toolName: "other" } },
			{ type: "message", message: { role: "user", toolName: "todo" } },
		];
		expect(reconstructTodos(entries)).toEqual([]);
	});

	it("returns todos from the single matching toolResult entry", () => {
		const items: TodoItem[] = [{ id: "a", title: "Task A", status: "pending" }];
		expect(reconstructTodos([todoEntry(items)])).toEqual(items);
	});

	it("returns the last matching entry's todos (last-write-wins)", () => {
		const first: TodoItem[] = [{ id: "a", title: "First", status: "pending" }];
		const last: TodoItem[] = [{ id: "b", title: "Last", status: "done" }];
		expect(reconstructTodos([todoEntry(first), todoEntry(last)])).toEqual(last);
	});

	it("ignores entries where details.todos is missing and keeps prior", () => {
		const a: TodoItem[] = [{ id: "a", title: "Task A", status: "pending" }];
		const b: TodoItem[] = [{ id: "b", title: "Task B", status: "done" }];
		const entries = [
			todoEntry(a),
			{ type: "message", message: { role: "toolResult", toolName: "todo", details: {} } },
			todoEntry(b),
		];
		expect(reconstructTodos(entries)).toEqual(b);
	});
});
