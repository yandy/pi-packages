import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	formatAck,
	isBlocked,
	listTodos,
	reconstructTodos,
	setTodos,
	type TodoDraft,
	type TodoItem,
	type TodoResult,
	updateTodo,
} from "./src/todo-store.js";
import { renderWidget } from "./src/widget.js";

// 编辑器上方 widget 的 slot id（值就是本包的标识）。
const PACKAGE_ID = "pi-todo";

interface TodoDetails {
	action: "set" | "update" | "list";
	todos: TodoItem[];
	error?: string;
}

export default function (pi: ExtensionAPI) {
	let todos: TodoItem[] = [];

	const refreshWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const lines = renderWidget(todos, ctx.ui.theme);
		ctx.ui.setWidget(PACKAGE_ID, lines ?? undefined);
	};

	// Reconstruct branch-safe state from tool-result details on (re)start / tree navigation.
	const reconstructState = (ctx: ExtensionContext) => {
		todos = reconstructTodos(ctx.sessionManager.getBranch());
		refreshWidget(ctx);
	};

	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	const TodoParams = Type.Object({
		action: Type.String({ enum: ["set", "update", "list"] }),
		items: Type.Optional(
			Type.Array(
				Type.Object({
					title: Type.String(),
					status: Type.String({ enum: ["pending", "in_progress", "done"] }),
					blockedBy: Type.Optional(Type.Array(Type.String())),
				}),
			),
		),
		id: Type.Optional(Type.String()),
		status: Type.Optional(Type.String({ enum: ["pending", "in_progress", "done"] })),
		title: Type.Optional(Type.String()),
		blockedBy: Type.Optional(Type.Array(Type.String())),
	});

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Track a task list for the current session.\n" +
			'"set" replaces the whole list with items {title, status: pending|in_progress|done, blockedBy?: ids} and returns it. ' +
			"The tool owns ids: it assigns 1..n by position and renumbers them on every set, so never pass an id.\n" +
			'"update" changes one task by its exact id (status / title / blockedBy) and returns progress plus the next task.\n' +
			'"list" returns the current list.',
		promptSnippet: "Track a task list (set/update/list); keep statuses current.",
		promptGuidelines: [
			'Use todo to plan multi-step work: action "set" lists all tasks up front.',
			"Set a task in_progress before you start it, and keep exactly one in_progress at a time.",
			"Mark a task done as soon as it passes — never batch completions to the end of the run.",
			'Call todo action "list" when you need the current ids or statuses — the extension does not re-send the list on its own.',
		],
		parameters: TodoParams,

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.action === "update" && args.id) text += ` ${theme.fg("accent", args.id)}`;
			if (args.action === "set" && args.items) text += ` ${theme.fg("dim", `(${args.items.length} items)`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as TodoDetails | undefined;
			if (details?.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}
			if (!details) {
				const text = result.content?.[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.action === "list" || details.action === "set") {
				if (details.todos.length === 0) {
					return new Text(theme.fg("dim", "No todos"), 0, 0);
				}
				const done = details.todos.filter((t) => t.status === "done").length;
				let out = theme.fg("muted", `${done}/${details.todos.length} done`);
				const display = expanded ? details.todos : details.todos.slice(0, 8);
				for (const t of display) {
					const icon = isBlocked(details.todos, t)
						? "🔒"
						: t.status === "done"
							? "✓"
							: t.status === "in_progress"
								? "◉"
								: "○";
					const label = t.status === "done" ? theme.strikethrough(theme.fg("dim", t.title)) : theme.fg("text", t.title);
					out += `\n${icon} ${theme.fg("accent", t.id.slice(0, 4))} ${label}`;
				}
				if (!expanded && details.todos.length > 8) {
					out += `\n${theme.fg("dim", `... ${details.todos.length - 8} more`)}`;
				}
				return new Text(out, 0, 0);
			}

			// update：ack 自带状态图标，不能再拼前缀，否则渲染出两个 ✓
			const text = result.content?.[0];
			return new Text(theme.fg("success", text?.type === "text" ? text.text : ""), 0, 0);
		},

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			let result: TodoResult;

			switch (params.action) {
				case "set": {
					result = setTodos((params.items ?? []) as TodoDraft[]);
					break;
				}
				case "update": {
					if (!params.id) {
						result = { todos: [...todos], error: "id is required for update" };
					} else {
						result = updateTodo(todos, params.id, {
							status: params.status as TodoItem["status"] | undefined,
							title: params.title,
							blockedBy: params.blockedBy,
						});
					}
					break;
				}
				default: {
					result = { todos: [...todos] };
					break;
				}
			}

			if (!result.error) {
				todos = result.todos;
			}

			refreshWidget(ctx);

			const text =
				result.error ?? (params.action === "update" ? formatAck(todos, result.id ?? params.id ?? "") : listTodos(todos));
			return {
				content: [{ type: "text", text }],
				details: { action: params.action, todos: [...todos], error: result.error } as TodoDetails,
			};
		},
	});
}
