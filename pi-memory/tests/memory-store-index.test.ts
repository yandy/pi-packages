import { chmod, link, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serializeEntryFile, type EntryMeta } from "../src/entry-file";
import { parseEntryIndex } from "../src/entry-index";
import { MemoryStore, sameFile, unlinkStrict, type StoreConfig } from "../src/memory-store";

let dir: string;
let store: MemoryStore;

const CFG: StoreConfig = {
	memoryDir: "",
	indexMaxLines: 200,
	indexMaxBytes: 25600,
	lock: { timeoutMs: 5000, snapshotKeep: 5 },
};

function meta(name: string, over: Partial<EntryMeta> = {}): EntryMeta {
	return {
		name,
		description: `${name} 摘要`,
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
	dir = await mkdtemp(join(tmpdir(), "mem-store-index-"));
	store = new MemoryStore({ ...CFG, memoryDir: dir });
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("removeEntry", () => {
	it("deletes the file and only its index line", async () => {
		await writeFile(join(dir, "MEMORY.md"), "# Memory Index\n<!-- keep -->\n", "utf8");
		await store.addEntry({ name: "A", body: "正文" });
		await store.addEntry({ name: "B", body: "正文" });
		await store.removeEntry("A");

		expect(await readdir(dir)).not.toContain("A.md");
		const raw = await store.readIndex();
		expect(raw).toContain("<!-- keep -->");
		expect(parseEntryIndex(raw).entries.map((e) => e.file)).toEqual(["B.md"]);
	});

	it("throws for an unknown ref", async () => {
		await expect(store.removeEntry("nope")).rejects.toThrow('Entry "nope" not found');
	});

	it("snapshots the entry file before deleting it", async () => {
		await store.addEntry({ name: "A", body: "正文" });
		await store.removeEntry("A");
		const snapshots = (await readdir(join(dir, ".backups"))).sort();
		const last = snapshots[snapshots.length - 1];
		expect(await readFile(join(dir, ".backups", last, "A.md"), "utf8")).toContain("正文");
	});

	// 与 addEntry 同一性质（spec §6 / §18.1）：快照建不了时删除必须中止，
	// 否则会出现「无快照可回滚」的不可逆删除。
	it("aborts the removal when the snapshot cannot be created", async () => {
		await store.addEntry({ name: "A", body: "正文" });
		const before = await store.readIndex();
		await rm(join(dir, ".backups"), { recursive: true, force: true });
		await writeFile(join(dir, ".backups"), "not a directory", "utf8");

		await expect(store.removeEntry("A")).rejects.toThrow();
		expect(await readdir(dir)).toContain("A.md");
		expect(await store.readIndex()).toBe(before);
	});

	// 删除失败必须 fail-closed：吞掉错误的话索引行已删、缓存已失效但文件还在，
	// 下次 rebuildIndex（dream 会常规调用）会把它加回来 —— 删除被静默回滚。
	// 注：目录只读时锁的临时文件也建不了，所以本用例钉的是「只读目录 → 干净失败、无半成品」这个端到端
	// 性质；unlinkStrict 本身的抛错语义由下面的 internal 用例直接覆盖。
	// win32：`chmod` 只能切只读位（Node 文档：Windows 上只有写权限可被 chmod 影响），目录 ACL 才决定
	// 删除权，`0o500` 造不出「无法 unlink」→ 平台门；上面那条 root 守卫管的是另一件事，保留。
	it.skipIf(process.platform === "win32")("fails the removal when the entry file cannot be deleted", async () => {
		if (typeof process.getuid === "function" && process.getuid() === 0) return; // root 会绕过权限检查
		await store.addEntry({ name: "A", body: "正文" });
		await chmod(dir, 0o500); // 目录只读 → unlink 失败
		try {
			await expect(store.removeEntry("A")).rejects.toThrow();
		} finally {
			await chmod(dir, 0o700);
		}
		expect((await store.readEntry("A"))?.body).toBe("正文");
		expect(parseEntryIndex(await store.readIndex()).entries.some((e) => e.file === "A.md")).toBe(true);
	});
});

describe("unlinkStrict / sameFile", () => {
	it("treats a missing file as already deleted", async () => {
		await expect(unlinkStrict(join(dir, "nope.md"))).resolves.toBeUndefined();
	});

	// fail-closed 的本体：ENOENT 之外的错误一律上抛，不得静默变成「删除成功」。
	// win32：与上一条同一原因（`chmod` 造不出不可删除的目录）→ 平台门；root 守卫保留。
	it.skipIf(process.platform === "win32")("rethrows any error that is not ENOENT", async () => {
		if (typeof process.getuid === "function" && process.getuid() === 0) return;
		await writeFile(join(dir, "a.md"), "x", "utf8");
		await chmod(dir, 0o500);
		try {
			await expect(unlinkStrict(join(dir, "a.md"))).rejects.toThrow();
		} finally {
			await chmod(dir, 0o700);
		}
		expect(await readFile(join(dir, "a.md"), "utf8")).toBe("x");
	});

	// 大小写不敏感 / Unicode 规范化的文件系统上，两个不同的字符串可能指向同一 inode；
	// 那时 rename 后的 unlink 会把刚写入的文件删掉。硬链接是 Linux 上能构造出的同 inode 双名字。
	// win32：`link` 只在支持硬链接的卷（NTFS/ReFS，FAT/exFAT 与部分网络盘不支持）上可用，
	// 且 `sameFile` 比较的 `dev`/`ino` 是 POSIX inode 语义而非跨平台契约 → 平台门。
	it.skipIf(process.platform === "win32")("detects two names that point at the same inode", async () => {
		await writeFile(join(dir, "a.md"), "x", "utf8");
		await writeFile(join(dir, "c.md"), "y", "utf8");
		await link(join(dir, "a.md"), join(dir, "b.md"));
		expect(await sameFile(join(dir, "a.md"), join(dir, "b.md"))).toBe(true);
		expect(await sameFile(join(dir, "a.md"), join(dir, "c.md"))).toBe(false);
		expect(await sameFile(join(dir, "a.md"), join(dir, "missing.md"))).toBe(false);
	});
});

describe("rebuildIndex", () => {
	it("rebuilds from disk in (modified, file) order", async () => {
		await writeEntry("b.md", meta("B", { modified: "2026-10-02T00:00:00.000Z" }));
		await writeEntry("a.md", meta("A", { modified: "2026-10-01T00:00:00.000Z" }));
		const result = await store.rebuildIndex();
		expect(result.entries).toBe(2);
		expect(parseEntryIndex(await store.readIndex()).entries.map((e) => e.file)).toEqual(["a.md", "b.md"]);
	});

	it("adds a default header when the index had none", async () => {
		await writeEntry("a.md", meta("A"));
		await store.rebuildIndex();
		expect((await store.readIndex()).startsWith("# Memory Index\n")).toBe(true);
	});

	it("preserves the handwritten block above the first index line", async () => {
		await writeEntry("a.md", meta("A"));
		await writeFile(join(dir, "MEMORY.md"), "# Memory Index\n\n## Project\n- [Old](old.md) — 陈旧\n", "utf8");
		await store.rebuildIndex();
		const raw = await store.readIndex();
		expect(raw).toContain("## Project");
		expect(raw).not.toContain("old.md");
		expect(parseEntryIndex(raw).entries.map((e) => e.file)).toEqual(["a.md"]);
	});

	it("includes orphan files that were missing from the index", async () => {
		await writeEntry("orphan.md", meta("Orphan"));
		await store.rebuildIndex();
		expect(parseEntryIndex(await store.readIndex()).entries.map((e) => e.file)).toEqual(["orphan.md"]);
	});

	it("drops index lines whose file no longer exists", async () => {
		const path = await writeEntry("a.md", meta("A"));
		await store.rebuildIndex();
		await unlink(path);
		await store.rebuildIndex();
		expect(parseEntryIndex(await store.readIndex()).entries).toEqual([]);
	});

	it("leaves unparseable files alone without indexing them", async () => {
		await writeEntry("a.md", meta("A"));
		await writeFile(join(dir, "broken.md"), "no frontmatter\n", "utf8");
		await store.rebuildIndex();
		expect(parseEntryIndex(await store.readIndex()).entries.map((e) => e.file)).toEqual(["a.md"]);
		expect(await readFile(join(dir, "broken.md"), "utf8")).toBe("no frontmatter\n");
	});

	it("snapshots MEMORY.md before rebuilding", async () => {
		await writeFile(join(dir, "MEMORY.md"), "- [Old](old.md) — 陈旧\n", "utf8");
		await store.rebuildIndex();
		const snapshots = (await readdir(join(dir, ".backups"))).sort();
		const last = snapshots[snapshots.length - 1];
		expect(await readFile(join(dir, ".backups", last, "MEMORY.md"), "utf8")).toBe("- [Old](old.md) — 陈旧\n");
	});
});
