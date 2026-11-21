import { basename } from "node:path";

export function instanceName(sessionName: string | undefined, cwd: string): string {
	return sessionName || basename(cwd);
}

export function instanceContext(sessionName: string | undefined, cwd: string, pid: number, detail?: string): string {
	const project = basename(cwd);
	const parts = sessionName && sessionName !== project ? [project] : [];
	if (detail) parts.push(detail);
	parts.push(`pid ${pid}`);
	return parts.join(" · ");
}

export function withContext(subject: string, context: string): string {
	return subject ? `${subject}\n${context}` : context;
}

export function formatDuration(durationMs: number): string {
	const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
	if (totalSeconds < 1) return "<1s";
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (totalMinutes < 60) return seconds > 0 ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

interface ContentBlockLike {
	type?: unknown;
	text?: unknown;
}

interface MessageLike {
	role?: unknown;
	content?: unknown;
}

function assistantText(message: MessageLike): string {
	const { content } = message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is ContentBlockLike & { text: string } =>
				typeof block === "object" &&
				block !== null &&
				(block as ContentBlockLike).type === "text" &&
				typeof (block as ContentBlockLike).text === "string",
		)
		.map((block) => block.text)
		.join(" ");
}

/** Best-effort markup removal for a one-line desktop notification; not a full markdown parser. */
function stripMarkdown(text: string): string {
	return text
		.split("\n")
		.map((line) => line.replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+)/, ""))
		.join("\n")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/\*([^*\n]+)\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/_([^_\n]+)_/g, "$1");
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function truncate(text: string, maxLen: number): string {
	const graphemes = Array.from(graphemeSegmenter.segment(text), (part) => part.segment);
	if (graphemes.length <= maxLen) return text;
	if (maxLen <= 0) return "…";

	const prefix = graphemes.slice(0, maxLen);
	let sentenceEnd = -1;
	for (let i = 0; i < prefix.length; i++) {
		const grapheme = prefix[i];
		if ("。！？".includes(grapheme) || (".!?".includes(grapheme) && graphemes[i + 1] === " ")) {
			sentenceEnd = i + 1;
		}
	}
	let end = sentenceEnd >= maxLen / 2 ? sentenceEnd : maxLen;
	if (end === maxLen && sentenceEnd !== maxLen && graphemes[maxLen] !== " ") {
		const wordBoundary = prefix.lastIndexOf(" ");
		if (wordBoundary >= maxLen / 2) end = wordBoundary;
	}
	return `${graphemes.slice(0, end).join("").trimEnd()}…`;
}

export function extractSummary(entries: unknown[], maxLen = 160): string {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (typeof entry !== "object" || entry === null) continue;
		const { type, message } = entry as { type?: unknown; message?: MessageLike };
		if (type !== "message" || typeof message !== "object" || message === null) continue;
		if (message.role !== "assistant") continue;
		const text = stripMarkdown(assistantText(message)).replace(/\s+/g, " ").trim();
		if (!text) return "";
		return truncate(text, maxLen);
	}
	return "";
}
