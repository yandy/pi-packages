import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Keybinding,
	type KeybindingsManager,
	matchesKey,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { isBlocked, type TodoItem } from "./todo-store.js";
import { formatProgress, selectWindow } from "./widget.js";

const RULE = "─";
/** 非内容行：上下分隔线 + 表头 + 键位提示。 */
const CHROME_ROWS = 4;
/** overlay 高度占终端行数的比例，与 maxHeight 保持一致，避免内容被硬裁。 */
const OVERLAY_HEIGHT_RATIO = 0.85;
const MIN_VIEW_ROWS = 6;

export interface TodoViewRenderOptions {
	width: number;
	rows: number;
	selectedIndex: number;
}

/**
 * 全量清单视图：表头一行进度，中间是可导航的窗口，尾部是键位提示。
 * 纯函数，便于在没有终端的情况下测试行数与宽度约束。
 */
export function renderTodoViewLines(items: TodoItem[], theme: Theme, options: TodoViewRenderOptions): string[] {
	const width = Math.max(1, options.width);
	const rows = Math.max(CHROME_ROWS + 1, Math.floor(options.rows));
	const contentRows = Math.max(1, rows - CHROME_ROWS);
	const selectedIndex = Math.min(Math.max(Math.floor(options.selectedIndex), 0), Math.max(items.length - 1, 0));
	const window = selectWindow(items, selectedIndex, contentRows, { align: "center" });

	const position = window.visible.length < items.length ? ` (${selectedIndex + 1}/${items.length})` : "";
	const header = ` ${theme.fg("accent", theme.bold("Todos"))} · ${theme.fg("muted", formatProgress(items))}${theme.fg("dim", position)}`;

	const lines: string[] = [RULE.repeat(width), header];

	let index = window.hiddenAbove;
	for (const item of window.visible) {
		const pointer = index === selectedIndex ? theme.fg("accent", "→") : " ";
		const row = `${pointer} ${icon(items, item)} #${item.id} ${label(theme, item)}`;
		lines.push(index === selectedIndex ? theme.fg("accent", row) : row);
		index += 1;
	}

	lines.push(` ${theme.fg("dim", "↑↓ move · g/G top/bottom · Esc close")}`);
	lines.push(RULE.repeat(width));

	return lines.map((line) => truncateToWidth(line, width, "…"));
}

function icon(items: TodoItem[], item: TodoItem): string {
	if (isBlocked(items, item)) return "🔒";
	return item.status === "done" ? "✓" : item.status === "in_progress" ? "◉" : "○";
}

function label(theme: Theme, item: TodoItem): string {
	if (item.status !== "done") return item.title;
	return theme.fg("dim", theme.strikethrough(item.title));
}

/**
 * `/todos` 的 overlay 组件：↑↓ 移动，g/G 首尾，Esc/q 关闭。
 * 只读——没有任何操作会改动看板。
 */
export class TodoView implements Component {
	private currentIndex: number;

	constructor(
		private items: TodoItem[],
		private theme: Theme,
		private tui: { terminal: { rows: number } },
		private keybindings: KeybindingsManager | undefined,
		private onClose: () => void,
	) {
		// 打开时把光标放在在飞任务上，与 widget 的窗口锚点保持一致。
		const anchor = items.findIndex((t) => t.status === "in_progress");
		this.currentIndex = anchor === -1 ? 0 : anchor;
	}

	get selectedIndex(): number {
		return this.currentIndex;
	}

	render(width: number): string[] {
		return renderTodoViewLines(this.items, this.theme, {
			width,
			rows: this.viewportRows(),
			selectedIndex: this.currentIndex,
		});
	}

	invalidate(): void {
		// 每次 render 现算，无缓存可失效。
	}

	handleInput(data: string): void {
		if (
			this.matches("tui.select.cancel", data) ||
			matchesKey(data, "escape") ||
			matchesKey(data, "ctrl+c") ||
			data === "q"
		) {
			this.onClose();
			return;
		}
		if (this.matches("tui.select.up", data) || matchesKey(data, "up") || data === "k") {
			this.move(-1);
			return;
		}
		if (this.matches("tui.select.down", data) || matchesKey(data, "down") || data === "j") {
			this.move(1);
			return;
		}
		if (data === "g" || matchesKey(data, "home")) {
			this.jump(0);
			return;
		}
		if (data === "G" || matchesKey(data, "end")) {
			this.jump(this.items.length - 1);
		}
	}

	private matches(keybinding: Keybinding, data: string): boolean {
		return this.keybindings?.matches(data, keybinding) ?? false;
	}

	private viewportRows(): number {
		return Math.max(MIN_VIEW_ROWS, Math.floor(this.tui.terminal.rows * OVERLAY_HEIGHT_RATIO));
	}

	private move(delta: number): void {
		this.jump(this.currentIndex + delta);
	}

	private jump(target: number): void {
		const last = Math.max(0, this.items.length - 1);
		this.currentIndex = Math.min(Math.max(target, 0), last);
	}
}
