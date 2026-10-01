import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseEntryFile } from "../src/entry-file";
import { parseEntryIndex } from "../src/entry-index";
import { MemoryStore, type StoreConfig } from "../src/memory-store";
import { isLegacyTopicFile, migrateIfNeeded, MIGRATED_FILE, parseLegacyEntries } from "../src/migrate";

let dir: string;
let store: MemoryStore;

const CFG = (memoryDir: string, over: Partial<StoreConfig> = {}): StoreConfig => ({
	memoryDir,
	indexMaxLines: 200,
	indexMaxBytes: 25600,
	lock: { timeoutMs: 5000, snapshotKeep: 5 },
	...over,
});

/** 拼一个 v1 topic 文件（frontmatter + 若干 `## ` 段）。 */
function topicFile(
	name: string,
	type: string,
	updated: string,
	sections: Array<[title: string, body: string]>,
	description = name,
): string {
	return [
		"---",
		`name: ${name}`,
		`description: ${description}`,
		`type: ${type}`,
		`updated: ${updated}`,
		"---",
		"",
		...sections.flatMap(([title, body]) => [`## ${title}`, "", body, ""]),
	].join("\n");
}

/** 铺一个「升级前」的 memory 目录，返回待迁移的 topic 文件名。 */
async function seedLegacy(files: Record<string, string>, index = "# Memory Index\n"): Promise<string[]> {
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "MEMORY.md"), index, "utf8");
	for (const [name, raw] of Object.entries(files)) {
		await writeFile(join(dir, name), raw, "utf8");
	}
	return Object.keys(files);
}

async function marker(): Promise<Record<string, unknown> | null> {
	const raw = await readFile(join(dir, MIGRATED_FILE), "utf8").catch(() => null);
	return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

async function backupDirs(): Promise<string[]> {
	return (await readdir(join(dir, ".backups")).catch(() => [] as string[])).sort();
}

/** addEntry 抛错的假 store：用来验证「失败不写标记、备份保留」。 */
function failingStore(real: MemoryStore): MemoryStore {
	return {
		cfg: real.cfg,
		withLogicalLock: (fn: () => Promise<unknown>) => fn(),
		listEntries: async () => [],
		addEntry: async () => {
			throw new Error("boom");
		},
		rebuildIndex: async () => ({ entries: 0, headerLines: 2 }),
	} as unknown as MemoryStore;
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "mem-migrate-"));
	store = new MemoryStore(CFG(dir));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("isLegacyTopicFile", () => {
	it("detects the legacy updated field", () => {
		expect(isLegacyTopicFile(topicFile("debugging", "project", "2026-07-03", [["Only", "一段"]]))).toBe(true);
	});

	it("detects two or more ## sections without any frontmatter", () => {
		expect(isLegacyTopicFile("## A\n\n正文 A\n\n## B\n\n正文 B\n")).toBe(true);
	});

	it("leaves a single-section file without frontmatter alone", () => {
		expect(isLegacyTopicFile("## A\n\n正文 A\n")).toBe(false);
	});

	it("never treats a v2 entry file as legacy, even with several ## headings", () => {
		const v2 = [
			"---",
			"name: A",
			"description: d",
			"type: feedback",
			"created: 2026-01-01",
			"modified: 2026-01-02T00:00:00.000Z",
			"---",
			"",
			"## 小节一",
			"",
			"正文",
			"",
			"## 小节二",
			"",
			"正文",
			"",
		].join("\n");
		expect(isLegacyTopicFile(v2)).toBe(false);
	});

	it("handles CRLF", () => {
		const crlf = topicFile("debugging", "project", "2026-07-03", [["A", "正文"]]).replaceAll("\n", "\r\n");
		expect(isLegacyTopicFile(crlf)).toBe(true);
		expect(parseLegacyEntries(crlf)).toEqual([
			{ title: "A", content: "正文", type: "project", updated: "2026-07-03" },
		]);
	});
});

describe("parseLegacyEntries", () => {
	it("splits every ## section and carries the file-level type and updated", () => {
		const raw = topicFile("debugging", "project", "2026-07-03", [
			["SSH Gotcha", "staging 用 2222"],
			["MySQL Timeout", "连接池 30s 超时"],
		]);
		expect(parseLegacyEntries(raw)).toEqual([
			{ title: "SSH Gotcha", content: "staging 用 2222", type: "project", updated: "2026-07-03" },
			{ title: "MySQL Timeout", content: "连接池 30s 超时", type: "project", updated: "2026-07-03" },
		]);
	});

	it("returns nothing for a frontmatter-only file", () => {
		expect(parseLegacyEntries(topicFile("debugging", "project", "2026-07-03", []))).toEqual([]);
	});
});

describe("migrateIfNeeded", () => {
	it("splits a multi-entry topic file into one entry per section", async () => {
		await seedLegacy({
			"debugging.md": topicFile("debugging", "project", "2026-07-03", [
				["SSH Gotcha", "staging 的 SSH 用 2222 端口。"],
				["MySQL Timeout", "连接池 30s 超时。"],
			]),
		});

		const result = await migrateIfNeeded(store, { now: new Date("2026-10-02T00:00:00.000Z") });

		expect(result).toEqual({
			files: 1,
			entries: 2,
			backupDir: join(dir, ".backups", "migrate-2026-10-02T00-00-00-000Z"),
		});

		const ssh = await store.readEntry("SSH Gotcha");
		expect(ssh?.file).toBe("SSH-Gotcha.md");
		expect(ssh?.body).toBe("staging 的 SSH 用 2222 端口。");
		expect(ssh?.type).toBe("project");
		expect(ssh?.created).toBe("2026-07-03");
		expect(ssh?.description).toBe("SSH Gotcha");
		expect((await store.readEntry("MySQL Timeout"))?.body).toBe("连接池 30s 超时。");

		// 原 topic 文件已移除
		expect(await readdir(dir)).not.toContain("debugging.md");
	});

	it("migrates a single-entry topic file", async () => {
		await seedLegacy({ "a.md": topicFile("a", "user", "2026-01-02", [["Only One", "唯一一条"]]) });
		const result = await migrateIfNeeded(store);
		expect(result).toMatchObject({ files: 1, entries: 1 });
		expect((await store.readEntry("Only One"))?.type).toBe("user");
	});

	it("generates no entry for a frontmatter-only file but still removes it", async () => {
		await seedLegacy({ "empty.md": topicFile("empty", "project", "2026-01-02", []) });
		const result = await migrateIfNeeded(store);

		expect(result).toMatchObject({ files: 1, entries: 0 });
		expect(await readdir(dir)).not.toContain("empty.md");
		expect(await store.listEntries()).toEqual([]);
	});

	it("falls back to type feedback for an unknown legacy type", async () => {
		await seedLegacy({ "a.md": topicFile("a", "bogus", "2026-01-02", [["T", "正文"]]) });
		await migrateIfNeeded(store);
		expect((await store.readEntry("T"))?.type).toBe("feedback");
	});

	it("falls back to today when the legacy updated value is unparseable", async () => {
		await seedLegacy({ "a.md": topicFile("a", "feedback", "昨天", [["T", "正文"]]) });
		await migrateIfNeeded(store, { now: new Date("2026-10-02T00:00:00.000Z") });
		expect((await store.readEntry("T"))?.created).toBe("2026-10-02");
	});

	it("disambiguates the same title across files with a (2) suffix", async () => {
		await seedLegacy({
			"a.md": topicFile("a", "feedback", "2026-01-02", [["Dup", "来自 a"]]),
			"b.md": topicFile("b", "feedback", "2026-01-03", [["Dup", "来自 b"], ["Dup", "来自 b 的第二条"]]),
		});

		const result = await migrateIfNeeded(store);

		expect(result).toMatchObject({ files: 2, entries: 3 });
		const names = (await store.listEntries()).map((e) => e.name).sort();
		expect(names).toEqual(["Dup", "Dup (2)", "Dup (3)"]);
		expect((await store.readEntry("Dup"))?.body).toBe("来自 a");
		expect((await store.readEntry("Dup (2)"))?.body).toBe("来自 b");
		expect((await store.readEntry("Dup (3)"))?.body).toBe("来自 b 的第二条");
	});

	it("keeps non-ASCII titles as file names", async () => {
		await seedLegacy({ "a.md": topicFile("a", "feedback", "2026-01-02", [["集成测试必须连真实数据库", "不要 mock"]]) });
		await migrateIfNeeded(store);

		const entry = await store.readEntry("集成测试必须连真实数据库");
		expect(entry?.file).toBe("集成测试必须连真实数据库.md");
		expect(entry?.body).toBe("不要 mock");
	});

	it("migrates a CRLF topic file", async () => {
		const crlf = topicFile("a", "project", "2026-01-02", [
			["A", "正文 A"],
			["B", "正文 B"],
		]).replaceAll("\n", "\r\n");
		await seedLegacy({ "a.md": crlf });

		const result = await migrateIfNeeded(store);

		expect(result).toMatchObject({ files: 1, entries: 2 });
		expect((await store.readEntry("A"))?.body).toBe("正文 A");
		expect((await store.readEntry("B"))?.type).toBe("project");
	});

	it("migrates a file with no frontmatter but two ## sections", async () => {
		await seedLegacy({ "loose.md": "## 甲\n\n正文甲\n\n## 乙\n\n正文乙\n" });

		const result = await migrateIfNeeded(store, { now: new Date("2026-10-02T00:00:00.000Z") });

		expect(result).toMatchObject({ files: 1, entries: 2 });
		expect((await store.readEntry("甲"))?.type).toBe("feedback");
		expect((await store.readEntry("甲"))?.created).toBe("2026-10-02");
	});

	it("leaves a single-section file without frontmatter untouched", async () => {
		await seedLegacy({ "loose.md": "## 甲\n\n正文甲\n" });

		const result = await migrateIfNeeded(store);

		expect(result).toBeNull();
		expect(await readdir(dir)).toContain("loose.md");
		expect(await store.listEntries()).toEqual([]);
		expect(await marker()).toMatchObject({ entries: 0, files: 0 });
	});

	// Review Focus #2：标题里的 `](` 会伪造索引行的 name/file 分组，store 会拒绝它 ——
	// 迁移不能因为一条标题里有个 markdown 链接就整轮失败。
	it("neutralises '](' in a legacy title so it cannot forge an index key", async () => {
		await seedLegacy({ "a.md": topicFile("a", "feedback", "2026-01-02", [["A](x.md) — fake", "正文"]]) });

		const result = await migrateIfNeeded(store);

		expect(result).toMatchObject({ entries: 1 });
		const [entry] = await store.listEntries();
		expect(entry.name).toBe("A](x.md) — fake".replace("](", "] ("));
		expect(parseEntryIndex(await store.readIndex()).entries).toHaveLength(1);
	});

	// Review Focus #3：一条标题为 MEMORY 的 legacy 条目不得写穿索引。
	it("never migrates a legacy entry onto MEMORY.md", async () => {
		await seedLegacy({ "a.md": topicFile("a", "feedback", "2026-01-02", [["MEMORY", "关于记忆系统本身"]]) });

		await migrateIfNeeded(store);

		const entry = await store.readEntry("MEMORY");
		expect(entry?.file).not.toBe("MEMORY.md");
		expect(parseEntryIndex(await store.readIndex()).entries).toHaveLength(1);
	});

	it("skips a section with an empty body instead of failing the whole migration", async () => {
		await seedLegacy({
			"a.md": topicFile("a", "feedback", "2026-01-02", [
				["空的", ""],
				["有内容", "正文"],
			]),
		});

		const result = await migrateIfNeeded(store);

		expect(result).toMatchObject({ files: 1, entries: 1 });
		expect(await store.readEntry("空的")).toBeNull();
		expect((await store.readEntry("有内容"))?.body).toBe("正文");
	});

	// Review Focus #5：rebuildIndex 保留第一条索引行之前的手写块。
	it("rebuilds the index from the migrated entries and keeps a handwritten header", async () => {
		await seedLegacy(
			{ "a.md": topicFile("a", "feedback", "2026-01-02", [["A", "正文 A"], ["B", "正文 B"]]) },
			"# Memory Index\n\n## Project\n- [a](a.md) — A; B\n",
		);

		await migrateIfNeeded(store);

		const raw = await store.readIndex();
		expect(raw).toContain("# Memory Index");
		expect(raw).toContain("## Project");
		const entries = parseEntryIndex(raw).entries;
		expect(entries.map((e) => e.name).sort()).toEqual(["A", "B"]);
		expect(entries.some((e) => e.file === "a.md")).toBe(false);
	});

	it("creates a migrate- rollback point that keeps the originals", async () => {
		const legacy = topicFile("a", "feedback", "2026-01-02", [["A", "正文 A"]]);
		await seedLegacy({ "a.md": legacy, "b.md": topicFile("b", "user", "2026-01-03", [["B", "正文 B"]]) });

		const result = await migrateIfNeeded(store, { now: new Date("2026-10-02T01:02:03.456Z") });

		const backups = await backupDirs();
		expect(backups).toEqual(["migrate-2026-10-02T01-02-03-456Z"]);
		expect(result?.backupDir).toBe(join(dir, ".backups", backups[0]));

		const contents = await readdir(result?.backupDir as string);
		expect(contents.sort()).toEqual(["MEMORY.md", "a.md", "b.md", "originals"]);
		expect(await readFile(join(result?.backupDir as string, "originals", "a.md"), "utf8")).toBe(legacy);
	});

	it("is not pruned by a later write even with snapshotKeep=1", async () => {
		await seedLegacy({ "a.md": topicFile("a", "feedback", "2026-01-02", [["A", "正文 A"]]) });
		const tiny = new MemoryStore(CFG(dir, { lock: { timeoutMs: 5000, snapshotKeep: 1 } }));
		await migrateIfNeeded(tiny);

		// 之后连拍 3 次普通写入快照：migrate- 目录永不参与裁剪（spec §19）
		for (const name of ["X", "Y", "Z"]) await tiny.addEntry({ name, body: "正文" });

		const backups = await backupDirs();
		expect(backups.filter((n) => n.startsWith("migrate-"))).toHaveLength(1);
		expect(backups.filter((n) => !n.startsWith("migrate-"))).toHaveLength(1);
	});

	it("writes .migrated last, with the counts and the backup path", async () => {
		await seedLegacy({ "a.md": topicFile("a", "feedback", "2026-01-02", [["A", "正文 A"]]) });
		await migrateIfNeeded(store, { now: new Date("2026-10-02T00:00:00.000Z") });

		expect(await marker()).toEqual({
			migratedAt: "2026-10-02T00:00:00.000Z",
			entries: 1,
			files: 1,
			backupDir: join(dir, ".backups", "migrate-2026-10-02T00-00-00-000Z"),
		});
	});

	// Review Focus #4：幂等。
	it("returns null on the second run and writes no duplicates", async () => {
		await seedLegacy({ "a.md": topicFile("a", "feedback", "2026-01-02", [["A", "正文 A"], ["B", "正文 B"]]) });
		const first = await migrateIfNeeded(store);
		expect(first).toMatchObject({ files: 1, entries: 2 });

		const second = await migrateIfNeeded(store);

		expect(second).toBeNull();
		expect((await store.listEntries()).map((e) => e.name).sort()).toEqual(["A", "B"]);
		expect(await backupDirs()).toHaveLength(1);
		expect(parseEntryIndex(await store.readIndex()).entries).toHaveLength(2);
	});

	it("does not write .migrated when a step fails, and keeps the backup", async () => {
		await seedLegacy({ "a.md": topicFile("a", "feedback", "2026-01-02", [["A", "正文 A"]]) });

		await expect(migrateIfNeeded(failingStore(store))).rejects.toThrow("boom");

		expect(await marker()).toBeNull();
		expect(await readdir(dir)).toContain("a.md");
		const backups = await backupDirs();
		expect(backups).toHaveLength(1);
		expect(await readdir(join(dir, ".backups", backups[0], "originals"))).toEqual(["a.md"]);
	});

	// Review Focus #4：失败后重跑必须干净 —— usedNames 的初值来自磁盘，addEntry 对同名幂等。
	it("re-runs cleanly after a failed migration", async () => {
		await seedLegacy({
			"a.md": topicFile("a", "feedback", "2026-01-02", [["A", "正文 A"]]),
			"b.md": topicFile("b", "feedback", "2026-01-03", [["B", "正文 B"]]),
		});
		await expect(migrateIfNeeded(failingStore(store))).rejects.toThrow("boom");

		const result = await migrateIfNeeded(store);

		expect(result).toMatchObject({ files: 2, entries: 2 });
		expect((await store.listEntries()).map((e) => e.name).sort()).toEqual(["A", "B"]);
		expect(parseEntryIndex(await store.readIndex()).entries).toHaveLength(2);
		expect(await marker()).toMatchObject({ entries: 2, files: 2 });
	});

	// 重跑安全（spec §15.4）：上一轮已经写成功的条目不得在重跑时变成 `A (2)` 影子副本。
	it("reuses an entry left by a previous partial run instead of creating a (2) shadow", async () => {
		await seedLegacy({
			"a.md": topicFile("a", "project", "2026-01-02", [["A", "正文 A"]]),
			"b.md": topicFile("b", "feedback", "2026-01-03", [["B", "正文 B"]]),
		});
		// 模拟「上一轮迁移已经写成功 A 之后才失败」：磁盘上已有一条同名同正文的 v2 entry。
		await store.addEntry({ name: "A", description: "A", type: "project", body: "正文 A", created: "2020-05-06" });

		const result = await migrateIfNeeded(store);

		expect(result).toMatchObject({ files: 2, entries: 2 });
		const names = (await store.listEntries()).map((e) => e.name).sort();
		expect(names).toEqual(["A", "B"]);
		const a = await store.readEntry("A");
		expect(a?.body).toBe("正文 A");
		// 同名复用走 addEntry 的幂等覆盖：磁盘上的 created 必须保留，不能被旧 updated 覆盖
		expect(a?.created).toBe("2020-05-06");
		expect(parseEntryIndex(await store.readIndex()).entries).toHaveLength(2);
	});

	// 部分写入后重跑：第一轮在第二条写入处失败，A 已落盘；重跑必须复用 A 而不是产出 A (2)。
	it("re-running after a failed migration does not duplicate entries", async () => {
		await seedLegacy({
			"a.md": topicFile("a", "feedback", "2026-01-02", [["A", "正文 A"]]),
			"b.md": topicFile("b", "feedback", "2026-01-03", [["B", "正文 B"]]),
		});
		const real = store.addEntry.bind(store);
		const spy = vi
			.spyOn(store, "addEntry")
			.mockImplementationOnce((input, options) => real(input, options))
			.mockRejectedValueOnce(new Error("boom"));

		await expect(migrateIfNeeded(store)).rejects.toThrow("boom");

		expect(await marker()).toBeNull();
		// 第一轮确实部分写入了：A 落盘、B 未写（失败发生在第二次 addEntry）
		expect((await store.listEntries()).map((e) => e.name)).toEqual(["A"]);

		spy.mockRestore();
		const result = await migrateIfNeeded(store);

		expect(result).toMatchObject({ files: 2, entries: 2 });
		const names = (await store.listEntries()).map((e) => e.name).sort();
		expect(names).toEqual(["A", "B"]);
		expect(parseEntryIndex(await store.readIndex()).entries).toHaveLength(2);
		expect(await marker()).toMatchObject({ entries: 2, files: 2 });
	});

	it("takes the logical lock for the whole run with a 30s timeout", async () => {
		await seedLegacy({ "a.md": topicFile("a", "feedback", "2026-01-02", [["A", "正文 A"]]) });
		const withLogicalLock = vi.spyOn(store, "withLogicalLock");

		await migrateIfNeeded(store);

		expect(withLogicalLock).toHaveBeenCalledWith(expect.any(Function), 30_000);
		expect(store.logicalLockActive()).toBe(false);
	});

	it("writes .migrated and returns null when there is nothing to migrate", async () => {
		await seedLegacy({});
		expect(await migrateIfNeeded(store)).toBeNull();
		expect(await marker()).toMatchObject({ entries: 0, files: 0, backupDir: "" });
	});

	it("does not migrate v2 entry files", async () => {
		await store.addEntry({ name: "已经是 v2", description: "d", body: "## 小节\n\n正文" });
		const before = await store.listEntries();

		expect(await migrateIfNeeded(store)).toBeNull();
		expect(await store.listEntries()).toEqual(before);
		// addEntry 自己会拍一份 write 快照；这里只需确认没有多出 migrate- 回滚点
		expect((await backupDirs()).filter((n) => n.startsWith("migrate-"))).toEqual([]);
	});

	it("returns null without touching anything when the memory directory does not exist", async () => {
		const missing = new MemoryStore(CFG(join(dir, "nope", "memory")));
		expect(await migrateIfNeeded(missing)).toBeNull();
		expect(await readdir(join(dir, "nope", "memory")).catch(() => null)).toBeNull();
	});

	it("writes .migrated when MEMORY.md is absent", async () => {
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "a.md"), topicFile("a", "feedback", "2026-01-02", [["A", "正文"]]), "utf8");

		expect(await migrateIfNeeded(store)).toBeNull();
		expect(await marker()).toMatchObject({ entries: 0, files: 0 });
		// 没有 MEMORY.md 就不算 legacy 目录（spec §15.2），原文件保持不动
		expect(await readdir(dir)).toContain("a.md");
	});
});
