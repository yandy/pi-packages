import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isEntryType } from "./entry-file";
import { BACKUP_DIR, INDEX_FILE, LOCK_FILE, unlinkStrict, type MemoryStore } from "./memory-store";

/** 迁移完成标记。写在**最后一步** —— 中途失败时它不存在，下次 session_start 会重试（spec §15.4）。 */
export const MIGRATED_FILE = ".migrated";

/** spec §15.3 步骤 1：迁移的整轮锁超时是 30s（要在锁内逐条重写整个目录）。 */
export const MIGRATE_LOCK_TIMEOUT_MS = 30_000;

export interface MigrationResult {
	/** 被拆开并删除的 legacy topic 文件数。 */
	files: number;
	/** 生成的 entry 数。 */
	entries: number;
	/** 回滚点目录（`.backups/migrate-<ts>/`），原 topic 文件另存于其下的 `originals/`。 */
	backupDir: string;
}

interface MigrationMarker extends MigrationResult {
	migratedAt: string;
}

export interface LegacyEntry {
	title: string;
	content: string;
	type: string;
	updated: string;
}

/** CRLF（以及老 Mac 的单独 CR）会让下面每一个正则都失配：`line === "---"` 不成立、
 *  `^## (.+)$` 里的 `.` 不匹配 `\r`。归一只在解析入口做一次。 */
function normalizeEol(raw: string): string {
	return raw.includes("\r") ? raw.replace(/\r\n?/g, "\n") : raw;
}

const FIELD_RE = /^([A-Za-z_][A-Za-z0-9_]*):[ \t]*(.*)$/;

/** 取 frontmatter 的字段表；没有 frontmatter 时返回空对象（不返回 null —— 无 frontmatter 的
 *  legacy 文件同样合法，spec §15.2 的第二个触发条件是「≥2 个 `## ` 段」）。 */
function parseLegacyFrontmatter(text: string): Record<string, string> {
	if (!text.startsWith("---\n")) return {};
	const end = text.indexOf("\n---", 4);
	if (end === -1) return {};
	const fields: Record<string, string> = {};
	for (const line of text.slice(4, end).split("\n")) {
		const m = line.match(FIELD_RE);
		if (m) fields[m[1]] = m[2].trim();
	}
	return fields;
}

/** 按 `## ` 切段（v1 `topic-file.ts#parseEntries` 的算法，逐字迁过来）。 */
function parseLegacySections(text: string): Array<{ title: string; content: string }> {
	const entries: Array<{ title: string; content: string }> = [];
	let currentTitle = "";
	let currentContent: string[] = [];
	let inEntry = false;
	let inFrontmatter = false;

	for (const line of text.split("\n")) {
		if (line === "---") {
			inFrontmatter = !inFrontmatter;
			continue;
		}
		if (inFrontmatter) continue;

		const h2 = line.match(/^## (.+)$/);
		if (h2) {
			if (inEntry) entries.push({ title: currentTitle, content: currentContent.join("\n").trim() });
			currentTitle = h2[1];
			currentContent = [];
			inEntry = true;
			continue;
		}
		if (inEntry) currentContent.push(line);
	}
	if (inEntry) entries.push({ title: currentTitle, content: currentContent.join("\n").trim() });
	return entries;
}

/**
 * 这个文件是不是 v1 的 topic 文件（spec §15.2）？
 *
 * 判据：`MEMORY.md` 之外的 `.md`，且（frontmatter 含旧字段 `updated` **或** 含 ≥2 个 `## ` 段）。
 *
 * **必须先排除含 `modified` 的文件**：v2 的 entry 文件正文里完全可能有多个 `## ` 小标题，
 * 若不排除，一条正常的 v2 记忆会被当成 legacy topic 再拆一次 —— 正文被切碎、原文件被删。
 */
export function isLegacyTopicFile(raw: string): boolean {
	const text = normalizeEol(raw);
	const fields = parseLegacyFrontmatter(text);
	if (fields.modified !== undefined) return false;
	if (fields.updated !== undefined) return true;
	return parseLegacySections(text).length >= 2;
}

/** 拆出 legacy topic 文件里的全部 `## ` 段，并把该文件 frontmatter 的 `type` / `updated` 附到每一段上。 */
export function parseLegacyEntries(raw: string): LegacyEntry[] {
	const text = normalizeEol(raw);
	const fields = parseLegacyFrontmatter(text);
	return parseLegacySections(text).map((section) => ({
		title: section.title,
		content: section.content,
		type: fields.type ?? "",
		updated: fields.updated ?? "",
	}));
}

/**
 * 把 legacy 标题变成合法的 entry `name`。
 *
 * `](` 必须中和：`MemoryStore.#validateName` 会拒绝它（它能伪造索引行的 name/file 分组），
 * 而迁移**不能**因为一条标题里有个 markdown 链接就整轮失败。替换成 `] (` 保住可读性。
 */
function sanitizeName(title: string): string {
	return title.replace(/[\r\n]+/g, " ").replaceAll("](", "] (").trim();
}

/**
 * 给一条 legacy 段落挑一个不与其它记忆冲突的 `name`（spec §15.3 的后缀规则）。
 *
 * 候选按 `base`、`base (2)`、`base (3)`…… 依次探测（`name` 精确匹配，与 store 的语义一致）：
 * - 未被占用 → 采用。
 * - 已被占用，但磁盘上同名条目的正文与这一段相同 → **复用**这个名字：`addEntry` 对同名条目
 *   是幂等覆盖，且保留磁盘上的 `created`。迁移中途失败后重跑时，上一轮已经写成功的条目走的正是
 *   这条路 —— 不会产出 ` (2)` 影子副本（spec §15.4 的重跑安全）。
 * - 已被占用、正文不同 → 试下一个后缀：迁移前就存在的同名用户条目必须被保护。
 */
function pickName(used: Set<string>, bodies: Map<string, string>, base: string, body: string): string {
	const wanted = body.trim();
	let candidate = base;
	for (let n = 2; used.has(candidate) && bodies.get(candidate)?.trim() !== wanted; n++) {
		candidate = `${base} (${n})`;
	}
	return candidate;
}

/** 旧 `updated` 归一为 store 接受的 `YYYY-MM-DD`；解析不出来就用今天（`created` 是必填字段）。 */
function normalizeDate(updated: string, now: Date): string {
	const iso = updated.match(/(\d{4})-(\d{2})-(\d{2})/);
	if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
	const parsed = updated ? new Date(updated) : null;
	if (parsed && !Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
	return now.toISOString().slice(0, 10);
}

async function isFile(path: string): Promise<boolean> {
	return stat(path).then(
		(info) => info.isFile(),
		() => false,
	);
}

/** 只把 ENOENT 当作「文件不在了」；其余读取错误（EISDIR/EACCES/EIO）一律上抛（spec §15.4）。 */
async function readIfExists(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw e;
	}
}

/**
 * 自建回滚点 `.backups/migrate-<ts>/`（spec §15.3 步骤 2）。
 *
 * **不能用 `createSnapshot`**：它恒产出 `<ts>-<label>`，不可能以 `migrate-` 开头，
 * 而 `pruneSnapshots` 只豁免 `migrate-` 前缀 —— 用它建的回滚点会在后续任何一次写入时
 * 被 `snapshotKeep`（默认 5）裁掉，用户就再也回不去了（spec §19 风险表明列了这一条）。
 *
 * 布局：`migrate-<ts>/` = memoryDir 下所有普通文件的副本；`migrate-<ts>/originals/` = 待迁移的
 * topic 文件副本（手工回滚时从这里恢复，见 spec §15.5）。
 */
async function createRollbackPoint(memoryDir: string, legacyFiles: string[], now: Date): Promise<string> {
	const stamp = now.toISOString().replace(/[:.]/g, "-");
	const backupDir = join(memoryDir, BACKUP_DIR, `migrate-${stamp}`);
	await mkdir(join(backupDir, "originals"), { recursive: true });

	// memoryDir 的存在性已在调用前检查过；列表失败（EACCES/EIO）不能吞：那会返回一个只有
	// `originals/` 的不完整回滚点，而它随后就被写进 `.migrated` —— 用户再也回不去（spec §15.4）。
	const entries = await readdir(memoryDir, { withFileTypes: true });
	for (const entry of entries) {
		// 只复制普通文件、跳过锁记录；`.backups` 与 `sessions/` 是目录，天然被排除。
		// `.migrated` 此刻还不存在（它在最后一步才写），所以不需要显式排除。
		if (!entry.isFile() || entry.name === LOCK_FILE) continue;
		await cp(join(memoryDir, entry.name), join(backupDir, entry.name));
	}
	for (const file of legacyFiles) {
		await cp(join(memoryDir, file), join(backupDir, "originals", file));
	}
	return backupDir;
}

async function writeMarker(path: string, marker: MigrationMarker): Promise<void> {
	await writeFile(path, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}

/**
 * 首次 `session_start` 时把 v1 的 topic 布局迁移到 v2 的 per-entry 布局（spec §15 / D10）。
 *
 * 返回 `null` 表示「本次没有迁移任何东西」（已迁移过、目录不存在、或没有 legacy 文件）。
 * 失败时**不写** `.migrated`、保留备份、把错误原样上抛（spec §15.4）：下次 session_start 重试，
 * 而重跑是安全的 —— `addEntry` 对同名条目幂等，且候选名只在「磁盘上同名条目的正文与当前段落不同」
 * 时才追加后缀（正文相同即复用，见 `pickName`）。
 */
export async function migrateIfNeeded(
	store: MemoryStore,
	options?: { now?: Date },
): Promise<MigrationResult | null> {
	const memoryDir = store.cfg.memoryDir;
	const markerPath = join(memoryDir, MIGRATED_FILE);
	if (await isFile(markerPath)) return null;

	// 目录还不存在：没有 legacy 数据，也不在这里替 store 建目录（首次写入时它自己会建）。
	const names = await readdir(memoryDir).catch(() => null);
	if (names === null) return null;

	const now = options?.now ?? new Date();
	const nothing: MigrationMarker = { migratedAt: now.toISOString(), entries: 0, files: 0, backupDir: "" };

	// 触发条件之一是「MEMORY.md 存在」（spec §15.2）。不存在就没有旧索引可迁，写标记以免每次
	// session_start 都全目录 readFile。
	if (!names.includes(INDEX_FILE)) {
		await writeMarker(markerPath, nothing);
		return null;
	}

	const candidates = names
		.filter((n) => n.endsWith(".md") && n !== INDEX_FILE && !n.startsWith("."))
		.sort();
	const legacyFiles: string[] = [];
	for (const file of candidates) {
		// 只容忍 ENOENT（readdir 与 read 之间文件消失 → 当作非 legacy）。EISDIR/EACCES/EIO 必须上抛：
		// 把不可读的候选归为「非 legacy」会在它是唯一候选时写下 0/0 标记，重试永久不再发生（spec §15.4）。
		const raw = await readIfExists(join(memoryDir, file));
		if (raw !== null && isLegacyTopicFile(raw)) legacyFiles.push(file);
	}
	if (legacyFiles.length === 0) {
		await writeMarker(markerPath, nothing);
		return null;
	}

	return store.withLogicalLock(async () => {
		const backupDir = await createRollbackPoint(memoryDir, legacyFiles, now);

		// `name` 唯一性集合的初值来自磁盘：这让「迁移中途失败后重跑」不会产出 ` (2)` 影子副本 ——
		// 上一轮已经写成功的条目会在 listEntries 里，正文与当前段落相同的候选会被复用（addEntry 幂等）。
		const summaries = await store.listEntries();
		const usedNames = new Set(summaries.map((summary) => summary.name));
		// 候选探测还需要「同名的正文」：只从这次已经扫描到的 entries 里读一遍建成 Map，避免在候选
		// 循环里反复扫目录。同名但正文不同的条目（迁移前就存在的用户记忆）因此会在它旁边加后缀。
		const bodies = new Map<string, string>();
		for (const summary of summaries) {
			const entry = await store.readEntry(summary.file);
			if (entry) bodies.set(entry.name, entry.body);
		}
		let entries = 0;

		for (const file of legacyFiles) {
			const raw = await readFile(join(memoryDir, file), "utf8");
			for (const legacy of parseLegacyEntries(raw)) {
				const name = pickName(usedNames, bodies, sanitizeName(legacy.title), legacy.content);
				// 空标题或空正文的段落不生成 entry：store 会拒绝（"name is required" / "body is required"），
				// 而让整轮迁移因为一个空 `## ` 段失败是更差的取舍。原文件在 originals/ 里，信息没有丢。
				if (!name || !legacy.content) continue;
				usedNames.add(name);
				await store.addEntry(
					{
						name,
						description: name,
						type: isEntryType(legacy.type) ? legacy.type : "feedback",
						body: legacy.content,
						created: normalizeDate(legacy.updated, now),
					},
					{ skipLogicalLock: true, skipSnapshot: true },
				);
				entries++;
			}
		}

		await store.rebuildIndex({ skipLogicalLock: true, skipSnapshot: true });

		// 原 topic 文件从 memory 目录移除，否则 rebuildIndex 之后它们还会作为「无法解析的 .md」
		// 留在目录里（spec §15.3 步骤 5）。它们已经保留在 migrate-<ts>/originals/。
		// 删除失败必须上抛（只有 ENOENT 视为已删除）：吞掉的话 `.migrated` 会在文件仍留在目录里的
		// 情况下被写下，重试永久不再发生（spec §15.4）。
		for (const file of legacyFiles) {
			await unlinkStrict(join(memoryDir, file));
		}

		await writeMarker(markerPath, { migratedAt: now.toISOString(), entries, files: legacyFiles.length, backupDir });
		return { files: legacyFiles.length, entries, backupDir };
	}, MIGRATE_LOCK_TIMEOUT_MS);
}
