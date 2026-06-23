import { describe, expect, it } from "vitest";
import { listTodos, setTodos, type TodoItem, updateTodo } from "../src/todo-store.js";

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
		expect(text).toContain("○ Task A");
		expect(text).toContain("◉ Task B");
		expect(text).toContain("✓ Task C");
		expect(text).toContain("🔒 Task D");
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
