import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { truncateForInjection } from "./index-file";
import { parseFrontmatter } from "./topic-file";

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

export interface TopicManifest {
	filename: string;
	name: string;
	description: string;
	type: string;
	mtimeMs: number;
}

export async function scanTopics(memoryDir: string): Promise<TopicManifest[]> {
	const files = (await readdir(memoryDir).catch(() => []))
		.filter(f => f.endsWith(".md") && f !== "MEMORY.md");

	const manifests: TopicManifest[] = [];
	for (const f of files.slice(0, 200)) {
		try {
			const raw = await readFile(join(memoryDir, f), "utf8");
			const meta = parseFrontmatter(raw);
			if (!meta) continue;
			let mtimeMs = 0;
			try {
				const s = await stat(join(memoryDir, f));
				mtimeMs = s.mtimeMs;
			} catch { /* ignore */ }
			manifests.push({
				filename: f,
				name: meta.name,
				description: meta.description,
				type: meta.type,
				mtimeMs,
			});
		} catch { /* skip unreadable files */ }
	}
	return manifests.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function buildSurfacingPrompt(
	manifest: TopicManifest[],
	userPrompt: string,
	injectedTopics: Set<string>,
): string {
	const lines = manifest.map(t => {
		const marker = injectedTopics.has(t.filename) ? " [already injected]" : "";
		return `[${t.type}] ${t.filename} — ${t.description.slice(0, 80)}${marker}`;
	});
	const alreadyInjected = injectedTopics.size > 0
		? `\n\nNote: ${injectedTopics.size} topic file(s) have already been injected in this session and are marked [already injected]. Prefer selecting uninjected topics.`
		: "";

	return [
		"You are a memory relevance selector. Below is a list of memory topic files and a user message.",
		"Select up to N topic files that are relevant to the user's current query.",
		"Response format: JSON with a 'selected_files' array of filenames.",
		alreadyInjected,
		"",
		"=== Topic Files ===",
		...lines,
		"",
		"=== User Message ===",
		userPrompt,
		"",
		'Return: {"selected_files": ["a.md", "b.md"]}',
	].join("\n");
}

export async function injectSurfacedContent(
	memoryDir: string,
	selectedFiles: string[],
	maxTopicBytes: number,
	maxInjectionBytes: number,
): Promise<string> {
	const blocks: string[] = [];
	let totalBytes = 0;

	for (const f of selectedFiles) {
		try {
			const raw = await readFile(join(memoryDir, f), "utf8");
			const { content } = truncateForInjection(raw, 999999, maxTopicBytes);
			const block = `## ${f}\n${content}`;
			const blockBytes = Buffer.byteLength(block, "utf8");
			if (totalBytes + blockBytes > maxInjectionBytes) break;
			blocks.push(block);
			totalBytes += blockBytes;
		} catch { /* skip unreadable files */ }
	}

	if (blocks.length === 0) return "";
	return `<relevant_memories>\n${blocks.join("\n\n")}\n</relevant_memories>`;
}
