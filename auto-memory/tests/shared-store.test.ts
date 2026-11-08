import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore, formatIndexLine, parseEntryIndex, resolveMemoryDir, type StoreConfig } from "../src/index.js";

/**
 * 跨宿主共享的实质承诺：**同一个目录上的并发写不会把索引写坏**。
 *
 * 这里钉的是**同进程两个 `MemoryStore` 实例**的组合行为：它们共用 `#indexPath()` 这个逻辑锁 key
 * （`process-lock` 的 states 是模块级的），写入又都经 `#savingQueue` 的模块级变更队列，所以在到达
 * 跨进程 `.lock` 之前就已被完全串行化 —— 本文件**不**制造跨进程锁竞争。
 *
 * 跨进程 `.lock` 的原语语义（活持有者、异主机持有者、死进程遗留、`open(wx)` 建立与写记录之间的
 * 0 字节窗口、重叠调用串行化）由 `fs-lock.test.ts` 的 18 条用例直接覆盖。真正起两个进程的端到端
 * 用例需要子进程能 import 编译产物，留到阶段 2 有了 `dist/` 再加。
 */
let dir: string;

const CFG = (memoryDir: string): StoreConfig => ({
	memoryDir,
	indexMaxLines: 200,
	indexMaxBytes: 25600,
	lock: { timeoutMs: 5000, snapshotKeep: 5 },
});

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "am-shared-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("two stores on one directory", () => {
	it("serialises two in-process stores so concurrent writes never tear the index", async () => {
		const a = new MemoryStore(CFG(dir));
		const b = new MemoryStore(CFG(dir));

		await Promise.all([
			...[0, 1, 2, 3, 4].map((i) => a.addEntry({ name: `A${i}`, description: `a${i}`, body: `正文 A${i}` })),
			...[0, 1, 2, 3, 4].map((i) => b.addEntry({ name: `B${i}`, description: `b${i}`, body: `正文 B${i}` })),
		]);

		const raw = await readFile(join(dir, "MEMORY.md"), "utf8");
		const parsed = parseEntryIndex(raw);
		expect(parsed.entries).toHaveLength(10);
		expect(parsed.unrecognized).toBe(0);
		// 没有空行、没有半行：每一行都严格是 formatIndexLine 的输出
		const files = parsed.entries.map((e) => e.file).sort();
		expect(files).toEqual([...[0, 1, 2, 3, 4].map((i) => `A${i}.md`), ...[0, 1, 2, 3, 4].map((i) => `B${i}.md`)].sort());
		for (const line of raw.split("\n")) {
			if (line.trim() === "" || line.startsWith("#")) continue;
			const entry = parsed.entries.find((e) => line === formatIndexLine(e.name, e.file, e.description));
			expect(entry, `索引行不是 formatIndexLine 的产物：${JSON.stringify(line)}`).toBeDefined();
		}
		// 十个 entry 文件都在，正文没被写串
		expect((await a.listEntries()).map((e) => e.file).sort()).toEqual(files);
		expect(await readFile(join(dir, "A0.md"), "utf8")).toContain("正文 A0");
		expect(await readFile(join(dir, "B4.md"), "utf8")).toContain("正文 B4");
	});

	it("leaves no lock behind once both stores are done", async () => {
		const a = new MemoryStore(CFG(dir));
		const b = new MemoryStore(CFG(dir));
		await Promise.all([a.addEntry({ name: "A", body: "a" }), b.addEntry({ name: "B", body: "b" })]);
		// `.lock` 只在毫秒级物理写入期间存在；两次写都结束后目录里不该留下它
		// （同进程下这两个 store 被逻辑锁串行化，所以这里其实很难观察到竞争后的残留 ——
		// 它钉的是「正常路径不留锁」，崩溃残留的处置见 fs-lock.test.ts）
		expect(await readdir(dir)).not.toContain(".lock");
	});

	it("resolves the same directory for the same cwd whoever asks", async () => {
		// 跨宿主共享的前提：目录推导只依赖 cwd 与数据根，不依赖任何宿主状态。
		const config = { memoryDir: dir };
		const first = await resolveMemoryDir(config, process.cwd());
		const second = await resolveMemoryDir({ ...config }, process.cwd());
		expect(first).toBe(second);
		expect(first.startsWith(dir)).toBe(true);
	});
});
