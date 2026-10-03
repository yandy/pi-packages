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

/**
 * 索引唯一的按行拆分入口（解析、写入与**注入**必须共用它，否则同一个 `lineNo` 在三处含义不同）。
 *
 * CRLF（以及老 Mac 的单独 CR）必须在这里归一：JS 的 `.` 不匹配 `\r`，且无 `m` 标志的 `$`
 * 也无法在一个 `\r` 之前成立 —— `LINE_RE` 对 CRLF 行会**完全匹配不上**，于是每一行都被计成
 * `unrecognized`：删除变成空操作（留下死链）、追加变成重复行、`rebuildIndex` 把整块当成手写头部。
 * 归一之后写回仍只输出 `\n`（`joinLines`），因此对 CRLF 文件的首次写入会把它转成 LF ——
 * 这是有意的，它消除的是「混合行尾」这个更糟的中间态。
 */
export function splitLines(raw: string): string[] {
	const text = raw.includes("\r") ? raw.replace(/\r\n?/g, "\n") : raw;
	if (text.length === 0) return [];
	const lines = text.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function joinLines(lines: string[]): string {
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export function parseEntryIndex(raw: string): ParsedEntryIndex {
	const lines = splitLines(raw);
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
	const lines = splitLines(raw);

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

/**
 * 只删匹配到的那一行，其余行（含手写标题、分组、注释）逐字保留。
 * 没匹配上时**原样返回输入**，不做任何重写（否则一次「无操作的删除」也会补上一个尾换行、
 * 或把 CRLF 文件转成 LF，让调用方在无意间改动用户的文件）。
 */
export function removeIndexLine(raw: string, file: string): string {
	const target = parseEntryIndex(raw).entries.find((e) => e.file === file);
	if (!target) return raw;
	const lines = splitLines(raw);
	lines.splice(target.lineNo, 1);
	return joinLines(lines);
}

export interface IndexCapacity {
	lineCount: number;
	byteLength: number;
	ok: boolean;
}

export function indexCapacity(raw: string, maxLines: number, maxBytes: number): IndexCapacity {
	// 与解析共用同一切分口径，避开「同一规则在三处各自实现」的漂移
	const lineCount = splitLines(raw).filter((line) => line.trim().length > 0).length;
	const byteLength = Buffer.byteLength(raw, "utf8");
	return { lineCount, byteLength, ok: lineCount <= maxLines && byteLength <= maxBytes };
}
