import { describe, expect, it } from "vitest";
import {
	FIRST_REMINDER_TURNS,
	formatReminder,
	MAX_REMINDER_INTERVAL_TURNS,
	ReminderScheduler,
} from "../src/reminder.js";
import type { TodoItem } from "../src/todo-store.js";

const item = (id: string, title: string, status: TodoItem["status"], blockedBy?: string[]): TodoItem => ({
	id,
	title,
	status,
	blockedBy,
});

describe("ReminderScheduler", () => {
	it("stays silent until the first interval has passed", () => {
		const s = new ReminderScheduler();
		for (let i = 0; i < FIRST_REMINDER_TURNS - 1; i++) s.onTurn();
		expect(s.takeDue()).toBeUndefined();
	});

	it("hands back the stale turn count once the interval is reached", () => {
		const s = new ReminderScheduler();
		for (let i = 0; i < FIRST_REMINDER_TURNS; i++) s.onTurn();
		expect(s.takeDue()).toBe(FIRST_REMINDER_TURNS);
		// 取走即重新计时：下一轮不会立刻再提醒
		expect(s.takeDue()).toBeUndefined();
	});

	it("resets the clock and the backoff after a todo call", () => {
		const s = new ReminderScheduler();
		for (let i = 0; i < FIRST_REMINDER_TURNS; i++) s.onTurn();
		s.takeDue(); // 间隔已翻倍
		s.onTodoCall();
		expect(s.takeDue()).toBeUndefined();
		for (let i = 0; i < FIRST_REMINDER_TURNS; i++) s.onTurn();
		expect(s.takeDue()).toBe(FIRST_REMINDER_TURNS);
	});

	it("doubles the interval after every reminder and caps it", () => {
		const s = new ReminderScheduler();
		const waits: number[] = [];
		let interval = FIRST_REMINDER_TURNS;
		for (let n = 0; n < 6; n++) {
			waits.push(interval);
			for (let i = 0; i < interval; i++) s.onTurn();
			expect(s.takeDue()).toBe(interval);
			interval = Math.min(interval * 2, MAX_REMINDER_INTERVAL_TURNS);
		}
		// 单调递增到上限，之后恒定 —— 长 run 里不会刷屏
		expect(waits.at(-1)).toBe(MAX_REMINDER_INTERVAL_TURNS);
		expect(waits).toEqual([...waits].sort((a, b) => a - b));
	});
});

describe("formatReminder", () => {
	it("returns undefined when nothing is left to do", () => {
		expect(formatReminder([], 6)).toBeUndefined();
		expect(formatReminder([item("1", "A", "done")], 6)).toBeUndefined();
	});

	it("stays quiet when every open task is blocked", () => {
		// 依赖成环在 set/update 就被拦了，所以「全阻塞」只可能来自重建出的旧看板：
		// blockedBy 指向一个已不存在的 id（例如旧 session 里的 uuid）。这时催也没用。
		expect(formatReminder([item("1", "A", "pending", ["9"])], 6)).toBeUndefined();
	});

	it("still nudges when the blocked tasks are not the only work left", () => {
		const text = formatReminder([item("1", "A", "pending"), item("2", "B", "pending", ["1"])], 6) ?? "";
		expect(text).toContain("#1 A");
	});

	it("names the in-progress task and asks for an immediate update", () => {
		const text = formatReminder([item("1", "A", "done"), item("2", "修 CI", "in_progress")], 6) ?? "";
		expect(text).toContain("#2 修 CI");
		expect(text).toContain("6 turns");
		expect(text).toContain('"update"');
		expect(text).toContain('"done"');
		// 与 T3-B 的区别：提醒的是「你多久没更新」，不是冒充当下的看板快照
		expect(text.startsWith("<todo-reminder>")).toBe(true);
		expect(text.endsWith("</todo-reminder>")).toBe(true);
	});

	it("asks for an in_progress mark when nothing is in flight, naming the next task", () => {
		const text = formatReminder([item("1", "A", "done"), item("2", "B", "pending")], 5) ?? "";
		expect(text).toContain("nothing is in_progress");
		expect(text).toContain('"in_progress"');
		expect(text).toContain("#2 B");
	});

	it("folds extra in-flight tasks instead of listing them all", () => {
		const todos = [item("1", "A", "in_progress"), item("2", "B", "in_progress"), item("3", "C", "in_progress")];
		const text = formatReminder(todos, 9) ?? "";
		expect(text).toContain("#1 A");
		expect(text).toContain("#2 B");
		expect(text).toContain("+1");
		expect(text).not.toContain("#3 C");
	});

	it("clips long titles and keeps the reminder short enough to ride in every request", () => {
		const long = "x".repeat(200);
		const text = formatReminder([item("1", long, "in_progress")], 12) ?? "";
		expect(text).toContain("…");
		expect(text.length).toBeLessThanOrEqual(320);
	});
});
