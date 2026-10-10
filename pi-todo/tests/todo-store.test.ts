import { describe, expect, it } from "vitest";
import {
	clipTitle,
	formatAck,
	listTodos,
	pickNext,
	reconstructTodos,
	setTodos,
	type TodoItem,
	updateTodo,
} from "../src/todo-store.js";

describe("setTodos", () => {
	it("assigns short positional ids to every item", () => {
		const result = setTodos([
			{ title: "Task A", status: "pending" },
			{ title: "Task B", status: "pending", blockedBy: ["1"] },
		]);
		expect(result.error).toBeUndefined();
		expect(result.todos.map((t) => t.id)).toEqual(["1", "2"]);
		expect(result.todos[1].blockedBy).toEqual(["1"]);
	});

	it("ignores any id the model still sends (the tool owns ids)", () => {
		const result = setTodos([
			{ id: "model-made-up-id", title: "Task A", status: "pending" },
			{ title: "Task B", status: "pending" },
		] as never);
		expect(result.error).toBeUndefined();
		expect(result.todos.map((t) => t.id)).toEqual(["1", "2"]);
	});

	it("renumbers on every set", () => {
		const before = setTodos([
			{ title: "A", status: "done" },
			{ title: "B", status: "pending" },
		]);
		expect(before.todos.map((t) => t.id)).toEqual(["1", "2"]);
		const after = setTodos([{ title: "C", status: "pending" }]);
		expect(after.todos.map((t) => t.id)).toEqual(["1"]);
	});

	it("rejects a dependency on a non-existent id and inlines the board", () => {
		const result = setTodos([
			{ title: "Task A", status: "pending" },
			{ title: "Task B", status: "pending", blockedBy: ["zzz"] },
		]);
		expect(result.error).toMatch(/blockedBy/);
		expect(result.error).toContain("#1 Task A");
		expect(result.todos).toEqual([]);
	});

	it("rejects a todo that blocks on itself", () => {
		const result = setTodos([{ title: "Task A", status: "pending", blockedBy: ["1"] }]);
		expect(result.error).toMatch(/self/i);
		expect(result.todos).toEqual([]);
	});

	it("rejects a circular dependency", () => {
		const result = setTodos([
			{ title: "A", status: "pending", blockedBy: ["2"] },
			{ title: "B", status: "pending", blockedBy: ["1"] },
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
		expect(text).toContain("○ #a Task A");
		expect(text).toContain("◉ #b Task B");
		expect(text).toContain("✓ #c Task C");
		expect(text).toContain("🔒 #d Task D");
	});

	it("caps the list and reports how many were dropped", () => {
		const many: TodoItem[] = Array.from({ length: 25 }, (_, i) => ({
			id: String(i + 1),
			title: `任务 ${i + 1}`,
			status: "pending" as const,
		}));
		const text = listTodos(many, 20);
		expect(text).toContain("… +5 more");
		expect(text).not.toContain("#21");
	});
});

describe("updateTodo", () => {
	const base: TodoItem[] = [
		{ id: "1", title: "写单测", status: "pending" },
		{ id: "2", title: "修 CI", status: "pending", blockedBy: ["1"] },
	];

	it("updates the status of an existing todo and echoes the canonical id", () => {
		const result = updateTodo(base, "1", { status: "in_progress" });
		expect(result.error).toBeUndefined();
		expect(result.id).toBe("1");
		expect(result.todos[0].status).toBe("in_progress");
		expect(result.todos[1].status).toBe("pending");
	});

	it("updates the title of an existing todo", () => {
		const result = updateTodo(base, "1", { title: "Renamed" });
		expect(result.error).toBeUndefined();
		expect(result.todos[0].title).toBe("Renamed");
	});

	it("leaves other fields untouched when patch is partial", () => {
		const result = updateTodo(base, "2", { status: "done" });
		expect(result.error).toBeUndefined();
		expect(result.todos[1].title).toBe("修 CI");
		expect(result.todos[1].blockedBy).toEqual(["1"]);
	});

	it("re-validates dependencies when blockedBy is patched", () => {
		const result = updateTodo(base, "1", { blockedBy: ["2"] });
		expect(result.error).toMatch(/cycle/i);
		expect(result.todos).toEqual(base);
	});

	it("matches only exact ids — no index, prefix or title lookup", () => {
		expect(updateTodo(base, "写单测", { status: "done" }).error).toMatch(/not found/i);
		expect(updateTodo(base, "1 ", { status: "done" }).error).toBeUndefined(); // trim 后仍是精确 id
		const numbered: TodoItem[] = [
			{ id: "1", title: "A", status: "pending" },
			{ id: "2", title: "B", status: "pending" },
		];
		// 短 id 就是位置，但超范围的数字不会被当成序号
		expect(updateTodo(numbered, "3", { status: "done" }).error).toMatch(/not found/i);
	});

	it("inlines the board so a wrong id self-corrects without an extra call", () => {
		const r = updateTodo(base, "zzz", { status: "done" });
		expect(r.error).toMatch(/not found/i);
		expect(r.error).toContain("#1 写单测");
		expect(r.error).toContain("#2 修 CI");
		expect(r.todos).toEqual(base);
	});

	it("bounds the board it inlines into an error", () => {
		const many: TodoItem[] = Array.from({ length: 60 }, (_, i) => ({
			id: String(i + 1),
			title: `任务 ${i + 1} ${"z".repeat(200)}`,
			status: "pending" as const,
		}));
		const r = updateTodo(many, "不存在的引用", { status: "done" });
		expect(r.error).toContain("… +40 more");
		expect(r.error!.length).toBeLessThan(3000);
	});

	it("rejects an empty or blank ref", () => {
		expect(updateTodo(base, "", { status: "done" }).error).toMatch(/required/i);
		expect(updateTodo(base, "   ", { status: "done" }).error).toMatch(/required/i);
	});
});

describe("pickNext", () => {
	const list: TodoItem[] = [
		{ id: "1", title: "A", status: "done" },
		{ id: "2", title: "B", status: "in_progress" },
		{ id: "3", title: "C", status: "pending" },
	];

	it("skips the excluded id even when it is the earliest open task", () => {
		expect(pickNext(list, { excludeId: "2" })?.id).toBe("3");
	});

	it("does not fall back to a blocked task by default", () => {
		const blocked: TodoItem[] = [
			{ id: "1", title: "A", status: "in_progress" },
			{ id: "2", title: "B", status: "pending", blockedBy: ["1"] },
		];
		expect(pickNext(blocked, { excludeId: "1" })).toBeUndefined();
	});

	it("falls back to a blocked task only when includeBlocked is set", () => {
		const blocked: TodoItem[] = [
			{ id: "1", title: "A", status: "done" },
			{ id: "2", title: "B", status: "pending", blockedBy: ["3"] },
			{ id: "3", title: "C", status: "pending", blockedBy: ["2"] },
		];
		expect(pickNext(blocked, { excludeId: "1", includeBlocked: true })?.id).toBe("2");
	});
});

describe("clipTitle", () => {
	it("returns a short title untouched", () => {
		expect(clipTitle("写单测")).toBe("写单测");
	});

	it("clips a long title to 60 chars plus an ellipsis", () => {
		const out = clipTitle("x".repeat(200));
		expect(out).toHaveLength(61);
		expect(out.endsWith("…")).toBe(true);
	});
});

describe("formatAck", () => {
	const items: TodoItem[] = [
		{ id: "1", title: "写单测", status: "done" },
		{ id: "2", title: "修 CI", status: "done" },
		{ id: "3", title: "更新文档", status: "pending" },
		{ id: "4", title: "发布", status: "pending", blockedBy: ["3"] },
		{ id: "5", title: "写发布说明", status: "pending" },
	];

	it("reports progress and the next unblocked task", () => {
		expect(formatAck(items, "2")).toBe("✓ #2 修 CI done (2/5 done) · next: #3 更新文档");
	});

	it("reports an in_progress task without a next hint", () => {
		const list = items.map((t) => (t.id === "3" ? { ...t, status: "in_progress" as const } : t));
		expect(formatAck(list, "3")).toBe("◉ #3 更新文档 in_progress (2/5 done)");
	});

	it("picks the earliest unblocked task as next", () => {
		const list = items.map((t) => (t.id === "3" ? { ...t, status: "done" as const } : t));
		// #4 的阻塞者 #3 刚变 done 故不再阻塞，next 取靠前的 #4 而非 #5
		expect(formatAck(list, "3")).toContain("next: #4 发布");
	});

	it("reports when everything is done", () => {
		const list = items.map((t) => ({ ...t, status: "done" as const }));
		expect(formatAck(list, "5")).toBe("✓ all 5 tasks done");
	});

	it("annotates the next task when every remaining task is blocked", () => {
		const stuck: TodoItem[] = [
			{ id: "1", title: "A", status: "done" },
			{ id: "2", title: "B", status: "pending", blockedBy: ["1", "3"] },
			{ id: "3", title: "C", status: "pending", blockedBy: ["2"] },
		];
		// #2 的依赖 #1 已 done 故不列出；#2/#3 互相阻塞，next 取列表靠前的 #2
		expect(formatAck(stuck, "1")).toBe("✓ #1 A done (1/3 done) · next: #2 B (blocked by #3)");
	});

	it("truncates very long titles", () => {
		const long: TodoItem[] = [{ id: "1", title: "x".repeat(200), status: "in_progress" }];
		expect(formatAck(long, "1").length).toBeLessThan(100);
		expect(formatAck(long, "1")).toContain("…");
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
