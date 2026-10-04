import { mkdir, mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serializeEntryFile, type EntryMeta } from "../src/entry-file";
import { MemoryStore, type StoreConfig } from "../src/memory-store";

let dir: string;
let store: MemoryStore;

const CFG = (memoryDir: string, platform?: NodeJS.Platform): StoreConfig => ({
	memoryDir,
	indexMaxLines: 200,
	indexMaxBytes: 25600,
	lock: { timeoutMs: 5000, snapshotKeep: 5 },
	platform,
});

function meta(name: string, over: Partial<EntryMeta> = {}): EntryMeta {
	return {
		name,
		description: `${name} 的摘要`,
		type: "feedback",
		created: "2026-10-01",
		modified: "2026-10-01T00:00:00.000Z",
		...over,
	};
}

async function writeEntry(file: string, m: EntryMeta, body = "正文"): Promise<string> {
	const path = join(dir, file);
	await writeFile(path, serializeEntryFile(m, body), "utf8");
	return path;
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "mem-store-read-"));
	store = new MemoryStore(CFG(dir));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("listEntries", () => {
	it("lists entries sorted by modified then file", async () => {
		await writeEntry("b.md", meta("B", { modified: "2026-10-02T00:00:00.000Z" }));
		await writeEntry("a.md", meta("A", { modified: "2026-10-01T00:00:00.000Z" }));
		await writeEntry("c.md", meta("C", { modified: "2026-10-01T00:00:00.000Z" }));
		const files = (await store.listEntries()).map((e) => e.file);
		expect(files).toEqual(["a.md", "c.md", "b.md"]);
	});

	it("ignores MEMORY.md, dotfiles, non-markdown files and directories", async () => {
		await writeEntry("a.md", meta("A"));
		await writeFile(join(dir, "MEMORY.md"), "# Memory Index\n", "utf8");
		await writeFile(join(dir, ".dream-meta.json"), "{}", "utf8");
		await writeFile(join(dir, "notes.txt"), "x", "utf8");
		await mkdir(join(dir, "sessions"));
		expect((await store.listEntries()).map((e) => e.file)).toEqual(["a.md"]);
	});

	it("skips unparseable files without touching them", async () => {
		await writeEntry("a.md", meta("A"));
		const broken = join(dir, "broken.md");
		await writeFile(broken, "no frontmatter\n", "utf8");
		expect((await store.listEntries()).map((e) => e.file)).toEqual(["a.md"]);
		expect(await readFile(broken, "utf8")).toBe("no frontmatter\n");
	});

	it("serves cached frontmatter while mtime is unchanged", async () => {
		const path = await writeEntry("a.md", meta("A", { description: "原始摘要" }));
		// writeFile 落盘的是亚毫秒精度 mtime，utimes 只能还原到毫秒精度；先把 mtime 钉成确定值。
		const pinned = new Date("2026-10-01T00:00:00.000Z");
		await utimes(path, pinned, pinned);
		await store.listEntries();
		const before = await stat(path);
		await writeFile(path, serializeEntryFile(meta("A", { description: "修改后的摘要" }), "正文"), "utf8");
		await utimes(path, before.atime, before.mtime);
		expect((await store.listEntries())[0].description).toBe("原始摘要");
	});

	it("refreshes the cache when mtime changes", async () => {
		const path = await writeEntry("a.md", meta("A", { description: "原始摘要" }));
		await store.listEntries();
		await writeFile(path, serializeEntryFile(meta("A", { description: "修改后的摘要" }), "正文"), "utf8");
		const future = new Date(Date.now() + 5000);
		await utimes(path, future, future);
		expect((await store.listEntries())[0].description).toBe("修改后的摘要");
	});

	it("drops cached files that disappeared", async () => {
		const path = await writeEntry("a.md", meta("A"));
		await store.listEntries();
		await unlink(path);
		expect(await store.listEntries()).toEqual([]);
	});

	it("skips files named after Windows devices on win32 (reading them would hit the device)", async () => {
		await writeEntry("con.md", meta("Con entry"));
		await writeEntry("ok.md", meta("Ok entry"));
		const win = new MemoryStore(CFG(dir, "win32"));
		expect((await win.listEntries()).map((e) => e.file)).toEqual(["ok.md"]);
		const posix = new MemoryStore(CFG(dir, "linux"));
		expect((await posix.listEntries()).map((e) => e.file).sort()).toEqual(["con.md", "ok.md"]);
	});
});

describe("readEntry", () => {
	it("locates by file name and by name, preserving non-ASCII names", async () => {
		await writeEntry("集成测试.md", meta("集成测试必须连真实 PostgreSQL"));
		expect((await store.readEntry("集成测试.md"))?.body).toBe("正文");
		expect((await store.readEntry("集成测试必须连真实 PostgreSQL"))?.file).toBe("集成测试.md");
	});

	it("returns null for an unknown ref", async () => {
		expect(await store.readEntry("nope.md")).toBeNull();
	});

	it("exposes created and body", async () => {
		await writeEntry("a.md", meta("A", { created: "2026-09-01" }), "多行\n正文");
		const entry = await store.readEntry("a.md");
		expect(entry?.created).toBe("2026-09-01");
		expect(entry?.body).toBe("多行\n正文");
	});
});

describe("readIndex", () => {
	it("returns the raw index and empty string when absent", async () => {
		expect(await store.readIndex()).toBe("");
		await writeFile(join(dir, "MEMORY.md"), "- [A](a.md) — A\n", "utf8");
		expect(await store.readIndex()).toBe("- [A](a.md) — A\n");
	});
});

describe("searchEntries", () => {
	it("matches name, description and body case-insensitively", async () => {
		await writeEntry("a.md", meta("Alpha", { description: "第一个" }), "正文里有 PostgreSQL");
		await writeEntry("b.md", meta("Beta", { description: "第二个" }), "无关内容");
		expect((await store.searchEntries("alpha")).map((e) => e.file)).toEqual(["a.md"]);
		expect((await store.searchEntries("第二")).map((e) => e.file)).toEqual(["b.md"]);
		expect((await store.searchEntries("postgresql")).map((e) => e.file)).toEqual(["a.md"]);
		expect(await store.searchEntries("不存在的词")).toEqual([]);
	});
});
