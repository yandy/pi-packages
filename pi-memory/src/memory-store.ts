import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { type EntryType, parseEntryFile } from "./entry-file";

export const INDEX_FILE = "MEMORY.md";
export const LOCK_FILE = ".lock";
export const BACKUP_DIR = ".backups";

export interface StoreConfig {
	memoryDir: string;
	indexMaxLines: number;
	indexMaxBytes: number;
	lock: { timeoutMs: number; dreamTimeoutMs: number; ttlMs: number; snapshotKeep: number };
}

export interface EntrySummary {
	file: string;
	name: string;
	description: string;
	type: EntryType;
	modified: string;
}

export interface Entry extends EntrySummary {
	created: string;
	body: string;
}

interface CacheRow {
	mtimeMs: number;
	summary: EntrySummary;
}

function compareSummaries(a: EntrySummary, b: EntrySummary): number {
	return a.modified === b.modified ? a.file.localeCompare(b.file) : a.modified.localeCompare(b.modified);
}

/** 进程级唯一写入通道。所有对 memory 目录的修改必须经它。 */
export class MemoryStore {
	readonly #cache = new Map<string, CacheRow>();

	constructor(readonly cfg: StoreConfig) {}

	async #entryFiles(): Promise<string[]> {
		const names = await readdir(this.cfg.memoryDir).catch(() => []);
		return names.filter((n) => n.endsWith(".md") && n !== INDEX_FILE && !n.startsWith(".")).sort();
	}

	/** 扫描目录并返回按 (modified, file) 排序的条目标量；mtime 未变时复用缓存的 frontmatter。 */
	async listEntries(): Promise<EntrySummary[]> {
		const files = await this.#entryFiles();
		const out: EntrySummary[] = [];
		const seen = new Set<string>();

		for (const file of files) {
			const info = await stat(join(this.cfg.memoryDir, file)).catch(() => null);
			if (!info?.isFile()) continue;
			seen.add(file);

			const cached = this.#cache.get(file);
			if (cached && cached.mtimeMs === info.mtimeMs) {
				out.push(cached.summary);
				continue;
			}

			const parsed = parseEntryFile(await readFile(join(this.cfg.memoryDir, file), "utf8").catch(() => ""));
			if (!parsed) {
				this.#cache.delete(file);
				continue;
			}

			const summary: EntrySummary = { file, ...parsed.meta };
			this.#cache.set(file, { mtimeMs: info.mtimeMs, summary });
			out.push(summary);
		}

		for (const file of [...this.#cache.keys()]) if (!seen.has(file)) this.#cache.delete(file);
		return out.sort(compareSummaries);
	}

	/** 按文件名或 name 定位一个 entry。 */
	async readEntry(ref: string): Promise<Entry | null> {
		const summaries = await this.listEntries();
		const summary = summaries.find((s) => s.file === ref) ?? summaries.find((s) => s.name === ref);
		if (!summary) return null;
		const parsed = parseEntryFile(await readFile(join(this.cfg.memoryDir, summary.file), "utf8").catch(() => ""));
		return parsed ? { ...summary, created: parsed.meta.created, body: parsed.body } : null;
	}

	async readIndex(): Promise<string> {
		return readFile(join(this.cfg.memoryDir, INDEX_FILE), "utf8").catch(() => "");
	}

	async searchEntries(query: string): Promise<Entry[]> {
		const needle = query.toLowerCase();
		const out: Entry[] = [];
		for (const summary of await this.listEntries()) {
			const entry = await this.readEntry(summary.file);
			if (!entry) continue;
			const haystack = [entry.name, entry.description, entry.body].map((f) => f.toLowerCase());
			if (haystack.some((f) => f.includes(needle))) out.push(entry);
		}
		return out;
	}

	/** 清空并重建缓存（手工编辑过目录后用）。 */
	async refreshCache(): Promise<void> {
		this.#cache.clear();
		await this.listEntries();
	}
}
