export interface IndexEntry {
  title: string;
  topic: string;
  raw: string;
}
export interface IndexFile {
  entries: IndexEntry[];
  raw: string;
}

// Matches: - [Title](topic.md)
const LINE_RE = /^-\s+\[([^\]]+)\]\(([^)]+)\)\s*$/;

export function parseIndex(content: string): IndexFile {
  const entries: IndexEntry[] = [];
  for (const line of content.split("\n")) {
    const m = line.match(LINE_RE);
    if (m) entries.push({ title: m[1].trim(), topic: m[2].trim(), raw: line });
  }
  return { entries, raw: content };
}

export function serializeIndex(entries: IndexEntry[]): string {
  return entries.map((e) => `- [${e.title}](${e.topic})`).join("\n");
}

export function addEntry(entries: IndexEntry[], entry: IndexEntry): IndexEntry[] {
  return [...entries, entry];
}

export function removeEntryByTitle(entries: IndexEntry[], title: string): IndexEntry[] {
  const idx = entries.findIndex((e) => e.title === title);
  if (idx === -1) throw new Error(`Entry "${title}" not found in index`);
  const next = [...entries];
  next.splice(idx, 1);
  return next;
}

export interface MatchResult {
  entry: IndexEntry | null;
  unique: boolean;
}

export function matchEntryByTitle(entries: IndexEntry[], title: string): MatchResult {
  const matches = entries.filter((e) => e.title === title);
  if (matches.length === 0) return { entry: null, unique: false };
  if (matches.length === 1) return { entry: matches[0], unique: true };
  return { entry: matches[0], unique: false };
}

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

export function checkCapacity(
  entries: IndexEntry[],
  maxLines: number,
  maxBytes: number,
): boolean {
  const serialized = serializeIndex(entries);
  if (entries.length > maxLines) return false;
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) return false;
  return true;
}
