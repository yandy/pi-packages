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
			'pi-todo echoes the list as <todo-state> at the start of each run; that echo is extension-generated, not a user message, and it does not refresh mid-run — call action "list" when unsure.',
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

describe("before_agent_start", () => {
	const fire = () => handlers["before_agent_start"]?.[0]({ type: "before_agent_start" }, ctx);

	it("registers exactly one before_agent_start handler", () => {
		expect(handlers["before_agent_start"]).toHaveLength(1);
	});

	it("injects nothing when there are no todos", async () => {
		expect(await fire()).toBeUndefined();
	});

	it("injects a hidden snapshot when tasks are open", async () => {
		await run({
			action: "set",
			items: [
				{ title: "写单测", status: "pending" },
				{ title: "修 CI", status: "pending" },
			],
		});
		const r = await fire();
		expect(r.message.customType).toBe("pi-todo");
		expect(r.message.display).toBe(false);
		expect(r.message.content).toContain("<todo-state>");
		expect(r.message.content).toContain("0/2 done");
	});

	it("stops injecting once every task is done", async () => {
		await run({ action: "set", items: [{ title: "写单测", status: "pending" }] });
		await run({ action: "update", id: "1", status: "done" }, "c2");
		expect(await fire()).toBeUndefined();
	});

	it("injects after state is reconstructed from a resumed session", async () => {
		// 重建路径必须用另一个 harness 实例：todos 关在 extension 闭包里
		const resumed = createHarness(() => [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: { todos: [{ id: "1", title: "写单测", status: "pending" }] },
				},
			},
		]);
		await resumed.handlers["session_start"][0]({ type: "session_start", reason: "startup" }, resumed.ctx);
		const r = await resumed.handlers["before_agent_start"][0]({ type: "before_agent_start" }, resumed.ctx);
		expect(r.message.content).toContain("写单测");
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
