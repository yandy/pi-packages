import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { parseIndex, serializeIndex, upsertEntry, checkCapacity, type IndexEntry } from "./index-file";
import { buildFrontmatter, appendContent, isEmptyAfterRemove } from "./topic-file";
import { safeTopicPath } from "./paths";

export interface AddParams { content: string; topic: string; title?: string; description?: string; maxLines: number; maxBytes: number; }
export interface ReplaceParams { old_text: string; content: string; topic?: string; }
export interface RemoveParams { old_text: string; topic?: string; }
export interface ActionResult { ok: boolean; error?: string; entries?: IndexEntry[]; }

const MEMORY_MD = "MEMORY.md";

async function readIndex(memoryDir: string): Promise<IndexEntry[]> {
	try {
		const raw = await readFile(join(memoryDir, MEMORY_MD), "utf8");
		return parseIndex(raw).entries;
	} catch {
		return [];
	}
}

function slug(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "memory";
}

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

export async function doAdd(memoryDir: string, p: AddParams): Promise<ActionResult> {
	let topicPath: string;
	try {
		topicPath = safeTopicPath(memoryDir, p.topic);
	} catch (e: any) {
		return { ok: false, error: e.message };
	}
	return withFileMutationQueue(topicPath, async () => {
		await mkdir(memoryDir, { recursive: true });
		const entries = await readIndex(memoryDir);
		const title = p.title ?? p.topic.replace(/\.md$/i, "");
		const description = p.description ?? p.content.split("\n")[0].slice(0, 80);
		const next = upsertEntry(entries, { title, topic: p.topic, description, raw: "" });
		if (!checkCapacity(next, p.maxLines, p.maxBytes)) {
			return { ok: false, error: `MEMORY.md capacity exceeded (max ${p.maxLines} lines / ${p.maxBytes} bytes). Current entries: ${serializeIndex(entries)}` };
		}
		// write topic file
		let existing: string | null = null;
		try { existing = await readFile(topicPath, "utf8"); } catch { existing = null; }
		const isNew = !existing;
		const out = isNew
			? `${buildFrontmatter({ name: slug(title), description, type: "project", updated: today() })}${appendContent(null, title, p.content)}`
			: appendContent(existing, title, p.content);
		await writeFile(topicPath, out, "utf8");
		// write index
		await writeFile(join(memoryDir, MEMORY_MD), serializeIndex(next) + "\n", "utf8");
		return { ok: true, entries: next };
	});
}

interface MatchSite { file: string; type: "index" | "topic"; }

async function findMatches(memoryDir: string, old_text: string, topic?: string): Promise<MatchSite[]> {
	const sites: MatchSite[] = [];
	// index
	const idxRaw = await readFile(join(memoryDir, MEMORY_MD), "utf8").catch(() => "");
	if (idxRaw.includes(old_text)) sites.push({ file: MEMORY_MD, type: "index" });
	// topics
	const files = topic ? [topic] : (await readdir(memoryDir).catch(() => [])).filter((f) => f.endsWith(".md") && f !== MEMORY_MD);
	for (const f of files) {
		const c = await readFile(join(memoryDir, f), "utf8").catch(() => "");
		if (c.includes(old_text)) sites.push({ file: f, type: "topic" });
	}
	return sites;
}

export async function doReplace(memoryDir: string, p: ReplaceParams): Promise<ActionResult> {
	const sites = await findMatches(memoryDir, p.old_text, p.topic);
	if (sites.length === 0) return { ok: false, error: `No match for old_text` };
	if (sites.length > 1) return { ok: false, error: `Multiple matches (${sites.length}); specify topic. Sites: ${sites.map((s) => s.file).join(", ")}` };
	const site = sites[0];
	const filePath = join(memoryDir, site.file);
	return withFileMutationQueue(filePath, async () => {
		const raw = await readFile(filePath, "utf8");
		const next = raw.replace(p.old_text, p.content);
		await writeFile(filePath, next, "utf8");
		return { ok: true };
	});
}

export async function doRemove(memoryDir: string, p: RemoveParams): Promise<ActionResult> {
	// When no topic is specified, search only the index (doRemove semantics:
	// removing an entry from MEMORY.md). When topic is given, search in
	// that topic file plus the index.
	let sites: MatchSite[];
	if (p.topic) {
		sites = await findMatches(memoryDir, p.old_text, p.topic);
	} else {
		const idxRaw = await readFile(join(memoryDir, MEMORY_MD), "utf8").catch(() => "");
		sites = idxRaw.includes(p.old_text) ? [{ file: MEMORY_MD, type: "index" }] : [];
	}
	if (sites.length === 0) return { ok: false, error: `No match for old_text` };
	if (sites.length > 1) return { ok: false, error: `Multiple matches (${sites.length}); specify topic. Sites: ${sites.map((s) => s.file).join(", ")}` };
	const site = sites[0];
	const filePath = join(memoryDir, site.file);
	return withFileMutationQueue(filePath, async () => {
		if (site.type === "index") {
			const raw = await readFile(filePath, "utf8");
			const lines = raw.split("\n").filter((l) => !l.includes(p.old_text));
			await writeFile(filePath, lines.join("\n").replace(/\n{3,}/g, "\n\n"), "utf8");
		} else {
			const raw = await readFile(filePath, "utf8");
			const next = raw.replace(p.old_text, "");
			if (isEmptyAfterRemove(next)) {
				await unlink(filePath).catch(() => {});
				// also drop its index line
				const idxRaw = await readFile(join(memoryDir, MEMORY_MD), "utf8").catch(() => "");
				if (idxRaw) {
					const lines = idxRaw.split("\n").filter((l) => !l.includes(`](${site.file})`));
					await writeFile(join(memoryDir, MEMORY_MD), lines.join("\n"), "utf8");
				}
			} else {
				await writeFile(filePath, next, "utf8");
			}
		}
		return { ok: true };
	});
}

// search memory scope — implemented fully in Task 9
export async function searchMemory(memoryDir: string, query: string): Promise<string> {
	const files = (await readdir(memoryDir).catch(() => [])).filter((f) => f.endsWith(".md"));
	const q = query.toLowerCase();
	const hits: string[] = [];
	for (const f of files) {
		const lines = (await readFile(join(memoryDir, f), "utf8").catch(() => "")).split("\n");
		for (const [i, line] of lines.entries()) {
			if (line.toLowerCase().includes(q)) {
				const ctx = lines.slice(Math.max(0, i - 2), i + 3).join("\n");
				hits.push(`### ${f}\n\`\`\`\n${ctx}\n\`\`\``);
			}
		}
	}
	return hits.length ? hits.join("\n\n") : "No matches in memory.";
}
