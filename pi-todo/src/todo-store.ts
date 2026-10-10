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

export interface TodoRefResult {
	item?: TodoItem;
	candidates: TodoItem[];
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

/** `set` 接收的任务条目：`id` 可缺失，由 `assignIds` 按位置补上短 id。 */
export type TodoDraft = {
	id?: string;
	title: string;
	status: TodoItem["status"];
	blockedBy?: string[];
};

/**
 * 两遍扫描：先收集显式 id（并查重），再为 id 缺失或空白的项按位置分配不冲突的短 id。
 * 显式 id 原样保留（旧 session 的 uuid 不受影响）；重复的显式 id 是错误。
 */
function assignIds(items: TodoDraft[]): { items: TodoItem[]; error?: string } {
	const taken = new Set<string>();
	for (const item of items) {
		const explicit = item.id?.trim();
		if (!explicit) continue;
		if (taken.has(explicit)) return { items: [], error: `Duplicate task id: ${explicit}` };
		taken.add(explicit);
	}

	let next = 1;
	const resolved = items.map<TodoItem>((item) => {
		const explicit = item.id?.trim();
		if (explicit) return { ...item, id: explicit };
		while (taken.has(String(next))) next += 1;
		const id = String(next);
		taken.add(id);
		next += 1;
		return { ...item, id };
	});
	return { items: resolved };
}

export function setTodos(items: TodoDraft[]): TodoResult {
	const assigned = assignIds(items);
	if (assigned.error) return { todos: [], error: assigned.error };
	const error = validateDependencies(assigned.items);
	if (error) return { todos: [], error };
	return { todos: assigned.items.map((i) => ({ ...i })) };
}

/** 归一化引用文本：小写 + 去掉空白与常见分隔符，使「修 CI」与「修ci」等价。 */
function normalizeRefText(value: string): string {
	return value.toLowerCase().replace(/[\s\-_:：，,。.、]/g, "");
}

/**
 * 把模型给的任务引用解析成唯一任务。顺序：精确 id → 纯数字按 1-based 序号 →
 * 唯一 id 前缀（忽略大小写）→ 规范化 title 包含匹配。
 * 纯数字只走序号而不走前缀，否则 "1" 会同时前缀命中 "1"/"10"/"11" 造成假歧义。
 */
export function resolveTodoRef(todos: TodoItem[], ref: string): TodoRefResult {
	const needle = ref?.trim() ?? "";
	if (!needle) return { candidates: [] };

	const exact = todos.find((t) => t.id === needle);
	if (exact) return { item: exact, candidates: [exact] };

	if (/^\d+$/.test(needle)) {
		const byIndex = todos[Number(needle) - 1];
		return byIndex ? { item: byIndex, candidates: [byIndex] } : { candidates: [] };
	}

	const lower = needle.toLowerCase();
	const byPrefix = todos.filter((t) => t.id.toLowerCase().startsWith(lower));
	if (byPrefix.length > 0) {
		return byPrefix.length === 1 ? { item: byPrefix[0], candidates: byPrefix } : { candidates: byPrefix };
	}

	const normalized = normalizeRefText(needle);
	const byTitle = todos.filter((t) => normalizeRefText(t.title).includes(normalized));
	return byTitle.length === 1 ? { item: byTitle[0], candidates: byTitle } : { candidates: byTitle };
}

export function updateTodo(
	todos: TodoItem[],
	ref: string,
	patch: {
		status?: "pending" | "in_progress" | "done";
		title?: string;
		blockedBy?: string[];
	},
): TodoResult {
	const { item: target, candidates } = resolveTodoRef(todos, ref);
	if (!target) {
		const needle = ref?.trim() ?? "";
		if (!needle) return { todos: [...todos], error: "Task reference is required" };
		if (candidates.length > 1) {
			const listing = candidates.map((t) => `#${t.id} ${t.title}`).join(", ");
			return { todos: [...todos], error: `Ambiguous task reference "${needle}": ${listing}` };
		}
		// 未命中时内联完整清单，让模型不需要额外调 list 就能自纠
		return { todos: [...todos], error: `Task not found: "${needle}"\n${listTodos(todos)}` };
	}

	const updated: TodoItem = { ...target };
	if (patch.status !== undefined) updated.status = patch.status;
	if (patch.title !== undefined) updated.title = patch.title;
	if (patch.blockedBy !== undefined) updated.blockedBy = [...patch.blockedBy];

	const next = todos.map((t) => (t.id === target.id ? updated : t));
	const error = validateDependencies(next);
	if (error) return { todos: [...todos], error };

	return { todos: next, id: target.id };
}

/** title 过长时截断，避免 ack 与后续注入把上下文吃掉。 */
function clip(title: string): string {
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
		return `◉ #${target.id} ${clip(target.title)} in_progress (${done}/${total} done)`;
	}

	const marker = target.status === "done" ? "✓" : "○";
	const head = `${marker} #${target.id} ${clip(target.title)} ${target.status} (${done}/${total} done)`;

	const open = todos.filter((t) => t.id !== target.id && t.status !== "done");
	const next = open.find((t) => !isBlocked(todos, t)) ?? open[0];
	if (!next) return head;

	const byId = new Map(todos.map((t) => [t.id, t]));
	const blockers = (next.blockedBy ?? []).filter((dep) => byId.get(dep)?.status !== "done");
	const suffix =
		isBlocked(todos, next) && blockers.length > 0 ? ` (blocked by ${blockers.map((b) => `#${b}`).join(", ")})` : "";
	return `${head} · next: #${next.id} ${clip(next.title)}${suffix}`;
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

export function listTodos(todos: TodoItem[]): string {
	if (todos.length === 0) return "No todos";
	return todos
		.map((t) => {
			const marker = isBlocked(todos, t) ? "🔒" : STATUS_MARKER[t.status];
			return `${marker} [${t.id}] ${t.title}`;
		})
		.join("\n");
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
