import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { parseIndex, serializeIndex, addEntry, removeEntryByTitle, matchEntryByTitle, checkCapacity, type IndexEntry } from "./index-file";
import { buildFrontmatter, appendContent, updateFrontmatterDate, removeEntrySection, hasEntries, parseEntries } from "./topic-file";
import { safeTopicPath } from "./paths";

export interface AddParams { content: string; topic: string; title: string; maxLines: number; maxBytes: number; }
export interface RemoveParams { entry: string; }
export interface ReadParams { topic?: string; entry?: string; }
export interface ReadResult { ok: boolean; error?: string; content?: string; }
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

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

export async function doAdd(memoryDir: string, p: AddParams): Promise<ActionResult> {
	if (!p.title) return { ok: false, error: "title is required" };
	let topicPath: string;
	try {
		topicPath = safeTopicPath(memoryDir, p.topic);
	} catch (e: any) {
		return { ok: false, error: e.message };
	}
	return withFileMutationQueue(join(memoryDir, MEMORY_MD), async () => {
		await mkdir(dirname(topicPath), { recursive: true });
		const entries = await readIndex(memoryDir);
		const next = addEntry(entries, { title: p.title, topic: p.topic, raw: "" });
		if (!checkCapacity(next, p.maxLines, p.maxBytes)) {
			return {
				ok: false,
				error: `MEMORY.md capacity exceeded (max ${p.maxLines} lines / ${p.maxBytes} bytes). Current entries: ${serializeIndex(entries)}`,
			};
		}
		// write topic file
		let existing: string | null = null;
		try { existing = await readFile(topicPath, "utf8"); } catch { existing = null; }
		if (!existing) {
			const out = `${buildFrontmatter({ updated: today() })}${appendContent(null, p.title, p.content)}`;
			await writeFile(topicPath, out, "utf8");
		} else {
			const updated = updateFrontmatterDate(existing, today());
			const out = appendContent(updated, p.title, p.content);
			await writeFile(topicPath, out, "utf8");
		}
		// write index
		await writeFile(join(memoryDir, MEMORY_MD), serializeIndex(next) + "\n", "utf8");
		return { ok: true, entries: next };
	});
}

export async function doRemove(memoryDir: string, p: RemoveParams): Promise<ActionResult> {
	return withFileMutationQueue(join(memoryDir, MEMORY_MD), async () => {
		const entries = await readIndex(memoryDir);
		const match = matchEntryByTitle(entries, p.entry);
		if (!match.entry) {
			return { ok: false, error: `Entry "${p.entry}" not found in index` };
		}
		if (!match.unique) {
			const matchingTopics = entries
				.filter((e) => e.title === p.entry)
				.map((e) => e.topic)
				.join(", ");
			return { ok: false, error: `Multiple matches for entry "${p.entry}" in topics: ${matchingTopics}` };
		}

		const topicFile = match.entry.topic;
		const topicPath = safeTopicPath(memoryDir, topicFile);

		// remove index line
		const updated = removeEntryByTitle(entries, p.entry);
		await writeFile(join(memoryDir, MEMORY_MD), serializeIndex(updated) + "\n", "utf8");

		// remove ## block from topic file
		try {
			const raw = await readFile(topicPath, "utf8");
			const afterRemoval = removeEntrySection(raw, p.entry);
			if (hasEntries(afterRemoval)) {
				const refreshed = updateFrontmatterDate(afterRemoval, today());
				await writeFile(topicPath, refreshed, "utf8");
			} else {
				await unlink(topicPath).catch(() => {});
			}
		} catch (e: any) {
			// topic file missing — still ok, index already removed
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		}

		return { ok: true };
	});
}

export async function doRead(memoryDir: string, p: ReadParams): Promise<ReadResult> {
	if (p.topic) {
		const topicName = p.topic.endsWith(".md") ? p.topic : `${p.topic}.md`;
		let topicPath: string;
		try {
			topicPath = safeTopicPath(memoryDir, topicName);
		} catch (e: any) {
			return { ok: false, error: e.message };
		}
		try {
			const content = await readFile(topicPath, "utf8");
			return { ok: true, content };
		} catch {
			return { ok: false, error: `Topic "${p.topic}" not found` };
		}
	}
	if (p.entry) {
		const files = (await readdir(memoryDir).catch(() => [])).filter(
			(f) => f.endsWith(".md") && f !== MEMORY_MD,
		);
		for (const f of files) {
			const raw = await readFile(join(memoryDir, f), "utf8").catch(() => "");
			const entries = parseEntries(raw);
			const found = entries.find((e) => e.title === p.entry);
			if (found) {
				return { ok: true, content: `## ${found.title}\n\n${found.content}` };
			}
		}
		return { ok: false, error: `Entry "${p.entry}" not found in any topic` };
	}
	return { ok: false, error: "Either topic or entry must be provided" };
}

export async function searchMemory(memoryDir: string, query: string): Promise<string> {
	const files = (await readdir(memoryDir).catch(() => [])).filter((f) => f.endsWith(".md") && f !== MEMORY_MD);
	const q = query.toLowerCase();
	const hits: string[] = [];
	for (const f of files) {
		const raw = await readFile(join(memoryDir, f), "utf8").catch(() => "");
		const entryBlocks = parseEntries(raw);
		for (const entry of entryBlocks) {
			if (entry.content.toLowerCase().includes(q) || entry.title.toLowerCase().includes(q)) {
				hits.push(`### ${f}\n\`\`\`\n## ${entry.title}\n${entry.content}\n\`\`\``);
			}
		}
	}
	return hits.length ? hits.join("\n\n") : "No matches in memory.";
}

export interface MemoryToolDeps {
	getMemoryDir: () => string | null;
	getConfig: () => { memIndexMaxLines: number; memIndexMaxBytes: number; sessionSearch: { maxSessions: number; maxMatches: number } };
	getEnabled: () => boolean;
	searchSessions: (cwd: string, query: string, cfg: { maxSessions: number; maxMatches: number }) => Promise<string>;
	cwd: () => string;
}

export function createMemoryTool(deps: MemoryToolDeps) {
	return {
		name: "memory",
		label: "Memory",
		description:
			"Read/write project memory across sessions. action 'add' appends content under a topic (auto-created) as an entry; 'remove' deletes an entry by title; 'read' loads a topic or entry; 'search' queries memory files or history sessions.",
		promptSnippet: "Read/write project memory across sessions (add/remove/search/read).",
		promptGuidelines: [
			"Use memory to persist project facts, user preferences, and lessons learned across sessions.",
			"Use memory action 'add' with an explicit topic filename and entry title when you discover something worth remembering long-term.",
			"Use memory action 'search' with scope='sessions' to find past work in history sessions.",
			"Use memory action 'read' with topic or entry to load stored knowledge.",
		],
		parameters: Type.Object({
			action: StringEnum(["add", "remove", "search", "read"] as const),
			// add
			content: Type.Optional(Type.String({ description: "Knowledge text to store (add)." })),
			topic: Type.Optional(Type.String({ description: "Target topic filename, e.g. 'debugging.md'. Auto-created if new (add/read)." })),
			title: Type.Optional(Type.String({ description: "Short title for the MEMORY.md index line (add). Required for add." })),
			// remove
			entry: Type.Optional(Type.String({ description: "Entry title to remove. Exact match on MEMORY.md index line (remove/read)." })),
			// search
			query: Type.Optional(Type.String()),
			scope: Type.Optional(StringEnum(["memory", "sessions"] as const)),
		}),
		renderCall(args: any, theme: any) {
			let t = theme.fg("toolTitle", theme.bold("memory ")) + theme.fg("muted", args.action);
			if (args.topic) t += ` ${theme.fg("accent", args.topic)}`;
			if (args.query) t += ` ${theme.fg("dim", `"${args.query}"`)}`;
			return new Text(t, 0, 0);
		},
		renderResult(result: any, { expanded }: any, theme: any) {
			const txt = result.content?.[0];
			const text = txt?.type === "text" ? txt.text : "";
			if (result.details?.error) return new Text(theme.fg("error", `Error: ${result.details.error}`), 0, 0);
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", text.split("\n")[0]), 0, 0);
		},
		async execute(_id: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, _ctx: any) {
			if (!deps.getEnabled()) throw new Error("Memory is disabled (run /memory on)");
			const dir = deps.getMemoryDir();
			const cfg = deps.getConfig();
			if (!dir) throw new Error("Memory not initialized (no session_start yet)");
			let text: string;
			let details: any = {};
			switch (params.action) {
				case "add": {
					if (!params.content) throw new Error("content is required for add");
					if (!params.topic) throw new Error("topic is required for add");
					if (!params.title) throw new Error("title is required for add");
					const r = await doAdd(dir, { content: params.content, topic: params.topic, title: params.title, maxLines: cfg.memIndexMaxLines, maxBytes: cfg.memIndexMaxBytes });
					if (!r.ok) throw new Error(r.error);
					text = `Added "${params.title}" to ${params.topic}. Index now has ${r.entries?.length ?? 0} entries.`;
					details = { entries: r.entries?.length };
					break;
				}
				case "remove": {
					if (!params.entry) throw new Error("entry is required for remove");
					const r = await doRemove(dir, { entry: params.entry });
					if (!r.ok) throw new Error(r.error);
					text = `Removed entry "${params.entry}".`;
					break;
				}
				case "search": {
					if (!params.query) throw new Error("query is required for search");
					if (params.scope === "sessions") {
						text = await deps.searchSessions(deps.cwd(), params.query, cfg.sessionSearch);
					} else {
						text = await searchMemory(dir, params.query);
					}
					break;
				}
				case "read": {
					if (!params.topic && !params.entry) throw new Error("topic or entry is required for read");
					const r = await doRead(dir, { topic: params.topic, entry: params.entry });
					if (!r.ok) throw new Error(r.error);
					text = r.content!;
					break;
				}
				default:
					throw new Error(`Unknown action: ${params.action}`);
			}
			return { content: [{ type: "text", text }], details };
		},
	};
}
