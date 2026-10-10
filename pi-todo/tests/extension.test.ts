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

describe("prompt", () => {
	it("keeps the description to the API contract only", () => {
		const def = tools[0];
		expect(def.description).toContain("The tool owns ids");
		expect(def.description).toContain("exact id");
		expect(def.description).not.toContain("uuid");
		// 行为规则归 promptGuidelines，description 不抢它们的活
		expect(def.description).not.toContain("IMMEDIATELY");
		expect(def.description).not.toContain("batch");
		expect(def.description).not.toContain("Exactly one");
		// T3-B 之后这句话已经不成立，不能留在提示词里
		expect(def.description).not.toContain("NOT re-shown");
		expect(def.description.length).toBeLessThan(700);
	});

	it("puts the behavioral rules in guidelines without repeating the description", () => {
		expect(tools[0].promptGuidelines).toEqual([
			'Use todo to plan multi-step work: action "set" lists all tasks up front.',
			"Set a task in_progress before you start it, and keep exactly one in_progress at a time.",
			"Mark a task done as soon as it passes — never batch completions to the end of the run.",
			'Call todo action "list" when you need the current ids or statuses — the extension does not re-send the list on its own.',
		]);
		const repeated = tools[0].promptGuidelines.filter((g: string) => tools[0].description.includes(g));
		expect(repeated).toEqual([]);
	});
});

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
		expect(result.content[0].text).toContain("○ #1 写单测");
	});
});

describe("tool schema", () => {
	it("does not accept items[].id at all (ids belong to the tool)", () => {
		const itemSchema = (tools[0].parameters.properties.items as any).items;
		expect(itemSchema.properties.id).toBeUndefined();
		expect(itemSchema.required).toContain("title");
		expect(itemSchema.required).toContain("status");
	});
});

describe("context injection", () => {
	// T3-B（before_agent_start 注入 <todo-state>）已于 0.2.0 发布前删除：价值未被证明，
	// 且每轮一份会累积出「冒充当下、实为过去」的矛盾快照。见 spec §决策变更。
	// 这条断言是回归门：重新加回注入前先读完那段理由。
	it("registers no before_agent_start handler", () => {
		expect(handlers["before_agent_start"]).toBeUndefined();
	});

	it("does not write custom_message entries", () => {
		expect(Object.keys(handlers).sort()).toEqual(["session_start", "session_tree"]);
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
