import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseEntryFile } from "../src/entry-file";
import { parseEntryIndex } from "../src/entry-index";
import { MemoryStore, type StoreConfig } from "../src/memory-store";
import { ProcessLockTimeoutError } from "../src/process-lock";

let dir: string;
let store: MemoryStore;

const CFG = (memoryDir: string, over: Partial<StoreConfig> = {}): StoreConfig => ({
	memoryDir,
	indexMaxLines: 200,
	indexMaxBytes: 25600,
	lock: { timeoutMs: 5000, snapshotKeep: 5 },
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

	// MEMORY.md 不是条目，被 #entryFiles 过滤掉，因此它从来不在「已占用文件名」集合里。
	// 不计入的话，一次合法的 addEntry({ name: "MEMORY" }) 会解析出索引本身并写穿它 ——
	// 手写头部与全部索引行静默销毁，而调用还返回成功。
	it("never writes over the index file itself", async () => {
		await store.addEntry({ name: "A", body: "A 正文" });
		const before = await store.readIndex();
		const { file } = await store.addEntry({ name: "MEMORY", body: "关于记忆系统本身" });

		expect(file).not.toBe("MEMORY.md");
		expect(await store.readIndex()).toContain(before.trim());
		const entries = parseEntryIndex(await store.readIndex()).entries;
		expect(entries.filter((e) => e.file === "A.md")).toHaveLength(1);
		expect((await store.readEntry(file))?.name).toBe("MEMORY");
	});

	it("treats a name that derives to the index file name as taken too", async () => {
		// entryFileName 会剥掉前置句点，所以 ".MEMORY" 同样派生出 MEMORY.md；
		// 大小写不敏感文件系统上的 "Memory" 也一样（那里靠写前的磁盘探测兜底）。
		const { file } = await store.addEntry({ name: ".MEMORY", body: "正文" });
		expect(file).not.toBe("MEMORY.md");
		expect((await store.readEntry(file))?.body).toBe("正文");
	});

	it("snapshots MEMORY.md before mutating", async () => {
		await writeFile(join(dir, "MEMORY.md"), "# Memory Index\n", "utf8");
		await store.addEntry({ name: "A", body: "正文" });
		const snapshots = await readdir(join(dir, ".backups"));
		expect(snapshots).toHaveLength(1);
		expect(await readFile(join(dir, ".backups", snapshots[0], "MEMORY.md"), "utf8")).toBe("# Memory Index\n");
	});

	// spec §18.1「快照失败 → 写入失败」（§6 的 fail-closed）。把 .backups 建成普通文件，
	// createSnapshot 的 mkdir 会抛 EEXIST —— 此时既不得写出条目文件，也不得改动 MEMORY.md。
	it("aborts the write when the snapshot cannot be created", async () => {
		await writeFile(join(dir, "MEMORY.md"), "# Memory Index\n", "utf8");
		await writeFile(join(dir, ".backups"), "not a directory", "utf8");

		await expect(store.addEntry({ name: "A", body: "正文" })).rejects.toThrow();
		expect(await readdir(dir)).not.toContain("A.md");
		expect(await store.readIndex()).toBe("# Memory Index\n");
		expect(await store.listEntries()).toEqual([]);
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

	// name 里的 `](` 会伪造索引行的 name/file 分组：
	// formatIndexLine("A](x.md) — fake", "real.md", "d") → `- [A](x.md) — fake](real.md) — d`，
	// 解析回 { name: "A", file: "x.md" }。于是 removeIndexLine(raw, "x.md") 删掉的是这一行，
	// 真正的 `- [X](x.md) — d` 留下 —— 删 X 报成功却留下死链，real.md 变成无索引的孤儿。
	it("rejects a name containing '](' and leaves the index untouched", async () => {
		await writeFile(join(dir, "MEMORY.md"), "# Memory Index\n", "utf8");
		await expect(store.addEntry({ name: "A](x.md) — fake", body: "正文" })).rejects.toThrow(
			"name must not contain ']('",
		);
		expect(await store.readIndex()).toBe("# Memory Index\n");
		expect(await store.listEntries()).toEqual([]);
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

	// 存储目录尚不存在时首次 add 必须能工作：锁的临时文件就落在该目录下，不先建目录会报出一个
	// 既没有 memory 字眼、也没有目录说明的 ENOENT。今天靠 memory-tool.ts 的 mkdir 兜着，
	// Plan B 删掉那条路径后全新项目的第一次 memory add 就会崩。
	it("creates the memory directory on the first write", async () => {
		const nested = join(dir, "a", "b", "memory");
		const fresh = new MemoryStore(CFG(nested));
		const { file } = await fresh.addEntry({ name: "A", body: "正文" });

		expect(file).toBe("A.md");
		expect(parseEntryFile(await readFile(join(nested, file), "utf8"))?.body).toBe("正文");
		expect(parseEntryIndex(await fresh.readIndex()).entries).toHaveLength(1);
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

	// 与 addEntry 共用同一条校验：两个原语必须一致，否则改名就成了绕过入口。
	it("rejects a rename to a name containing '](' and leaves the index untouched", async () => {
		await store.addEntry({ name: "A", body: "正文" });
		const before = await store.readIndex();
		await expect(store.replaceEntry("A", { name: "A](x.md) — fake" })).rejects.toThrow(
			"name must not contain ']('",
		);
		expect(await store.readIndex()).toBe(before);
		expect((await store.readEntry("A"))?.body).toBe("正文");
	});

	it("rejects a rename onto an existing name, leaving both entries intact", async () => {
		await store.addEntry({ name: "A", body: "A 正文" });
		await store.addEntry({ name: "B", body: "B 正文" });
		await expect(store.replaceEntry("B", { name: "A" })).rejects.toThrow('Entry "A" already exists');

		expect(parseEntryIndex(await store.readIndex()).entries.map((e) => e.file).sort()).toEqual(["A.md", "B.md"]);
		expect((await store.readEntry("A"))?.body).toBe("A 正文");
		expect((await store.readEntry("B"))?.body).toBe("B 正文");
		expect(await readdir(dir)).not.toContain("A-2.md");
	});

	it("reuses the same file when a rename only changes the derived file name", async () => {
		const first = await store.addEntry({ name: "A B", body: "正文" });
		const renamed = await store.replaceEntry("A B", { name: "A-B" });

		expect(renamed.file).toBe(first.file);
		expect(await readdir(dir)).not.toContain("A-B-2.md");
		expect(parseEntryIndex(await store.readIndex()).entries).toHaveLength(1);
		expect((await store.readEntry("A-B"))?.file).toBe("A-B.md");
	});

	it("drops a stale index line for the target file when renaming", async () => {
		await store.addEntry({ name: "B", body: "正文" });
		// 手工制造「文件已删、索引行还在」的陈旧状态
		await writeFile(join(dir, "MEMORY.md"), `${await store.readIndex()}- [Old](Old.md) — 陈旧\n`, "utf8");
		await store.replaceEntry("B", { name: "Old" });

		expect(parseEntryIndex(await store.readIndex()).entries.filter((e) => e.file === "Old.md")).toHaveLength(1);
	});
});

// 两级锁：进程内逻辑锁承担「逻辑作用域」（单次调用 / dream 整轮），跨进程 .lock 只管毫秒级物理写入。
// 这样 dream 整轮持锁时，它**自己**的原语调用（传 skipLogicalLock）不会自锁，而其它调用方会被挡在门外。
describe("进程内逻辑锁", () => {
	const shortLock = (memoryDir: string): StoreConfig => ({ ...CFG(memoryDir), lock: { timeoutMs: 40, snapshotKeep: 5 } });

	it("blocks a primitive while a long scope holds the logical lock, and passes the holder's own calls through", async () => {
		const store = new MemoryStore(shortLock(dir));

		await store.withLogicalLock(async () => {
			expect(store.logicalLockActive()).toBe(true);
			await expect(store.addEntry({ name: "A", body: "正文" })).rejects.toThrow(ProcessLockTimeoutError);
			await expect(store.addEntry({ name: "A", body: "正文" }, { skipLogicalLock: true })).resolves.toMatchObject({
				file: "A.md",
			});
		});

		expect(store.logicalLockActive()).toBe(false);
		await expect(store.readEntry("A")).resolves.toMatchObject({ body: "正文" });
	});

	it("does not couple different memory directories", async () => {
		const other = await mkdtemp(join(tmpdir(), "mem-store-other-"));
		try {
			const a = new MemoryStore(shortLock(dir));
			const b = new MemoryStore(shortLock(other));
			await a.withLogicalLock(async () => {
				await expect(b.addEntry({ name: "B", body: "正文" })).resolves.toMatchObject({ file: "B.md" });
			});
		} finally {
			await rm(other, { recursive: true, force: true });
		}
	});

	it("serialises two primitives that arrive at the same time", async () => {
		const store = new MemoryStore(CFG(dir));
		const results = await Promise.all(
			["A", "B", "C"].map((name) => store.addEntry({ name, body: `${name} 正文` })),
		);
		expect(new Set(results.map((r) => r.file)).size).toBe(3);
		expect(parseEntryIndex(await store.readIndex()).entries).toHaveLength(3);
	});
});

// ── Plan B（运行时接入）新增：skipSnapshot / created / 逻辑锁的超时与 try 形态 ────────────────
describe("WriteOptions.skipSnapshot", () => {
	it("writes the entry and the index without creating .backups", async () => {
		const { file } = await store.addEntry({ name: "A", body: "正文" }, { skipSnapshot: true });

		expect(file).toBe("A.md");
		expect(parseEntryFile(await readFile(join(dir, file), "utf8"))?.body).toBe("正文");
		expect(parseEntryIndex(await indexOf()).entries).toHaveLength(1);
		expect(await readdir(join(dir, ".backups")).then(() => true, () => false)).toBe(false);
	});

	it("applies to replace / rebuildIndex / remove as well", async () => {
		await store.addEntry({ name: "A", body: "正文" }, { skipSnapshot: true });
		await store.replaceEntry("A", { body: "新正文" }, { skipSnapshot: true });
		await store.rebuildIndex({ skipSnapshot: true });
		await store.removeEntry("A", { skipSnapshot: true });

		expect(await readdir(join(dir, ".backups")).then(() => true, () => false)).toBe(false);
		expect(await store.listEntries()).toEqual([]);
		expect(parseEntryIndex(await indexOf()).entries).toHaveLength(0);
	});

	it("still snapshots when the option is absent", async () => {
		await store.addEntry({ name: "A", body: "正文" });
		expect(await readdir(join(dir, ".backups"))).toHaveLength(1);
	});
});

describe("addEntry 的 created 入参", () => {
	it("uses the caller-supplied created date", async () => {
		const { file } = await store.addEntry({ name: "A", body: "正文", created: "2025-01-02" });
		expect(parseEntryFile(await readFile(join(dir, file), "utf8"))?.meta.created).toBe("2025-01-02");
	});

	it("keeps the existing created date when the same name is added again", async () => {
		await store.addEntry({ name: "A", body: "第一版", created: "2025-01-02" });
		await store.addEntry({ name: "A", body: "第二版", created: "2026-09-09" });

		expect((await store.readEntry("A"))?.created).toBe("2025-01-02");
		expect((await store.readEntry("A"))?.body).toBe("第二版");
		expect(parseEntryIndex(await indexOf()).entries).toHaveLength(1);
	});

	it("defaults created to today", async () => {
		await store.addEntry({ name: "A", body: "正文" });
		expect((await store.readEntry("A"))?.created).toBe(new Date().toISOString().slice(0, 10));
	});

	it("rejects a created value that is not YYYY-MM-DD and writes nothing", async () => {
		await expect(store.addEntry({ name: "A", body: "正文", created: "昨天" })).rejects.toThrow(
			"created must be YYYY-MM-DD",
		);
		await expect(
			store.addEntry({ name: "A", body: "正文", created: "2025-01-02T03:04:05.000Z" }),
		).rejects.toThrow("created must be YYYY-MM-DD");

		expect(await store.listEntries()).toEqual([]);
		expect(await readdir(dir)).not.toContain("A.md");
	});
});

describe("逻辑锁的超时与 try 形态", () => {
	it("honours an explicit timeout instead of the configured default", async () => {
		const started = Date.now();
		// store 的默认 timeoutMs 是 5000：若参数被忽略，内层会等满 5s 才抛错。
		await store.withLogicalLock(async () => {
			await expect(store.withLogicalLock(async () => "inner", 30)).rejects.toThrow(ProcessLockTimeoutError);
		});
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it("runs the callback when the logical lock is free", async () => {
		expect(await store.tryWithLogicalLock(async () => "ok")).toBe("ok");
		expect(store.logicalLockActive()).toBe(false);
	});

	it("returns null without running the callback when the lock is held", async () => {
		let ran = false;
		await store.withLogicalLock(async () => {
			const out = await store.tryWithLogicalLock(async () => {
				ran = true;
				return "inner";
			});
			expect(out).toBeNull();
		});
		expect(ran).toBe(false);
	});

	// Review Focus #1：锁冲突必须是「可向用户交代的明确失败」，不能是一句看不懂的 EBUSY。
	it("reports a readable, actionable error naming the directory", async () => {
		await store.withLogicalLock(async () => {
			await expect(store.withLogicalLock(async () => "inner", 20)).rejects.toThrow(
				`Memory operations for ${join(dir, "MEMORY.md")} are already running in this process`,
			);
		});
	});
});
