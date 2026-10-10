import { describe, expect, it } from "vitest";
import type { TodoItem } from "../src/todo-store.js";
import { formatSnapshot, hasOpenTodos } from "../src/snapshot.js";

describe("hasOpenTodos", () => {
	it("is false for an empty list", () => expect(hasOpenTodos([])).toBe(false));

	it("is false when everything is done", () =>
		expect(hasOpenTodos([{ id: "1", title: "A", status: "done" }])).toBe(false));

	it("is true when something is still open", () =>
		expect(hasOpenTodos([{ id: "1", title: "A", status: "pending" }])).toBe(true));
});

describe("formatSnapshot", () => {
	it("reports progress, in_progress and pending tasks", () => {
		const snap = formatSnapshot([
			{ id: "1", title: "写单测", status: "done" },
			{ id: "2", title: "修 CI", status: "in_progress" },
			{ id: "3", title: "更新文档", status: "pending", blockedBy: ["2"] },
		]);
		expect(snap.startsWith("<todo-state>\n")).toBe(true);
		expect(snap.endsWith("\n</todo-state>")).toBe(true);
		expect(snap).toContain("1/3 done");
		expect(snap).toContain("in_progress: #2 修 CI");
		expect(snap).toContain("pending: #3 更新文档 (blocked by #2)");
		expect(snap).toContain("mark #2 done as soon as it passes");
	});

	it("omits the in_progress clause and asks to start one", () => {
		const snap = formatSnapshot([{ id: "1", title: "写单测", status: "pending" }]);
		expect(snap).not.toContain("in_progress:");
		expect(snap).toContain("set #1 in_progress before you start it");
	});

	it("caps the pending list at 8 items", () => {
		const many: TodoItem[] = Array.from({ length: 20 }, (_, i) => ({
			id: String(i + 1),
			title: `任务 ${i + 1}`,
			status: "pending" as const,
		}));
		const snap = formatSnapshot(many);
		expect(snap).toContain("… +12 more");
		expect(snap).not.toContain("任务 9");
	});

	it("never tells the model to re-enter the task that is already in_progress", () => {
		const snap = formatSnapshot([
			{ id: "1", title: "写单测", status: "done" },
			{ id: "2", title: "修 CI", status: "in_progress" },
			{ id: "3", title: "更新文档", status: "pending" },
		]);
		expect(snap).toContain("then set #3 in_progress");
		expect(snap).not.toContain("then set #2 in_progress");
	});

	it("frames the snapshot as an automatic echo, not a user request", () => {
		const snap = formatSnapshot([{ id: "1", title: "写单测", status: "pending" }]);
		expect(snap.split("\n")[1]).toContain("not a request from the user");
	});

	it("caps the in_progress segment and calls out more than one", () => {
		const many: TodoItem[] = Array.from({ length: 12 }, (_, i) => ({
			id: String(i + 1),
			title: `任务 ${i + 1}`,
			status: "in_progress" as const,
		}));
		const snap = formatSnapshot(many);
		expect(snap).toContain("… +4 more");
		expect(snap).toContain("12 tasks are in_progress but exactly one is allowed");
	});

	it("has exactly the shape the model receives", () => {
		const snap = formatSnapshot([
			{ id: "1", title: "写单测", status: "done" },
			{ id: "2", title: "修 CI", status: "in_progress" },
			{ id: "3", title: "更新文档", status: "pending" },
			{ id: "4", title: "发布", status: "pending", blockedBy: ["3"] },
		]);
		expect(snap).toBe(
			[
				"<todo-state>",
				"Automatic status echo from the pi-todo extension, not a request from the user.",
				"1/4 done · in_progress: #2 修 CI · pending: #3 更新文档, #4 发布 (blocked by #3)",
				"Discipline: mark #2 done as soon as it passes, then set #3 in_progress. Never batch completions.",
				"</todo-state>",
			].join("\n"),
		);
	});

	it("truncates long titles", () => {
		const snap = formatSnapshot([{ id: "1", title: "y".repeat(200), status: "in_progress" }]);
		expect(snap.length).toBeLessThan(400);
		expect(snap).toContain("…");
	});
});
