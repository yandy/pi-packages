import { describe, expect, it } from "vitest";
import { DREAM_ACTIONS, MAIN_AGENT_ACTIONS, type MemoryAction, memoryToolSchema } from "../src/index.js";

/**
 * `memory` 工具的中立契约。
 *
 * 这里钉的是**发给模型的 JSON Schema 本身**：pi 适配层把它转成 typebox、dsh 适配层把它转成
 * schemastery，两边都必须转出与这里逐字相同的线格式（pi 侧的钉子是
 * `pi-memory/tests/memory-tool.test.ts` 的 JSON 往返相等用例）。所以任何一处改动都等于改了
 * 所有宿主的工具schema，必须在这里先红。
 */
describe("memoryToolSchema", () => {
	it("exposes exactly the five main-agent actions and no new_name", () => {
		const schema = memoryToolSchema(MAIN_AGENT_ACTIONS);
		expect(schema.properties.action.enum).toEqual(["add", "replace", "remove", "list", "search"]);
		expect(schema.properties.action.enum).toEqual([...MAIN_AGENT_ACTIONS]);
		expect(Object.keys(schema.properties)).not.toContain("new_name");
		expect(schema.required).toEqual(["action"]);
	});

	it("exposes all seven actions plus new_name for dream", () => {
		const schema = memoryToolSchema(DREAM_ACTIONS);
		expect(schema.properties.action.enum).toEqual([
			"add",
			"replace",
			"remove",
			"list",
			"search",
			"rename",
			"rebuild_index",
		]);
		expect(Object.keys(schema.properties)).toContain("new_name");
	});

	it("drops the legacy topic/title/entry parameters", () => {
		const schema = memoryToolSchema(DREAM_ACTIONS);
		for (const legacy of ["topic", "title", "entry"]) {
			expect(Object.keys(schema.properties)).not.toContain(legacy);
		}
	});

	it("emits the exact wire format every adapter must reproduce", () => {
		expect(memoryToolSchema(MAIN_AGENT_ACTIONS)).toEqual({
			type: "object",
			required: ["action"],
			properties: {
				action: {
					type: "string",
					enum: ["add", "replace", "remove", "list", "search"],
					description: "Which memory operation to perform.",
				},
				name: {
					type: "string",
					description:
						"Unique, human-readable title of the memory. Required for add; the lookup key for replace/remove/rename.",
				},
				description: {
					type: "string",
					description:
						"One self-contained line; future sessions select memories from it. Defaults to the first sentence of content.",
				},
				type: {
					type: "string",
					enum: ["user", "feedback", "project", "reference"],
					description: "Memory type. Defaults to feedback.",
				},
				content: {
					type: "string",
					description: "The memory body. Required for add and replace; it becomes the whole entry file.",
				},
				query: { type: "string", description: "Search text (search)." },
				scope: {
					type: "string",
					enum: ["memory", "sessions"],
					description: "search target: memory entries (default) or past sessions.",
				},
			},
		});
	});

	it("adds new_name last, and only for a schema that includes rename", () => {
		expect(Object.keys(memoryToolSchema(DREAM_ACTIONS).properties)).toEqual([
			"action",
			"name",
			"description",
			"type",
			"content",
			"query",
			"scope",
			"new_name",
		]);
		expect(memoryToolSchema(DREAM_ACTIONS).properties.new_name).toEqual({
			type: "string",
			description: "New unique title for the memory (rename). Its file name and index line follow.",
		});
	});

	it("narrows the action enum to whatever subset it is given", () => {
		const subset: readonly MemoryAction[] = ["add", "list"];
		expect(memoryToolSchema(subset).properties.action.enum).toEqual(["add", "list"]);
	});
});

describe("action 集合是冻结的（注册范围不得被静默拓宽）", () => {
	it("freezes both action sets", () => {
		expect(Object.isFrozen(MAIN_AGENT_ACTIONS)).toBe(true);
		expect(Object.isFrozen(DREAM_ACTIONS)).toBe(true);
	});

	// 适配器按引用持有这两个数组去建 enum：谁 push 一下，已经注册出去的 schema 就跟着变宽。
	it("refuses a push so a registered schema can never widen", () => {
		expect(() => (MAIN_AGENT_ACTIONS as MemoryAction[]).push("rebuild_index")).toThrow(TypeError);
		expect(() => (DREAM_ACTIONS as MemoryAction[]).splice(0, 1)).toThrow(TypeError);

		expect(MAIN_AGENT_ACTIONS).toEqual(["add", "replace", "remove", "list", "search"]);
		expect(DREAM_ACTIONS).toEqual(["add", "replace", "remove", "list", "search", "rename", "rebuild_index"]);
	});

	it("still builds both schemas from the frozen sets", () => {
		expect(memoryToolSchema(MAIN_AGENT_ACTIONS).properties.action.enum).toEqual([...MAIN_AGENT_ACTIONS]);
		expect(memoryToolSchema(DREAM_ACTIONS).properties.action.enum).toEqual([...DREAM_ACTIONS]);
	});
});
