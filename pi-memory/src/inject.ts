import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { runHeadlessAgent } from "./agent-runner";
import type { SessionPersistenceConfig, ThinkLevel } from "./config";
import type { EntryType } from "./entry-file";
import { MEMORY_INDEX_SECTION } from "./index-source";
import type { MemoryStore } from "./memory-store";
import { sanitizeForInjection } from "./sanitize";

/**
 * 注入用的「按行 + 按字节」截断。原本住在 `index-file.ts`（topic 模型的索引层），
 * 但它的两个消费者都在本文件里（索引快照 + entry 正文），因此随 v2 迁到此处，行为逐字不变。
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
		let cut = out;
		while (Buffer.byteLength(cut, "utf8") > maxBytes && cut.length > 0) cut = cut.slice(0, -1);
		out = cut;
		truncated = true;
	}
	if (truncated) out += `\n[truncated: memory index exceeds injection limit]`;
	return { ok: !truncated, content: out, truncated };
}

export function buildInjection(systemPrompt: string, snapshot: string): string {
	if (!snapshot) return systemPrompt;
	return `${systemPrompt}\n\n${snapshot}`;
}

/**
 * `memory_index` section 的值（spec §9.1 / D13）：读索引 → 截断 → 净化。
 *
 * **不再自己加 `# Memory Index\n` 前缀**：v1 的索引快照函数会补一份头部，而 v2 的
 * `MEMORY.md` 由 `rebuildIndex`（默认头部就是 `# Memory Index`）与迁移写入 —— 再补一次
 * 注入文本里就有两份标题。
 *
 * 空索引返回 `""`（调用方仍要把 `""` 无条件写进 sections，见 `applyIndexSection`）。
 *
 * **顺序是「先截断、后净化」，刻意如此**（Plan C 终审 #6 的决策：保留现状）。注入预算是
 * **软**约束，而反过来（先净化后截断）会在字节上限处切出半个 HTML entity（`…&l`）——
 * 那才是真正会让模型读错的破损。代价：`<` → `&lt;` 会让净化后的字节数略超 `maxBytes`
 * （索引正文里尖括号极少，实际放大可忽略）。`injectSurfacedContent` 同理。
 */
export async function buildIndexSection(store: MemoryStore, maxLines: number, maxBytes: number): Promise<string> {
	const raw = await store.readIndex();
	const { content } = truncateForInjection(raw, maxLines, maxBytes);
	return sanitizeForInjection(content);
}

/**
 * 把冻结的索引值写进 `event.systemPromptOptions.sections`（就地修改这个可变对象）。
 *
 * 返回 `false` 表示宿主 SDK 太旧、没有 `sections`（本地类型是 0.80.2），调用方必须回退
 * `{ systemPrompt: buildInjection(…) }`（spec §19 的退路：功能不受损，只是缓存变差）。
 *
 * **无条件设置**，哪怕值是 `""`：省略这个键等于告诉 pi「该 section 不应存在」，
 * `diffSystemPromptSections` 会生成 `{ memory_index: null }`，索引被从 system prompt 里
 * **静默删除**（spec §9.1 的 null 陷阱）。「不想改」只能靠喂回逐字节相同的值实现。
 */
export function applyIndexSection(systemPromptOptions: unknown, value: string): boolean {
	const options = systemPromptOptions as { sections?: unknown } | null | undefined;
	const sections = options?.sections;
	if (typeof sections !== "object" || sections === null) return false;
	(sections as Record<string, string | null>)[MEMORY_INDEX_SECTION] = value;
	return true;
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
 * 从 store 取清单。**不逐文件 readFile** —— mtime 缓存由 store 持有（spec §9.2），
 * 于是每轮只付一次 `readdir` + 每文件一次 `stat`，而不是最多 200 次 `readFile`。
 *
 * 排序为 `modified` **降序**：新记忆优先给侧查询看（`listEntries` 是升序，这里翻过来），
 * 然后截到 `SIDE_QUERY_MAX_ENTRIES`（Finding I2）。
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

export async function injectSurfacedContent(
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
		// spec §13：正文与 name 都要净化（用户/模型写进磁盘的内容可能含 `</relevant_memories>`
		// 之类的仿冒标签）。包裹标签是我们自己生成的，不净化。
		// 先截断后净化的取舍见 `buildIndexSection` 的注释（Plan C 终审 #6：预算是软约束，
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
	// `Math.max(1, …)`：空清单不会走到这里（runSideQuery 先返回 []），但除零会得到 Infinity。
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

/** Parse selected_files JSON from headless agent response. */
function parseSelectedFiles(result: string, candidates: EntryManifest[], maxFiles: number): string[] {
	try {
		const jsonMatch = result.match(/\{[^}]*"selected_files"[^}]*\}/s);
		if (!jsonMatch) return [];
		const parsed = JSON.parse(jsonMatch[0]);
		const files: string[] = parsed.selected_files ?? [];
		return files.filter((f: string) => candidates.some((c) => c.file === f)).slice(0, maxFiles);
	} catch {
		return [];
	}
}

/** Run a lightweight headless side-query to select relevant entry files.
 *  Returns [] on timeout/failure — no fallback. */
export async function runSideQuery(
	manifest: EntryManifest[],
	userPrompt: string,
	injectedFiles: Set<string>,
	maxFiles: number,
	thinkLevel: ThinkLevel,
	model: string | undefined,
	modelRegistry: ModelRegistry,
	parentModel: Model<any> | undefined,
	memoryDir: string,
	sessionPersistence?: SessionPersistenceConfig,
): Promise<string[]> {
	const candidates = manifest.filter((entry) => !injectedFiles.has(entry.file));
	if (candidates.length === 0) return [];
	const task = buildSideQueryTask(candidates, userPrompt, maxFiles);
	try {
		const result = await runHeadlessAgent({
			task,
			cwd: memoryDir,
			modelRegistry,
			model,
			parentModel,
			thinkLevel,
			maxTurns: 1,
			timeoutMs: 30_000,
			// 侧查询没有任何 customTools，零工具就是意图：tools: []（白名单）把 builtin 也关掉。
			// 若以后要给它加 customTools，必须改成 noTools: "builtin"（见 agent-runner.ts 的警告）。
			tools: [],
			sessionPersistence,
		});
		return parseSelectedFiles(result, candidates, maxFiles);
	} catch {
		return [];
	}
}
