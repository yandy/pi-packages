import { createHash } from "node:crypto";
import { isReservedWindowsName } from "./windows-names";

/** 文件系统不安全字符与控制字符。 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 控制字符是故意列入的（Global Constraints 要求剥离 U+0000–U+001F 与 U+007F）
const UNSAFE = /[/\\:*?"<>|\u0000-\u001f\u007f]/g;
/** 首尾空白与句点（句点会让 "." / ".." 变成非法文件名）。 */
const EDGE = /^[\s.]+|[\s.]+$/g;
const WHITESPACE_RUN = /\s+/g;

const STEM_MAX_BYTES = 100;

export const ENTRY_EXT = ".md";

function shortHash(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 8);
}

function truncateBytes(input: string, maxBytes: number): string {
	let out = "";
	let bytes = 0;
	for (const ch of input) {
		const size = Buffer.byteLength(ch, "utf8");
		if (bytes + size > maxBytes) break;
		out += ch;
		bytes += size;
	}
	return out;
}

/** 由 entry 的 name 派生确定性的文件名（含扩展名）。同一 name 在同一输入下总得到同一结果。 */
export function entryFileName(name: string): string {
	const cleaned = name.replace(UNSAFE, "_").replace(EDGE, "");
	const stem = cleaned.length === 0 ? "" : truncateBytes(cleaned.replace(WHITESPACE_RUN, "-"), STEM_MAX_BYTES);
	// 保留设备名（`con`、`nul`、`com1`…）在 Windows 上会命中设备而不是文件：`memory add name="CON"`
	// 的内容会写进控制台，而索引里已经多了一行 —— 静默丢记忆。**全平台**加前缀：git 类记忆目录
	// 跨机共享，名字必须在两边都安全（spec Ruling 5）。既有文件不受影响：addEntry 按 frontmatter
	// 的 name 复用已有文件，这里只影响**新建**文件的派生名。
	const finalStem = stem.length === 0 ? `entry-${shortHash(name)}` : isReservedWindowsName(stem) ? `_${stem}` : stem;
	return `${finalStem}${ENTRY_EXT}`;
}

/** 在已占用的文件名集合中为 base 找一个空闲名字（追加 -2、-3……）。 */
export function resolveUniqueFileName(used: Iterable<string>, base: string): string {
	const taken = used instanceof Set ? used : new Set(used);
	if (!taken.has(base)) return base;
	const hasExt = base.endsWith(ENTRY_EXT);
	const stem = hasExt ? base.slice(0, -ENTRY_EXT.length) : base;
	const ext = hasExt ? ENTRY_EXT : "";
	for (let n = 2; ; n++) {
		const candidate = `${stem}-${n}${ext}`;
		if (!taken.has(candidate)) return candidate;
	}
}
