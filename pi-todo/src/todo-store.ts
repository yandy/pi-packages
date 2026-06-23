export interface TodoItem {
	id: string;
	title: string;
	status: "pending" | "in_progress" | "done";
	blockedBy?: string[];
}

export interface TodoResult {
	todos: TodoItem[];
	error?: string;
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

export function setTodos(items: TodoItem[]): TodoResult {
	const error = validateDependencies(items);
	if (error) return { todos: [], error };
	return { todos: items.map((i) => ({ ...i })) };
}

export function updateTodo(
	todos: TodoItem[],
	id: string,
	patch: {
		status?: "pending" | "in_progress" | "done";
		title?: string;
		blockedBy?: string[];
	},
): TodoResult {
	const target = todos.find((t) => t.id === id);
	if (!target) {
		return { todos: [...todos], error: `Task not found: ${id}` };
	}

	const updated: TodoItem = { ...target };
	if (patch.status !== undefined) updated.status = patch.status;
	if (patch.title !== undefined) updated.title = patch.title;
	if (patch.blockedBy !== undefined) updated.blockedBy = [...patch.blockedBy];

	const next = todos.map((t) => (t.id === id ? updated : t));
	const error = validateDependencies(next);
	if (error) return { todos: [...todos], error };

	return { todos: next };
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
