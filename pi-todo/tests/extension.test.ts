import { beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../index.js";
import type { TodoItem } from "../src/todo-store.js";

// 与 tests/widget.test.ts 同形的最小 Theme stub。
const theme = { fg: (_n: string, t: string) => t, strikethrough: (t: string) => t } as any;

/**
 * 捕获扩展注册的工具与事件处理器。index.ts 的默认导出把 todos 关在闭包里，
 * 所以每个用例（或每条「session」）都要重新调用一次 extension 拿新实例。
 */
function createHarness(getBranch: () => unknown[] = () => []) {
	const tools: any[] = [];
	const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
	const pi = {
		registerTool: (def: any) => tools.push(def),
		on: (event: string, handler: any) => {
			(handlers[event] ??= []).push(handler);
			return () => {};
		},
	};
	// hasUI=false 时 refreshWidget 直接返回，无需 stub 更多 UI。
	const ctx = { hasUI: false, sessionManager: { getBranch }, ui: { setWidget: vi.fn(), theme } };
	extension(pi as any);
	return { tools, handlers, ctx };
}

let tools: any[];
let handlers: Record<string, Array<(event: any, ctx: any) => any>>;
let ctx: any;
beforeEach(() => {
	({ tools, handlers, ctx } = createHarness());
});

const run = (params: Record<string, unknown>, id = "call") =>
	tools[0].execute(id, params, undefined, undefined, ctx);

describe("todo tool execute", () => {
	it("update returns an ack instead of a bare OK", async () => {
		await run({
			action: "set",
			items: [
				{ id: "1", title: "写单测", status: "pending" },
				{ id: "2", title: "修 CI", status: "pending" },
			],
		});
		const result = await run({ action: "update", id: "1", status: "done" });
		expect(result.content[0].text).toBe("✓ #1 写单测 done (1/2 done) · next: #2 修 CI");
	});

	it("set still returns the whole list", async () => {
		const result = await run({ action: "set", items: [{ id: "1", title: "写单测", status: "pending" }] });
		expect(result.content[0].text).toContain("○ [1] 写单测");
	});
});

describe("todo tool renderResult", () => {
	const todos: TodoItem[] = [
		{ id: "1", title: "写单测", status: "done" },
		{ id: "2", title: "修 CI", status: "done" },
		{ id: "3", title: "更新文档", status: "pending" },
	];
	const ack = "✓ #2 修 CI done (2/3 done) · next: #3 更新文档";

	it("renders the update ack without adding a second status marker", () => {
		const result = { content: [{ type: "text", text: ack }], details: { action: "update", todos } };
		const rendered = tools[0].renderResult(result, { expanded: false }, theme, {}).render(200).join("\n");
		expect(rendered.match(/✓/g)?.length).toBe(1);
		expect(rendered).toContain("#2 修 CI done");
	});
});
