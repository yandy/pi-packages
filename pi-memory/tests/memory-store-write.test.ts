import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseEntryFile } from "../src/entry-file";
import { parseEntryIndex } from "../src/entry-index";
import { MemoryStore, type StoreConfig } from "../src/memory-store";

let dir: string;
let store: MemoryStore;

const CFG = (memoryDir: string, over: Partial<StoreConfig> = {}): StoreConfig => ({
	memoryDir,
	indexMaxLines: 200,
	indexMaxBytes: 25600,
	lock: { timeoutMs: 5000, dreamTimeoutMs: 30000, ttlMs: 600_000, snapshotKeep: 5 },
	...over,
});

async function indexOf(target = store): Promise<string> {
	return target.readIndex();
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "mem-store-write-"));
	store = new MemoryStore(CFG(dir));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("addEntry", () => {
	it("creates the file, appends one index line, and derives the description", async () => {
		const { file, capacityWarning } = await store.addEntry({
			name: "Use real DB in tests",
			body: "集成测试必须连真实 PostgreSQL。\n\n细节若干。",
		});
		expect(file).toBe("Use-real-DB-in-tests.md");
		expect(capacityWarning).toBeUndefined();

		const parsed = parseEntryFile(await readFile(join(dir, file), "utf8"));
		expect(parsed?.meta.name).toBe("Use real DB in tests");
		expect(parsed?.meta.type).toBe("feedback");
		expect(parsed?.meta.description).toBe("集成测试必须连真实 PostgreSQL。");
		expect(parsed?.meta.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(parsed?.meta.modified).toMatch(/T.*Z$/);

		const index = parseEntryIndex(await indexOf());
		expect(index.entries).toHaveLength(1);
		expect(index.entries[0]).toMatchObject({ name: "Use real DB in tests", file });
	});

	it("honours an explicit description and type", async () => {
		await store.addEntry({ name: "A", type: "user", description: "显式摘要", body: "正文" });
		const parsed = parseEntryFile(await readFile(join(dir, "A.md"), "utf8"));
		expect(parsed?.meta).toMatchObject({ description: "显式摘要", type: "user" });
	});

	it("is idempotent on an identical name: overwrites in place and keeps created", async () => {
		const first = await store.addEntry({ name: "A", body: "第一版" });
		const created = parseEntryFile(await readFile(join(dir, first.file), "utf8"))?.meta.created;
		const second = await store.addEntry({ name: "A", body: "第二版" });

		expect(second.file).toBe(first.file);
		expect(await readdir(dir)).not.toContain("A-2.md");
		const index = parseEntryIndex(await indexOf());
		expect(index.entries).toHaveLength(1);
		const parsed = parseEntryFile(await readFile(join(dir, second.file), "utf8"));
		expect(parsed?.body).toBe("第二版");
		expect(parsed?.meta.created).toBe(created);
	});

	it("does not overwrite an existing entry when only the file name collides", async () => {
		await store.addEntry({ name: "A B", body: "第一条" });
		const second = await store.addEntry({ name: "A-B", body: "第二条" });

		expect(second.file).toBe("A-B-2.md");
		expect(parseEntryFile(await readFile(join(dir, "A-B.md"), "utf8"))?.body).toBe("第一条");
		expect(parseEntryFile(await readFile(join(dir, second.file), "utf8"))?.body).toBe("第二条");
		expect(parseEntryIndex(await indexOf()).entries).toHaveLength(2);
	});

	it("handles non-ASCII names end to end", async () => {
		const { file } = await store.addEntry({ name: "部署 🔥 检查", body: "正文" });
		expect(file).toBe("部署-🔥-检查.md");
		expect((await store.readEntry("部署 🔥 检查"))?.file).toBe(file);
	});

	it("snapshots MEMORY.md before mutating", async () => {
		await writeFile(join(dir, "MEMORY.md"), "# Memory Index\n", "utf8");
		await store.addEntry({ name: "A", body: "正文" });
		const snapshots = await readdir(join(dir, ".backups"));
		expect(snapshots).toHaveLength(1);
		expect(await readFile(join(dir, ".backups", snapshots[0], "MEMORY.md"), "utf8")).toBe("# Memory Index\n");
	});

	it("preserves handwritten index lines", async () => {
		await writeFile(join(dir, "MEMORY.md"), "# Memory Index\n\n## Project\n<!-- keep -->\n", "utf8");
		await store.addEntry({ name: "A", body: "正文" });
		const raw = await indexOf();
		expect(raw).toContain("# Memory Index");
		expect(raw).toContain("## Project");
		expect(raw).toContain("<!-- keep -->");
		expect(parseEntryIndex(raw).entries).toHaveLength(1);
	});

	it("rejects an empty name or body", async () => {
		await expect(store.addEntry({ name: "  ", body: "正文" })).rejects.toThrow("name is required");
		await expect(store.addEntry({ name: "A", body: "  " })).rejects.toThrow("body is required");
	});

	it("rejects a name or description containing a newline", async () => {
		await expect(store.addEntry({ name: "A\n---\nfoo: bar", body: "正文" })).rejects.toThrow("name must be a single line");
		await expect(store.addEntry({ name: "A", description: "第一行\n第二行", body: "正文" })).rejects.toThrow(
			"description must be a single line",
		);
	});

	it("falls back to the entry name when the derived description is empty", async () => {
		const { file } = await store.addEntry({ name: "空摘要条目", body: "- \n实际内容在下一行" });
		expect((await store.readEntry(file))?.description).toBe("空摘要条目");
	});

	it("still writes when over capacity and returns an actionable warning", async () => {
		const tiny = new MemoryStore(CFG(dir, { indexMaxLines: 1, indexMaxBytes: 25600 }));
		const first = await tiny.addEntry({ name: "A", body: "正文" });
		expect(first.capacityWarning).toBeUndefined();

		const second = await tiny.addEntry({ name: "B", body: "正文" });
		expect(second.capacityWarning).toContain("over its limit");
		expect(second.capacityWarning).toContain("2/1 lines");
		expect(parseEntryIndex(await tiny.readIndex()).entries).toHaveLength(2);
	});

	it("serialises concurrent adds from the same process", async () => {
		const results = await Promise.all(
			["A", "B", "C", "D", "E"].map((name) => store.addEntry({ name, body: `${name} 正文` })),
		);
		expect(new Set(results.map((r) => r.file)).size).toBe(5);
		expect(parseEntryIndex(await indexOf()).entries).toHaveLength(5);
	});
});

describe("replaceEntry", () => {
	it("updates in place and keeps the index line position", async () => {
		await store.addEntry({ name: "A", body: "旧正文" });
		await store.addEntry({ name: "B", body: "B 正文" });
		const result = await store.replaceEntry("A", { body: "新正文" });

		expect(result.file).toBe("A.md");
		const entries = parseEntryIndex(await indexOf()).entries;
		expect(entries.map((e) => e.file)).toEqual(["A.md", "B.md"]);
		const parsed = parseEntryFile(await readFile(join(dir, "A.md"), "utf8"));
		expect(parsed?.body).toBe("新正文");
		expect(parsed?.meta.description).toBe("新正文");
	});

	it("keeps the description when only the body is patched with an explicit description", async () => {
		await store.addEntry({ name: "A", description: "保留我", body: "旧正文" });
		await store.replaceEntry("A", { body: "新正文", description: "保留我" });
		expect((await store.readEntry("A"))?.description).toBe("保留我");
	});

	it("renames the file and keeps the index line position", async () => {
		await store.addEntry({ name: "旧名字", body: "正文" });
		await store.addEntry({ name: "B", body: "B 正文" });
		const result = await store.replaceEntry("旧名字", { name: "新名字" });

		expect(result.file).toBe("新名字.md");
		expect(await readdir(dir)).not.toContain("旧名字.md");
		const entries = parseEntryIndex(await indexOf()).entries;
		expect(entries.map((e) => e.file)).toEqual(["新名字.md", "B.md"]);
	});

	it("throws for an unknown ref", async () => {
		await expect(store.replaceEntry("nope", { body: "x" })).rejects.toThrow('Entry "nope" not found');
	});
});
