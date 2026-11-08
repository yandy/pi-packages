import type { EntryType } from "./store/entry-file.js";
import { splitLines } from "./store/entry-index.js";
import type { MemoryStore } from "./store/memory-store.js";
import { sanitizeForInjection } from "./store/sanitize.js";

/**
 * entry 正文的截断标记。与 `INDEX_TRUNCATION_MARKER` **刻意分开**：这里截的是
 * `<relevant_memories>` 里的一条正文，说「memory index」会指错对象。
 */
export const ENTRY_TRUNCATION_MARKER = "[truncated: memory entry exceeds injection limit]";

/**
 * entry 正文用的「按行 + 按字节」截断：**保留开头**，从尾部削。
 *
 * 索引不进这里 —— 它的窗口取**最新**的一段（`truncateIndexForInjection`），方向正好相反：
 * 一起用会让窗口永远只保留最旧的记忆。
 */
export function truncateForInjection(
	content: string,
	maxLines: number,
	maxBytes: number,
): { ok: boolean; content: string; truncated: boolean } {
	const lines = content.split("\n");
	let out = content;
	let truncated = false;
	if (lines.length > maxLines) {
		out = lines.slice(0, maxLines).join("\n");
		truncated = true;
	}
	if (Buffer.byteLength(out, "utf8") > maxBytes) {
		out = cutToBytes(out, maxBytes);
		truncated = true;
	}
	if (truncated) out += `\n${ENTRY_TRUNCATION_MARKER}`;
	return { ok: !truncated, content: out, truncated };
}

/**
 * 按字符从尾部削到字节上限。
 *
 * 顺手丢掉被切一半的代理对：孤立高代理是**无效 UTF-16**，任何编码器都会把它变成 U+FFFD ——
 * 宁可少一个字符，也不要给模型塞一个替换字符。
 */
function cutToBytes(text: string, maxBytes: number): string {
	let cut = text;
	while (Buffer.byteLength(cut, "utf8") > maxBytes && cut.length > 0) cut = cut.slice(0, -1);
	const last = cut.charCodeAt(cut.length - 1);
	return cut.length > 0 && last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * 注入截断标记。放在窗口**开头**：索引是纯时间序，被丢掉的永远是**最旧**的行 ——
 * 标记若追加在末尾，读起来像「这条之后的都被切了」，而事实恰好相反。
 */
export const INDEX_TRUNCATION_MARKER = "[truncated: memory index exceeds injection limit; older entries omitted]";

/**
 * 索引文本 → 窗口用的行数组。
 *
 * 行拆分**共用 `entry-index` 的 `splitLines`**（先做行尾归一）：宿主状态命令报的 `Index:` 与
 * `Inject:` 必须活在同一个「行」的定义上，否则 CRLF / 单独 CR 的文件上两行行数会互相矛盾。
 * 额外摘掉**尾部全部空行**：`rebuildIndex` 把它们当噪音，但它们照样白吃窗口行数。
 */
function indexWindowLines(content: string): string[] {
	const lines = splitLines(content);
	while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
	return lines;
}

interface IndexWindow {
	/** 窗口内的行，保持文件原顺序（旧 → 新）。 */
	lines: string[];
	/** 窗口的字节数（行间换行算在内；标记与末尾换行不算）。 */
	byteLength: number;
	/** 是否有行被丢弃（含「只保留了最新一行的字节前缀」这种退化）。 */
	truncated: boolean;
}

/** 从尾部（最新）向头部累积，直到行数或字节数触顶。`truncateIndexForInjection` 与
 *  `indexInjectionCapacity` 共用它 —— 两处口径不可能漂移。 */
function indexWindow(lines: string[], maxLines: number, maxBytes: number): IndexWindow {
	const kept: string[] = [];
	let byteLength = 0;
	let degenerated = false;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		const lineBytes = Buffer.byteLength(line, "utf8");
		const cost = kept.length === 0 ? lineBytes : lineBytes + 1;
		if (kept.length >= maxLines || byteLength + cost > maxBytes) break;
		kept.unshift(line);
		byteLength += cost;
	}
	if (kept.length === 0 && lines.length > 0 && maxLines > 0 && maxBytes > 0) {
		// 退化：最新一行自身就超预算 —— 保留它的字节前缀。空 section 比截断的一行更糟：
		// 模型连「这里本来有索引」都看不到。两个非正守卫是内部防御（调用方已先挡掉非正预算）。
		const prefix = cutToBytes(lines[lines.length - 1], maxBytes);
		kept.push(prefix);
		byteLength = Buffer.byteLength(prefix, "utf8");
		// 行数没变（1 → 1），但内容确实被削过：必须算截断，否则 `truncateIndexForInjection`
		// 会以为「没丢行」而返回未截断的原文，标记也不出现。
		degenerated = true;
	}
	return { lines: kept, byteLength, truncated: degenerated || kept.length < lines.length };
}

/** 行数组 → 注入文本（行间与末尾都是 LF）；空窗口不补换行，只留标记。 */
function joinWindowLines(lines: string[]): string {
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/**
 * 索引的注入窗口：保留**最新**的 maxLines 行 / maxBytes 字节。
 *
 * - 窗口内保持文件原顺序（旧 → 新），**不反转**：形如「索引末尾的一段连续片段」；
 * - 超出字节预算时继续丢窗口内**最旧**的一端；
 * - 截断时在开头加 `INDEX_TRUNCATION_MARKER`；
 * - 未超预算时**逐字节返回原文**（空索引也是）—— 小索引的注入值与改动前完全一致，
 *   会话内冻结的值也不会因为这次改动而漂移；唯一的例外是 CRLF / 单独 CR 的文件：行拆分
 *   先做归一，这时返回的是 LF 文本（`\r` 不进 system prompt）。
 * - 预算非正（`memIndexInjectMaxLines/Bytes` 写 0）= **不注入**：返回空值而不是裸标记 ——
 *   标记的含义是「索引被截断了」，与「按配置不注入」对模型的含义完全不同。
 */
export function truncateIndexForInjection(
	content: string,
	maxLines: number,
	maxBytes: number,
): { ok: boolean; content: string; truncated: boolean } {
	if (maxLines <= 0 || maxBytes <= 0) return { ok: true, content: "", truncated: false };

	const window = indexWindow(indexWindowLines(content), maxLines, maxBytes);
	if (!window.truncated) {
		return { ok: true, content: content.includes("\r") ? joinWindowLines(window.lines) : content, truncated: false };
	}
	return { ok: false, content: `${INDEX_TRUNCATION_MARKER}\n${joinWindowLines(window.lines)}`, truncated: true };
}

/**
 * 注入侧的容量口径（供宿主的状态命令使用）。复用 `indexWindow`，所以报出来的数字与实际注入的值不可能不一致。
 *
 * 口径：行数 = 窗口内的索引行（**不含**截断标记那一行）；字节数 = 窗口正文的 UTF-8 字节
 * （行间换行与末尾换行算在内，**不含**截断标记）。未截断且文件是 LF 时，它与 `Index:`
 * （写入口径，同样用 `splitLines`）对同一份文件报的字节数相同；真实 section 在截断时还多
 * 出「标记 + 一个换行」。
 */
export function indexInjectionCapacity(
	content: string,
	maxLines: number,
	maxBytes: number,
): { lineCount: number; byteLength: number; truncated: boolean } {
	if (maxLines <= 0 || maxBytes <= 0) return { lineCount: 0, byteLength: 0, truncated: false };

	const window = indexWindow(indexWindowLines(content), maxLines, maxBytes);
	return {
		lineCount: window.lines.length,
		byteLength: window.lines.length > 0 ? window.byteLength + 1 : 0,
		truncated: window.truncated,
	};
}

/**
 * 注入用的索引值：读索引 → 截断 → 净化。
 *
 * **不再自己加 `# Memory Index\n` 前缀**：v1 的索引快照函数会补一份头部，而 v2 的
 * `MEMORY.md` 由 `rebuildIndex`（默认头部就是 `# Memory Index`）写入 —— 再补一次
 * 注入文本里就有两份标题。
 *
 * 空索引返回 `""`，而调用方仍要把这个 `""` **无条件**写进宿主的 section：省略该键通常等于
 * 告诉宿主「这个 section 不该存在」，索引会被从 system prompt 里静默删除。
 *
 * **顺序是「先截断、后净化」，刻意如此**。注入预算是
 * **软**约束，而反过来（先净化后截断）会在字节上限处切出半个 HTML entity（`…&l`）——
 * 那才是真正会让模型读错的破损。代价：`<` → `&lt;` 会让净化后的字节数略超 `maxBytes`
 * （索引正文里尖括号极少，实际放大可忽略）。`renderSurfacedBlock` 同理。
 */
export async function buildIndexSection(store: MemoryStore, maxLines: number, maxBytes: number): Promise<string> {
	const raw = await store.readIndex();
	const { content } = truncateIndexForInjection(raw, maxLines, maxBytes);
	return sanitizeForInjection(content);
}

/** 侧查询清单的一行 = 一条 entry（v1 是一个 topic 文件）。 */
export interface EntryManifest {
	file: string;
	name: string;
	description: string;
	type: EntryType;
	modified: string;
}

/** 清单总预算（字符）。v1 把每条 description 硬切成 80 字符，v2 改为按清单长度均分。 */
export const SIDE_QUERY_MANIFEST_CHARS = 4000;
/** 均分的下限：清单再长，每条也至少留 80 字符，否则侧查询没有判别依据。 */
export const SIDE_QUERY_MIN_DESC_CHARS = 80;
/**
 * 清单条数上限。恢复了 v1 的界：v1 的候选集合就是 MEMORY.md 索引本身，而索引有
 * `memIndexMaxLines`（默认 200）行上限，所以侧查询看到的条目天然有界。v2 改成扫描目录后
 * 清单会随目录无限增长，而 `buildSideQueryTask` 每行都要带 description —— 不封顶会把 prompt
 * 和每轮迭代开销一起拉爆。200 与索引上限同量级。
 */
export const SIDE_QUERY_MAX_ENTRIES = 200;

/**
 * 从 store 取清单。**不逐文件 readFile** —— mtime 缓存由 store 持有，
 * 于是每轮只付一次 `readdir` + 每文件一次 `stat`，而不是最多 200 次 `readFile`。
 *
 * 排序为 `modified` **降序**：新记忆优先给侧查询看（`listEntries` 是升序，这里翻过来），
 * 然后截到 `SIDE_QUERY_MAX_ENTRIES`：清单会随目录无限增长，而每行都要带 description，
 * 不封顶会把 prompt 和每轮迭代开销一起拉爆。
 */
export async function scanEntries(store: MemoryStore): Promise<EntryManifest[]> {
	const summaries = await store.listEntries();
	return summaries
		.map((s) => ({ file: s.file, name: s.name, description: s.description, type: s.type, modified: s.modified }))
		.sort((a, b) =>
			a.modified === b.modified ? a.file.localeCompare(b.file) : b.modified.localeCompare(a.modified),
		)
		.slice(0, SIDE_QUERY_MAX_ENTRIES);
}

export async function renderSurfacedBlock(
	store: MemoryStore,
	selectedFiles: string[],
	maxEntryBytes: number,
	maxInjectionBytes: number,
): Promise<string> {
	const blocks: string[] = [];
	let totalBytes = 0;

	for (const file of selectedFiles) {
		// 经 store 读：v2 的注入单位是 entry 的**正文**，不是整个文件（frontmatter 不进上下文）。
		const entry = await store.readEntry(file);
		if (!entry) continue;
		const { content } = truncateForInjection(entry.body, 999999, maxEntryBytes);
		// 正文与 name 都要净化（用户/模型写进磁盘的内容可能含 `</relevant_memories>`
		// 之类的仿冒标签）。包裹标签是我们自己生成的，不净化。
		// 先截断后净化的取舍见 `buildIndexSection` 的注释（预算是软约束，
		// 而「净化后截断」会切出半个 entity）。
		const block = `## ${sanitizeForInjection(entry.name)}\n${sanitizeForInjection(content)}`;
		const blockBytes = Buffer.byteLength(block, "utf8");
		if (totalBytes + blockBytes > maxInjectionBytes) break;
		blocks.push(block);
		totalBytes += blockBytes;
	}

	if (blocks.length === 0) return "";
	return `<relevant_memories>\n${blocks.join("\n\n")}\n</relevant_memories>`;
}

/** Build the side-query task prompt. */
export function buildSideQueryTask(manifest: EntryManifest[], userPrompt: string, maxFiles: number): string {
	// `Math.max(1, …)`：空清单不会走到这里（侧查询先返回 []），但除零会得到 Infinity。
	const perEntry = Math.max(
		SIDE_QUERY_MIN_DESC_CHARS,
		Math.floor(SIDE_QUERY_MANIFEST_CHARS / Math.max(1, manifest.length)),
	);
	const lines = manifest.map((e) => `[${e.type}] ${e.file} — ${e.description.slice(0, perEntry)}`);

	return [
		`You are a memory relevance selector. Select up to ${maxFiles} memory files most relevant to the user query.`,
		"If nothing matches, select none.",
		"",
		"=== Memory Files ===",
		...lines,
		"",
		"=== User Query ===",
		userPrompt,
		"",
		'Respond with ONLY a JSON object: {"selected_files": ["filename.md", ...]}',
	].join("\n");
}
