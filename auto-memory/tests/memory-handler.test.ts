import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseEntryFile } from "../src/store/entry-file.js";
import { parseEntryIndex } from "../src/store/entry-index.js";
import { MemoryStore, type StoreConfig } from "../src/store/memory-store.js";
import { DREAM_ACTIONS, MAIN_AGENT_ACTIONS, createMemoryActionHandler, type MemoryHandlerDeps } from "../src/index.js";

let dir: string;
let store: MemoryStore;

const CFG = (memoryDir: string, over: Partial<StoreConfig> = {}): StoreConfig => ({
	memoryDir,
	indexMaxLines: 200,
	indexMaxBytes: 25600,
	lock: { timeoutMs: 5000, snapshotKeep: 5 },
	...over,
});

function deps(over: Partial<MemoryHandlerDeps> = {}): MemoryHandlerDeps {
	return {
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

/** 跑一次 action 并取回给模型的文本。 */
async function run(
	handler: (params: unknown) => Promise<{ text: string; details: Record<string, unknown> }>,
	params: Record<string, unknown>,
): Promise<string> {
	return (await handler(params)).text;
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "mem-tool-"));
	store = new MemoryStore(CFG(dir));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});


describe("action add", () => {
	it("creates one entry file and exactly one index line", async () => {
		const handler = createMemoryActionHandler(deps());
		const text = await run(handler, {
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
		const handler = createMemoryActionHandler(deps());
		await run(handler, { action: "add", name: "A", content: "第一版" });
		const text = await run(handler, { action: "add", name: "A", content: "第二版" });

		expect(text).toBe('Saved "A" (A.md).');
		expect(await readdir(dir)).not.toContain("A-2.md");
		expect(parseEntryIndex(await store.readIndex()).entries).toHaveLength(1);
		expect((await store.readEntry("A"))?.body).toBe("第二版");
	});

	it("does not merge two different names that derive to the same file name", async () => {
		const handler = createMemoryActionHandler(deps());
		await run(handler, { action: "add", name: "A B", content: "第一条" });
		const text = await run(handler, { action: "add", name: "A-B", content: "第二条" });

		expect(text).toBe('Saved "A-B" (A-B-2.md).');
		expect(parseEntryIndex(await store.readIndex()).entries).toHaveLength(2);
	});

	it("honours an explicit description and type", async () => {
		const handler = createMemoryActionHandler(deps());
		await run(handler, { action: "add", name: "A", description: "显式摘要", type: "project", content: "正文" });

		expect((await store.readEntry("A"))?.description).toBe("显式摘要");
		expect((await store.readEntry("A"))?.type).toBe("project");
	});

	it("requires name and content", async () => {
		const handler = createMemoryActionHandler(deps());
		await expect(run(handler, { action: "add", content: "正文" })).rejects.toThrow("name is required for add");
		await expect(run(handler, { action: "add", name: "A" })).rejects.toThrow("content is required for add");
	});

	// MEMORY.md 是索引本身，绝不能被当成 entry 文件写穿。
	it("never writes an entry over MEMORY.md", async () => {
		const handler = createMemoryActionHandler(deps());
		await run(handler, { action: "add", name: "A", content: "A 正文" });
		const before = await store.readIndex();

		const text = await run(handler, { action: "add", name: "MEMORY", content: "关于记忆系统本身" });

		expect(text).not.toContain("(MEMORY.md)");
		expect(await store.readIndex()).toContain(before.trim());
		expect((await store.readEntry("MEMORY"))?.body).toBe("关于记忆系统本身");
		expect(parseEntryIndex(await store.readIndex()).entries.filter((e) => e.file === "A.md")).toHaveLength(1);
	});

	it("succeeds over capacity and returns an actionable warning with current values and limits", async () => {
		store = new MemoryStore(CFG(dir, { indexMaxLines: 1 }));
		const handler = createMemoryActionHandler(deps());
		await run(handler, { action: "add", name: "A", content: "正文" });
		const text = await run(handler, { action: "add", name: "B", content: "正文" });

		expect(text).toContain('Saved "B" (B.md).');
		expect(text).toContain("over its limit");
		expect(text).toContain("2/1 lines");
		expect(text).toContain("Rewrite it now");
		expect(parseEntryIndex(await store.readIndex()).entries).toHaveLength(2);
	});

	// 用户手写的索引内容与「无尾换行」都必须在工具写入后逐字保留。
	it("preserves handwritten index lines and a missing trailing newline", async () => {
		await writeFile(join(dir, "MEMORY.md"), "# Memory Index\n\n## Project\n<!-- keep -->", "utf8");
		const handler = createMemoryActionHandler(deps());
		await run(handler, { action: "add", name: "A", content: "正文" });

		const raw = await store.readIndex();
		expect(raw).toContain("# Memory Index");
		expect(raw).toContain("## Project");
		expect(raw).toContain("<!-- keep -->");
		expect(parseEntryIndex(raw).entries).toHaveLength(1);
	});
});

describe("action replace", () => {
	it("rewrites the body and description of an existing entry", async () => {
		const handler = createMemoryActionHandler(deps());
		await run(handler, { action: "add", name: "A", description: "旧摘要", content: "旧正文" });
		const text = await run(handler, { action: "replace", name: "A", content: "新正文", description: "新摘要" });

		expect(text).toBe('Replaced "A" (A.md).');
		const entry = await store.readEntry("A");
		expect(entry?.body).toBe("新正文");
		expect(entry?.description).toBe("新摘要");
		expect(parseEntryIndex(await store.readIndex()).entries).toHaveLength(1);
	});

	it("does not rename: rename is a separate, dream-only action", async () => {
		const handler = createMemoryActionHandler(deps(), { actions: DREAM_ACTIONS });
		await run(handler, { action: "add", name: "A", content: "正文" });
		await run(handler, { action: "replace", name: "A", content: "新正文" });

		expect((await store.readEntry("A"))?.name).toBe("A");
		expect(await readdir(dir)).toContain("A.md");
	});

	it("propagates the store error for an unknown entry instead of swallowing it", async () => {
		const handler = createMemoryActionHandler(deps());
		await expect(run(handler, { action: "replace", name: "nope", content: "x" })).rejects.toThrow(
			'Entry "nope" not found',
		);
	});

	it("requires name and content", async () => {
		const handler = createMemoryActionHandler(deps());
		await expect(run(handler, { action: "replace", content: "x" })).rejects.toThrow("name is required for replace");
		await expect(run(handler, { action: "replace", name: "A" })).rejects.toThrow("content is required for replace");
	});
});

describe("action remove", () => {
	it("deletes the entry file and its index line", async () => {
		const handler = createMemoryActionHandler(deps());
		await run(handler, { action: "add", name: "A", content: "正文" });
		const text = await run(handler, { action: "remove", name: "A" });

		expect(text).toBe('Removed "A".');
		expect(await readdir(dir)).not.toContain("A.md");
		expect(parseEntryIndex(await store.readIndex()).entries).toHaveLength(0);
	});

	it("propagates the store error instead of reporting success", async () => {
		const handler = createMemoryActionHandler(deps());
		await expect(run(handler, { action: "remove", name: "nope" })).rejects.toThrow('Entry "nope" not found');
	});

	it("requires name", async () => {
		const handler = createMemoryActionHandler(deps());
		await expect(run(handler, { action: "remove" })).rejects.toThrow("name is required for remove");
	});
});

describe("action list", () => {
	it("renders one line per entry with type, modified, description and file", async () => {
		const handler = createMemoryActionHandler(deps());
		await run(handler, { action: "add", name: "A", description: "摘要 A", type: "user", content: "正文 A" });
		const entry = await store.readEntry("A");
		const text = await run(handler, { action: "list" });

		expect(text).toBe(`- A (user, modified ${entry?.modified}) — 摘要 A [A.md]`);
	});

	it("says so when there is nothing yet", async () => {
		const handler = createMemoryActionHandler(deps());
		expect(await run(handler, { action: "list" })).toBe("No memories yet.");
	});
});

describe("action search", () => {
	it("searches memory entries by default and prints the bodies", async () => {
		const handler = createMemoryActionHandler(deps());
		await run(handler, {
			action: "add",
			name: "SSH port",
			description: "staging 用 2222",
			content: "staging 的 SSH 端口是 2222。",
		});
		await run(handler, { action: "add", name: "Other", description: "无关", content: "完全无关的内容。" });

		const text = await run(handler, { action: "search", query: "2222" });

		expect(text).toContain("## SSH port");
		expect(text).toContain("file: SSH-port.md");
		expect(text).toContain("type: feedback");
		expect(text).toContain("staging 的 SSH 端口是 2222。");
		expect(text).not.toContain("## Other");
	});

	it("reports no matches", async () => {
		const handler = createMemoryActionHandler(deps());
		expect(await run(handler, { action: "search", query: "nothing" })).toBe("No matches in memory.");
	});

	it("routes scope=sessions to searchSessions with the configured limits", async () => {
		const searchSessions = vi.fn(async () => "Found 1 match(es)");
		const handler = createMemoryActionHandler(deps({ searchSessions }));

		const text = await run(handler, { action: "search", query: "q", scope: "sessions" });

		expect(text).toBe("Found 1 match(es)");
		expect(searchSessions).toHaveBeenCalledWith(dir, "q", { maxSessions: 10, maxMatches: 5 });
	});

	it("requires query", async () => {
		const handler = createMemoryActionHandler(deps());
		await expect(run(handler, { action: "search" })).rejects.toThrow("query is required for search");
	});
});

describe("dream-only actions", () => {
	it("renames the entry, its file and its index line", async () => {
		const handler = createMemoryActionHandler(deps(), { actions: DREAM_ACTIONS });
		await run(handler, { action: "add", name: "旧名字", content: "正文" });
		const text = await run(handler, { action: "rename", name: "旧名字", new_name: "新名字" });

		expect(text).toBe('Renamed "旧名字" → "新名字" (新名字.md).');
		expect(await readdir(dir)).not.toContain("旧名字.md");
		expect(parseEntryIndex(await store.readIndex()).entries.map((e) => e.name)).toEqual(["新名字"]);
	});

	it("requires name and new_name for rename", async () => {
		const handler = createMemoryActionHandler(deps(), { actions: DREAM_ACTIONS });
		await run(handler, { action: "add", name: "A", content: "正文" });
		await expect(run(handler, { action: "rename", name: "A" })).rejects.toThrow("new_name is required for rename");
		await expect(run(handler, { action: "rename", new_name: "B" })).rejects.toThrow("name is required for rename");
	});

	it("rebuilds the index and reports entry and header line counts", async () => {
		const handler = createMemoryActionHandler(deps(), { actions: DREAM_ACTIONS });
		await run(handler, { action: "add", name: "A", content: "正文" });
		await writeFile(join(dir, "MEMORY.md"), "", "utf8");

		const text = await run(handler, { action: "rebuild_index" });

		expect(text).toBe("Rebuilt index: 1 entries (2 header lines).");
		expect(parseEntryIndex(await store.readIndex()).entries).toHaveLength(1);
	});

	it("appends an actionable capacity warning after rebuild_index", async () => {
		store = new MemoryStore(CFG(dir, { indexMaxLines: 1 }));
		const handler = createMemoryActionHandler(deps(), { actions: DREAM_ACTIONS });
		await run(handler, { action: "add", name: "A", content: "正文" });
		await run(handler, { action: "add", name: "B", content: "正文" });
		await writeFile(join(dir, "MEMORY.md"), "", "utf8");

		const text = await run(handler, { action: "rebuild_index" });

		expect(text).toContain("Rebuilt index: 2 entries");
		expect(text).toContain("over its limit");
		expect(text).toContain("/1 lines");
	});

	it("refuses an action outside the registered set", async () => {
		const handler = createMemoryActionHandler(deps());
		await expect(run(handler, { action: "rename", name: "A", new_name: "B" })).rejects.toThrow(
			"Unknown action: rename",
		);
		await expect(run(handler, { action: "rebuild_index" })).rejects.toThrow("Unknown action: rebuild_index");
	});
});

describe("guards 与写选项透传", () => {
	it("throws when the store is not initialized yet", async () => {
		const handler = createMemoryActionHandler(deps({ getStore: () => null }));
		await expect(run(handler, { action: "list" })).rejects.toThrow(
			"Memory not initialized (no store for this session yet)",
		);
	});

	it("prints the unavailable message verbatim when the caller supplies one", async () => {
		const handler = createMemoryActionHandler(
			deps({
				getStore: () => null,
				getUnavailableMessage: () =>
					'Memory not initialized — no model for dream — set "dream.model" or "defaults.model" in the config file',
			}),
		);
		await expect(run(handler, { action: "list" })).rejects.toThrow(
			'Memory not initialized — no model for dream — set "dream.model" or "defaults.model" in the config file',
		);
	});

	it("passes skipLogicalLock and skipSnapshot through to the store", async () => {
		const addEntry = vi.spyOn(store, "addEntry");
		const handler = createMemoryActionHandler(deps(), {
			actions: MAIN_AGENT_ACTIONS,
			skipLogicalLock: true,
			skipSnapshot: true,
		});

		await run(handler, { action: "add", name: "A", content: "正文" });

		expect(addEntry).toHaveBeenCalledWith(
			{ name: "A", description: undefined, type: undefined, body: "正文" },
			{ skipLogicalLock: true, skipSnapshot: true },
		);
		expect(await readdir(join(dir, ".backups")).then(() => true, () => false)).toBe(false);
	});

	it("snapshots by default so a bad write can be rolled back", async () => {
		const handler = createMemoryActionHandler(deps());
		await run(handler, { action: "add", name: "A", content: "正文" });
		expect(await readdir(join(dir, ".backups"))).toHaveLength(1);
	});
});

describe("onWrite 回调", () => {
	it("fires once per successful write action, with the action and the name", async () => {
		const onWrite = vi.fn();
		const handler = createMemoryActionHandler(deps(), { actions: DREAM_ACTIONS, onWrite });

		await run(handler, { action: "add", name: "A", description: "d", content: "正文" });
		await run(handler, { action: "replace", name: "A", content: "新正文" });
		await run(handler, { action: "rename", name: "A", new_name: "B" });
		await run(handler, { action: "remove", name: "B" });
		await run(handler, { action: "rebuild_index" });

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
		const handler = createMemoryActionHandler(deps(), { onWrite });
		await run(handler, { action: "add", name: "A", description: "d", content: "正文" });
		onWrite.mockClear();

		await run(handler, { action: "list" });
		await run(handler, { action: "search", query: "A" });
		await run(handler, { action: "search", query: "A", scope: "sessions" });

		expect(onWrite).not.toHaveBeenCalled();
	});

	it("does not fire when the write is rejected", async () => {
		const onWrite = vi.fn();
		const handler = createMemoryActionHandler(deps(), { onWrite });

		await expect(run(handler, { action: "add", name: "", content: "x" })).rejects.toThrow("name is required for add");
		await expect(run(handler, { action: "add", name: "A", content: "" })).rejects.toThrow(
			"content is required for add",
		);
		await expect(run(handler, { action: "remove", name: "不存在" })).rejects.toThrow();

		expect(onWrite).not.toHaveBeenCalled();
	});




});

// ── action 集合的冻结保证 ────────────────────────────────────────────────────

describe("search 的 sessions 分支也填 details", () => {
	it("reports the scope and the trimmed query instead of an empty object", async () => {
		const handler = createMemoryActionHandler(deps());

		const result = await handler({ action: "search", query: "  ssh  ", scope: "sessions" });

		expect(result.details).toEqual({ scope: "sessions", query: "ssh" });
		expect(result.text).toBe("session hits");
	});

	it("keeps the memory scope details as they were", async () => {
		const handler = createMemoryActionHandler(deps());
		await handler({ action: "add", name: "A", description: "d", content: "正文" });

		const result = await handler({ action: "search", query: "正文" });

		expect(result.details).toEqual({ count: 1 });
	});
});
