export interface TodoItem {
	id: string;
	title: string;
	status: "pending" | "in_progress" | "done";
	blockedBy?: string[];
}

export interface TodoResult {
	todos: TodoItem[];
	error?: string;
	/** update 成功时 = 命中任务的规范 id（供 ack 与渲染使用）。 */
	id?: string;
}

/**
 * Validate blockedBy references: existence, no self-dependency, no cycles.
 * Returns an error message string, or undefined when valid.
 */
export function validateDependencies(items: TodoItem[]): string | undefined {
	const ids = new Set(items.map((i) => i.id));

	// Existence + self-dependency
	for (const item of items) {
		for (const dep of item.blockedBy ?? []) {
			if (dep === item.id) return `Task ${item.id} cannot block on itself`;
			if (!ids.has(dep)) return `Task ${item.id} blockedBy unknown id: ${dep}`;
		}
	}

	// Cycle detection via DFS
	const byId = new Map(items.map((i) => [i.id, i]));
	const WHITE = 0;
	const GRAY = 1;
	const BLACK = 2;
	const color = new Map<string, number>();
	for (const id of ids) color.set(id, WHITE);

	const visit = (id: string, path: string[]): boolean => {
		color.set(id, GRAY);
		const node = byId.get(id);
		for (const dep of node?.blockedBy ?? []) {
			const c = color.get(dep);
			if (c === GRAY) return true; // back edge → cycle
			if (c === WHITE && visit(dep, [...path, dep])) return true;
		}
		color.set(id, BLACK);
		return false;
	};

	for (const id of ids) {
		if (color.get(id) === WHITE && visit(id, [id])) {
			return `Dependency cycle detected`;
		}
	}
	return undefined;
}

/** `set` 接收的任务条目：**没有 id 字段**，id 由工具按位置分配，模型不自己编。 */
export type TodoDraft = {
	title: string;
	status: TodoItem["status"];
	blockedBy?: string[];
};

/**
 * 按位置分配短 id `1..n`。模型若仍传了 id（旧习惯），会被后面的 `id` 键盖掉：
 * 只此一种 id 形式，所以下游引用只需要精确匹配。
 */
function assignIds(items: TodoDraft[]): TodoItem[] {
	return items.map((item, i) => ({ ...item, id: String(i + 1) }));
}

export function setTodos(items: TodoDraft[]): TodoResult {
	const assigned = assignIds(items);
	const error = validateDependencies(assigned);
	if (error) return { todos: [], error: `${error}\n${listTodos(assigned, ERROR_BOARD_CAP)}` };
	return { todos: assigned.map((i) => ({ ...i })) };
}

export interface PickNextOptions {
	/** 要跳过的任务（通常是刚被更新的那个）。 */
	excludeId?: string;
	/** 全部 pending 都被阻塞时，是否退化到第一个 pending 项（ack 会标注 blocked by）。 */
	includeBlocked?: boolean;
}

/**
 * 下一个可以领的任务：`pending` 里第一个未被阻塞且不是 excludeId 的。
 * **已 in_progress 的不算候选**：它已经在某个 worker 手里；并行派发时推荐它
 * 等于建议重做一遍。
 */
export function pickNext(todos: TodoItem[], opts: PickNextOptions = {}): TodoItem | undefined {
	const candidates = todos.filter((t) => t.id !== opts.excludeId && t.status === "pending");
	const unblocked = candidates.find((t) => !isBlocked(todos, t));
	if (unblocked) return unblocked;
	return opts.includeBlocked ? candidates[0] : undefined;
}

/** 内联进错误信息的清单上限行数（模型需要的是可抄回的 id，不是整面墙）。 */
const ERROR_BOARD_CAP = 20;

export function updateTodo(
	todos: TodoItem[],
	ref: string,
	patch: {
		status?: "pending" | "in_progress" | "done";
		title?: string;
		blockedBy?: string[];
	},
): TodoResult {
	const needle = ref?.trim() ?? "";
	if (!needle) return { todos: [...todos], error: "Task reference is required" };

	const target = todos.find((t) => t.id === needle);
	if (!target) {
		// 未命中时内联清单，让模型不需要额外调 list 就能自纠
		return { todos: [...todos], error: `Task not found: "${needle}"\n${listTodos(todos, ERROR_BOARD_CAP)}` };
	}

	const updated: TodoItem = { ...target };
	if (patch.status !== undefined) updated.status = patch.status;
	if (patch.title !== undefined) updated.title = patch.title;
	if (patch.blockedBy !== undefined) updated.blockedBy = [...patch.blockedBy];

	const next = todos.map((t) => (t.id === target.id ? updated : t));
	const error = validateDependencies(next);
	if (error) return { todos: [...todos], error: `${error}\n${listTodos(todos, ERROR_BOARD_CAP)}` };

	return { todos: next, id: target.id };
}

/** title 过长时截断到 60 字符，避免 ack 与注入快照把上下文吃掉。 */
export function clipTitle(title: string): string {
	return title.length > 60 ? `${title.slice(0, 60)}…` : title;
}

/**
 * update 成功后的单行 ack：本次变更、进度、下一个该做的任务。
 * 它面向模型而非用户：给出闭环信号，让「完成即更新」能被强化。
 */
export function formatAck(todos: TodoItem[], id: string): string {
	const total = todos.length;
	const done = todos.filter((t) => t.status === "done").length;
	if (total > 0 && done === total) return `✓ all ${total} tasks done`;

	const target = todos.find((t) => t.id === id);
	if (!target) return `${done}/${total} done`;

	if (target.status === "in_progress") {
		// 并行派发时需要知道还剩多少可领，但不递「next」去催生新的并发
		const pending = todos.filter((t) => t.status === "pending").length;
		const tail = pending > 0 ? ` · ${pending} pending` : "";
		return `◉ #${target.id} ${clipTitle(target.title)} in_progress (${done}/${total} done${tail})`;
	}

	const marker = target.status === "done" ? "✓" : "○";
	const head = `${marker} #${target.id} ${clipTitle(target.title)} ${target.status} (${done}/${total} done)`;

	const next = pickNext(todos, { excludeId: target.id, includeBlocked: true });
	if (next) {
		const byId = new Map(todos.map((t) => [t.id, t]));
		const blockers = (next.blockedBy ?? []).filter((dep) => byId.get(dep)?.status !== "done");
		const suffix =
			isBlocked(todos, next) && blockers.length > 0 ? ` (blocked by ${blockers.map((b) => `#${b}`).join(", ")})` : "";
		return `${head} · next: #${next.id} ${clipTitle(next.title)}${suffix}`;
	}

	// 没东西可领但还有在飞的：报数而不是沉默，否则父会以为已经完工
	const inFlight = todos.filter((t) => t.status === "in_progress").length;
	return inFlight > 0 ? `${head} · ${inFlight} in flight` : head;
}

const STATUS_MARKER: Record<TodoItem["status"], string> = {
	pending: "○",
	in_progress: "◉",
	done: "✓",
};

/** True when a todo is blocked by at least one incomplete dependency. */
export function isBlocked(todos: TodoItem[], item: TodoItem): boolean {
	const byId = new Map(todos.map((t) => [t.id, t]));
	for (const dep of item.blockedBy ?? []) {
		const node = byId.get(dep);
		if (node?.status !== "done") return true;
	}
	return false;
}

/**
 * 面对模型的清单文本。统一用 `#<id>` 记法（与 ack / 快照 / 错误信息一致），
 * 因为模型要把看到的 id 拄回去；capLines 用于错误内联，避免大清单撞爆 tool result。
 */
export function listTodos(todos: TodoItem[], capLines?: number): string {
	if (todos.length === 0) return "No todos";
	const lines = todos.map((t) => {
		const marker = isBlocked(todos, t) ? "🔒" : STATUS_MARKER[t.status];
		return `${marker} #${t.id} ${clipTitle(t.title)}`;
	});
	if (capLines !== undefined && lines.length > capLines) {
		return [...lines.slice(0, capLines), `… +${lines.length - capLines} more`].join("\n");
	}
	return lines.join("\n");
}

/** Reconstruct the current todo list from session branch entries (last-write-wins). */
export function reconstructTodos(
	entries: Array<{ type: string; message?: { role?: string; toolName?: string; details?: unknown } }>,
): TodoItem[] {
	let todos: TodoItem[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg?.role !== "toolResult" || msg.toolName !== "todo") continue;
		const details = msg.details as { todos?: TodoItem[] } | undefined;
		if (details?.todos) todos = details.todos;
	}
	return todos;
}
