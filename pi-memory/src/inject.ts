import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { runHeadlessAgent } from "./agent-runner";
import type { ThinkLevel } from "./config";
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
	const files = (await readdir(memoryDir).catch(() => [])).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");

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
			} catch {
				/* ignore */
			}
			manifests.push({
				filename: f,
				name: meta.name,
				description: meta.description,
				type: meta.type,
				mtimeMs,
			});
		} catch {
			/* skip unreadable files */
		}
	}
	return manifests.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function buildSurfacingPrompt(manifest: TopicManifest[], userPrompt: string): string {
	const lines = manifest.map((t) => {
		return `[${t.type}] ${t.filename} — ${t.description.slice(0, 80)}`;
	});

	return [
		"You are a memory relevance selector. Below is a list of memory topic files and a user message.",
		"Select up to N topic files that are relevant to the user's current query.",
		"Response format: JSON with a 'selected_files' array of filenames.",
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
		} catch {
			/* skip unreadable files */
		}
	}

	if (blocks.length === 0) return "";
	return `<relevant_memories>\n${blocks.join("\n\n")}\n</relevant_memories>`;
}

/** Build the side-query task prompt. Extracted for testability. */
export function buildSideQueryTask(prompt: string, maxFiles: number): string {
	return [
		"Respond with ONLY a JSON object.",
		"",
		"Below is a list of memory topic files and a user query.",
		`Select up to ${maxFiles} topic files MOST relevant to the user's current query.`,
		'If nothing is relevant, return {"selected_files": []}.',
		"",
		prompt,
		"",
		'Respond with EXACTLY: {"selected_files": [...]}',
	].join("\n");
}

/** Parse selected_files JSON from headless agent response. */
function parseSelectedFiles(result: string, candidates: TopicManifest[], maxFiles: number): string[] {
	try {
		const jsonMatch = result.match(/\{[^}]*"selected_files"[^}]*\}/s);
		if (!jsonMatch) return [];
		const parsed = JSON.parse(jsonMatch[0]);
		const files: string[] = parsed.selected_files ?? [];
		return files.filter((f: string) => candidates.some((c) => c.filename === f)).slice(0, maxFiles);
	} catch {
		return [];
	}
}

/** Run a lightweight headless side-query to select relevant topic files.
 *  Returns [] on timeout/failure — no fallback. */
export async function runSideQuery(
	manifest: TopicManifest[],
	userPrompt: string,
	injectedTopics: Set<string>,
	maxFiles: number,
	thinkLevel: ThinkLevel,
	model: string | undefined,
	modelRegistry: ModelRegistry,
	parentModel: Model<any> | undefined,
	memoryDir: string,
	sessionPersistence?: import("./config").SessionPersistenceConfig,
): Promise<string[]> {
	const candidates = manifest.filter((t) => !injectedTopics.has(t.filename));
	if (candidates.length === 0) return [];
	const surfacingPrompt = buildSurfacingPrompt(candidates, userPrompt);
	const task = buildSideQueryTask(surfacingPrompt, maxFiles);
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
			sessionPersistence,
		});
		return parseSelectedFiles(result, candidates, maxFiles);
	} catch {
		return [];
	}
}
