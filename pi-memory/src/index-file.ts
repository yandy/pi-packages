export interface IndexEntry {
	title: string;
	topic: string;
	description: string;
	raw: string;
}
export interface IndexFile {
	entries: IndexEntry[];
	raw: string;
}

// Matches: - [Title](topic.md) — description  (em-dash U+2014 or --)
const LINE_RE = /^-\s+\[([^\]]+)\]\(([^)]+)\)\s*[—-]{1,2}\s*(.+)$/;

export function parseIndex(content: string): IndexFile {
	const entries: IndexEntry[] = [];
	for (const line of content.split("\n")) {
		const m = line.match(LINE_RE);
		if (m) entries.push({ title: m[1].trim(), topic: m[2].trim(), description: m[3].trim(), raw: line });
	}
	return { entries, raw: content };
}

export function serializeIndex(entries: IndexEntry[]): string {
	return entries.map((e) => `- [${e.title}](${e.topic}) — ${e.description}`).join("\n");
}

export function upsertEntry(entries: IndexEntry[], entry: IndexEntry): IndexEntry[] {
	const idx = entries.findIndex((e) => e.topic === entry.topic);
	if (idx === -1) return [...entries, entry];
	const next = [...entries];
	next[idx] = { ...entry };
	return next;
}

export function truncateForInjection(content: string, maxLines: number, maxBytes: number): { ok: boolean; content: string; truncated: boolean } {
	const lines = content.split("\n");
	let out = content;
	let truncated = false;
	if (lines.length > maxLines) {
		out = lines.slice(0, maxLines - 1).join("\n");
		truncated = true;
	}
	if (Buffer.byteLength(out, "utf8") > maxBytes) {
		// cut by bytes
		let cut = out;
		while (Buffer.byteLength(cut, "utf8") > maxBytes && cut.length > 0) cut = cut.slice(0, -1);
		out = cut;
		truncated = true;
	}
	if (truncated) out += `\n[truncated]: memory index exceeds injection limit`;
	return { ok: !truncated, content: out, truncated };
}

export function checkCapacity(entries: IndexEntry[], maxLines: number, maxBytes: number): boolean {
	const serialized = serializeIndex(entries);
	if (entries.length > maxLines) return false;
	if (Buffer.byteLength(serialized, "utf8") > maxBytes) return false;
	return true;
}
