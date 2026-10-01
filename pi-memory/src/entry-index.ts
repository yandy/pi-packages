// name 与 file 两组都必须是**非贪婪**的：(1) file 可能含 `)`（entryFileName 不剥括号）；
// (2) name 可能含 `]`。贪婪组会把分割点吃掉，[^\]]+ / [^)]+ 则表示这两种行根本匹配不上。
const LINE_RE = /^-\s+\[(.+?)\]\((.+?)\)\s*—\s*(.*)$/;

export interface IndexLineEntry {
	name: string;
	file: string;
	description: string;
	lineNo: number;
}

export interface ParsedEntryIndex {
	lines: string[];
	entries: IndexLineEntry[];
	/** 非空但无法识别的行数（标题、分组、注释等）。 */
	unrecognized: number;
}

/** 按行拆分，去掉末尾由换行产生的空元素（不影响其余行的下标）。 */
function normalizeLines(raw: string): string[] {
	if (raw.length === 0) return [];
	const lines = raw.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function joinLines(lines: string[]): string {
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export function parseEntryIndex(raw: string): ParsedEntryIndex {
	const lines = raw.length === 0 ? [] : raw.split("\n");
	const entries: IndexLineEntry[] = [];
	let unrecognized = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim().length === 0) continue;
		const m = line.match(LINE_RE);
		if (m) entries.push({ name: m[1].trim(), file: m[2].trim(), description: m[3].trim(), lineNo: i });
		else unrecognized++;
	}
	return { lines, entries, unrecognized };
}

export function formatIndexLine(name: string, file: string, description: string): string {
	return `- [${name}](${file}) — ${description}`;
}

/**
 * 外科式写入：只改目标行，其余行（标题、分组、注释、空行）逐字保留。
 * 新增时插到最后一条已识别行之后；`atLineNo` 用于改名时保持行位置。
 */
export function upsertIndexLine(
	raw: string,
	entry: { name: string; file: string; description: string },
	options?: { atLineNo?: number },
): string {
	const parsed = parseEntryIndex(raw);
	const line = formatIndexLine(entry.name, entry.file, entry.description);
	const lines = normalizeLines(raw);

	if (options?.atLineNo !== undefined) {
		lines[options.atLineNo] = line;
		return joinLines(lines);
	}

	const existing = parsed.entries.find((e) => e.file === entry.file);
	if (existing) {
		lines[existing.lineNo] = line;
		return joinLines(lines);
	}

	const last = parsed.entries[parsed.entries.length - 1];
	if (last) lines.splice(last.lineNo + 1, 0, line);
	else lines.push(line);
	return joinLines(lines);
}

export function removeIndexLine(raw: string, file: string): string {
	const target = parseEntryIndex(raw).entries.find((e) => e.file === file);
	if (!target) return joinLines(normalizeLines(raw));
	const lines = normalizeLines(raw);
	lines.splice(target.lineNo, 1);
	return joinLines(lines);
}

export interface IndexCapacity {
	lineCount: number;
	byteLength: number;
	ok: boolean;
}

export function indexCapacity(raw: string, maxLines: number, maxBytes: number): IndexCapacity {
	const lineCount = raw.split("\n").filter((line) => line.trim().length > 0).length;
	const byteLength = Buffer.byteLength(raw, "utf8");
	return { lineCount, byteLength, ok: lineCount <= maxLines && byteLength <= maxBytes };
}
