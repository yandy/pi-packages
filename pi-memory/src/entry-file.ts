export const ENTRY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export interface EntryMeta {
	name: string;
	description: string;
	type: EntryType;
	/** YYYY-MM-DD */
	created: string;
	/** ISO 8601 时间戳 */
	modified: string;
}

export interface ParsedEntryFile {
	meta: EntryMeta;
	body: string;
}

const FIELD_RE = /^([A-Za-z_][A-Za-z0-9_]*):[ \t]*(.*)$/;
const MD_MARKER_RE = /^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/;
const SENTENCE_END_RE = /[。！？!?.]/;

const DESCRIPTION_MAX = 200;

export function isEntryType(value: string): value is EntryType {
	return (ENTRY_TYPES as readonly string[]).includes(value);
}

/** 序列化为「frontmatter + 空行 + 正文」的 markdown。 */
export function serializeEntryFile(meta: EntryMeta, body: string): string {
	const header = [
		"---",
		`name: ${meta.name}`,
		`description: ${meta.description}`,
		`type: ${meta.type}`,
		`created: ${meta.created}`,
		`modified: ${meta.modified}`,
		"---",
	].join("\n");
	const trimmed = body.trim();
	return trimmed.length === 0 ? `${header}\n` : `${header}\n\n${trimmed}\n`;
}

/** 解析 entry 文件。frontmatter 缺失或字段不全时返回 null。 */
export function parseEntryFile(raw: string): ParsedEntryFile | null {
	if (!raw.startsWith("---\n")) return null;
	const end = raw.indexOf("\n---", 4);
	if (end === -1) return null;

	const fields: Record<string, string> = {};
	for (const line of raw.slice(4, end).split("\n")) {
		const m = line.match(FIELD_RE);
		if (m) fields[m[1]] = m[2].trim();
	}

	const name = fields.name ?? "";
	const description = fields.description ?? "";
	const type = fields.type ?? "";
	const created = fields.created ?? "";
	const modified = fields.modified ?? "";
	// description 必须「存在」但允许为空。deriveDescription 对「首行只有 markdown 标记」的正文会返回 ""，
	// 若把空值当成缺字段，写出的文件将永远解析不了（对 store 静默不可见）。
	if (!name || !created || !modified || !isEntryType(type) || !("description" in fields)) return null;

	const bodyStart = raw.indexOf("\n", end + 1);
	const body = bodyStart === -1 ? "" : raw.slice(bodyStart + 1).trim();
	return { meta: { name, description, type, created, modified }, body };
}

/** 从正文派生一行摘要：取首个非空行的首句，剥掉 markdown 标记。 */
export function deriveDescription(body: string, max = DESCRIPTION_MAX): string {
	const firstLine = body.split("\n").find((line) => line.trim().length > 0) ?? "";
	const cleaned = firstLine.replace(MD_MARKER_RE, "").trim();
	const stop = cleaned.search(SENTENCE_END_RE);
	const sentence = (stop === -1 ? cleaned : cleaned.slice(0, stop + 1)).trim();
	return sentence.length <= max ? sentence : `${sentence.slice(0, max - 1)}…`;
}
