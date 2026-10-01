import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serializeEntryFile, type EntryMeta } from "../src/entry-file";
import { parseEntryIndex } from "../src/entry-index";
import { MemoryStore, type StoreConfig } from "../src/memory-store";

let dir: string;
let store: MemoryStore;

const CFG: StoreConfig = {
	memoryDir: "",
	indexMaxLines: 200,
	indexMaxBytes: 25600,
	lock: { timeoutMs: 5000, dreamTimeoutMs: 30000, ttlMs: 600_000, snapshotKeep: 5 },
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
});

describe("renameEntry", () => {
	it("renames the file and keeps the index line position", async () => {
		await store.addEntry({ name: "A", body: "A 正文" });
		await store.addEntry({ name: "B", body: "B 正文" });
		const result = await store.renameEntry("A", "A2");

		expect(result.file).toBe("A2.md");
		const raw = await store.readIndex();
		expect(parseEntryIndex(raw).entries.map((e) => e.file)).toEqual(["A2.md", "B.md"]);
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
