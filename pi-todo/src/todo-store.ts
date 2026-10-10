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
	const resolved = normalizeItemDeps(assigned.items);
	const error = validateDependencies(resolved);
	if (error) return { todos: [], error: `${error}\n${listTodos(resolved, ERROR_BOARD_CAP)}` };
	return { todos: resolved.map((i) => ({ ...i })) };
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
	// 单字符 ref 只做「归一化后全等」：否则 "a" 会子串命中 "Add caching"，
	// 静默把错的任务标成 done（widget、details.todos、下次注入跟着错）。
	const exactTitle = todos.filter((t) => normalizeRefText(t.title) === normalized);
	if (exactTitle.length === 1) return { item: exactTitle[0], candidates: exactTitle };
	if (normalized.length < 2) return { candidates: exactTitle };
	const byTitle = todos.filter((t) => normalizeRefText(t.title).includes(normalized));
	return byTitle.length === 1 ? { item: byTitle[0], candidates: byTitle } : { candidates: byTitle };
}

export interface PickNextOptions {
	/** 要跳过的任务（通常是当前 in_progress 或刚被更新的那个）。 */
	excludeId?: string;
	/** 全部候选都被阻塞时，是否退化到第一个开放任务（ack 会标注 blocked by）。 */
	includeBlocked?: boolean;
}

/**
 * 下一个该做的任务：第一个「未完成、未被阻塞、且不是 excludeId」的任务。
 * formatAck 与注入快照共用这一条规则：两边各写一份曾经给出自相矛盾的提示。
 */
export function pickNext(todos: TodoItem[], opts: PickNextOptions = {}): TodoItem | undefined {
	const open = todos.filter((t) => t.id !== opts.excludeId && t.status !== "done");
	const unblocked = open.find((t) => !isBlocked(todos, t));
	if (unblocked) return unblocked;
	return opts.includeBlocked ? open[0] : undefined;
}

/** 内联进错误信息的清单上限行数（模型需要的是候选 id，不是整面墙）。 */
const ERROR_BOARD_CAP = 20;
/** 歧义错误里列出的候选上限。 */
const CANDIDATE_CAP = 8;

function renderCandidates(candidates: TodoItem[]): string {
	const shown = candidates.slice(0, CANDIDATE_CAP).map((t) => `#${t.id} ${clipTitle(t.title)}`);
	if (candidates.length > CANDIDATE_CAP) shown.push(`… +${candidates.length - CANDIDATE_CAP} more`);
	return shown.join(", ");
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
			return {
				todos: [...todos],
				error: `Ambiguous task reference "${needle}": ${renderCandidates(candidates)}`,
			};
		}
		// 未命中时内联清单，让模型不需要额外调 list 就能自纠
		return { todos: [...todos], error: `Task not found: "${needle}"\n${listTodos(todos, ERROR_BOARD_CAP)}` };
	}

	const updated: TodoItem = { ...target };
	if (patch.status !== undefined) updated.status = patch.status;
	if (patch.title !== undefined) updated.title = patch.title;
	if (patch.blockedBy !== undefined) updated.blockedBy = normalizeDeps(todos, patch.blockedBy);

	const next = todos.map((t) => (t.id === target.id ? updated : t));
	const error = validateDependencies(next);
	if (error) return { todos: [...todos], error: `${error}\n${listTodos(todos, ERROR_BOARD_CAP)}` };

	return { todos: next, id: target.id };
}

/**
 * 把 blockedBy 里的宽松引用（title 片段 / 序号 / id 前缀）换成规范 id。
 * 解析不出或歧义时保留原样，由 validateDependencies 报错（否则模型拿到的是一句没有候选的 unknown id）。
 */
function normalizeDeps(todos: TodoItem[], blockedBy: string[]): string[] {
	return blockedBy.map((dep) => resolveTodoRef(todos, dep).item?.id ?? dep);
}

function normalizeItemDeps(items: TodoItem[]): TodoItem[] {
	return items.map((item) =>
		item.blockedBy?.length ? { ...item, blockedBy: normalizeDeps(items, item.blockedBy) } : item,
	);
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
		return `◉ #${target.id} ${clipTitle(target.title)} in_progress (${done}/${total} done)`;
	}

	const marker = target.status === "done" ? "✓" : "○";
	const head = `${marker} #${target.id} ${clipTitle(target.title)} ${target.status} (${done}/${total} done)`;

	const next = pickNext(todos, { excludeId: target.id, includeBlocked: true });
	if (!next) return head;

	const byId = new Map(todos.map((t) => [t.id, t]));
	const blockers = (next.blockedBy ?? []).filter((dep) => byId.get(dep)?.status !== "done");
	const suffix =
		isBlocked(todos, next) && blockers.length > 0 ? ` (blocked by ${blockers.map((b) => `#${b}`).join(", ")})` : "";
	return `${head} · next: #${next.id} ${clipTitle(next.title)}${suffix}`;
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
