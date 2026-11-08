import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DREAM_ACTIONS,
	MAIN_AGENT_ACTIONS,
	MEMORY_TOOL_DESCRIPTION,
	MEMORY_TOOL_GUIDELINES,
	MEMORY_TOOL_LABEL,
	MEMORY_TOOL_NAME,
	MEMORY_TOOL_SNIPPET,
	MemoryStore,
	type StoreConfig,
	memoryToolSchema,
} from "@yandy0725/auto-memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryTool, type MemoryToolDeps } from "../src/memory-tool";

/**
 * pi 适配层只负责三件事：把 core 的 JSON Schema 转成 typebox、渲染、以及 `ctx.ui.notify`。
 * action 的语义与磁盘效果全部钉在 `auto-memory/tests/memory-handler.test.ts`，这里不重复。
 */
let dir: string;
let store: MemoryStore;

const CFG = (memoryDir: string): StoreConfig => ({
	memoryDir,
	indexMaxLines: 200,
	indexMaxBytes: 25600,
	lock: { timeoutMs: 5000, snapshotKeep: 5 },
});

function deps(over: Partial<MemoryToolDeps> = {}): MemoryToolDeps {
	return {
		getMemoryDir: () => dir,
		getStore: () => store,
		getConfig: () => ({
			memIndexMaxLines: store.cfg.indexMaxLines,
			memIndexMaxBytes: store.cfg.indexMaxBytes,
			sessionSearch: { maxSessions: 10, maxMatches: 5 },
		}),
		getUnavailableMessage: () => null,
		searchSessions: async () => "session hits",
		cwd: () => dir,
		...over,
	};
}

/**
 * 跑一次工具调用并取回文本。`tool` 用 any：ToolDefinition 的 execute 第五参在类型上是必填的
 * ExtensionContext，而测试只需要塞 UI 相关的两三个字段（`ctx` 缺省 = 无 UI）。
 */
// biome-ignore lint/suspicious/noExplicitAny: 测试只塞 UI 字段
async function run(tool: any, params: Record<string, unknown>, ctx?: unknown): Promise<string> {
	const result = await tool.execute("call-1", params, undefined, undefined, ctx);
	const first = result.content?.[0];
	return first?.type === "text" ? first.text : "";
}

/** 带 UI 的假 ExtensionContext（execute 的第 5 个参数）。 */
function uiContext(notify = vi.fn()) {
	return { hasUI: true, ui: { notify, confirm: vi.fn(), setStatus: vi.fn() } };
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "mem-pitool-"));
	store = new MemoryStore(CFG(dir));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("schema 转换（JSON Schema → typebox）", () => {
	it("reproduces core's schema byte for byte after a JSON round trip", () => {
		// 这条不变量就是「拆分没有改变发给模型的线格式」：typebox 只是 core JSON Schema 的载体。
		expect(JSON.parse(JSON.stringify(createMemoryTool(deps()).parameters))).toEqual(
			memoryToolSchema(MAIN_AGENT_ACTIONS),
		);
	});

	it("does the same for dream's seven actions", () => {
		expect(JSON.parse(JSON.stringify(createMemoryTool(deps(), { actions: DREAM_ACTIONS }).parameters))).toEqual(
			memoryToolSchema(DREAM_ACTIONS),
		);
	});

	it("keeps action required and every other parameter optional", () => {
		const schema = JSON.parse(JSON.stringify(createMemoryTool(deps()).parameters));
		expect(schema.type).toBe("object");
		expect(schema.required).toEqual(["action"]);
		expect(schema.properties.action.enum).toEqual(["add", "replace", "remove", "list", "search"]);
	});
});

describe("三通道文案来自 core", () => {
	it("carries core's name, label, description, snippet and guidelines verbatim", () => {
		const tool = createMemoryTool(deps());
		expect(tool.name).toBe(MEMORY_TOOL_NAME);
		expect(tool.label).toBe(MEMORY_TOOL_LABEL);
		expect(tool.description).toBe(MEMORY_TOOL_DESCRIPTION);
		expect(tool.promptSnippet).toBe(MEMORY_TOOL_SNIPPET);
		expect(tool.promptGuidelines).toEqual([...MEMORY_TOOL_GUIDELINES]);
		expect(tool.promptGuidelines).toHaveLength(7);
	});
});

describe("Saved 通知（pi 通道，core 不认识 ctx.ui）", () => {
	it("trims the name in the Saved notification", async () => {
		const notify = vi.fn();
		const tool = createMemoryTool(deps());

		await run(tool, { action: "add", name: "  Padded  ", description: "d", content: "正文" }, uiContext(notify));

		expect(notify).toHaveBeenCalledWith("Saved: Padded", "info");
	});

	it("does not notify without a UI (headless extract / dream sessions)", async () => {
		const notify = vi.fn();
		const tool = createMemoryTool(deps());
		const headless = { hasUI: false, ui: { notify } };

		await run(tool, { action: "add", name: "A", description: "d", content: "正文" }, headless);
		// ctx 完全缺失（旧的调用形状）也不能炸
		await run(tool, { action: "add", name: "B", description: "d", content: "正文" });

		expect(notify).not.toHaveBeenCalled();
		expect(await store.listEntries()).toHaveLength(2);
	});

	// `ctx.ui` 是宿主代理，session dispose 之后 notify 会抛。一次**已经成功落盘**的写入不得因此
	// 变成工具错误 —— 模型会以为没存下来而重复写。
	it("still reports a successful add when the Saved notification throws", async () => {
		const notify = vi.fn(() => {
			throw new Error("Extension instance is no longer active");
		});
		const tool = createMemoryTool(deps());

		const text = await run(
			tool,
			{ action: "add", name: "A", description: "d", content: "正文" },
			{ hasUI: true, ui: { notify } },
		);

		expect(notify).toHaveBeenCalledTimes(1);
		expect(text).toBe('Saved "A" (A.md).');
		expect(await readFile(join(dir, "A.md"), "utf8")).toContain("name: A");
		expect(await store.listEntries()).toHaveLength(1);
	});

	it("notifies for add only — replace / rename / remove stay quiet", async () => {
		const notify = vi.fn();
		const ctx = uiContext(notify);
		const tool = createMemoryTool(deps(), { actions: DREAM_ACTIONS });

		await run(tool, { action: "add", name: "A", description: "d", content: "正文" }, ctx);
		await run(tool, { action: "replace", name: "A", content: "新正文" }, ctx);
		await run(tool, { action: "rename", name: "A", new_name: "B" }, ctx);
		await run(tool, { action: "remove", name: "B" }, ctx);
		await run(tool, { action: "rebuild_index" }, ctx);

		expect(notify.mock.calls).toEqual([["Saved: A", "info"]]);
	});
});
