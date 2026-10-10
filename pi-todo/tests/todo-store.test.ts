import { describe, expect, it } from "vitest";
import {
	clipTitle,
	formatAck,
	listTodos,
	pickNext,
	reconstructTodos,
	resolveTodoRef,
	setTodos,
	type TodoDraft,
	type TodoItem,
	updateTodo,
} from "../src/todo-store.js";

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

	it("assigns short positional ids when id is missing or blank", () => {
		const result = setTodos([
			{ title: "A", status: "pending" },
			{ id: "  ", title: "B", status: "pending" },
		]);
		expect(result.error).toBeUndefined();
		expect(result.todos.map((t) => t.id)).toEqual(["1", "2"]);
	});

	it("skips numbers already taken by explicit ids", () => {
		const result = setTodos([
			{ id: "1", title: "A", status: "pending" },
			{ title: "B", status: "pending" },
		]);
		expect(result.todos.map((t) => t.id)).toEqual(["1", "2"]);
	});

	it("keeps explicit uuid ids untouched (old-session compatibility)", () => {
		const uuid = "6f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
		const result = setTodos([{ id: uuid, title: "A", status: "pending" }]);
		expect(result.todos[0].id).toBe(uuid);
	});

	it("accepts blockedBy referencing auto-assigned ids", () => {
		const result = setTodos([
			{ title: "A", status: "pending" },
			{ title: "B", status: "pending", blockedBy: ["1"] },
		]);
		expect(result.error).toBeUndefined();
		expect(result.todos[1].blockedBy).toEqual(["1"]);
	});

	it("rejects duplicate explicit ids", () => {
		const result = setTodos([
			{ id: "1", title: "A", status: "pending" },
			{ id: "1", title: "B", status: "pending" },
		]);
		expect(result.error).toMatch(/duplicate.*id/i);
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

	it("bounds the candidate list in an ambiguity error", () => {
		const same: TodoItem[] = Array.from({ length: 40 }, (_, i) => ({
			id: String(i + 1),
			title: `部署步骤 ${i + 1}`,
			status: "pending" as const,
		}));
		const r = updateTodo(same, "部署步骤", { status: "done" });
		expect(r.error).toMatch(/ambiguous/i);
		expect(r.error).toContain("… +32 more");
		expect(r.error!.length).toBeLessThan(800);
	});

	it("leaves other fields untouched when patch is partial", () => {
		const result = updateTodo(base, "b", { status: "done" });
		expect(result.error).toBeUndefined();
		expect(result.todos[1].title).toBe("Task B");
		expect(result.todos[1].blockedBy).toEqual(["a"]);
	});

	it("returns the resolved canonical id on success", () => {
		expect(updateTodo(base, "a", { status: "done" }).id).toBe("a");
	});

	it("does not let a one-character ref hit a random title", () => {
		const ascii: TodoItem[] = [
			{ id: "1", title: "Add caching", status: "pending" },
			{ id: "2", title: "Fix login bug", status: "pending" },
		];
		expect(resolveTodoRef(ascii, "a").item).toBeUndefined();
		const r = updateTodo(ascii, "a", { status: "done" });
		expect(r.error).toMatch(/not found/i);
		expect(r.todos).toEqual(ascii);
	});

	it("reports ambiguity with every candidate title", () => {
		const r = updateTodo(
			[
				{ id: "1", title: "查询用户", status: "pending" },
				{ id: "2", title: "查询订单", status: "pending" },
			],
			"查询",
			{ status: "done" },
		);
		expect(r.error).toMatch(/ambiguous/i);
		expect(r.error).toContain("查询用户");
		expect(r.error).toContain("查询订单");
	});

	it("lists the whole board when the ref matches nothing", () => {
		const r = updateTodo(base, "zzz", { status: "done" });
		expect(r.error).toMatch(/not found/i);
		expect(r.error).toContain("#a Task A");
		expect(r.error).toContain("#b Task B");
	});

	it("rejects an empty ref", () => {
		expect(updateTodo(base, "", { status: "done" }).error).toMatch(/required/i);
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

describe("blockedBy reference normalization", () => {
	it("resolves a title fragment given as a dependency", () => {
		const result = setTodos([
			{ title: "写单测", status: "pending" },
			{ title: "写文档", status: "pending", blockedBy: ["写单测"] },
		] as TodoDraft[]);
		expect(result.error).toBeUndefined();
		expect(result.todos[1].blockedBy).toEqual(["1"]);
	});

	it("resolves a position when the ids are uuids", () => {
		const result = setTodos([
			{ id: "6f1e2d3c", title: "A", status: "pending" },
			{ id: "a1b2c3d4", title: "B", status: "pending", blockedBy: ["1"] },
		]);
		expect(result.error).toBeUndefined();
		expect(result.todos[1].blockedBy).toEqual(["6f1e2d3c"]);
	});

	it("still rejects a dependency that resolves to nothing", () => {
		const result = setTodos([
			{ title: "A", status: "pending" },
			{ title: "B", status: "pending", blockedBy: ["不存在的任务"] },
		] as TodoDraft[]);
		expect(result.error).toMatch(/blockedBy/);
	});

	it("normalizes dependencies on update too", () => {
		const list: TodoItem[] = [
			{ id: "1", title: "写单测", status: "pending" },
			{ id: "2", title: "修 CI", status: "pending" },
		];
		const r = updateTodo(list, "2", { blockedBy: ["写单测"] });
		expect(r.error).toBeUndefined();
		expect(r.todos[1].blockedBy).toEqual(["1"]);
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
});

describe("resolveTodoRef", () => {
	const list: TodoItem[] = [
		{ id: "1", title: "写单测", status: "done" },
		{ id: "2", title: "修 CI", status: "in_progress" },
		{ id: "10", title: "写文档", status: "pending" },
	];

	it("matches an exact id", () => {
		expect(resolveTodoRef(list, "10").item?.title).toBe("写文档");
	});

	it("matches a 1-based index when ids are not numeric-friendly", () => {
		const uuids: TodoItem[] = [
			{ id: "6f1e2d3c", title: "A", status: "pending" },
			{ id: "a1b2c3d4", title: "B", status: "pending" },
		];
		expect(resolveTodoRef(uuids, "2").item?.title).toBe("B");
	});

	it("matches a unique id prefix", () => {
		expect(resolveTodoRef(list, "2").item?.id).toBe("2"); // 序号与 id 一致
		const uuids: TodoItem[] = [{ id: "6f1e2d3c", title: "A", status: "pending" }];
		expect(resolveTodoRef(uuids, "6f1e").item?.title).toBe("A");
	});

	it("matches by normalized title substring", () => {
		expect(resolveTodoRef(list, "修 ci").item?.id).toBe("2");
	});

	it("returns candidates when ambiguous", () => {
		const dup: TodoItem[] = [
			{ id: "1", title: "查询用户", status: "pending" },
			{ id: "2", title: "查询订单", status: "pending" },
		];
		const r = resolveTodoRef(dup, "查询");
		expect(r.item).toBeUndefined();
		expect(r.candidates.map((t) => t.id)).toEqual(["1", "2"]);
	});

	it("matches a single-character ref only against the whole title", () => {
		const list2: TodoItem[] = [{ id: "1", title: "写", status: "pending" }];
		expect(resolveTodoRef(list2, "写").item?.id).toBe("1");
	});

	it("returns nothing for an empty or blank ref", () => {
		expect(resolveTodoRef(list, "  ").item).toBeUndefined();
		expect(resolveTodoRef(list, "  ").candidates).toEqual([]);
	});

	it("matches the current title after a rename, not the old one", () => {
		const renamed = updateTodo(list, "2", { title: "修复流水线" });
		expect(resolveTodoRef(renamed.todos, "修 CI").item).toBeUndefined();
		expect(resolveTodoRef(renamed.todos, "修复流水线").item?.id).toBe("2");
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
