import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { truncateForInjection } from "./index-file";

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
