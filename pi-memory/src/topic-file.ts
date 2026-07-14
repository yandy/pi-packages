export interface TopicMeta {
	name: string;
	description: string;
	type: string;
	updated: string;
}

export const ALLOWED_TYPES = ["user", "feedback", "project", "reference"] as const;

export function buildFrontmatter(meta: TopicMeta): string {
	return [
		"---",
		`name: ${meta.name}`,
		`description: ${meta.description}`,
		`type: ${meta.type}`,
		`updated: ${meta.updated}`,
		"---",
		"",
		"",
	].join("\n");
}

export function parseFrontmatter(raw: string): TopicMeta | null {
	if (!raw.startsWith("---\n")) return null;
	const endIdx = raw.indexOf("\n---\n", 4);
	if (endIdx === -1) return null;
	const block = raw.slice(4, endIdx);
	const meta: Record<string, string> = {};
	for (const line of block.split("\n")) {
		const m = line.match(/^(\w+):\s*(.*)$/);
		if (m) meta[m[1]] = m[2].trim();
	}
	if (!meta.name || !meta.description || !meta.type || !meta.updated) return null;
	if (!(ALLOWED_TYPES as readonly string[]).includes(meta.type)) return null;
	return meta as unknown as TopicMeta;
}

export function appendContent(existing: string | null, entryTitle: string, content: string): string {
	const section = `## ${entryTitle}\n\n${content}`;
	if (!existing || existing.trim() === "") return section;
	return `${existing.trimEnd()}\n\n${section}\n`;
}

export function updateFrontmatterDate(raw: string, date: string): string {
	return raw.replace(/^(---\n(?:.*\n)*?)updated: .+(\n---)/m, `$1updated: ${date}$2`);
}

export function replaceFrontmatterField(raw: string, field: string, value: string): string {
	const regex = new RegExp(`^(---\n(?:.*\n)*?)${field}: .+(\n)`, "m");
	return raw.replace(regex, `$1${field}: ${value}$2`);
}

export function removeEntrySection(raw: string, title: string): string {
	const marker = `## ${title}`;
	// find start of this entry block
	const startIdx = raw.indexOf(`\n${marker}\n`) !== -1 ? raw.indexOf(`\n${marker}\n`) : raw.indexOf(marker);
	if (startIdx === -1) throw new Error(`Entry "${title}" not found`);

	// find start of next ## or EOF
	const afterHeader = raw.indexOf("\n", startIdx + marker.length);
	const nextH2 = raw.indexOf("\n## ", afterHeader + 1);
	const endIdx = nextH2 === -1 ? raw.length : nextH2;

	// remove including preceding blank lines
	let cutStart = startIdx;
	while (cutStart > 0 && raw[cutStart - 1] === "\n") cutStart--;
	// also strip one more \n if present (the blank line separator)
	if (cutStart > 0 && raw[cutStart - 1] === "\n") cutStart--;

	let result = raw.slice(0, cutStart) + raw.slice(endIdx);
	// ensure exactly one trailing newline
	result = result.replace(/\n{3,}$/, "\n\n").replace(/\n{2,}$/, "\n");
	if (!result.endsWith("\n")) result += "\n";
	return result;
}

export function hasEntries(raw: string): boolean {
	return /^## /m.test(raw);
}

export interface ParsedEntry {
	title: string;
	content: string;
}

export function parseEntries(raw: string): ParsedEntry[] {
	const entries: ParsedEntry[] = [];
	const lines = raw.split("\n");
	let currentTitle = "";
	let currentContent: string[] = [];
	let inEntry = false;
	let inFrontmatter = false;

	for (const line of lines) {
		if (line === "---") {
			inFrontmatter = !inFrontmatter;
			continue;
		}
		if (inFrontmatter) continue;

		const h2 = line.match(/^## (.+)$/);
		if (h2) {
			if (inEntry) {
				entries.push({ title: currentTitle, content: currentContent.join("\n").trim() });
			}
			currentTitle = h2[1];
			currentContent = [];
			inEntry = true;
			continue;
		}
		if (inEntry) {
			currentContent.push(line);
		}
	}
	if (inEntry) {
		entries.push({ title: currentTitle, content: currentContent.join("\n").trim() });
	}
	return entries;
}
