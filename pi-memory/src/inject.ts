import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { truncateForInjection } from "./index-file";
import { parseFrontmatter } from "./topic-file";
import { getSubagentsService } from "@yandy0725/pi-subagents";
import { access } from "node:fs/promises";

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

/** Run a lightweight LLM side-query to select relevant topic files.
 *  Uses pi-subagents spawn + Promise pattern (same as dream.ts).
 *  Falls back to keyword matching if subagent service is unavailable. */
export async function runSideQuery(
	prompt: string,
	manifest: TopicManifest[],
	maxFiles: number,
	events?: { on(channel: string, handler: (data: any) => void): () => void },
): Promise<string[]> {
	// Filter to uninjected candidates only
	const candidates = manifest.filter(t => {
		// already-injected topics are marked in the prompt, but we also
		// filter here as a safety net
		return !prompt.includes(`[already injected] ${t.filename}`);
	});
	if (candidates.length === 0) return [];

	// Build a minimal selection prompt — only current user message + topic manifest.
	// With prompt_mode=replace, this IS the entire system prompt (no inheritance).
	const task = [
		"Respond with ONLY a JSON object.",
		"",
		"Below is a list of memory topic files and a user query.",
		`Select up to ${maxFiles} topic files MOST relevant to the user's current query.`,
		"If nothing is relevant, return {\"selected_files\": []}.",
		"",
		prompt,
		"",
		"Respond with EXACTLY: {\"selected_files\": [...]}",
	].join("\n");

	const service = getSubagentsService();
	if (!service) {
		// Fallback: keyword matching when subagent service unavailable
		return keywordMatch(candidates, prompt, maxFiles);
	}

	const provider = {
		async prepare(_ctx: any) {
			return { cwd: process.cwd(), dispose: () => undefined };
		},
	};
	const unregister = service.registerWorkspaceProvider(provider);

	try {
		const agentId = service.spawn("memory-agent", task, {
			maxTurns: 1,
			inheritContext: false,
			thinkingLevel: "off",
		});

		return await new Promise<string[]>((resolve) => {
			const timeout = setTimeout(() => {
				cleanup();
				// Timeout fallback: keyword matching
				resolve(keywordMatch(candidates, prompt, maxFiles));
			}, 10_000);

			let settled = false;
			const cleanup = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				unsubCompleted();
				unsubFailed();
				unregister();
			};

			const onCompleted = (data: { id: string }) => {
				if (data.id !== agentId) return;
				cleanup();
				const record = service.getRecord(agentId);
				const result = record?.result ?? "";
				try {
					const jsonMatch = result.match(/\{[^}]*"selected_files"[^}]*\}/s);
					if (jsonMatch) {
						const parsed = JSON.parse(jsonMatch[0]);
						const files: string[] = parsed.selected_files ?? [];
						// Validate filenames are in manifest
						const valid = files.filter((f: string) =>
							candidates.some(c => c.filename === f)
						).slice(0, maxFiles);
						resolve(valid);
					} else {
						resolve([]);
					}
				} catch {
					resolve([]);
				}
			};

			const onFailed = (data: { id: string }) => {
				if (data.id !== agentId) return;
				cleanup();
				resolve(keywordMatch(candidates, prompt, maxFiles));
			};

			const unsubCompleted = events?.on("subagents:completed", onCompleted) ?? (() => {});
			const unsubFailed = events?.on("subagents:failed", onFailed) ?? (() => {});

			// If no events channel, fallback immediately
			if (!events) {
				cleanup();
				resolve(keywordMatch(candidates, prompt, maxFiles));
			}
		});
	} catch {
		unregister();
		return keywordMatch(candidates, prompt, maxFiles);
	}
}

/** Keyword-matching fallback for topic selection (no LLM required). */
function keywordMatch(
	manifest: TopicManifest[],
	userPrompt: string,
	maxFiles: number,
): string[] {
	const words = userPrompt.toLowerCase().split(/\W+/).filter(w => w.length > 2);
	const scored = manifest
		.map(t => {
			const desc = (t.description + " " + t.name).toLowerCase();
			const score = words.filter(w => desc.includes(w)).length;
			return { filename: t.filename, score };
		})
		.filter(t => t.score > 0)
		.sort((a, b) => b.score - a.score);
	return scored.slice(0, maxFiles).map(t => t.filename);
}
