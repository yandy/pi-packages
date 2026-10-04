import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseEntryFile } from "../src/entry-file";
import { parseEntryIndex } from "../src/entry-index";
import { MemoryStore, type StoreConfig } from "../src/memory-store";
import {
	createMemoryTool,
	DREAM_ACTIONS,
	MAIN_AGENT_ACTIONS,
	type MemoryAction,
	type MemoryToolDeps,
} from "../src/memory-tool";

let dir: string;
let store: MemoryStore;

const CFG = (memoryDir: string, over: Partial<StoreConfig> = {}): StoreConfig => ({
	memoryDir,
	indexMaxLines: 200,
	indexMaxBytes: 25600,
	lock: { timeoutMs: 5000, snapshotKeep: 5 },
	...over,
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
async function run(tool: any, params: Record<string, unknown>, ctx?: unknown): Promise<string> {
	const result = await tool.execute("call-1", params, undefined, undefined, ctx);
	const first = result.content?.[0];
	return first?.type === "text" ? first.text : "";
}

function schemaOf(tool: { parameters: unknown }): any {
	return tool.parameters;
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "mem-tool-"));
	store = new MemoryStore(CFG(dir));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("schema（D12 注册范围）", () => {
	it("exposes exactly the five main-agent actions and no new_name", () => {
		const schema = schemaOf(createMemoryTool(deps()));
		expect(schema.properties.action.enum).toEqual(["add", "replace", "remove", "list", "search"]);
		expect(schema.properties.action.enum).toEqual(MAIN_AGENT_ACTIONS);
		expect(Object.keys(schema.properties)).not.toContain("new_name");
		expect(schema.required).toEqual(["action"]);
	});

	it("exposes all seven actions plus new_name for dream", () => {
		const schema = schemaOf(createMemoryTool(deps(), { actions: DREAM_ACTIONS }));
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
		const schema = schemaOf(createMemoryTool(deps(), { actions: DREAM_ACTIONS }));
		for (const legacy of ["topic", "title", "entry"]) {
			expect(Object.keys(schema.properties)).not.toContain(legacy);
		}
	});

	it("keeps rename and rebuild_index out of the main-agent set", () => {
		const schema = schemaOf(createMemoryTool(deps()));
		expect(schema.properties.action.enum).not.toContain("rename");
		expect(schema.properties.action.enum).not.toContain("rebuild_index");
	});
});

describe("action add", () => {
	it("creates one entry file and exactly one index line", async () => {
		const tool = createMemoryTool(deps());
		const text = await run(tool, {
			action: "add",
			name: "Use real DB in tests",
			content: "集成测试必须连真实 PostgreSQL。",
		});

		expect(text).toBe('Saved "Use real DB in tests" (Use-real-DB-in-tests.md).');
		const parsed = parseEntryFile(await readFile(join(dir, "Use-real-DB-in-tests.md"), "utf8"));
		expect(parsed?.meta.name).toBe("Use real DB in tests");
		expect(parsed?.meta.description).toBe("集成测试必须连真实 PostgreSQL。");
		expect(parsed?.meta.type).toBe("feedback");
		expect(parsed?.meta.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(parsed?.meta.modified).toMatch(/T.*Z$/);
		expect(parseEntryIndex(await store.readIndex()).entries).toHaveLength(1);
	});

	it("is idempotent on the exact same name", async () => {
		const tool = createMemoryTool(deps());
		await run(tool, { action: "add", name: "A", content: "第一版" });
		const text = await run(tool, { action: "add", name: "A", content: "第二版" });

		expect(text).toBe('Saved "A" (A.md).');
		expect(await readdir(dir)).not.toContain("A-2.md");
		expect(parseEntryIndex(await store.readIndex()).entries).toHaveLength(1);
		expect((await store.readEntry("A"))?.body).toBe("第二版");
	});

	it("does not merge two different names that derive to the same file name", async () => {
		const tool = createMemoryTool(deps());
		await run(tool, { action: "add", name: "A B", content: "第一条" });
		const text = await run(tool, { action: "add", name: "A-B", content: "第二条" });

		expect(text).toBe('Saved "A-B" (A-B-2.md).');
		expect(parseEntryIndex(await store.readIndex()).entries).toHaveLength(2);
	});

	it("honours an explicit description and type", async () => {
		const tool = createMemoryTool(deps());
		await run(tool, { action: "add", name: "A", description: "显式摘要", type: "project", content: "正文" });

		expect((await store.readEntry("A"))?.description).toBe("显式摘要");
		expect((await store.readEntry("A"))?.type).toBe("project");
	});

	it("requires name and content", async () => {
		const tool = createMemoryTool(deps());
		await expect(run(tool, { action: "add", content: "正文" })).rejects.toThrow("name is required for add");
		await expect(run(tool, { action: "add", name: "A" })).rejects.toThrow("content is required for add");
	});

	// Review Focus #3：MEMORY.md 是索引本身，绝不能被当成 entry 文件写穿。
	it("never writes an entry over MEMORY.md", async () => {
		const tool = createMemoryTool(deps());
		await run(tool, { action: "add", name: "A", content: "A 正文" });
		const before = await store.readIndex();

		const text = await run(tool, { action: "add", name: "MEMORY", content: "关于记忆系统本身" });

		expect(text).not.toContain("(MEMORY.md)");
		expect(await store.readIndex()).toContain(before.trim());
		expect((await store.readEntry("MEMORY"))?.body).toBe("关于记忆系统本身");
		expect(parseEntryIndex(await store.readIndex()).entries.filter((e) => e.file === "A.md")).toHaveLength(1);
	});

	it("succeeds over capacity and returns an actionable warning with current values and limits", async () => {
		store = new MemoryStore(CFG(dir, { indexMaxLines: 1 }));
		const tool = createMemoryTool(deps());
		await run(tool, { action: "add", name: "A", content: "正文" });
		const text = await run(tool, { action: "add", name: "B", content: "正文" });

		expect(text).toContain('Saved "B" (B.md).');
		expect(text).toContain("over its limit");
		expect(text).toContain("2/1 lines");
		expect(text).toContain("Rewrite it now");
		expect(parseEntryIndex(await store.readIndex()).entries).toHaveLength(2);
	});

	// Review Focus #5：用户手写的索引内容与「无尾换行」都必须在工具写入后逐字保留。
	it("preserves handwritten index lines and a missing trailing newline", async () => {
		await writeFile(join(dir, "MEMORY.md"), "# Memory Index\n\n## Project\n<!-- keep -->", "utf8");
		const tool = createMemoryTool(deps());
		await run(tool, { action: "add", name: "A", content: "正文" });

		const raw = await store.readIndex();
		expect(raw).toContain("# Memory Index");
		expect(raw).toContain("## Project");
		expect(raw).toContain("<!-- keep -->");
		expect(parseEntryIndex(raw).entries).toHaveLength(1);
	});
});

describe("action replace", () => {
	it("rewrites the body and description of an existing entry", async () => {
		const tool = createMemoryTool(deps());
		await run(tool, { action: "add", name: "A", description: "旧摘要", content: "旧正文" });
		const text = await run(tool, { action: "replace", name: "A", content: "新正文", description: "新摘要" });

		expect(text).toBe('Replaced "A" (A.md).');
		const entry = await store.readEntry("A");
		expect(entry?.body).toBe("新正文");
		expect(entry?.description).toBe("新摘要");
		expect(parseEntryIndex(await store.readIndex()).entries).toHaveLength(1);
	});

	it("does not rename: rename is a separate, dream-only action", async () => {
		const tool = createMemoryTool(deps(), { actions: DREAM_ACTIONS });
		await run(tool, { action: "add", name: "A", content: "正文" });
		await run(tool, { action: "replace", name: "A", content: "新正文" });

		expect((await store.readEntry("A"))?.name).toBe("A");
		expect(await readdir(dir)).toContain("A.md");
	});

	it("propagates the store error for an unknown entry instead of swallowing it", async () => {
		const tool = createMemoryTool(deps());
		await expect(run(tool, { action: "replace", name: "nope", content: "x" })).rejects.toThrow(
			'Entry "nope" not found',
		);
	});

	it("requires name and content", async () => {
		const tool = createMemoryTool(deps());
		await expect(run(tool, { action: "replace", content: "x" })).rejects.toThrow("name is required for replace");
		await expect(run(tool, { action: "replace", name: "A" })).rejects.toThrow("content is required for replace");
	});
});

describe("action remove", () => {
	it("deletes the entry file and its index line", async () => {
		const tool = createMemoryTool(deps());
		await run(tool, { action: "add", name: "A", content: "正文" });
		const text = await run(tool, { action: "remove", name: "A" });

		expect(text).toBe('Removed "A".');
		expect(await readdir(dir)).not.toContain("A.md");
		expect(parseEntryIndex(await store.readIndex()).entries).toHaveLength(0);
	});

	it("propagates the store error instead of reporting success", async () => {
		const tool = createMemoryTool(deps());
		await expect(run(tool, { action: "remove", name: "nope" })).rejects.toThrow('Entry "nope" not found');
	});

	it("requires name", async () => {
		const tool = createMemoryTool(deps());
		await expect(run(tool, { action: "remove" })).rejects.toThrow("name is required for remove");
	});
});

describe("action list", () => {
	it("renders one line per entry with type, modified, description and file", async () => {
		const tool = createMemoryTool(deps());
		await run(tool, { action: "add", name: "A", description: "摘要 A", type: "user", content: "正文 A" });
		const entry = await store.readEntry("A");
		const text = await run(tool, { action: "list" });

		expect(text).toBe(`- A (user, modified ${entry?.modified}) — 摘要 A [A.md]`);
	});

	it("says so when there is nothing yet", async () => {
		const tool = createMemoryTool(deps());
		expect(await run(tool, { action: "list" })).toBe("No memories yet.");
	});
});

describe("action search", () => {
	it("searches memory entries by default and prints the bodies", async () => {
		const tool = createMemoryTool(deps());
		await run(tool, {
			action: "add",
			name: "SSH port",
			description: "staging 用 2222",
			content: "staging 的 SSH 端口是 2222。",
		});
		await run(tool, { action: "add", name: "Other", description: "无关", content: "完全无关的内容。" });

		const text = await run(tool, { action: "search", query: "2222" });

		expect(text).toContain("## SSH port");
		expect(text).toContain("file: SSH-port.md");
		expect(text).toContain("type: feedback");
		expect(text).toContain("staging 的 SSH 端口是 2222。");
		expect(text).not.toContain("## Other");
	});

	it("reports no matches", async () => {
		const tool = createMemoryTool(deps());
		expect(await run(tool, { action: "search", query: "nothing" })).toBe("No matches in memory.");
	});

	it("routes scope=sessions to searchSessions with the configured limits", async () => {
		const searchSessions = vi.fn(async () => "Found 1 match(es)");
		const tool = createMemoryTool(deps({ searchSessions }));

		const text = await run(tool, { action: "search", query: "q", scope: "sessions" });

		expect(text).toBe("Found 1 match(es)");
		expect(searchSessions).toHaveBeenCalledWith(dir, "q", { maxSessions: 10, maxMatches: 5 });
	});

	it("requires query", async () => {
		const tool = createMemoryTool(deps());
		await expect(run(tool, { action: "search" })).rejects.toThrow("query is required for search");
	});
});

describe("dream-only actions", () => {
	it("renames the entry, its file and its index line", async () => {
		const tool = createMemoryTool(deps(), { actions: DREAM_ACTIONS });
		await run(tool, { action: "add", name: "旧名字", content: "正文" });
		const text = await run(tool, { action: "rename", name: "旧名字", new_name: "新名字" });

		expect(text).toBe('Renamed "旧名字" → "新名字" (新名字.md).');
		expect(await readdir(dir)).not.toContain("旧名字.md");
		expect(parseEntryIndex(await store.readIndex()).entries.map((e) => e.name)).toEqual(["新名字"]);
	});

	it("requires name and new_name for rename", async () => {
		const tool = createMemoryTool(deps(), { actions: DREAM_ACTIONS });
		await run(tool, { action: "add", name: "A", content: "正文" });
		await expect(run(tool, { action: "rename", name: "A" })).rejects.toThrow("new_name is required for rename");
		await expect(run(tool, { action: "rename", new_name: "B" })).rejects.toThrow("name is required for rename");
	});

	it("rebuilds the index and reports entry and header line counts", async () => {
		const tool = createMemoryTool(deps(), { actions: DREAM_ACTIONS });
		await run(tool, { action: "add", name: "A", content: "正文" });
		await writeFile(join(dir, "MEMORY.md"), "", "utf8");

		const text = await run(tool, { action: "rebuild_index" });

		expect(text).toBe("Rebuilt index: 1 entries (2 header lines).");
		expect(parseEntryIndex(await store.readIndex()).entries).toHaveLength(1);
	});

	it("appends an actionable capacity warning after rebuild_index", async () => {
		store = new MemoryStore(CFG(dir, { indexMaxLines: 1 }));
		const tool = createMemoryTool(deps(), { actions: DREAM_ACTIONS });
		await run(tool, { action: "add", name: "A", content: "正文" });
		await run(tool, { action: "add", name: "B", content: "正文" });
		await writeFile(join(dir, "MEMORY.md"), "", "utf8");

		const text = await run(tool, { action: "rebuild_index" });

		expect(text).toContain("Rebuilt index: 2 entries");
		expect(text).toContain("over its limit");
		expect(text).toContain("/1 lines");
	});

	it("refuses an action outside the registered set", async () => {
		const tool = createMemoryTool(deps());
		await expect(run(tool, { action: "rename", name: "A", new_name: "B" })).rejects.toThrow(
			"Unknown action: rename",
		);
		await expect(run(tool, { action: "rebuild_index" })).rejects.toThrow("Unknown action: rebuild_index");
	});
});

describe("guards 与写选项透传", () => {
	it("throws when the store is not initialized yet", async () => {
		const tool = createMemoryTool(deps({ getStore: () => null }));
		await expect(run(tool, { action: "list" })).rejects.toThrow("Memory not initialized (no session_start yet)");
	});

	it("prints the unavailable message verbatim when the caller supplies one", async () => {
		const tool = createMemoryTool(
			deps({
				getStore: () => null,
				getUnavailableMessage: () =>
					'Memory not initialized — no model for dream — set "dream.model" or "defaults.model" in memory.json; run /memory for details',
			}),
		);
		await expect(run(tool, { action: "list" })).rejects.toThrow(
			'Memory not initialized — no model for dream — set "dream.model" or "defaults.model" in memory.json; run /memory for details',
		);
	});

	it("passes skipLogicalLock and skipSnapshot through to the store", async () => {
		const addEntry = vi.spyOn(store, "addEntry");
		const tool = createMemoryTool(deps(), {
			actions: MAIN_AGENT_ACTIONS,
			skipLogicalLock: true,
			skipSnapshot: true,
		});

		await run(tool, { action: "add", name: "A", content: "正文" });

		expect(addEntry).toHaveBeenCalledWith(
			{ name: "A", description: undefined, type: undefined, body: "正文" },
			{ skipLogicalLock: true, skipSnapshot: true },
		);
		expect(await readdir(join(dir, ".backups")).then(() => true, () => false)).toBe(false);
	});

	it("snapshots by default so a bad write can be rolled back", async () => {
		const tool = createMemoryTool(deps());
		await run(tool, { action: "add", name: "A", content: "正文" });
		expect(await readdir(join(dir, ".backups"))).toHaveLength(1);
	});
});

// ── Plan C（spec §14 通知）新增 ───────────────────────────────────────────────
describe("onWrite 回调与 Saved 通知", () => {
	/** 带 UI 的假 ExtensionContext（execute 的第 5 个参数）。 */
	function uiContext(notify = vi.fn()) {
		return { hasUI: true, ui: { notify, confirm: vi.fn(), setStatus: vi.fn() } };
	}

	it("fires once per successful write action, with the action and the name", async () => {
		const onWrite = vi.fn();
		const tool = createMemoryTool(deps(), { actions: DREAM_ACTIONS, onWrite });

		await run(tool, { action: "add", name: "A", description: "d", content: "正文" });
		await run(tool, { action: "replace", name: "A", content: "新正文" });
		await run(tool, { action: "rename", name: "A", new_name: "B" });
		await run(tool, { action: "remove", name: "B" });
		await run(tool, { action: "rebuild_index" });

		expect(onWrite.mock.calls.map((call) => call[0])).toEqual([
			{ action: "add", name: "A" },
			{ action: "replace", name: "A" },
			{ action: "rename", name: "A" },
			{ action: "remove", name: "B" },
			{ action: "rebuild_index", name: undefined },
		]);
	});

	it("never fires for read actions", async () => {
		const onWrite = vi.fn();
		const tool = createMemoryTool(deps(), { onWrite });
		await run(tool, { action: "add", name: "A", description: "d", content: "正文" });
		onWrite.mockClear();

		await run(tool, { action: "list" });
		await run(tool, { action: "search", query: "A" });
		await run(tool, { action: "search", query: "A", scope: "sessions" });

		expect(onWrite).not.toHaveBeenCalled();
	});

	it("does not fire when the write is rejected", async () => {
		const onWrite = vi.fn();
		const tool = createMemoryTool(deps(), { onWrite });

		await expect(run(tool, { action: "add", name: "", content: "x" })).rejects.toThrow("name is required for add");
		await expect(run(tool, { action: "add", name: "A", content: "" })).rejects.toThrow(
			"content is required for add",
		);
		await expect(run(tool, { action: "remove", name: "不存在" })).rejects.toThrow();

		expect(onWrite).not.toHaveBeenCalled();
	});

	it("notifies 'Saved: <name>' after a successful add when the context has a UI", async () => {
		const notify = vi.fn();
		const tool = createMemoryTool(deps());

		await run(tool, { action: "add", name: "SSH port on staging", description: "d", content: "正文" }, uiContext(notify));

		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith("Saved: SSH port on staging", "info");
	});

	it("trims the name in the Saved notification", async () => {
		const notify = vi.fn();
		const tool = createMemoryTool(deps());

		await run(tool, { action: "add", name: "  Padded  ", description: "d", content: "正文" }, uiContext(notify));

		expect(notify).toHaveBeenCalledWith("Saved: Padded", "info");
	});

	// Review Focus #4：headless 会话不弹通知。
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

	// Plan C 终审 #11 / Plan D（D4）：`ctx.ui` 是宿主代理，session dispose 之后 notify 会抛。
	// 一次**已经成功落盘**的写入不得因此变成工具错误 —— 模型会以为没存下来而重复写。
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

// ── Plan C 清理项（Plan B ledger 分诊给 Plan C 的低风险 Minor）─────────────────
describe("action 集合是冻结的（D12 的注册范围不得被静默拓宽）", () => {
	it("freezes both action sets", () => {
		expect(Object.isFrozen(MAIN_AGENT_ACTIONS)).toBe(true);
		expect(Object.isFrozen(DREAM_ACTIONS)).toBe(true);
	});

	// `StringEnum` 按引用持有这个数组：谁 push 一下，已经注册出去的 enum 就跟着变宽。
	it("refuses a push so a registered schema can never widen", () => {
		expect(() => (MAIN_AGENT_ACTIONS as MemoryAction[]).push("rebuild_index")).toThrow(TypeError);
		expect(() => (DREAM_ACTIONS as MemoryAction[]).splice(0, 1)).toThrow(TypeError);

		expect(MAIN_AGENT_ACTIONS).toEqual(["add", "replace", "remove", "list", "search"]);
		expect(DREAM_ACTIONS).toEqual([
			"add",
			"replace",
			"remove",
			"list",
			"search",
			"rename",
			"rebuild_index",
		]);
	});

	it("still builds both schemas from the frozen sets", () => {
		expect(schemaOf(createMemoryTool(deps())).properties.action.enum).toEqual([...MAIN_AGENT_ACTIONS]);
		expect(schemaOf(createMemoryTool(deps(), { actions: DREAM_ACTIONS })).properties.action.enum).toEqual([
			...DREAM_ACTIONS,
		]);
	});
});

describe("search 的 sessions 分支也填 details", () => {
	it("reports the scope and the trimmed query instead of an empty object", async () => {
		const tool = createMemoryTool(deps()) as any;

		const result = await tool.execute(
			"c1",
			{ action: "search", query: "  ssh  ", scope: "sessions" },
			undefined,
			undefined,
			undefined,
		);

		expect(result.details).toEqual({ scope: "sessions", query: "ssh" });
		expect(result.content[0].text).toBe("session hits");
	});

	it("keeps the memory scope details as they were", async () => {
		const tool = createMemoryTool(deps()) as any;
		await tool.execute("c0", { action: "add", name: "A", description: "d", content: "正文" }, undefined, undefined, undefined);

		const result = await tool.execute("c1", { action: "search", query: "正文" }, undefined, undefined, undefined);

		expect(result.details).toEqual({ count: 1 });
	});
});
