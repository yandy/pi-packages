import { describe, expect, it } from "vitest";
import { setTodos, type TodoItem } from "../src/todo-store.js";

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
