import { clipTitle, isBlocked, type TodoItem } from "./todo-store.js";

/** pending 段最多列出的条目数，超出折叠成 `… +n more`，避免长清单吃掉注入预算。 */
const PENDING_CAP = 8;

/** 是否还有未完成的任务（空清单与全 done 都返回 false）。 */
export function hasOpenTodos(todos: TodoItem[]): boolean {
	return todos.some((t) => t.status !== "done");
}

/** `#<id> <title>`，被阻塞时附 `(blocked by #<dep>, …)`，只列未完成的依赖。 */
function describeTodo(todos: TodoItem[], item: TodoItem): string {
	const byId = new Map(todos.map((t) => [t.id, t]));
	const blockers = (item.blockedBy ?? []).filter((dep) => byId.get(dep)?.status !== "done");
	const blocked = isBlocked(todos, item) && blockers.length > 0;
	const suffix = blocked ? ` (blocked by ${blockers.map((b) => `#${b}`).join(", ")})` : "";
	return `#${item.id} ${clipTitle(item.title)}${suffix}`;
}

/** 第一个「未完成且未被阻塞」的任务。依赖图无环且引用存在时，非完成任务中必有这样一个。 */
function nextOpen(todos: TodoItem[]): TodoItem | undefined {
	return todos.find((t) => t.status !== "done" && !isBlocked(todos, t));
}

function disciplineLine(todos: TodoItem[]): string {
	const current = todos.find((t) => t.status === "in_progress");
	const next = nextOpen(todos);
	if (current) {
		return next
			? `Discipline: mark #${current.id} done as soon as it passes, then set #${next.id} in_progress. Never batch completions.`
			: `Discipline: mark #${current.id} done as soon as it passes. Never batch completions.`;
	}
	return `Discipline: set #${next?.id ?? "?"} in_progress before you start it, and mark tasks done immediately. Never batch completions.`;
}

/**
 * 注入给模型的 todo 状态快照。面向模型而非用户：`before_agent_start` 会把它作为
 * 隐藏消息发到上下文里，所以措辞用第三人称、并用标签包裹，避免被误读成用户的新指令。
 */
export function formatSnapshot(todos: TodoItem[]): string {
	const total = todos.length;
	const done = todos.filter((t) => t.status === "done").length;
	const inProgress = todos.filter((t) => t.status === "in_progress");
	const pending = todos.filter((t) => t.status === "pending");

	const segments = [`${done}/${total} done`];
	if (inProgress.length > 0) {
		segments.push(`in_progress: ${inProgress.map((t) => describeTodo(todos, t)).join(", ")}`);
	}
	if (pending.length > 0) {
		const listed = pending.slice(0, PENDING_CAP).map((t) => describeTodo(todos, t));
		if (pending.length > PENDING_CAP) listed.push(`… +${pending.length - PENDING_CAP} more`);
		segments.push(`pending: ${listed.join(", ")}`);
	}

	return `<todo-state>\n${segments.join(" · ")}\n${disciplineLine(todos)}\n</todo-state>`;
}
