import { basename } from "node:path";

export function instanceName(sessionName: string | undefined, cwd: string, pid: number): string {
	const name = sessionName || basename(cwd);
	return `${name} (pid ${pid})`;
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

export function extractSummary(entries: unknown[], maxLen = 160): string {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (typeof entry !== "object" || entry === null) continue;
		const { type, message } = entry as { type?: unknown; message?: MessageLike };
		if (type !== "message" || typeof message !== "object" || message === null) continue;
		if (message.role !== "assistant") continue;
		const text = assistantText(message).replace(/\s+/g, " ").trim();
		if (!text) return "";
		return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
	}
	return "";
}
