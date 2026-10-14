import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { isBlocked, type TodoItem } from "./todo-store.js";

const STATUS_ICON: Record<TodoItem["status"], string> = {
	pending: "○",
	in_progress: "◉",
	done: "✓",
};

/**
 * widget 的总行数预算（含两端标记行与汇总行）。
 * 低于 pi 数组 widget 的 10 行硬上限，因此永远不会触发宿主的 `(widget truncated)`。
 */
export const WIDGET_MAX_ROWS = 8;

export interface WindowResult<T> {
	visible: T[];
	hiddenAbove: number;
	hiddenBelow: number;
}

export interface WindowOptions {
	/** start（默认）：锚点尽量靠上，先向后铺满；center：锚点居中，适合可导航的列表。 */
	align?: "start" | "center";
}

/**
 * 取一段以 anchorIndex 为中心的可见项，并报告两端各隐藏了多少项。
 * start 对齐先向后铺、行有余量再回头补（在飞任务优先）；center 对齐把锚点放在窗口上半部。
 */
export function selectWindow<T>(
	items: T[],
	anchorIndex: number,
	maxRows: number,
	options: WindowOptions = {},
): WindowResult<T> {
	const total = items.length;
	if (total === 0) return { visible: [], hiddenAbove: 0, hiddenBelow: 0 };

	const rows = Math.max(1, Math.floor(maxRows));
	const anchor = Math.min(Math.max(Math.floor(anchorIndex), 0), total - 1);

	const start =
		options.align === "center"
			? Math.max(0, Math.min(anchor - Math.floor((rows - 1) / 2), total - rows))
			: Math.max(0, Math.min(anchor + rows, total) - rows);
	const end = Math.min(total, start + rows);

	return { visible: items.slice(start, end), hiddenAbove: start, hiddenBelow: total - end };
}

/** 汇总行：全局进度，永远占一行（独立一行，方便窄终端下仍能读到）。 */
export function formatProgress(items: TodoItem[]): string {
	const total = items.length;
	const done = items.filter((t) => t.status === "done").length;
	const pending = items.filter((t) => t.status === "pending").length;
	const blocked = items.filter((t) => isBlocked(items, t)).length;

	const parts = [`✓ ${done}/${total}`];
	if (pending > 0) parts.push(`○ ${pending}`);
	if (blocked > 0) parts.push(`🔒 ${blocked}`);
	return parts.join(" · ");
}

/** 窗口锚点：第一个在飞任务；没有则第一条未完成；全 done 时退化为 0（widget 本来就会隐藏）。 */
function anchorIndex(items: TodoItem[]): number {
	const inFlight = items.findIndex((t) => t.status === "in_progress");
	if (inFlight !== -1) return inFlight;
	const unfinished = items.findIndex((t) => t.status !== "done");
	return unfinished === -1 ? 0 : unfinished;
}

/** 状态图标：blocked 优先于状态本身。 */
export function statusIcon(items: TodoItem[], item: TodoItem): string {
	return isBlocked(items, item) ? "🔒" : STATUS_ICON[item.status];
}

/** 状态文本：done 走删除线，其余原样。widget 与 /todos 视图共用，避免两处风格漂移。 */
export function statusLabel(theme: Theme, item: TodoItem): string {
	return item.status === "done" ? theme.strikethrough(item.title) : item.title;
}

export interface WidgetRenderOptions {
	/** 终端宽度；省略时不做截断（RPC 等交给客户端渲染的场景）。 */
	width?: number;
	/** 总行数预算（含标记与汇总行）；最小 4，默认 WIDGET_MAX_ROWS。 */
	maxRows?: number;
}

/**
 * 渲染编辑器上方的 widget。
 * 无任务或全部完成时返回 null（隐藏 widget）。
 * 每次调用都现算，不缓存：列表很短，省掉缓存失效的坑。
 */
export function renderWidgetLines(items: TodoItem[], theme: Theme, options: WidgetRenderOptions): string[] | null {
	if (items.length === 0 || items.every((t) => t.status === "done")) return null;

	const budget = Math.max(4, options.maxRows ?? WIDGET_MAX_ROWS);
	const anchor = anchorIndex(items);

	// 预算含标记行，而标记行数又取决于窗口大小：迭代到稳定。
	// contentRows 单调不增、标记数单调不增，最多 3 轮收敛。
	let contentRows = Math.max(1, budget - 1);
	let window = selectWindow(items, anchor, contentRows);
	for (let i = 0; i < 4; i++) {
		const markers = (window.hiddenAbove > 0 ? 1 : 0) + (window.hiddenBelow > 0 ? 1 : 0);
		const next = Math.max(1, budget - 1 - markers);
		if (next === contentRows) break;
		contentRows = next;
		window = selectWindow(items, anchor, contentRows);
	}

	const lines: string[] = [];
	if (window.hiddenAbove > 0) lines.push(theme.fg("dim", `↑ ${window.hiddenAbove}`));
	for (const item of window.visible) {
		lines.push(theme.fg("muted", `${statusIcon(items, item)} #${item.id} ${statusLabel(theme, item)}`));
	}
	if (window.hiddenBelow > 0) lines.push(theme.fg("dim", `↓ ${window.hiddenBelow}`));
	lines.push(theme.fg("dim", formatProgress(items)));

	const width = options.width;
	if (width === undefined) return lines;
	return lines.map((line) => truncateToWidth(line, Math.max(1, width), "…"));
}

/** 编辑器上方的常驻 widget：字符串数组形式拿不到宽度，所以用组件形式自己裁行。 */
export class TodoWidget implements Component {
	constructor(
		private items: TodoItem[],
		private theme: Theme,
	) {}

	render(width: number): string[] {
		return renderWidgetLines(this.items, this.theme, { width }) ?? [];
	}

	invalidate(): void {
		// 每次 render 现算，无缓存可失效。
	}
}
