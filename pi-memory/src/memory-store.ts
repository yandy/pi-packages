import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { deriveDescription, type EntryType, parseEntryFile, serializeEntryFile } from "./entry-file";
import { formatIndexLine, indexCapacity, parseEntryIndex, removeIndexLine, upsertIndexLine } from "./entry-index";
import { entryFileName, resolveUniqueFileName } from "./filename";
import { withLock } from "./fs-lock";
import { isProcessLockActive, withProcessLock } from "./process-lock";
import { createSnapshot } from "./snapshot";

export const INDEX_FILE = "MEMORY.md";
export const LOCK_FILE = ".lock";
export const BACKUP_DIR = ".backups";

/**
 * 删除文件；ENOENT 视为成功，其余错误一律上抛（与快照的 fail-closed 策略一致）。
 *
 * 吞错会让调用方拿到「删除成功」的假信号：removeEntry 已删索引行、已失效缓存但文件还在，
 * 下次 rebuildIndex（dream 会常规调用）会把它加回来 —— 删除被静默回滚。
 * 导出仅为测试：这条语义无法在 Linux 上经由 MemoryStore 的公开 API 触发（锁的临时文件与
 * entry 文件同目录，目录不可写时会在获取锁阶段先失败）。
 */
export async function unlinkStrict(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
	}
}

/**
 * 两个路径是否指向同一个 inode。同样导出仅为测试。
 *
 * 大小写不敏感 / 会对 Unicode 做规范化的文件系统上，`file !== current.file` 只是字符串比较：
 * writeFile("b.md") 可能已经写穿了 "B.md" 的 inode，紧接着 unlink("B.md") 会把刚写入的文件删掉。
 */
export async function sameFile(a: string, b: string): Promise<boolean> {
	const [left, right] = await Promise.all([stat(a).catch(() => null), stat(b).catch(() => null)]);
	return left !== null && right !== null && left.dev === right.dev && left.ino === right.ino;
}

/**
 * 写原语的调用选项。
 *
 * `skipLogicalLock` 供**整轮持有者**使用：dream / 迁移先用 `withLogicalLock()` 包住整轮，
 * 它内部再调用原语时若还去抢同一把进程内锁就会自锁。默认值（不传）= 自己拿锁，这对
 * 「一次调用一个作用域」的调用方（主 agent 工具、extract）是安全的默认。
 */
export interface WriteOptions {
	skipLogicalLock?: boolean;
}

export interface StoreConfig {
	memoryDir: string;
	indexMaxLines: number;
	indexMaxBytes: number;
	/** 跨进程 `.lock` 的等待上限。注意这里**没有 ttl** —— 锁只在毫秒级的物理写入期间持有，
	 *  且永不自动回收（见 fs-lock.ts）；dream 的整轮互斥由 process-lock.ts 的进程内队列承担。 */
	lock: { timeoutMs: number; snapshotKeep: number };
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
 *
 * 锁契约（Plan B 的 dream / 迁移必须遵守）：
 * - **两级锁，作用域不同**：进程内**逻辑锁**（`process-lock.ts`，按 `memoryDir` 分键）承担
 *   「逻辑作用域」（单次原语 = 该次调用；dream / 迁移 = 整轮）；跨进程 `.lock` 承担「毫秒级的
 *   物理写入」。因此 `.lock` 永远只被持有一瞬间，不需要 TTL / 续约 / 接管（见 fs-lock.ts）。
 * - 不做整轮的调用方（主 agent 工具、extract）**不必传任何选项** —— 默认就会自取逻辑锁。
 * - 需要整轮独占时：用 `withLogicalLock()` 包住整轮，且**其内部调用必须传
 *   `{ skipLogicalLock: true }`**，否则会去抢自己已持有的锁而自锁到 `timeoutMs`。
 *   启动前用 `logicalLockActive()` 自检 —— 忘了包锁会静默失去整轮互斥。
 * - `#savingQueue`（进程内 mutation 队列）**没有**超时；它是毫秒级的，且已在逻辑锁之内，
 *   所以不会把超时语义弄糊。
 */
export class MemoryStore {
	readonly #cache = new Map<string, CacheRow>();

	constructor(readonly cfg: StoreConfig) {}

	async #entryFiles(): Promise<string[]> {
		const names = await readdir(this.cfg.memoryDir).catch(() => []);
		return names.filter((n) => n.endsWith(".md") && n !== INDEX_FILE && !n.startsWith(".")).sort();
	}

	/** 已被占用的文件名：磁盘上的条目文件 + 索引文件本身。
	 *  索引必须计入 —— 它被 #entryFiles 过滤掉（它不是条目），但绝不能作为条目文件名被写入：
	 *  一次合法的 addEntry({ name: "MEMORY" }) 会解析出 MEMORY.md 并写穿它，销毁手写头部与全部索引行。
	 *  ".MEMORY"（entryFileName 会剥掉前置句点）同样命中，因此这里按派生后的文件名而不是原始 name 判断。 */
	async #takenFileNames(): Promise<Set<string>> {
		const used = new Set(await this.#entryFiles());
		used.add(INDEX_FILE);
		return used;
	}

	/** 解析目标文件名：先按字符串占用集取名，再对磁盘探测一次。
	 *  大小写不敏感、或会对 Unicode 做规范化的文件系统上，"b.md" 与 "B.md" / NFC 与 NFD
	 *  可能指向同一个 inode —— 纯字符串比较会让我们以为名字空闲，写穿别人的文件。
	 *  `exclude` 是调用方自己的现有文件（改名时的自碰撞应复用原文件，而不是产生 A-B-2.md）。 */
	async #resolveTargetFile(name: string, exclude?: string): Promise<string> {
		const used = await this.#takenFileNames();
		if (exclude) used.delete(exclude);
		let candidate = resolveUniqueFileName(used, entryFileName(name));
		for (let attempt = 0; attempt < 100; attempt++) {
			if (candidate === exclude) return candidate;
			const taken = await stat(join(this.cfg.memoryDir, candidate)).then(
				() => true,
				() => false,
			);
			if (!taken) return candidate;
			used.add(candidate);
			candidate = resolveUniqueFileName(used, entryFileName(name));
		}
		throw new Error(`Unable to find a free file name for "${name}"`);
	}

	#indexPath(): string {
		return join(this.cfg.memoryDir, INDEX_FILE);
	}

	/** 进程内串行；跨进程安全由 #locked 负责。写路径都必须先保证目录存在 ——
	 *  锁的临时文件就落在该目录下，目录不存在会在获取锁时报出与 memory 无关的 ENOENT。 */
	async #savingQueue<T>(fn: () => Promise<T>): Promise<T> {
		await mkdir(this.cfg.memoryDir, { recursive: true });
		return withFileMutationQueue(this.#indexPath(), fn);
	}

	async #locked<T>(op: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
		return withLock(join(this.cfg.memoryDir, LOCK_FILE), op, { timeoutMs }, fn);
	}

	/**
	 * 进程内逻辑锁的 key。与跨进程锁同源（同一个 memoryDir），因此「同一目录的多个 store 实例」
	 * 共享同一把逻辑锁。注意 key 用配置里已展开的路径字符串：若同一个目录以不同写法（`..`、符号链接）
	 * 配置给两个 store，会得到两把锁 —— 目前所有调用方都走同一条 `resolveMemoryDir` 路径。
	 */
	get #logicalKey(): string {
		return this.#indexPath();
	}

	/**
	 * 写管线（所有原语的唯一入口）：
	 *   进程内逻辑锁（毫秒级：本调用） → 进程内 mutation 队列 → 跨进程 `.lock`（毫秒级） → 快照 → 读改。
	 * 两级锁的顺序固定（逻辑锁在外），因此不存在锁序反转。
	 */
	async #pipeline<T>(op: string, options: WriteOptions | undefined, fn: () => Promise<T>): Promise<T> {
		const run = () => this.#savingQueue(() => this.#locked(op, this.cfg.lock.timeoutMs, fn));
		if (options?.skipLogicalLock) return run();
		return withProcessLock(this.#logicalKey, this.cfg.lock.timeoutMs, run);
	}

	/**
	 * 在「进程内逻辑锁」下跑一整轮（dream / 迁移）。持有期间调用原语必须传
	 * `{ skipLogicalLock: true }`，否则会自锁到超时。
	 *
	 * 整轮互斥放进程内、而不是让跨进程 `.lock` 持整轮，是刻意的：`.lock` 只承担毫秒级的物理写入，
	 * 因而不需要 TTL / 续约 / 接管（见 fs-lock.ts）；而 dream 自己的原语调用也不会撞上自己的锁。
	 */
	async withLogicalLock<T>(fn: () => Promise<T>): Promise<T> {
		return withProcessLock(this.#logicalKey, this.cfg.lock.timeoutMs, fn);
	}

	/** 整轮持有者启动前的自检：忘了包 `withLogicalLock` 会静默失去整轮互斥。 */
	logicalLockActive(): boolean {
		return isProcessLockActive(this.#logicalKey);
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

	/** name 校验：非空、单行、不含 `](`。add 与 replace 共用，否则改名就成了绕过入口。 */
	#validateName(name: string): void {
		if (!name) throw new Error("name is required");
		if (/[\r\n]/.test(name)) throw new Error("name must be a single line");
		// `](` 会伪造索引行的 name/file 分组：formatIndexLine("A](x.md) — fake", "real.md", "d") 产出
		// `- [A](x.md) — fake](real.md) — d`，解析回 { name: "A", file: "x.md" }。于是 removeIndexLine
		// 删掉的是这一行，真正那条 x.md 留下（删 X 报成功却留下死链），而 real.md 变成无索引的孤儿。
		// description 里出现 `](` 无害（该组是到行尾的 `(.*)`），只有 name 危险。
		if (name.includes("](")) throw new Error("name must not contain ']('");
	}

	#validateDescription(value: string | undefined): void {
		if (value && /[\r\n]/.test(value)) throw new Error("description must be a single line");
	}

	async addEntry(
		input: { name: string; description?: string; type?: EntryType; body: string },
		options?: WriteOptions,
	): Promise<{ file: string; capacityWarning?: string }> {
		const name = input.name.trim();
		this.#validateName(name);
		const requestedDescription = input.description?.trim();
		this.#validateDescription(requestedDescription);
		const body = input.body.trim();
		if (!body) throw new Error("body is required");

		return this.#pipeline("add", options, async () => {
				const summaries = await this.listEntries();
				const existing = summaries.find((s) => s.name === name);
				const file = existing?.file ?? (await this.#resolveTargetFile(name));
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
		});
	}

	async replaceEntry(
		ref: string,
		patch: { name?: string; description?: string; type?: EntryType; body?: string },
		options?: WriteOptions,
	): Promise<{ file: string; capacityWarning?: string }> {
		return this.#pipeline("replace", options, async () => {
				const current = await this.readEntry(ref);
				if (!current) throw new Error(`Entry "${ref}" not found`);

				const name = (patch.name ?? current.name).trim();
				this.#validateName(name);
				const requestedDescription = patch.description?.trim();
				this.#validateDescription(requestedDescription);
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
				// 自碰撞（如 "A B" → "A-B" 派生出同一个文件名）由 #resolveTargetFile 的 exclude 参数复用原文件
				const file = name === current.name ? current.file : await this.#resolveTargetFile(name, current.file);

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
				if (file !== current.file) {
					// 大小写不敏感 / 做 Unicode 规范化的文件系统上，两个不同的字符串可能指向同一 inode；
					// 那种情况下上面的 writeFile 已经写穿了原文件，再 unlink 会把刚写入的文件删掉。
					const target = join(this.cfg.memoryDir, file);
					const source = join(this.cfg.memoryDir, current.file);
					if (!(await sameFile(target, source))) await unlinkStrict(source);
				}

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
		});
	}

	async removeEntry(ref: string, options?: WriteOptions): Promise<void> {
		await this.#pipeline("remove", options, async () => {
				const current = await this.readEntry(ref);
				if (!current) throw new Error(`Entry "${ref}" not found`);

				await this.#snapshot("write", [INDEX_FILE, current.file]);
				await unlinkStrict(join(this.cfg.memoryDir, current.file));
				await writeFile(this.#indexPath(), removeIndexLine(await this.readIndex(), current.file), "utf8");
				this.#cache.delete(current.file);
		});
	}

	async renameEntry(ref: string, newName: string, options?: WriteOptions): Promise<{ file: string }> {
		const { file } = await this.replaceEntry(ref, { name: newName }, options);
		return { file };
	}

	/** 从磁盘全量重建索引；保留第一条索引行之前的手写块，其余无法识别行丢弃。 */
	async rebuildIndex(options?: WriteOptions): Promise<{ entries: number; headerLines: number }> {
		return this.#pipeline("rebuild", options, async () => {
				await this.#snapshot("index", [INDEX_FILE]);

				const summaries = await this.listEntries();
				const { lines, entries } = parseEntryIndex(await this.readIndex());

				const header = lines.slice(0, entries[0]?.lineNo ?? lines.length);
				while (header.length > 0 && header[header.length - 1].trim() === "") header.pop();
				const effectiveHeader = header.length > 0 ? header : ["# Memory Index", ""];

				const rebuilt = [
					...effectiveHeader,
					...summaries.map((s) => formatIndexLine(s.name, s.file, s.description)),
				];
				await writeFile(this.#indexPath(), rebuilt.length === 0 ? "" : `${rebuilt.join("\n")}\n`, "utf8");
				this.#cache.clear();

				return { entries: summaries.length, headerLines: effectiveHeader.length };
		});
	}
}

function isoDate(date: Date): string {
	return date.toISOString().slice(0, 10);
}
