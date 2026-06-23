import type { Theme } from "@earendil-works/pi-coding-agent";
import { isBlocked, type TodoItem } from "./todo-store.js";

const STATUS_ICON: Record<TodoItem["status"], string> = {
	pending: "○",
	in_progress: "◉",
	done: "✓",
};

/**
 * Render the editor-overhead widget lines for the current todo list.
 * Returns null (hide the widget) when there are no todos or every todo is done.
 * Done items are omitted from the widget to keep it compact.
 */
export function renderWidget(items: TodoItem[], theme: Theme): string[] | null {
	const visible = items.filter((t) => t.status !== "done");
	if (visible.length === 0) return null;

	const parts = visible.map((t) => {
		const icon = isBlocked(items, t) ? "🔒" : STATUS_ICON[t.status];
		const label = t.title;
		return theme.fg("muted", `${icon} ${label}`);
	});

	return [parts.join(theme.fg("dim", "  "))];
}
