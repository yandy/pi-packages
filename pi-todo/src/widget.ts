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
 * Done items are shown with ✓ + strikethrough; only when ALL are done is the widget hidden.
 */
export function renderWidget(items: TodoItem[], theme: Theme): string[] | null {
	if (items.length === 0 || items.every((t) => t.status === "done")) return null;

	return items.map((t) => {
		const icon = isBlocked(items, t) ? "🔒" : STATUS_ICON[t.status];
		const label = t.status === "done" ? theme.strikethrough(t.title) : t.title;
		return theme.fg("muted", `${icon} ${label}`);
	});
}
