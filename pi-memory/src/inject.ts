import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { runHeadlessAgent } from "./agent-runner";
import type { SessionPersistenceConfig, ThinkLevel } from "./config";
import type { EntryType } from "./entry-file";
import type { MemoryStore } from "./memory-store";

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

export async function loadIndexSnapshot(memoryDir: string, maxLines: number, maxBytes: number): Promise<string> {
	try {
		const raw = await readFile(join(memoryDir, "MEMORY.md"), "utf8");
		const { content } = truncateForInjection(raw, maxLines, maxBytes);
		return content ? `# Memory Index\n${content}` : "";
	} catch {
		return "";
	}
}

export function buildInjection(systemPrompt: string, snapshot: string): string {
	if (!snapshot) return systemPrompt;
	return `${systemPrompt}\n\n${snapshot}`;
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
 * 从 store 取清单。**不逐文件 readFile** —— mtime 缓存由 store 持有（spec §9.2），
 * 于是每轮只付一次 `readdir` + 每文件一次 `stat`，而不是最多 200 次 `readFile`。
 *
 * 排序为 `modified` **降序**：新记忆优先给侧查询看（`listEntries` 是升序，这里翻过来）。
 */
export async function scanEntries(store: MemoryStore): Promise<EntryManifest[]> {
	const summaries = await store.listEntries();
	return summaries
		.map((s) => ({ file: s.file, name: s.name, description: s.description, type: s.type, modified: s.modified }))
		.sort((a, b) =>
			a.modified === b.modified ? a.file.localeCompare(b.file) : b.modified.localeCompare(a.modified),
		);
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
		const block = `## ${entry.name}\n${content}`;
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
			tools: [],
			sessionPersistence,
		});
		return parseSelectedFiles(result, candidates, maxFiles);
	} catch {
		return [];
	}
}
