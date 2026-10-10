import { clipTitle, isBlocked, pickNext, type TodoItem } from "./todo-store.js";

/** 每个段最多列出的条目数，超出折叠成 `… +n more`，避免长清单吃掉注入预算。 */
const SEGMENT_CAP = 8;

/**
 * 快照的第二行。宿主会把注入的 custom 消息投影成 user 角色（messages.js convertToLlm），
 * 所以必须先自报身份：这是扩展的自动回显，不是用户说的话。
 */
const FRAMING = "Automatic status echo from the pi-todo extension, not a request from the user.";

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

function renderSegment(todos: TodoItem[], items: TodoItem[]): string {
	const listed = items.slice(0, SEGMENT_CAP).map((t) => describeTodo(todos, t));
	if (items.length > SEGMENT_CAP) listed.push(`… +${items.length - SEGMENT_CAP} more`);
	return listed.join(", ");
}

function disciplineLine(todos: TodoItem[], inProgress: TodoItem[]): string {
	if (inProgress.length > 1) {
		const rest = inProgress.length - 1;
		return `Discipline: ${inProgress.length} tasks are in_progress but exactly one is allowed — keep #${inProgress[0].id}, set the other ${rest} back to pending, and mark done immediately.`;
	}
	const current = inProgress[0];
	// 排除当前 in_progress 项，否则会输出「把 #2 设为 in_progress」这种自相矛盾的提示
	const next = pickNext(todos, { excludeId: current?.id });
	if (current) {
		return next
			? `Discipline: mark #${current.id} done as soon as it passes, then set #${next.id} in_progress. Never batch completions.`
			: `Discipline: mark #${current.id} done as soon as it passes. Never batch completions.`;
	}
	if (!next) return `Discipline: every open task is blocked — unblock one, or replan with action "set".`;
	return `Discipline: set #${next.id} in_progress before you start it, and mark tasks done immediately. Never batch completions.`;
}

/**
 * 注入给模型的 todo 状态快照。面向模型而非用户：`before_agent_start` 会把它作为
 * 隐藏消息发到上下文里，所以用标签包裹并自报身份，避免被误读成用户的新指令。
 */
export function formatSnapshot(todos: TodoItem[]): string {
	const total = todos.length;
	const done = todos.filter((t) => t.status === "done").length;
	const inProgress = todos.filter((t) => t.status === "in_progress");
	const pending = todos.filter((t) => t.status === "pending");

	const segments = [`${done}/${total} done`];
	if (inProgress.length > 0) segments.push(`in_progress: ${renderSegment(todos, inProgress)}`);
	if (pending.length > 0) segments.push(`pending: ${renderSegment(todos, pending)}`);

	return `<todo-state>\n${FRAMING}\n${segments.join(" · ")}\n${disciplineLine(todos, inProgress)}\n</todo-state>`;
}
