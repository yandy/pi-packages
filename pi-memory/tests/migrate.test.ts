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

/**
 * 一个**合法的 v2 entry**，但闭合行带一个尾随空格（`--- `）：v2 解析器 `parseEntryFile`
 * 用宽松的 `indexOf("\n---", 4)` 认它，而迁移自己的 `splitFrontmatter` 要求逐字 `---`。
 * 手工编辑 / 某些编辑器保存时就会出现（Plan B ledger R40）。
 */
const V2_TRAILING_SPACE_CLOSE = [
	"---",
	"name: A",
	"description: d",
	"type: feedback",
	"created: 2026-01-01",
	"modified: 2026-01-02T00:00:00.000Z",
	"--- ",
	"",
	"## 小节一",
	"",
	"正文一",
	"",
	"## 小节二",
	"",
	"正文二",
	"",
].join("\n");

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
		searchEntries: async () => [],
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

	// Plan E/next #5：只有 **1 个** `## ` 段 + 闭合行正常的 v1 frontmatter（含 `updated`、无
	// `modified`/`created`）——「≥2 段」与「v2 解析通过」两条判据都不成立，只有 `updated` 分支
	// 能判它；而 `parseLegacyEntries` 的 type 必须来自 frontmatter（整份正文兜底只会给 ""）。
	it("detects a single-section v1 file by its updated field alone and keeps the frontmatter type", () => {
		const raw = topicFile("only", "user", "2026-07-03", [["Only One", "唯一一段"]]);

		expect(parseEntryFile(raw)).toBeNull();
		expect(isLegacyTopicFile(raw)).toBe(true);
		expect(parseLegacyEntries(raw)).toEqual([
			{ title: "Only One", content: "唯一一段", type: "user", updated: "2026-07-03" },
		]);
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

	// Plan D（D3）：分类必须与「store 怎么读它」同源 —— parseEntryFile 接受的文件永不迁移。
	it("never splits a v2 entry whose closing '---' carries trailing whitespace", () => {
		expect(parseEntryFile(V2_TRAILING_SPACE_CLOSE)).not.toBeNull();
		expect(isLegacyTopicFile(V2_TRAILING_SPACE_CLOSE)).toBe(false);
	});

	it("still treats a v1 file with the same trailing-space closing as legacy", () => {
		const v1 = topicFile("debugging", "project", "2026-07-03", [
			["SSH Gotcha", "staging 用 2222"],
			["MySQL Timeout", "连接池 30s 超时"],
		]).replace("\n---\n", "\n--- \n");
		expect(parseEntryFile(v1)).toBeNull();
		expect(isLegacyTopicFile(v1)).toBe(true);
		expect(parseLegacyEntries(v1).map((e) => e.title)).toEqual(["SSH Gotcha", "MySQL Timeout"]);
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

	// Finding I1：正文里的一行 `---` 不是 frontmatter 分隔符。v1 的宽松解析器会把 inFrontmatter
	// 切回去，吞掉其后的全部内容（包括下一个 `## B`），而迁移随后还要 unlink 原文件 → 数据静默丢失。
	it("keeps every section when the body itself contains a '---' line", async () => {
		const raw = topicFile("a", "project", "2026-01-02", [
			["A", "正文 A"],
			["B", "正文 B"],
		]).replace("## B", "---\n\n## B");
		await seedLegacy({ "a.md": raw });

		const result = await migrateIfNeeded(store, { now: new Date("2026-10-02T00:00:00.000Z") });

		expect(result).toMatchObject({ files: 1, entries: 2 });
		// `---` 是 A 段的正文（markdown 分隔线），必须保留而不是被当成 frontmatter 开关。
		expect((await store.readEntry("A"))?.body).toBe("正文 A\n\n---");
		expect((await store.readEntry("B"))?.body).toBe("正文 B");
		expect(await readdir(dir)).not.toContain("a.md");
		expect(await readFile(join(result?.backupDir as string, "originals", "a.md"), "utf8")).toBe(raw);
	});

	it("leaves a single-section file without frontmatter untouched", async () => {
		await seedLegacy({ "loose.md": "## 甲\n\n正文甲\n" });

		const result = await migrateIfNeeded(store);

		expect(result).toBeNull();
		expect(await readdir(dir)).toContain("loose.md");
		expect(await store.listEntries()).toEqual([]);
		expect(await marker()).toMatchObject({ entries: 0, files: 0 });
	});

	// spec §15.4：不可读的 legacy 候选不能当作「非 legacy」。若它是目录里唯一的候选，
	// 吞掉错误会写下 0/0 标记 → 重试永久不再发生，内容静默丢失。
	it("fails without writing .migrated when a legacy candidate cannot be read", async () => {
		await seedLegacy({});
		// readdir 会列出 bad.md，readFile 会以 EISDIR 失败
		await mkdir(join(dir, "bad.md"));

		await expect(migrateIfNeeded(store)).rejects.toThrow();

		expect(await readdir(dir)).not.toContain(MIGRATED_FILE);
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

	// spec §15.4：删除失败（EISDIR/EACCES/EIO）不能吞掉 —— 否则 `.migrated` 会在 topic 文件
	// 仍留在目录里的情况下被写下，重试永久不再发生（文件只能从手工回滚点找回）。
	it("does not write .migrated when a legacy topic file cannot be removed", async () => {
		await seedLegacy({ "a.md": topicFile("a", "feedback", "2026-01-02", [["A", "正文 A"]]) });
		const legacyPath = join(dir, "a.md");
		const original = store.rebuildIndex.bind(store);
		// 在 unlink 之前把 legacy 文件替换成同名目录 → unlinkStrict 以 EISDIR 上抛
		vi.spyOn(store, "rebuildIndex").mockImplementationOnce(async (options) => {
			await rm(legacyPath);
			await mkdir(legacyPath);
			return original(options);
		});

		await expect(migrateIfNeeded(store)).rejects.toThrow();

		expect(await readdir(dir)).not.toContain(MIGRATED_FILE);
		expect(await backupDirs()).toHaveLength(1);
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

	// Plan D（D3）：修复前这个文件会被当 legacy 拆成两条（有 migrate- 备份、正文不丢，
	// 但原文件被删、多出两个影子条目）；修复后它一字不动地留在原地。
	it("leaves a v2 entry with a trailing-space closing '---' completely alone", async () => {
		await seedLegacy({ "A.md": V2_TRAILING_SPACE_CLOSE });
		const before = await readFile(join(dir, "A.md"), "utf8");

		expect(await migrateIfNeeded(store)).toBeNull();

		expect(await readFile(join(dir, "A.md"), "utf8")).toBe(before);
		expect(await backupDirs()).toEqual([]);
		expect(await marker()).toMatchObject({ entries: 0, files: 0 });
		// 同源的判据：store 把它读成**一条**完整 entry，而不是被拆开的两段
		expect((await store.listEntries()).map((e) => e.name)).toEqual(["A"]);
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
