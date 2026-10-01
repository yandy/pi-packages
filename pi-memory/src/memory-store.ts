import { readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { deriveDescription, type EntryType, parseEntryFile, serializeEntryFile } from "./entry-file";
import { indexCapacity, parseEntryIndex, removeIndexLine, upsertIndexLine } from "./entry-index";
import { entryFileName, resolveUniqueFileName } from "./filename";
import { withLock } from "./fs-lock";
import { createSnapshot } from "./snapshot";

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

/**
 * 进程级唯一写入通道。所有对 memory 目录的修改必须经它。
 *
 * 已知崩溃窗口（由写前快照兜底，消费方属 Plan B 的恢复/迁移工具）：`replaceEntry` 改名时
 * 先写新文件、再删旧文件、最后重写索引；若在「删旧文件」与「重写索引」之间进程退出，
 * `MEMORY.md` 会残留一条指向已删文件的死链。`upsertIndexLine` 以 file 为键，因此这条死链
 * 不会被后续写入自动覆盖 —— 只能从 `.backups/` 快照恢复。
 */
export class MemoryStore {
	readonly #cache = new Map<string, CacheRow>();

	constructor(readonly cfg: StoreConfig) {}

	async #entryFiles(): Promise<string[]> {
		const names = await readdir(this.cfg.memoryDir).catch(() => []);
		return names.filter((n) => n.endsWith(".md") && n !== INDEX_FILE && !n.startsWith(".")).sort();
	}

	#indexPath(): string {
		return join(this.cfg.memoryDir, INDEX_FILE);
	}

	/** 进程内串行；跨进程安全由 #locked 负责。 */
	async #savingQueue<T>(fn: () => Promise<T>): Promise<T> {
		return withFileMutationQueue(this.#indexPath(), fn);
	}

	async #locked<T>(op: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
		return withLock(join(this.cfg.memoryDir, LOCK_FILE), op, { timeoutMs, ttlMs: this.cfg.lock.ttlMs }, fn);
	}

	async #snapshot(label: string, files: string[]): Promise<void> {
		await createSnapshot(join(this.cfg.memoryDir, BACKUP_DIR), label, files, this.cfg.memoryDir, {
			keep: this.cfg.lock.snapshotKeep,
		});
	}

	#capacityWarning(raw: string): string | undefined {
		const cap = indexCapacity(raw, this.cfg.indexMaxLines, this.cfg.indexMaxBytes);
		if (cap.ok) return undefined;
		return (
			`MEMORY.md is over its limit: ${cap.lineCount}/${this.cfg.indexMaxLines} lines, ` +
			`${cap.byteLength}/${this.cfg.indexMaxBytes} bytes. The write succeeded, but everything past ` +
			"the limit is dropped on the next load. Rewrite it now: keep one line per entry, merge or drop " +
			"stale entries, and move detail into entry bodies rather than the index."
		);
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

	/** 读单个 entry 的正文；调用方自己提供已扫描到的 summary，避免重复扫目录。 */
	async #readBody(summary: EntrySummary): Promise<Entry | null> {
		const parsed = parseEntryFile(await readFile(join(this.cfg.memoryDir, summary.file), "utf8").catch(() => ""));
		return parsed ? { ...summary, created: parsed.meta.created, body: parsed.body } : null;
	}

	/** 按文件名或 name 定位一个 entry。 */
	async readEntry(ref: string): Promise<Entry | null> {
		const summaries = await this.listEntries();
		const summary = summaries.find((s) => s.file === ref) ?? summaries.find((s) => s.name === ref);
		if (!summary) return null;
		return this.#readBody(summary);
	}

	async readIndex(): Promise<string> {
		return readFile(join(this.cfg.memoryDir, INDEX_FILE), "utf8").catch(() => "");
	}

	async searchEntries(query: string): Promise<Entry[]> {
		const needle = query.toLowerCase();
		const out: Entry[] = [];
		// 必须走 #readBody 而不是 readEntry：readEntry 会再调一次 listEntries（= 再一轮 readdir +
		// 每文件一次 stat），在 N 条目上就会变成 N+1 次目录扫描、约 N² 次 stat。
		for (const summary of await this.listEntries()) {
			const entry = await this.#readBody(summary);
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

	async addEntry(input: {
		name: string;
		description?: string;
		type?: EntryType;
		body: string;
	}): Promise<{ file: string; capacityWarning?: string }> {
		const name = input.name.trim();
		if (!name) throw new Error("name is required");
		if (/[\r\n]/.test(name)) throw new Error("name must be a single line");
		const requestedDescription = input.description?.trim();
		if (requestedDescription && /[\r\n]/.test(requestedDescription)) {
			throw new Error("description must be a single line");
		}
		const body = input.body.trim();
		if (!body) throw new Error("body is required");

		return this.#savingQueue(() =>
			this.#locked("add", this.cfg.lock.timeoutMs, async () => {
				const summaries = await this.listEntries();
				const existing = summaries.find((s) => s.name === name);
				const file = existing?.file ?? resolveUniqueFileName(new Set(await this.#entryFiles()), entryFileName(name));
				const created = existing ? ((await this.readEntry(existing.file))?.created ?? isoDate(new Date())) : isoDate(new Date());
				// `|| name` 是必需的：deriveDescription 可能返回 ""，而空 description 会让该 entry 对侧查询不可见。
				const description = requestedDescription || deriveDescription(body) || name;
				const now = new Date();

				await this.#snapshot("write", [INDEX_FILE, file]);
				await writeFile(
					join(this.cfg.memoryDir, file),
					serializeEntryFile(
						{
							name,
							description,
							type: input.type ?? existing?.type ?? "feedback",
							created,
							modified: now.toISOString(),
						},
						body,
					),
					"utf8",
				);

				const next = upsertIndexLine(await this.readIndex(), { name, file, description });
				await writeFile(this.#indexPath(), next, "utf8");
				this.#cache.delete(file);

				return { file, capacityWarning: this.#capacityWarning(next) };
			}),
		);
	}

	async replaceEntry(
		ref: string,
		patch: { name?: string; description?: string; type?: EntryType; body?: string },
	): Promise<{ file: string; capacityWarning?: string }> {
		return this.#savingQueue(() =>
			this.#locked("replace", this.cfg.lock.timeoutMs, async () => {
				const current = await this.readEntry(ref);
				if (!current) throw new Error(`Entry "${ref}" not found`);

				const name = (patch.name ?? current.name).trim();
				if (!name) throw new Error("name is required");
				if (/[\r\n]/.test(name)) throw new Error("name must be a single line");
				const requestedDescription = patch.description?.trim();
				if (requestedDescription && /[\r\n]/.test(requestedDescription)) {
					throw new Error("description must be a single line");
				}
				const body = patch.body === undefined ? current.body : patch.body.trim();
				const description =
					requestedDescription ||
					(patch.body === undefined ? current.description : deriveDescription(body)) ||
					current.description ||
					name;
				// 改名不得撞名。`resolveUniqueFileName` 只防**文件名**冲突，所以不在这里拦下的话，
				// rename 到已存在的 name 会写出第二个同名 entry（索引里两行都写着 [A]），之后 readEntry /
				// addEntry 都会命中其中较旧的那个 —— 「精确同名即幂等」的硬约束就断了。
				// 选择报错而不是合并或自动加后缀：合并会静默覆盖对方的内容，加后缀则会篡改调用方给的 name，
				// 两者都在用户没要求的地方动记忆。
				if (name !== current.name && (await this.listEntries()).some((s) => s.name === name)) {
					throw new Error(`Entry "${name}" already exists`);
				}
				const used = new Set(await this.#entryFiles());
				// 自碰撞（如 "A B" → "A-B" 派生出同一个文件名）应复用原文件，而不是产生 A-B-2.md
				used.delete(current.file);
				const file = name === current.name ? current.file : resolveUniqueFileName(used, entryFileName(name));

				await this.#snapshot("write", [INDEX_FILE, current.file, file]);
				await writeFile(
					join(this.cfg.memoryDir, file),
					serializeEntryFile(
						{
							name,
							description,
							type: patch.type ?? current.type,
							created: current.created,
							modified: new Date().toISOString(),
						},
						body,
					),
					"utf8",
				);
				if (file !== current.file) await unlink(join(this.cfg.memoryDir, current.file)).catch(() => {});

				const raw = await this.readIndex();
				// 目标文件名可能残留一条陈旧索引行（手工删了文件却没删行）。不先清掉的话，
				// 下面的 atLineNo 覆盖会与它并存 → 同一个 file 出现两条索引行。
				// 必须先清再重新解析行号：删除会让后面的行号前移。
				// 仅在真正换文件时清理：未改名（含 "A B" → "A-B" 派生同名文件）时 file === current.file，
				// removeIndexLine 会删掉我们要保留位置的那一行，它会被 upsert 追加到索引末尾。
				const cleaned = file === current.file ? raw : removeIndexLine(raw, file);
				const line = parseEntryIndex(cleaned).entries.find((e) => e.file === current.file);
				const next = upsertIndexLine(
					cleaned,
					{ name, file, description },
					line ? { atLineNo: line.lineNo } : undefined,
				);
				await writeFile(this.#indexPath(), next, "utf8");
				this.#cache.delete(current.file);
				this.#cache.delete(file);

				return { file, capacityWarning: this.#capacityWarning(next) };
			}),
		);
	}
}

function isoDate(date: Date): string {
	return date.toISOString().slice(0, 10);
}
