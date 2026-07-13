export interface IndexEntry {
  name: string;      // 原名 title，取自 frontmatter name
  topic: string;     // 文件名
  hook: string;      // 一行描述
  raw: string;       // 原始行文本
}

export interface IndexFile {
  entries: IndexEntry[];
  raw: string;
}

// Matches: - [Name](topic.md) — hook
const LINE_RE = /^-\s+\[([^\]]+)\]\(([^)]+)\)\s*—\s*(.*)$/;

export function parseIndex(content: string): IndexFile {
  const entries: IndexEntry[] = [];
  for (const line of content.split("\n")) {
    const m = line.match(LINE_RE);
    if (m) {
      entries.push({
        name: m[1].trim(),
        topic: m[2].trim(),
        hook: m[3].trim(),
        raw: line,
      });
    }
  }
  return { entries, raw: content };
}

export function serializeIndex(entries: IndexEntry[]): string {
  return entries.map((e) => `- [${e.name}](${e.topic}) — ${e.hook}`).join("\n");
}

export function upsertEntryByTopic(entries: IndexEntry[], entry: IndexEntry): IndexEntry[] {
  const idx = entries.findIndex((e) => e.topic === entry.topic);
  if (idx === -1) return [...entries, entry];
  const next = [...entries];
  next[idx] = entry;
  return next;
}

export function removeEntryByTopic(entries: IndexEntry[], topic: string): IndexEntry[] {
  const idx = entries.findIndex((e) => e.topic === topic);
  if (idx === -1) throw new Error(`Topic "${topic}" not found in index`);
  const next = [...entries];
  next.splice(idx, 1);
  return next;
}

export function findEntryByTopic(entries: IndexEntry[], topic: string): IndexEntry | null {
  return entries.find((e) => e.topic === topic) ?? null;
}

export function updateHook(entries: IndexEntry[], topic: string, hook: string): IndexEntry[] {
  const idx = entries.findIndex((e) => e.topic === topic);
  if (idx === -1) throw new Error(`Topic "${topic}" not found in index`);
  const next = [...entries];
  next[idx] = { ...next[idx], hook, raw: "" };
  return next;
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
